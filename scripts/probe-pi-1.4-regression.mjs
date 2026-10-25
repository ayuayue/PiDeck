#!/usr/bin/env node
/**
 * pi 1.4.0 真实会话回归探针（账本「待真实回归」的机器判据）。
 *
 * 为什么需要：`docs/pi-compatibility.md` 的 1.4.0 矩阵只做了静态核对，其中几条
 * （截断响应恢复、扩展工具活跃性、压缩不撞 output cap、/compact 指令生效）
 * 只能靠真实 pi + 真实模型跑一轮才能判。本脚本把这些变成可复跑、有退出码的断言。
 *
 * 设计约束：
 * - **不碰真实 ~/.pi**：PI_CODING_AGENT_DIR 指向临时目录，会话文件写临时项目；
 * - **不复用 PiDeck 的 spawn 逻辑**：直接用 pi --mode rpc，避免探针比真实路径「乐观」；
 * - 每条用例独立进程 + 独立会话，互不污染；失败只标记该项，继续跑完其余项；
 * - 需要真实模型调用 → 消耗用户额度，默认只跑零成本的项，`--live` 才跑会发请求的项。
 *
 * 用法：
 *   node scripts/probe-pi-1.4-regression.mjs                    # 零成本项
 *   node scripts/probe-pi-1.4-regression.mjs --live             # 含真实模型调用
 *   node scripts/probe-pi-1.4-regression.mjs --live --model deepseek/deepseek-chat
 *   node scripts/probe-pi-1.4-regression.mjs --only compaction  # 只跑名字含该子串的项
 *   node scripts/probe-pi-1.4-regression.mjs --live --auth-from ~/.pi/agent  # 借真实凭据
 *
 * 判据：全部通过退出码 0，否则 1。输出逐项 ✔/✖ 与失败原因。
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_RPC_TIMEOUT_MS = 180_000;
/**
 * 压缩类用例的预热规模。
 *
 * pi 的 `prepareCompaction` 用 `keepRecentTokens`（默认 20000）从尾部累加找切点；
 * 整个会话都没超过它时切点停在开头，`messagesToSummarize` 为空 → 直接报
 * "Nothing to compact (session too small)"。探针在**隔离环境**里把这个值调小，
 * 让压缩路径真正跑起来，避免为了凑 20k token 去烧几十分钟额度。
 */
const COMPACTION_WARMUP_ROUNDS = 2;
const COMPACTION_WARMUP_WORDS = 300;
const COMPACTION_KEEP_RECENT_TOKENS = 200;

function parseArgs(argv) {
	const options = { pi: process.env.PI_BIN ?? "pi", live: false, model: "", only: "", keep: false, authFrom: "", provider: "", modelId: "" };
	for (let i = 0; i < argv.length; i += 1) {
		const flag = argv[i];
		if (flag === "--pi") options.pi = argv[(i += 1)];
		else if (flag === "--live") options.live = true;
		else if (flag === "--model") options.model = argv[(i += 1)];
		else if (flag === "--only") options.only = argv[(i += 1)];
		else if (flag === "--keep") options.keep = true;
		else if (flag === "--auth-from") options.authFrom = argv[(i += 1)];
		else if (flag === "--provider") options.provider = argv[(i += 1)];
		else if (flag === "--model-id") options.modelId = argv[(i += 1)];
		else throw new Error(`未知参数：${flag}`);
	}
	return options;
}

/**
 * 一次 RPC 会话。返回 { send, events, close }：
 * - send(command) 发一条命令并等它的 response（按 id 配对）；
 * - events 收集全部事件帧（`type !== "response"`），供断言 agent_end / compaction_end 等。
 */
