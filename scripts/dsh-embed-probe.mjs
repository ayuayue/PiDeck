#!/usr/bin/env node
/**
 * DSH 深融合 PoC 探针（不用 `dsh web`）
 *
 * 验证目标（对应 docs/dsh-agent-backend-plan.md §8 阶段 0）：
 *   1. 进程内 `boot()` 引导完整 DSH host（dsh-base 组合，无 HTTP/无浏览器）
 *   2. `InProcessApiClient(toFetchHandler(ctx.apiProxy))` 零网络直连
 *   3. session.create → session.prompt → mux 流式事件
 *   4. approval/requested → respond 程序化应答
 *   5. session.history 读历史 → 显式 dispose 优雅退出
 *
 * 用法：
 *   node scripts/dsh-embed-probe.mjs [--cwd <dir>] [--prompt "<text>"]
 *       [--no-auto-approve] [--minimal] [--keep-home] [--timeout <ms>]
 *
 * 环境：
 *   DSH_HOME  缺省用临时目录（不污染 ~/.dsh）；--keep-home 时用真实 DSH_HOME
 *   DEEPSEEK_API_KEY  模型调用凭证（缺失时提示，管线其余部分仍可验证）
 */
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir, homedir as osHomedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { boot, loadOverlayPatches } from "@deepseek-ai/dsh-app-boot";
import { provideCmdline } from "@deepseek-ai/dsh-cmdline";
import { InProcessApiClient, toFetchHandler } from "@deepseek-ai/dsh-host-apiproxy";

const require = createRequire(import.meta.url);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");

// ── CLI 极简解析 ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback) => {
	const i = argv.indexOf(name);
	return i >= 0 ? (argv[i + 1] ?? fallback) : fallback;
};
const cwd = resolve(value("--cwd", process.cwd()));
const promptText = value("--prompt", "回复两个字：收到。不要调用任何工具，不要提问。");
const autoApprove = !flag("--no-auto-approve");
const minimal = flag("--minimal");
const keepHome = flag("--keep-home");
const debug = flag("--debug");
const copyCredentials = flag("--copy-credentials");
const runTimeoutMs = Number(value("--timeout", "120000"));

let exitCode = 0;
const log = (prefix, ...rest) => console.log(`[${prefix}]`, ...rest);

/** 防御性摘要：把未知事件压成可读一行，避免探针因形状变化直接崩。
 *  SessionEvent 形状为 { type, seq, time, data }——正文在 data 里。 */
function digest(value, max = 240) {
	if (value === null || value === undefined) return String(value);
	if (typeof value !== "object") return JSON.stringify(value);
	const data = value.data ?? value;
	const pick = {};
	for (const key of ["type", "role", "text", "toolName", "callId", "toolCallId", "approvalId", "outcome", "lastSeq", "sessionId", "reason", "message"]) {
		if (key in data) pick[key] = data[key];
	}
	let out = JSON.stringify(pick);
	if (out.length > max) out = `${out.slice(0, max)}…`;
	return out;
}

/** 从会话事件里提取可见文本。SessionEvent 正文在 data 字段：
 *  assistant/chunk.data.chunk = StreamChunk（delta 式）；
 *  assistant/message.data.message.content / user/message.data.content = 内容块数组。 */
function eventText(event) {
	if (!event || typeof event !== "object") return "";
	const data = event.data ?? event;
	if (!data || typeof data !== "object") return "";
	// assistant/chunk: { turn, step, chunk: StreamChunk }
	const chunk = data.chunk;
	if (chunk && typeof chunk === "object" && typeof chunk.type === "string") {
		if (chunk.type === "text-delta" || chunk.type === "reasoning-delta") {
			return typeof chunk.text === "string" ? chunk.text : "";
		}
		return "";
	}
	// 组装后的事件：内容块数组（assistant/message 的 message.content / user/message 的 content）
	const content = data.message?.content ?? data.content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (!block || typeof block !== "object") return "";
			if (block.type === "text" && typeof block.text === "string") return block.text;
			if (block.type === "reasoning" && typeof block.reasoning === "string") return block.reasoning;
			return "";
		})
		.join("");
}