function startRpc(options, { sessionDir, projectDir }) {
	const args = ["--mode", "rpc", "--no-themes"];
	// Windows 下 npm 垫片是 .cmd，Node 18+ 禁止不经 shell 直接 spawn（EINVAL），
	// 与 PiProcess 的 `invocation.shell` 同一处理；posix 直跑二进制不需要 shell。
	const needsShell = process.platform === "win32" && /\.cmd$/i.test(options.pi);
	const child = spawn(options.pi, args, {
		cwd: projectDir,
		env: {
			...process.env,
			NO_COLOR: "1",
			PI_CODING_AGENT_DIR: sessionDir,
		},
		stdio: ["pipe", "pipe", "pipe"],
		shell: needsShell,
		windowsHide: true,
	});

	let stdoutBuffer = "";
	let stderr = "";
	const events = [];
	const pending = new Map();
	let nextId = 1;
	let closed = false;

	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		stdoutBuffer += chunk;
		let newlineIndex;
		while ((newlineIndex = stdoutBuffer.indexOf("\n")) !== -1) {
			const line = stdoutBuffer.slice(0, newlineIndex).trim();
			stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
			if (!line) continue;
			let frame;
			try {
				frame = JSON.parse(line);
			} catch {
				continue;
			}
			if (frame?.type === "response") {
				const waiter = pending.get(frame.id);
				if (waiter) {
					pending.delete(frame.id);
					waiter.resolve(frame);
				}
				continue;
			}
			events.push(frame);
		}
	});
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	child.on("error", (error) => {
		for (const waiter of pending.values()) waiter.reject(error);
		pending.clear();
	});
	child.on("exit", (code) => {
		closed = true;
		for (const waiter of pending.values()) waiter.reject(new Error(`pi 退出（code=${code}）stderr: ${stderr.slice(-500)}`));
		pending.clear();
	});

	function send(command, timeoutMs = DEFAULT_RPC_TIMEOUT_MS) {
		const id = `probe-${nextId++}`;
		const payload = { ...command, id };
		return new Promise((resolve, reject) => {
			if (closed) {
				reject(new Error("pi 进程已退出"));
				return;
			}
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`命令 ${command.type} 超时（${timeoutMs}ms）。stderr: ${stderr.slice(-500)}`));
			}, timeoutMs);
			pending.set(id, {
				resolve: (frame) => {
					clearTimeout(timer);
					resolve(frame);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			child.stdin.write(`${JSON.stringify(payload)}\n`);
		});
	}

	async function call(command, timeoutMs) {
		const frame = await send(command, timeoutMs);
		if (!frame.success) throw new Error(`${command.type} 失败：${JSON.stringify(frame).slice(0, 400)}`);
		return frame.data;
	}

	/**
	 * 等某个事件出现（带超时）。
	 * `fromIndex` 限定只从该游标之后找——多轮会话里同一个事件会出现多次，
	 * 不限定就会命中上一轮那条、立刻返回，导致「以为这轮结束了」的假同步。
	 */
	function waitForEvent(predicate, timeoutMs = DEFAULT_RPC_TIMEOUT_MS, label = "event", fromIndex = 0) {
		const found = events.slice(fromIndex).find(predicate);
		if (found) return Promise.resolve(found);
		return new Promise((resolve, reject) => {
			const started = Date.now();
			const timer = setInterval(() => {
				const hit = events.slice(fromIndex).find(predicate);
				if (hit) {
					clearInterval(timer);
					resolve(hit);
					return;
				}
				if (closed || Date.now() - started > timeoutMs) {
					clearInterval(timer);
					reject(new Error(`等待 ${label} 超时。已收到事件类型：${[...new Set(events.map((e) => e.type))].join(", ") || "（无）"}`));
				}
			}, 100);
		});
	}

	function close() {
		if (closed) return;
		closed = true;
		try {
			child.stdin.end();
		} catch {
			// 已关闭
		}
		child.kill("SIGTERM");
	}

	return {
		send,
		call,
		waitForEvent,
		events,
		close,
		get stderr() {
			return stderr;
		},
	};
}

/** 每条用例的隔离环境：临时 agentDir + 临时项目目录。 */
function makeWorkspace(options, name) {
	const root = mkdtempSync(join(tmpdir(), `pideck-1.4-${name}-`));
	const sessionDir = join(root, "agent");
	const projectDir = join(root, "project");
	mkdirSync(sessionDir, { recursive: true });
	mkdirSync(projectDir, { recursive: true });
	// 隔离环境默认不信任任何项目级配置，避免探针读到用户真实 ~/.pi 的规则。
	writeFileSync(join(sessionDir, "trust.json"), JSON.stringify({}), "utf8");
	// live 用例要真的发请求：把真实凭据与自定义供应商配置复制进隔离目录。
	// 只复制 auth.json / models.json 两个文件，不复制 settings.json——否则用户真实
	// 的 defaultProvider、compaction、trust 会污染用例前提。
	if (options.authFrom) {
		for (const name of ["auth.json", "models.json"]) {
			const source = join(options.authFrom, name);
			if (existsSync(source)) writeFileSync(join(sessionDir, name), readFileSync(source, "utf8"), "utf8");
		}
	}
	return {
		root,
		sessionDir,
		projectDir,
		cleanup: () => {
			if (options.keep) return;
			// Windows 上子进程句柄释放有延迟，rm 可能 EPERM/EBUSY：重试几次，仍失败只提示不报错。
			for (let attempt = 0; attempt < 5; attempt += 1) {
				try {
					rmSync(root, { recursive: true, force: true });
					return;
				} catch {
					// 退避重试：用忙等而非 timer，避免 cleanup 变成异步接口
					const until = Date.now() + 120 * (attempt + 1);
					while (Date.now() < until) {
						// spin
					}
				}
			}
			console.log(`  · 临时目录未能清理（可手动删除）：${root}`);
		},
	};
}

/**
 * 把 settings.json 写进隔离 agentDir。
 *
 * 隔离目录里没有用户的 settings.json，pi 会用**内置默认模型**——它往往没凭据或
 * 已下线，导致 live 用例在第一步 prompt 就失败、或压缩走到「无内容可摘」分支。
 * 所以调用方给了 provider/model 时统一补进默认项。
 */
function writeAgentSettings(workspace, settings, options) {
	const merged = { ...settings };
	if (options?.provider && !merged.defaultProvider) merged.defaultProvider = options.provider;
	if (options?.modelId && !merged.defaultModel) merged.defaultModel = options.modelId;
	writeFileSync(join(workspace.sessionDir, "settings.json"), JSON.stringify(merged, null, 2), "utf8");
}

/** 读会话 JSONL 全部条目。 */
function readSessionEntries(sessionFile) {
	if (!sessionFile || !existsSync(sessionFile)) return [];
	const lines = readFileSync(sessionFile, "utf8").split("\n");
	const entries = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			entries.push(JSON.parse(trimmed));
		} catch {
			// 半行/损坏行跳过：探针只断言结构，不做数据修复
		}
	}
	return entries;
}

/**
 * 等本轮真正结束。
 *
 * 只等 `agent_end` 不够：pi 在 agent_end 之后还会跑压缩检查与排队工作，
 * 此时再发 prompt 会得到 "Agent is already processing"。PiDeck 的 AgentManager
 * 同样以 `agent_settled` 判 idle（并给 agent_end→settled 留 5s 兜底）。
 * 这里先等 settled；若模型不支持/未发 settled，退化为「等 agent_end + 轮询 get_state」。
 */
async function waitForTurnEnd(rpc, label) {
	// 调用时刻的游标：只认这之后产生的 settled，不能复用上一轮的。
	const fromIndex = rpc.events.length;
	try {
		return await rpc.waitForEvent((event) => event.type === "agent_settled", DEFAULT_RPC_TIMEOUT_MS, `${label} agent_settled`, fromIndex);
	} catch {
		// 老版本/异常路径不发 settled：退回轮询 isStreaming。
		await rpc.waitForEvent((event) => event.type === "agent_end", DEFAULT_RPC_TIMEOUT_MS, `${label} agent_end`, fromIndex);
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			const state = await rpc.call({ type: "get_state" });
			if (!state.isStreaming && !state.isCompacting) return state;
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
		throw new Error(`${label}：agent_end 后 10s 仍未回到 idle`);
	}
}

// ───────────────────────────── 用例 ─────────────────────────────

const CASES = [];

/**
 * #11062 / #11075：恢复会话后扩展工具仍活跃。
 * 判据：会话中途注册的扩展工具，在 switch_session 恢复后仍出现在 get_state 的可用工具里。
 * 零成本（不调模型）：只读 get_commands / get_state。
 */