async function main() {
	// ── DSH_HOME：默认永远用临时目录（隔离，不碰真实 ~/.dsh）；--keep-home 才用真实 home ──
	// 注意：环境里已存在的 DSH_HOME 不能被默认采用——探针写出的会话/存储不应污染用户数据，
	// 也绝不能在后清理时删除既有目录。只有本脚本创建的临时 home 才会在退出时删除。
	let homeIsTemp = false;
	let dshHome;
	if (keepHome) {
		dshHome = process.env.DSH_HOME || join(osHomedir(), ".dsh");
		log("home", `DSH_HOME=${dshHome}（--keep-home：真实 home，退出时不清理）`);
	} else {
		dshHome = mkdtempSync(join(tmpdir(), "pideck-dsh-probe-"));
		homeIsTemp = true;
		log("home", `DSH_HOME=${dshHome}（临时，退出时清理）`);
	}
	process.env.DSH_HOME = dshHome;
	process.env.DSH_TELEMETRY_DISABLED = "1";
	// --copy-credentials：把真实 home 的 .credentials.yaml 与 settings.yaml 复制进临时 home，
	// 让模型调用走用户已有的路由与凭证（文件随临时 home 一起删除，不落任何日志）。
	// 注意：真实 home 的模型路由（llm-pi-ai/agent-default-model 等）在 settings.yaml 里，
	// 凭证在 .credentials.yaml 里——两者都要复制，否则回退到默认 deepseek-official 路由。
	if (copyCredentials && !keepHome) {
		const realHome = join(osHomedir(), ".dsh");
		let copied = 0;
		for (const name of [".credentials.yaml", "settings.yaml"]) {
			const src = join(realHome, name);
			if (existsSync(src)) {
				writeFileSync(join(dshHome, name), readFileSync(src));
				copied += 1;
			}
		}
		log("home", copied > 0 ? `已复制真实 home 配置（${copied} 个文件，临时，退出即删）` : "warn: 真实 home 无配置文件，跳过");
	}

	// ── 组合：空配置 + dsh-base 补丁 + 本探针覆盖层 ───────────────────────────
	const basePatchPath = require.resolve("@deepseek-ai/dsh-base/cordis.patch.yml");
	const patches = loadOverlayPatches("pideck-probe", basePatchPath);
	// 探针覆盖：
	// 1) HMR 行禁用（要求 --expose-internals，Electron 主进程不可用；web/headless 同样禁用）
	// 2) 遥测行默认关（launcher 也这么做）
	// 3) ApiProxy 网关行（ctx.apiProxy 的提供者）依赖 workspaceRegistry（workspace 行）
	//    与 storage 三层；directoryPicker 由本地 stub 提供（无原生能力，host.* 目录方法优雅报错）
	//    —— 这是「base 组合不含 ApiProxyService」的补足（web 补丁里这四行是 web 专属）。
	patches.push({ id: "hmr", disabled: true });
	patches.push({ id: "session-telemetry-otel", disabled: true });
	patches.push({
		insert: [
			{ id: "storage", name: "@deepseek-ai/dsh-storage" },
			{
				id: "storage-json",
				name: "@deepseek-ai/dsh-storage-json",
				config: { root: { __jsExpr: "dshHomePath('storages')" } },
			},
			{ id: "storage-domain", name: "@deepseek-ai/dsh-storage-domain", config: { backend: "json" } },
			{ id: "workspace", name: "@deepseek-ai/dsh-workspace" },
			{ id: "api-gateway", name: "@deepseek-ai/dsh-host-apiproxy" },
			// 相对 config 目录解析的本地插件：提供无能力的 directoryPicker stub
			{ id: "pideck-directory-picker", name: "./pideck-directory-picker.js" },
		],
	});
	if (minimal) {
		for (const id of ["attachment-local", "subprocess", "bash-sandbox", "pwsh-sandbox", "tool-bash", "tool-pwsh"]) {
			patches.push({ id, disabled: true });
		}
		log("compose", `--minimal：已禁用 ${["attachment-local", "subprocess", "bash-sandbox", "pwsh-sandbox", "tool-bash", "tool-pwsh"].join(", ")}`);
	}
	log("compose", `base 补丁 + 覆盖层（${patches.length} 条 patch 条目）`);

	const configDir = mkdtempSync(join(tmpdir(), "pideck-dsh-config-"));
	const configPath = join(configDir, "cordis.yml");
	writeFileSync(configPath, "[]\n");
	// 本地 stub 插件：directoryPicker 服务只声明 capability，无 native/browse 能力。
	// ApiProxyService.inject 需要该服务存在；host.pickDirectory/listDirectory/createDirectory
	// 在 capability.kind 不匹配时返回 directory-picker-unavailable（优雅降级）。
	writeFileSync(join(configDir, "pideck-directory-picker.js"), ["export default {", "  apply(ctx) {", "    ctx.provide('directoryPicker', {", "      capability() { return { kind: 'none' }; },", "    });", "  },", "};", ""].join("\n"));

	// ── boot：prepare 钩子里补 launcher 职责（cmdline + appExit）──────────────
	const bootStartedAt = Date.now();
	let ctx;
	try {
		ctx = await boot(
			"pideck-probe",
			configPath,
			patches,
			(hostCtx) => {
				provideCmdline(hostCtx, {
					args: [],
					exit: (code) => {
						log("appExit", `host 请求退出 code=${code}`);
						exitCode = code;
					},
				});
			},
			pathToFileURL(join(projectRoot, "node_modules") + "/").href,
		);
	} catch (error) {
		log("boot", `FAILED：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
		if (minimal) {
			log("hint", "仍失败：见上方错误；可尝试去掉 --minimal（本机 node-pty/sharp 已装好）");
		} else {
			log("hint", "可尝试 --minimal（禁用 attachment-local/subprocess 等原生重行后重试）");
		}
		return 1;
	}
	log("boot", `OK，耗时 ${Date.now() - bootStartedAt}ms`);
	for (const svc of ["agents", "apiProxy", "sessions", "tools", "llm", "settings"]) {
		log("svc", `ctx.${svc} = ${ctx.get(svc) !== undefined ? "present" : "MISSING"}`);
	}

	// ── 零网络直连客户端 ───────────────────────────────────────────────────────
	const client = new InProcessApiClient(toFetchHandler(ctx.apiProxy));
	const abort = new AbortController();
	const stats = { events: 0, approvals: 0, questions: 0, turns: 0, streamError: null, turnError: null };
	const streamed = [];

	// ── mux 流泵：消费事件 + 应答审批/提问 ────────────────────────────────────
	const pump = (async () => {
		for await (const frame of client.events.mux({}, abort.signal)) {
			const rpcId = frame?.rpcId;
			const payload = frame?.payload ?? frame;
			if (!payload || typeof payload !== "object") continue;
			switch (payload.type) {
				case "session/subscribed":
					log("mux", `subscribed session=${payload.sessionId} lastSeq=${payload.lastSeq}`);
					break;
				case "session/event": {
					stats.events += 1;
					const event = payload.event;
					if (debug) log("raw", JSON.stringify(event));
					const text = eventText(event);
					if (text) streamed.push(text);
					if (event?.type === "turn/end") {
						stats.turns += 1;
						const reason = event.data?.reason;
						if (reason?.kind === "error") {
							stats.turnError = reason.error?.message ?? JSON.stringify(reason);
							log("turn", `turn/end with ERROR: ${stats.turnError}`);
						}
					}
					// finish chunk 携带流式失败（如凭证缺失）——提前报告
					const chunk = event?.data?.chunk;
					if (chunk?.type === "finish" && chunk.reason?.kind === "error") {
						log("chunk", `stream finish/error: ${chunk.reason.failure?.message ?? JSON.stringify(chunk.reason)}`);
					}
					log("evt", `${event?.type ?? "?"} ${text ? `「${text.slice(0, 60)}${text.length > 60 ? "…" : ""}」` : digest(event)}`);
					break;
				}
				case "approval/requested": {
					stats.approvals += 1;
					log("approval", `REQUESTED tool=${payload.toolName} reason=${payload.reason ?? "-"} (${payload.approvalId})`);
					if (!autoApprove) {
						log("approval", "（--no-auto-approve：不应答，等待超时）");
						break;
					}
					const receipt = await client.respond({
						type: "client-response",
						rpcId,
						result: {
							ok: true,
							value: {
								sessionId: payload.sessionId,
								approvalId: payload.approvalId,
								outcome: "allowed-once",
							},
						},
					});
					log("approval", `RESPOND allowed-once → ${JSON.stringify(receipt)}`);
					break;
				}
				case "question/requested": {
					stats.questions += 1;
					log("question", `REQUESTED ${payload.questions?.length ?? 0} 问：${JSON.stringify(payload.questions ?? []).slice(0, 200)}`);
					if (!autoApprove) break;
					const receipt = await client.respond({
						type: "client-response",
						rpcId,
						result: {
							ok: true,
							value: {
								sessionId: payload.sessionId,
								answer: {
									answers: (payload.questions ?? []).map((q) => ({
										id: q.id,
										selected: q.options?.length ? [q.options[0].label] : [],
										custom: q.options?.length ? undefined : "probe-auto",
									})),
								},
							},
						},
					});
					log("question", `RESPOND → ${JSON.stringify(receipt)}`);
					break;
				}
				case "stream/error":
					stats.streamError = payload.error;
					log("mux", `stream/error: ${JSON.stringify(payload.error)}`);
					break;
				default:
					log("mux", `${payload.type}: ${digest(payload)}`);
			}
		}
	})().catch((error) => {
		if (abort.signal.aborted) return;
		log("mux", `pump error: ${error instanceof Error ? error.message : String(error)}`);
	});

	// ── 创建会话并发送 ─────────────────────────────────────────────────────────
	if (!existsSync(cwd)) {
		log("fatal", `--cwd 不存在：${cwd}`);
		abort.abort();
		return 1;
	}
	const created = await client.sessions.create({ cwd });
	if (!created.result.ok) {
		log("create", `FAILED: ${JSON.stringify(created.result.error)}`);
		abort.abort();
		return 1;
	}
	const sessionId = created.result.value.sessionId;
	log("create", `session=${sessionId} agentPreset=${created.result.value.agentPreset ?? "(base 默认)"}`);

	log("prompt", `sending: ${promptText.slice(0, 80)}`);
	const sent = await client.sessions.prompt({
		sessionId,
		mode: "queue",
		content: [{ type: "text", text: promptText }],
	});
	if (!sent.result.ok) {
		log("prompt", `REJECTED: ${JSON.stringify(sent.result.error)}`);
		if (sent.result.error?.code === "model-unavailable" || sent.result.error?.code === "bad-request") {
			log("hint", "若提示模型/凭证问题：设置 DEEPSEEK_API_KEY 后重试（默认模型 deepseek-official/deepseek-v4-flash）");
		}
	} else {
		log("prompt", `accepted: ${JSON.stringify(sent.result.value)}`);
	}

	// ── 等待回合结束或超时 ─────────────────────────────────────────────────────
	const deadline = Date.now() + runTimeoutMs;
	let lastProgressLog = 0;
	if (sent.result.ok) {
		while (Date.now() < deadline && stats.turns < 1 && !stats.streamError) {
			if (Date.now() - lastProgressLog > 10000) {
				lastProgressLog = Date.now();
				log("wait", `回合进行中（${Math.round((Date.now() - (deadline - runTimeoutMs)) / 1000)}s / ${Math.round(runTimeoutMs / 1000)}s，事件 ${stats.events} 条）`);
			}
			await new Promise((r) => setTimeout(r, 100));
		}
	} else {
		// prompt 被拒：给 pump 2 秒收尾（可能仍有历史/错误帧到达）
		await new Promise((r) => setTimeout(r, 2000));
	}
	const timedOut = sent.result.ok && stats.turns < 1 && Date.now() >= deadline;

	// ── 历史验证 ───────────────────────────────────────────────────────────────
	const history = await client.sessions.history({ sessionId, maxMessages: 8 });
	if (history.result.ok) {
		const events = history.result.value.events ?? [];
		log("history", `tail ${events.length} 条事件（hasMore=${history.result.value.hasMore}）：`);
		for (const entry of events.slice(-8)) {
			const evt = entry.event ?? {};
			log("history", `  ${evt.type ?? "?"}: ${eventText(evt) || digest(evt)}`);
		}
	} else {
		log("history", `FAILED: ${JSON.stringify(history.result.error)}`);
	}

	// ── 汇总 ───────────────────────────────────────────────────────────────────
	log("summary", JSON.stringify({ sessionId, stats, timedOut, streamedChars: streamed.join("").length }, null, 2));
	if (timedOut) {
		log("summary", "⚠️ 超时：回合未在期限内结束（检查 DEEPSEEK_API_KEY / 网络）");
		exitCode = 1;
	} else if (!sent.result.ok) {
		log("summary", "⚠️ prompt 被拒（管线已通，模型调用未成）");
		exitCode = 1;
	} else if (stats.turnError) {
		log("summary", `⚠️ 回合以错误结束：${stats.turnError}`);
		if (stats.turnError.includes("MISSING_CREDENTIAL") || stats.turnError.includes("API key")) {
			log("hint", "设置 DEEPSEEK_API_KEY 后重试（默认模型 deepseek-official/deepseek-v4-flash）");
		}
		exitCode = 1;
	} else if (streamed.join("").trim().length === 0) {
		log("summary", "⚠️ 回合正常结束但未流式产出文本（验证流式解析）");
		exitCode = 1;
	} else {
		log("summary", "✅ 全流程通过（含模型流式回复）");
	}

	// ── 清理：停流 + 显式 dispose（每步都有兜底超时，防止进程内 SSE/插件 stop 卡死）──
	abort.abort();
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	await Promise.race([pump.catch(() => undefined), sleep(3000)]).catch(() => undefined);
	const disposedAt = Date.now();
	const disposeDone = await Promise.race([
		ctx.fiber.dispose().then(
			() => true,
			(error) => {
				log("dispose", `warn: ${String(error)}`);
				return true;
			},
		),
		sleep(5000).then(() => false),
	]);
	if (disposeDone) {
		log("dispose", `ctx.fiber.dispose() OK，耗时 ${Date.now() - disposedAt}ms`);
	} else {
		log("dispose", "warn: dispose 超时（5s），强制退出");
	}
	if (homeIsTemp) {
		// 只清理本脚本创建的临时 home；失败不致命（Windows 上 watcher/句柄可能短暂占用）
		try {
			rmSync(dshHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
		} catch (error) {
			log("cleanup", `warn: 临时 home 清理失败（${String(error)}），保留在 ${dshHome}`);
		}
	}
	// configDir 恒为本脚本创建的临时目录，一律清理
	rmSync(configDir, { recursive: true, force: true });
	return exitCode;
}

main().then((code) => {
	// 探针脚本：直接退出，避免残留句柄（mux 流/worker）挂住进程
	process.exit(code);
});