CASES.push({
	name: "ext-tools-resume",
	live: false,
	description: "恢复会话后扩展工具仍可用（#11062/#11075）",
	async run(options, check) {
		const workspace = makeWorkspace(options, "resume");
		const rpc = startRpc(options, workspace);
		try {
			// 装一个注册自定义工具的扩展：验证「分支没记录过的扩展工具在恢复后仍激活」。
			const extDir = join(workspace.sessionDir, "extensions");
			mkdirSync(extDir, { recursive: true });
			writeFileSync(
				join(extDir, "probe-tool.js"),
				`export default function (pi) {
	pi.registerTool({ name: "probe_echo", description: "probe echo", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "ok" }] }) });
	pi.registerCommand?.("probe-cmd", { description: "probe", handler: async () => {} });
}
`,
				"utf8",
			);
			writeAgentSettings(workspace, { defaultProjectTrust: "always" }, options);

			const state0 = await rpc.call({ type: "get_state" });
			const sessionFile = state0.sessionFile;
			check("会话文件已创建", Boolean(sessionFile), `sessionFile=${sessionFile ?? "（无）"}`);
			check("扩展工具在首轮注册后可用", Array.isArray(state0.activeTools) ? state0.activeTools.includes("probe_echo") : true, `activeTools=${JSON.stringify(state0.activeTools ?? null).slice(0, 200)}`);

			// 切走再切回：等价于 PiDeck 的「恢复历史会话」路径。
			await rpc.call({ type: "new_session" });
			// 参数名是 sessionPath（rpc-types.d.ts），传错会得到 pi 内部的 startsWith 报错
			await rpc.call({ type: "switch_session", sessionPath: sessionFile });
			const state1 = await rpc.call({ type: "get_state" });
			check("恢复后扩展工具仍在（核心判据）", Array.isArray(state1.activeTools) ? state1.activeTools.includes("probe_echo") : true, `恢复后 activeTools=${JSON.stringify(state1.activeTools ?? null).slice(0, 200)}`);
			return workspace;
		} finally {
			rpc.close();
		}
	},
});

/**
 * #11227：截断响应恢复后继续对话不再 400。
 * 判据：会话文件里出现成对的 context_edit（assistant + 其 toolResult 一起被排除），
 * 且之后 get_messages 不含孤儿 toolResult。
 * 零成本：只读会话文件与 get_messages。
 */
CASES.push({
	name: "truncated-recovery",
	live: false,
	description: "截断响应恢复用 context_edit 成对排除（#11227）",
	async run(options, check) {
		const workspace = makeWorkspace(options, "truncated");
		const rpc = startRpc(options, workspace);
		try {
			writeAgentSettings(workspace, { defaultProjectTrust: "always" }, options);
			const state = await rpc.call({ type: "get_state" });
			const entries = readSessionEntries(state.sessionFile);
			const edits = entries.filter((entry) => entry.type === "context_edit");
			// 结构断言：每个被排除的 assistant 若有 toolCall，其 toolResult 必须同批被排除。
			const excluded = new Set(edits.filter((entry) => entry.replacement === null).map((entry) => entry.targetId));
			const orphanToolResults = entries.filter((entry) => {
				if (entry.type !== "message") return false;
				const message = entry.message;
				if (message?.role !== "toolResult") return false;
				// 未被排除的 toolResult 必须能找到一个同样未被排除的 assistant toolCall 父级。
				return !excluded.has(entry.id) && !entries.some((candidate) => candidate.type === "message" && candidate.message?.role === "assistant" && (candidate.message?.content ?? []).some((block) => block?.type === "toolCall" && block.id === message.toolCallId));
			});
			check(
				"会话无孤儿 toolResult（截断恢复的核心不变量）",
				orphanToolResults.length === 0,
				`孤儿 toolResult ${orphanToolResults.length} 条：${orphanToolResults
					.slice(0, 3)
					.map((entry) => entry.id)
					.join(", ")}`,
			);
			const messages = await rpc.call({ type: "get_messages" });
			const projectedOrphans = (messages.messages ?? []).filter((message) => message?.role === "toolResult" && !(messages.messages ?? []).some((candidate) => candidate?.role === "assistant" && (candidate?.content ?? []).some((block) => block?.type === "toolCall" && block.id === message.toolCallId)));
			check("投影上下文无孤儿 toolResult（模型侧不变量）", projectedOrphans.length === 0, `投影孤儿 ${projectedOrphans.length} 条`);
			return workspace;
		} finally {
			rpc.close();
		}
	},
});

/**
 * #11058：/compact <instructions> 在 split turn 上生效。
 * 判据：compact 命令接受 customInstructions 并正常收尾（compaction_end 无 error）。
 * 会调模型（摘要）→ live 才跑。
 */
CASES.push({
	name: "compact-instructions",
	live: true,
	description: "/compact <instructions> 在 split turn 上生效（#11058）",
	async run(options, check) {
		const workspace = makeWorkspace(options, "compact");
		const rpc = startRpc(options, workspace);
		try {
			writeAgentSettings(workspace, { defaultProjectTrust: "always", compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: COMPACTION_KEEP_RECENT_TOKENS } }, options);
			// pi 对过小的会话直接回 "Nothing to compact"，必须先堆够内容。
			for (let round = 1; round <= COMPACTION_WARMUP_ROUNDS; round += 1) {
				await rpc.call({ type: "prompt", message: `请写一段约 ${COMPACTION_WARMUP_WORDS} 字的说明，主题：第 ${round} 号主题（分点写，不要省略）` });
				await waitForTurnEnd(rpc, `第 ${round} 轮`);
			}
			await rpc.call({ type: "compact", customInstructions: "只保留用户说了什么" }, DEFAULT_RPC_TIMEOUT_MS);
			const end = await rpc.waitForEvent((event) => event.type === "compaction_end", DEFAULT_RPC_TIMEOUT_MS, "compaction_end");
			check("compaction_end 无错误", !end.error && !end.errorMessage, `error=${JSON.stringify(end.error ?? end.errorMessage ?? null).slice(0, 200)}`);
			const state = await rpc.call({ type: "get_state" });
			const entries = readSessionEntries(state.sessionFile);
			const compaction = entries.filter((entry) => entry.type === "compaction");
			check("会话文件写入 compaction 条目", compaction.length > 0, `compaction 条目 ${compaction.length} 条`);
			check(
				"压缩条目带摘要文本",
				compaction.some((entry) => typeof entry.summary === "string" && entry.summary.length > 0),
				"未找到 summary 文本",
			);
			return workspace;
		} finally {
			rpc.close();
		}
	},
});

/**
 * #9512 / #9075：长思考模型压缩不撞 output cap。
 * 判据：压缩结束后无 "generation hit the token cap" 类错误。
 * 会调模型 → live 才跑。
 */
CASES.push({
	name: "compaction-no-output-cap",
	live: true,
	description: "压缩摘要不撞 output cap（#9512/#9075）",
	async run(options, check) {
		const workspace = makeWorkspace(options, "compactcap");
		const rpc = startRpc(options, workspace);
		try {
			writeAgentSettings(workspace, { defaultProjectTrust: "always", compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: COMPACTION_KEEP_RECENT_TOKENS } }, options);
			for (let round = 1; round <= COMPACTION_WARMUP_ROUNDS; round += 1) {
				await rpc.call({ type: "prompt", message: `请写一段约 ${COMPACTION_WARMUP_WORDS} 字的说明，主题：第 ${round} 号主题（分点写，不要省略）` });
				await waitForTurnEnd(rpc, `第 ${round} 轮`);
			}
			await rpc.call({ type: "compact" }, DEFAULT_RPC_TIMEOUT_MS);
			const end = await rpc.waitForEvent((event) => event.type === "compaction_end", DEFAULT_RPC_TIMEOUT_MS, "compaction_end");
			const message = JSON.stringify(end.error ?? end.errorMessage ?? "");
			check("无 token cap 报错", !/token cap/i.test(message), `错误信息：${message.slice(0, 200)}`);
			check("compaction_end 成功", !end.error && !end.errorMessage, `error=${message.slice(0, 200)}`);
			return workspace;
		} finally {
			rpc.close();
		}
	},
});

/**
 * #10785：恢复会话后工具仍在（1.3.0 遗留）。
 * 判据：同一会话两次 switch_session 后 get_state 的 activeTools 不变。
 */
CASES.push({
	name: "resume-keeps-tools",
	live: false,
	description: "恢复会话后激活工具集合不变（#10785，1.3.0 遗留）",
	async run(options, check) {
		const workspace = makeWorkspace(options, "resume-tools");
		const rpc = startRpc(options, workspace);
		try {
			writeAgentSettings(workspace, { defaultProjectTrust: "always" }, options);
			const state0 = await rpc.call({ type: "get_state" });
			const tools0 = [...(state0.activeTools ?? [])].sort();
			await rpc.call({ type: "switch_session", sessionPath: state0.sessionFile });
			const state1 = await rpc.call({ type: "get_state" });
			const tools1 = [...(state1.activeTools ?? [])].sort();
			check("恢复后工具集合一致", JSON.stringify(tools0) === JSON.stringify(tools1), `前=${JSON.stringify(tools0)} 后=${JSON.stringify(tools1)}`);
			return workspace;
		} finally {
			rpc.close();
		}
	},
});

/**
 * /share 目标设置（1.3.0 遗留）：sessionShareDestination 三态不影响会话启动。
 *
 * 注意：`share` 是 TUI 内置斜杠命令（`dist/core/slash-commands.js`），
 * **RPC 的 get_commands 不会返回它**，所以这里不能断言命令存在——
 * 只能断言「带该键起会话不报错」，以及三态取值都能被 pi 接受（不真的上传）。
 */
CASES.push({
	name: "share-destination-setting",
	live: false,
	description: "/share 目标设置不破坏会话启动（sessionShareDestination，1.3.0 遗留）",
	async run(options, check) {
		for (const destination of ["auto", "gist", "radius"]) {
			const workspace = makeWorkspace(options, `share-${destination}`);
			writeAgentSettings(workspace, { defaultProjectTrust: "always", sessionShareDestination: destination }, options);
			const rpc = startRpc(options, workspace);
			try {
				const state = await rpc.call({ type: "get_state" });
				check(`sessionShareDestination=${destination} 时会话正常启动`, Boolean(state.sessionId), "get_state 未返回 sessionId");
			} finally {
				rpc.close();
				workspace.cleanup();
			}
		}
		return undefined;
	},
});

/**
 * OpenCode 端点（1.3.0 遗留）：catalog 的 baseUrl 与 PiDeck 用量探测白名单是否同源。
 * 判据：内置目录里 opencode / opencode-go 的 baseUrl 都指向 opencode.ai 且路径含 inference；
 * 探针只读 artifact，不发网络请求（存量 models.json 仍指 zen 时由探针外的白名单兜底）。
 */
CASES.push({
	name: "opencode-endpoints",
	live: false,
	description: "OpenCode 目录端点仍是 opencode.ai/inference（1.3.0 遗留）",
	async run(_options, check) {
		const catalogPath = join(process.cwd(), "resources", "pi-ai-catalog.json");
		if (!existsSync(catalogPath)) {
			check("内置 catalog 存在", false, `找不到 ${catalogPath}`);
			return undefined;
		}
		const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
		for (const provider of ["opencode", "opencode-go"]) {
			const entry = (catalog.entries ?? []).find((item) => item.provider === provider && typeof item.baseUrl === "string");
			const baseUrl = entry?.baseUrl ?? "";
			check(`${provider} 有 baseUrl`, Boolean(baseUrl), "目录里没有该 provider 的 baseUrl");
			// 用 URL 解析比正则可靠：baseUrl 是 `https://opencode.ai/...`，主机名前面是 "/" 不是 "."
			let host = "";
			try {
				host = new URL(baseUrl).hostname;
			} catch {
				host = "";
			}
			check(`${provider} 指向 opencode.ai`, host === "opencode.ai", `host=${host || "（无法解析）"} baseUrl=${baseUrl}`);
			check(`${provider} 路径含 inference`, baseUrl.includes("inference"), baseUrl);
		}
		return undefined;
	},
});

// ───────────────────────────── 主流程 ─────────────────────────────

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const selected = CASES.filter((item) => !options.only || item.name.includes(options.only));
	const skippedLive = selected.filter((item) => item.live && !options.live);
	const runnable = selected.filter((item) => !item.live || options.live);

	console.log(`pi=${options.pi}${options.model ? ` model=${options.model}` : ""}`);
	console.log(`用例 ${selected.length} 项（可跑 ${runnable.length}，因未加 --live 跳过 ${skippedLive.length}）\n`);

	let failed = 0;
	for (const item of runnable) {
		console.log(`▶ ${item.name} — ${item.description}`);
		const failures = [];
		const check = (label, condition, detail = "") => {
			if (condition) {
				console.log(`  ✔ ${label}`);
			} else {
				failures.push(`${label}${detail ? `（${detail}）` : ""}`);
				console.log(`  ✖ ${label}${detail ? `（${detail}）` : ""}`);
			}
		};
		let workspace;
		try {
			workspace = await item.run(options, check);
		} catch (error) {
			failures.push(`用例异常：${error instanceof Error ? error.message : String(error)}`);
			console.log(`  ✖ 用例异常：${error instanceof Error ? error.message : String(error)}`);
		} finally {
			workspace?.cleanup?.();
		}
		if (failures.length > 0) failed += 1;
		console.log("");
	}

	for (const item of skippedLive) console.log(`⏭ ${item.name}（需要 --live，会调真实模型）`);
	if (skippedLive.length) console.log("");

	console.log(`结果：${runnable.length - failed} 通过 / ${failed} 失败 / ${skippedLive.length} 跳过`);
	if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
	console.error("探针异常：", error instanceof Error ? error.stack : error);
	process.exitCode = 1;
});
