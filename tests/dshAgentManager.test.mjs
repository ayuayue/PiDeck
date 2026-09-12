import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { DshAgentManager } = loadTsCommonJs("src/main/dsh/DshAgentManager.ts");
const { dshSessionFilePath } = loadTsCommonJs("src/main/dsh/dshSessionPath.ts");

test("dshSessionFilePath：workspace 目录名编码与 DSH 内部规则一致", () => {
	// 实测目录：cwd = C:\Users\14012\pi-desktop → "--C-Users-14012-pi-desktop--"；
	// 盘符冒号与分隔符折叠为一个 "-"；sessionId 自带 session- 前缀（目录名 = sessionId）
	assert.equal(
		dshSessionFilePath("C:\\Users\\14012\\.dsh", "C:\\Users\\14012\\pi-desktop", "session-abc-123"),
		"C:\\Users\\14012\\.dsh\\sessions\\--C-Users-14012-pi-desktop--\\session-abc-123\\session.jsonl.zstd",
	);
	// 正斜杠混合（WSL 风格 cwd）；join 分隔符随平台，归一化后比较
	const norm = (path) => path.replace(/\\/g, "/");
	assert.equal(
		norm(dshSessionFilePath("/home/user/.dsh", "C:/work/project", "session-x")),
		"/home/user/.dsh/sessions/--C-work-project--/session-x/session.jsonl.zstd",
	);
	// 不安全字符按 ~XXXX 转义（与 projectKey 一致）
	assert.equal(
		norm(dshSessionFilePath("/h", "C:\\work\\带空格 项目", "session-y")),
		"/h/sessions/--C-work-~5E26~7A7A~683C~0020~9879~76EE--/session-y/session.jsonl.zstd",
	);
});

/**
 * 假 DSH host：内存 session 注册表 + 可注入的 history 事件。
 * DshAgentManager 只依赖 DshHost 的 ensureStarted/getClient（InProcessApiClient），
 * 这里用同形状的假 client（sessions.list/create/history + events.mux 空流）。
 */
function makeFakeHost({ muxFrames = [], failRespond = false, modelsValue = undefined } = {}) {
	const sessions = new Map();
	let nextSession = 0;
	const historyBySession = new Map();
	// 可选：history 尾页的 projections baseline（官方 host 在尾页携带完整投影折叠）
	const historyProjections = new Map();
	const attachments = new Map();
	const calls = { create: 0, list: 0, history: 0, fork: 0, prompt: 0, cancel: 0, workspaceCreate: 0, attachment: 0 };
	const createPayloads = [];
	const promptCalls = [];
	const promptModes = [];
	const respondCalls = [];
	// host 进程状态（断连自愈测试用）：triggerExit 模拟崩溃，restartHost 模拟自动重启完成。
	const hostState = { running: true, ready: true };
	const muxCalls = [];
	// 可中途注入的 mux 帧队列（abort 竞态测试用：先注入 turn/start+chunk，
	// abort 之后再注入旧回合残留帧，模拟 host 侧 cancel 收尾）。
	const frameQueue = [...muxFrames];
	let nextBatchResolve = null;
	let streamDone = false;
	const client = {
		sessions: {			async list() {
				calls.list += 1;
				return { result: { ok: true, value: { items: [...sessions.values()] } } };
			},
			async create(payload) {
				calls.create += 1;
				createPayloads.push(payload);
				// 与官方 schema 对齐：workspaceId 与 cwd 二选一；本夹具拒绝 cwd-only，
				// 锁住「只传 cwd 会进 dsh-web 未分组」这条兼容红线。
				if (payload?.workspaceId !== undefined && payload?.cwd !== undefined) {
					return { result: { ok: false, error: { code: "bad-request", message: "workspaceId and cwd are mutually exclusive" } } };
				}
				if (!payload?.workspaceId) {
					return { result: { ok: false, error: { code: "ungrouped", message: "cwd-only create leaves the session Ungrouped" } } };
				}
				const sessionId = `session-fake-${++nextSession}`;
				const cwd = String(payload.workspaceId).startsWith("ws:")
					? String(payload.workspaceId).slice(3)
					: PROJECT.path;
				// host 行为：agentPreset 随 sessions.create 提交，解析后写入会话 header
				//（list 行返回；预选 id 无效时 host 回退部署默认并返回解析值）。
				const summary = {
					sessionId,
					cwd,
					running: false,
					blank: true,
					...(payload?.agentPreset ? { agentPreset: payload.agentPreset } : {}),
				};
				sessions.set(sessionId, summary);
				return { result: { ok: true, value: summary } };
			},
			async history({ sessionId, beforeSeq, maxMessages }) {
				calls.history += 1;
				const log = historyBySession.get(sessionId) ?? [];
				// 与 DSH 官方 pageOf 同语义：end = beforeSeq 缺失时取末尾（排除边界，
				// 返回 seq < beforeSeq 的事件）；从 end 往前数 maxMessages 条消息，
				// 在最近一个 turn/start 处切页；hasMore = 起点之前还有事件。
				const end = beforeSeq === undefined ? log.length : Math.max(0, Math.min(beforeSeq, log.length));
				let start = 0;
				let messages = 0;
				for (let i = end - 1; i >= 0; i -= 1) {
					const item = log[i];
					if (item?.type === "user/message" || item?.type === "assistant/message") messages += 1;
					if (item?.type === "turn/start" && messages >= maxMessages) {
						start = i;
						break;
					}
				}
				return {
					result: {
						ok: true,
						value: {
							events: log.slice(start, end).map((entry) => ({ event: entry })),
							hasMore: start > 0,
							...(historyProjections.has(sessionId)
								? { projections: historyProjections.get(sessionId) }
								: {}),
						},
					},
				};
			},
			async attachment({ sessionId, attachmentId }) {
				calls.attachment += 1;
				const value = attachments.get(`${sessionId}:${attachmentId}`);
				if (!value) {
					return { result: { ok: false, error: { code: "attachment-error", message: "missing" } } };
				}
				return { result: { ok: true, value } };
			},
			async prompt({ content, mode }) {
				calls.prompt += 1;
				promptCalls.push(content?.[0]?.text ?? "");
				promptModes.push(mode ?? "queue");
				return { result: { ok: true, value: { accepted: true } } };
			},
			async cancel() {
				calls.cancel += 1;
				return { result: { ok: true, value: {} } };
			},
			async rename({ title }) {
				return { result: { ok: true, value: { title } } };
			},
			async models() {
				return { result: { ok: true, value: modelsValue ?? { groups: [] } } };
			},
			async selectModel({ provider, model }) {
				return { result: { ok: true, value: { selected: { provider, model } } } };
			},
			async fork({ sessionId, atSeq }) {
				calls.fork += 1;
				// 模拟 fork：生成新 sessionId，并把 atSeq 前的历史带过去
				const newId = `session-forked-${sessionId}-${atSeq}`;
				sessions.set(newId, { sessionId: newId, cwd: PROJECT.path, running: false, blank: false });
				const source = historyBySession.get(sessionId) ?? [];
				historyBySession.set(newId, source.filter((item) => (item.seq ?? 0) <= atSeq));
				return { result: { ok: true, value: { sessionId: newId } } };
			},
		},
			events: {
				async *mux(_input, signal) {
					muxCalls.push(Date.now());
					// 可注入帧队列：初始帧（muxFrames）先放行，之后每次 pushFrames 补一批；
					// abortAllPending（host 崩溃）置 streamDone 结束生成器（同真实桥中断语义）。
					// 每次订阅都是新流：重置 streamDone，否则重连后的生成器会立即结束，
					// pump 陷入「订阅→立即结束→退避→再订阅」的无限定时器循环。
					streamDone = false;
					while (!streamDone) {
						while (frameQueue.length > 0) yield frameQueue.shift();
						if (signal?.aborted) return;
						await new Promise((resolve) => {
							nextBatchResolve = resolve;
							signal?.addEventListener("abort", resolve, { once: true });
						});
						if (signal?.aborted) return;
					}
				},
			},
			/** 测试注入：向运行中的 mux 流补发帧（模拟 host 后续推送）。 */
			pushFrames(...frames) {
				frameQueue.push(...frames);
				nextBatchResolve?.();
				nextBatchResolve = null;
			},
			abortAllPending() {
				// 同 DshApiClient.abortAllPending：中断悬挂的 mux 流（error 语义）。
				streamDone = true;
				nextBatchResolve?.();
				nextBatchResolve = null;
			},
			async respond(input) {
			if (failRespond) throw new Error("host not started");
			respondCalls.push(input);
			return { result: { ok: true, value: {} } };
		},
		llm: {
			async models() {
				return { result: { ok: true, value: { groups: [] } } };
			},
		},
		workspace: {
			async create({ path }) {
				calls.workspaceCreate += 1;
				if (!path) {
					return { result: { ok: false, error: { code: "bad-request", message: "path required" } } };
				}
				return {
					result: {
						ok: true,
						value: {
							workspace: { workspaceId: `ws:${path}`, path, sessionIds: [] },
							created: false,
						},
					},
				};
			},
		},
	};
	// 0.1.5 适配层形状（DshRemoteClient）：manager 调扁平方法；事件走
	// openEvents（审批/提问瀑布 + 测试注入帧）与 sessionsFollow（空流，
	// 测试帧统一经 openEvents 派发，dispatchMuxFrame 按 payload.type 分发）。
	Object.assign(client, {
		// 动态委托：测试用例可在 create 后覆写 sessions.selectModel 等方法，
		// 扁平方法每次调用时重新查 nested 槽位（bind 直接引用会让覆写失效）。
		sessionsList(...args) { return client.sessions.list(...args); },
		sessionsCreate(...args) { return client.sessions.create(...args); },
		sessionsHistory(...args) { return client.sessions.history(...args); },
		sessionsAttachment(...args) { return client.sessions.attachment(...args); },
		sessionsPrompt(...args) { return client.sessions.prompt(...args); },
		sessionsCancel(...args) { return client.sessions.cancel(...args); },
		sessionsRename(...args) { return client.sessions.rename(...args); },
		sessionsModelCatalog(...args) { return client.sessions.models(...args); },
		sessionsSelectModel(...args) { return client.sessions.selectModel(...args); },
		sessionsFork(...args) { return client.sessions.fork(...args); },
		async *openEvents(signal) {
			muxCalls.push(Date.now());
			streamDone = false;
			while (!streamDone) {
				while (frameQueue.length > 0) yield frameQueue.shift();
				if (signal?.aborted) return;
				await new Promise((resolve) => {
					nextBatchResolve = resolve;
					signal?.addEventListener("abort", resolve, { once: true });
				});
				if (signal?.aborted) return;
			}
		},
		async *sessionsFollow(_input, signal) {
			while (!signal?.aborted) {
				// unref：pump 的等待定时器不能阻止测试进程正常退出。
				await new Promise((resolve) => {
					const timer = setTimeout(resolve, 50);
					if (typeof timer.unref === "function") timer.unref();
					signal?.addEventListener("abort", () => resolve(), { once: true });
				});
			}
		},
	});
	const host = {
		async ensureStarted() {},
		getClient() {
			return client;
		},
		/** 官方路径：workspace.create({path}) 幂等解析，失败才返回 undefined。 */
		async resolveWorkspaceId(cwd) {
			const resolved = await client.workspace.create({ path: cwd });
			if (!resolved.result.ok) return undefined;
			return resolved.result.value.workspace.workspaceId;
		},
		onHostReady() {
			// E4 恢复钩子：测试中不触发恢复逻辑，直接返回退订函数。
			return () => {};
		},
		isHostProcessRunning() {
			return hostState.running;
		},
		isHostReady() {
			return hostState.ready;
		},
		getHomeDir() {
			return "C:\\fake-dsh-home";
		},
		/** 冷读会话 cursor（0.1.5 session/page 的 throughSeq 来源）：夹具按日志长度模拟。 */
		async readSessionCursor(sessionId) {
			const log = historyBySession.get(sessionId) ?? [];
			return log.length - 1;
		},
		/** 模拟 host 进程退出（崩溃）：置位 + 中断在途 mux，同 DshHost 的 exit → abortAllPending 联动。 */
		triggerExit() {
			hostState.running = false;
			hostState.ready = false;
			client.abortAllPending();
		},
		/** 模拟崩溃自动重启完成（DshHostProcess.restartAfterCrash → host-ready）。 */
		restartHost() {
			hostState.running = true;
			hostState.ready = true;
		},
	};
	return { host, client, sessions, historyBySession, historyProjections, attachments, calls, createPayloads, promptCalls, promptModes, respondCalls, muxCalls };
}

/**
 * 模拟 host 懒启动（冷启动）：getClient 返回 null，ensureStarted 后才就绪。
 * 回归锚点：readHistoryPage 是唯一不经 runtime 激活、按 catalog dshSessionId
 * 直接读 host 历史的入口（渲染层打开会话的首屏分页），冷启动时必须先
 * ensureStarted（等 boot）而不是 requireClient 直接抛错——否则聊天区域
 * 表现为「历史消息没加载」（空白），会话里其实有消息。
 */
function makeColdStartHost() {
	const inner = makeFakeHost();
	let started = false;
	const host = {
		async ensureStarted() {
			started = true;
			await inner.host.ensureStarted();
		},
		getClient() {
			return started ? inner.client : null;
		},
		isHostProcessRunning() {
			return inner.host.isHostProcessRunning();
		},
		isHostReady() {
			return inner.host.isHostReady();
		},
		onHostReady() {
			return () => {};
		},
		async resolveWorkspaceId(cwd) {
			await this.ensureStarted();
			return inner.host.resolveWorkspaceId(cwd);
		},
		/** 冷读 cursor 与桥同步：真实 DshHost.bridgeRpc 先 ensureStarted，冷启动下同样要等。 */
		async readSessionCursor(sessionId) {
			await this.ensureStarted();
			return inner.host.readSessionCursor(sessionId);
		},
	};
	// 冷启动 host 必须最后展开：inner 里也带 host 键（fake host，getClient 恒返回 client），
	// 若先展开 host 会被 inner 覆盖 → 测试拿到的是「温 host」，冷启动回归永远测不到。
	return { ...inner, host };
}

/** 让 pump/respond 等异步链全部落盘（循环 setImmediate 而非定时器，测试更稳）。 */
async function flush() {
	for (let i = 0; i < 10; i += 1) {
		await new Promise((resolve) => setImmediate(resolve));
	}
}

/** 与 DSH mux 实测一致的 approval/requested 帧。 */
const approvalFrame = (rpcId, sessionId, approvalId, extra = {}) => ({
	rpcId,
	payload: { type: "approval/requested", sessionId, approvalId, ...extra },
});

const PROJECT = { id: "project-1", path: "C:\\work" };

/** 构造与 DSH 实测一致的 SessionEvent。 */
const event = (type, seq, data = {}) => ({ type, seq, time: 1700000000000 + seq, data });

test("第二个 runtime 的 follow 泵也必须创建（共享 mux 已在跑不得提前 return）", async () => {
	// 回归（2026-09-12）：startMux 的 ensureFollowPump 曾放在共享 mux 启动路径里，
	// 第二个会话 startMux 时 mux 已在跑、提前 return 把 follow 泵整个吞掉——
	// 0.1.5 会话 journal 事件只走 follow 泵，于是新会话发送后 host 正常跑完回合
	// 但 PiDeck 收不到任何事件（无流式、无收口、无报错，页面空白）。
	const { host, client } = makeFakeHost();
	let followOpens = 0;
	const innerFollow = client.sessionsFollow.bind(client);
	client.sessionsFollow = (...args) => {
		followOpens += 1;
		return innerFollow(...args);
	};
	const manager = new DshAgentManager(host, () => PROJECT);
	const first = await manager.create({ projectId: "project-1", backend: "dsh" });
	const second = await manager.create({ projectId: "project-1", backend: "dsh" });
	assert.notEqual(first.id, second.id);
	assert.equal(followOpens, 2, "每个 runtime 各开一条 session/follow 泵");
});

test("create 新建 DSH 会话并注册 runtime（无 dshSessionId 时）", async () => {
	const { host, calls, createPayloads } = makeFakeHost();
	const manager = new DshAgentManager(host, () => PROJECT);
	const tab = await manager.create({ projectId: "project-1", backend: "dsh" });
	assert.equal(calls.create, 1);
	assert.equal(calls.workspaceCreate, 1, "必须先走官方 workspace.create({path})");
	// vm 上下文对象与测试字面量 prototype 不同，deepStrictEqual 会误报
	assert.equal(createPayloads[0].workspaceId, `ws:${PROJECT.path}`);
	assert.equal(createPayloads[0].cwd, undefined, "不得再传 cwd，否则会进 dsh-web 未分组");
	assert.match(tab.id, /^dsh:session-fake-/);
	assert.equal(tab.backend, "dsh");
	assert.equal(manager.list().length, 1);
	assert.equal(manager.getMessages(tab.id).length, 0, "新建会话无历史");
});

// 修复：上一个 test 此前缺少收尾 `});`，导致下面两个用例被吞成它的嵌套子测试
// 并在父测试结束时被 cancel（node:test 报 cancelledByParent）。
test("create 携带草稿期预选的 agentPreset 随 sessions.create 提交并回读解析值", async () => {
	const { host, calls, createPayloads } = makeFakeHost();
	const manager = new DshAgentManager(host, () => PROJECT);
	const tab = await manager.create({
		projectId: "project-1",
		backend: "dsh",
		agentPreset: "code",
	});
	assert.equal(calls.create, 1);
	// 预选必须随 create 提交给 host（preset 决定会话工具与提示，创建即固定）
	assert.equal(createPayloads[0].agentPreset, "code");
	// host 把解析后的 preset 写进会话 header 并在响应里返回 → tab 携带，供回写 catalog
	assert.equal(tab.agentPreset, "code");
});

test("attach 已有会话时从 host list 行读回实际 agentPreset（以 host 为准）", async () => {
	const { host, sessions, calls } = makeFakeHost();
	// host 侧已存在的会话：header 持久化了 minimal（外部 dsh-web 创建）
	sessions.set("session-preset-1", {
		sessionId: "session-preset-1",
		cwd: PROJECT.path,
		running: false,
		blank: false,
		agentPreset: "minimal",
	});
	const manager = new DshAgentManager(host, () => PROJECT);
	const tab = await manager.create({
		projectId: "project-1",
		backend: "dsh",
		dshSessionId: "session-preset-1",
		// 草稿期预选与 host 不一致时，attach 必须用 host 实际值（不允许事后改 preset）
		agentPreset: "standard",
	});
	assert.equal(calls.create, 0, "attach 路径不新建 host 会话");
	assert.equal(tab.sessionId, "session-preset-1");
	assert.equal(tab.agentPreset, "minimal");
});

test("create 在 workspace 解析失败时不得降级为 cwd-only（会进 dsh-web 未分组）", async () => {
	const { host } = makeFakeHost();
	host.resolveWorkspaceId = async () => undefined;
	const manager = new DshAgentManager(host, () => PROJECT);
	await assert.rejects(
		() => manager.create({ projectId: "project-1", backend: "dsh" }),
		/workspace\.resolve failed/,
	);
});

test("create 带 dshSessionId 且 host 存在该会话：attach 不新建", async () => {
	const { host, sessions, historyBySession, calls } = makeFakeHost();
	// 预置 host 里已存在的会话（模拟上次运行创建、本次重启后 attach）
	sessions.set("session-old-1", { sessionId: "session-old-1", cwd: PROJECT.path, running: false, blank: false });
	historyBySession.set("session-old-1", [
		event("user/message", 1, {
			content: [{ type: "text", text: "上一轮的提问" }],
			source: { kind: "user", rpcId: "rpc-1" },
		}),
		event("turn/start", 2),
		event("assistant/message", 3, {
			message: { content: [{ type: "text", text: "上一轮的回复" }] },
		}),
	]);
	const manager = new DshAgentManager(host, () => PROJECT);
	const tab = await manager.create({ projectId: "project-1", backend: "dsh", dshSessionId: "session-old-1" });
	assert.equal(calls.create, 0, "attach 路径不得新建 host 会话");
	assert.equal(tab.id, "dsh:session-old-1");
	// 历史尾部被投影为初始消息（真实对话可见）
	const messages = manager.getMessages(tab.id);
	assert.equal(messages.length, 2);
	assert.equal(messages[0].role, "user");
	assert.equal(messages[0].text, "上一轮的提问");
	assert.equal(messages[1].role, "assistant");
	assert.equal(messages[1].text, "上一轮的回复");
	assert.equal(calls.history, 1);
});

test("create attach 时回填 DSH canonical 图片 attachment（历史主界面可显示）", async () => {
	const { host, sessions, historyBySession, attachments, calls } = makeFakeHost();
	sessions.set("session-img-1", { sessionId: "session-img-1", cwd: PROJECT.path, running: false, blank: false });
	historyBySession.set("session-img-1", [
		event("user/message", 1, {
			content: [
				{ type: "text", text: "看图" },
				{ type: "image", attachment: { attachmentId: "att-123", mediaType: "image/png", bytes: 5, width: 1, height: 1 } },
			],
			source: { kind: "user", rpcId: "rpc-1" },
		}),
	]);
	attachments.set("session-img-1:att-123", {
		attachment: { attachmentId: "att-123", mediaType: "image/png", bytes: 5, width: 1, height: 1 },
		data: "aGVsbG8=",
	});
	const manager = new DshAgentManager(host, () => PROJECT);
	const tab = await manager.create({ projectId: "project-1", backend: "dsh", dshSessionId: "session-img-1" });
	const messages = manager.getMessages(tab.id);
	assert.equal(messages.length, 1);
	assert.equal(messages[0].images?.length, 1);
	assert.equal(messages[0].images?.[0].type, "image");
	assert.equal(messages[0].images?.[0].mimeType, "image/png");
	assert.equal(messages[0].images?.[0].data, "aGVsbG8=");
	assert.equal(calls.attachment, 1);
});

test("create 带 dshSessionId 但 host 已无该会话：退回新建", async () => {
	const { host, calls } = makeFakeHost();
	const manager = new DshAgentManager(host, () => PROJECT);
	const tab = await manager.create({
		projectId: "project-1",
		backend: "dsh",
		dshSessionId: "session-gone-9",
	});
	assert.equal(calls.create, 1, "host 找不到持久化 id 时必须新建");
	assert.notEqual(tab.id, "dsh:session-gone-9");
	assert.equal(manager.getMessages(tab.id).length, 0);
});

test("create attach 历史投影过滤注入上下文（source.kind=agent-instructions 不上屏）", async () => {
	const { host, sessions, historyBySession } = makeFakeHost();
	sessions.set("session-old-2", { sessionId: "session-old-2", cwd: PROJECT.path, running: false, blank: false });
	historyBySession.set("session-old-2", [
		event("user/message", 1, {
			content: [{ type: "text", text: "提问" }],
			source: { kind: "user", rpcId: "rpc-2" },
		}),
		// 工作区上下文注入：不应出现在时间线
		event("user/message", 2, {
			content: [{ type: "text", text: "<system-reminder>AGENTS.md…" }],
			source: { kind: "agent-instructions", form: "instructions", baseline: true },
		}),
		event("assistant/message", 3, {
			message: { content: [{ type: "text", text: "回复" }] },
		}),
	]);
	const manager = new DshAgentManager(host, () => PROJECT);
	const tab = await manager.create({ projectId: "project-1", backend: "dsh", dshSessionId: "session-old-2" });
	const messages = manager.getMessages(tab.id);
	assert.equal(messages.length, 2, "注入上下文不得投影为用户消息");
	assert.equal(messages[0].text, "提问");
	assert.equal(messages[1].text, "回复");
	assert.equal(messages[0].role, "user");
	assert.equal(messages[1].role, "assistant");
});

test("readHistoryPage 对齐渲染层 disk 分页协议（seq 游标、hasMore 边界）", async () => {
	const { host, sessions, historyBySession, calls } = makeFakeHost();
	sessions.set("session-hist-1", { sessionId: "session-hist-1", cwd: PROJECT.path, running: false, blank: false });
	// 4 轮对话（turn/start + user + assistant），seq 1..12：
	//   [1 turn/start, 2 问1, 3 答1] [4 turn/start, 5 问2, 6 答2]
	//   [7 turn/start, 8 问3, 9 答3] [10 turn/start, 11 问4, 12 答4]
	const history = [];
	const turns = [
		[1, 2, 3],
		[4, 5, 6],
		[7, 8, 9],
		[10, 11, 12],
	];
	for (const [turnSeq, userSeq, assistantSeq] of turns) {
		history.push(event("turn/start", turnSeq));
		history.push(event("user/message", userSeq, {
			content: [{ type: "text", text: `问${userSeq}` }],
			source: { kind: "user", rpcId: `rpc-${userSeq}` },
		}));
		history.push(event("assistant/message", assistantSeq, {
			message: { content: [{ type: "text", text: `答${assistantSeq}` }] },
		}));
	}
	historyBySession.set("session-hist-1", history);
	const manager = new DshAgentManager(host, () => PROJECT);
	// 首页：beforeSeq undefined → 尾部 4 条消息（问8 答9 问11 答12，seq 7..12）
	const page1 = await manager.readHistoryPage("session-hist-1", undefined, 4);
	assert.equal(page1.messages.length, 4);
	assert.equal(page1.messages[0].text, "问8");
	assert.equal(page1.messages[3].text, "答12");
	assert.equal(typeof page1.nextBefore, "number", "还有更早历史时 nextBefore 是数字游标");
	assert.equal(page1.total, -1, "DSH 无总条数概念，返回 -1 占位");
	// 翻页：beforeSeq = 本页最旧事件 seq（排除边界，seq < beforeSeq 的事件）
	const page2 = await manager.readHistoryPage("session-hist-1", page1.nextBefore, 4);
	assert.equal(page2.messages.length, 4);
	assert.equal(page2.messages[0].text, "问2");
	assert.equal(page2.messages[3].text, "答6");
	assert.equal(page2.nextBefore, null, "8 条消息两页取尽，到尾页 hasMore=false → nextBefore=null");
	assert.equal(calls.history, 2);
});

test("readHistoryPage 空会话返回空页且 nextBefore=null", async () => {
	const { host, sessions } = makeFakeHost();
	sessions.set("session-empty", { sessionId: "session-empty", cwd: PROJECT.path, running: false, blank: true });
	const manager = new DshAgentManager(host, () => PROJECT);
	const page = await manager.readHistoryPage("session-empty", undefined, 100);
	assert.equal(page.messages.length, 0);
	assert.equal(page.nextBefore, null);
	assert.equal(page.total, -1);
});

test("readSystemPrompt：运行时会话返回 attach 重放缓存的系统提示（request/header 折叠）", async () => {
	const { host, sessions, historyBySession } = makeFakeHost();
	sessions.set("session-old-9", { sessionId: "session-old-9", cwd: PROJECT.path, running: false, blank: false });
	historyBySession.set("session-old-9", [
		event("request/header", 1, {
			header: { system: "你是 DSH 代理。\n## 准则\n…" },
			reason: { kind: "steer", step: 1 },
		}),
		event("user/message", 2, {
			content: [{ type: "text", text: "提问" }],
			source: { kind: "user", rpcId: "rpc-9" },
		}),
		event("turn/start", 3),
		event("assistant/message", 4, {
			message: { content: [{ type: "text", text: "回复" }] },
		}),
	]);
	const manager = new DshAgentManager(host, () => PROJECT);
	const tab = await manager.create({ projectId: "project-1", backend: "dsh", dshSessionId: "session-old-9" });
	// attach 重放后：运行时会话直接读 runtime 缓存（不重复拉 history）
	const prompt = await manager.readSystemPrompt(tab.id, "session-old-9");
	assert.equal(prompt, "你是 DSH 代理。\n## 准则\n…");
});

test("readSystemPrompt：历史会话从 host history 折叠最后一个 request/header", async () => {
	const { host, sessions, historyBySession } = makeFakeHost();
	sessions.set("session-hist-9", { sessionId: "session-hist-9", cwd: PROJECT.path, running: false, blank: false });
	historyBySession.set("session-hist-9", [
		event("request/header", 1, { header: { system: "第一版提示" } }),
		event("user/message", 2, {
			content: [{ type: "text", text: "提问" }],
			source: { kind: "user", rpcId: "rpc-9" },
		}),
		event("assistant/message", 3, {
			message: { content: [{ type: "text", text: "回复" }] },
		}),
		// 模型切换后第二次请求：last wins
		event("request/header", 4, { header: { system: "第二版提示" } }),
		event("user/message", 5, {
			content: [{ type: "text", text: "追问" }],
			source: { kind: "user", rpcId: "rpc-10" },
		}),
		event("assistant/message", 6, {
			message: { content: [{ type: "text", text: "回复 2" }] },
		}),
	]);
	const manager = new DshAgentManager(host, () => PROJECT);
	// 未激活会话（agentId undefined）：走 host history 折叠
	const prompt = await manager.readSystemPrompt(undefined, "session-hist-9");
	assert.equal(prompt, "第二版提示");
});

test("readSystemPrompt：无 request/header / 无 host 时返回 undefined（不阻断轨迹）", async () => {
	const { host, sessions, historyBySession } = makeFakeHost();
	sessions.set("session-no-hdr", { sessionId: "session-no-hdr", cwd: PROJECT.path, running: false, blank: false });
	historyBySession.set("session-no-hdr", [
		event("user/message", 1, {
			content: [{ type: "text", text: "提问" }],
			source: { kind: "user", rpcId: "rpc-1" },
		}),
		event("assistant/message", 2, {
			message: { content: [{ type: "text", text: "回复" }] },
		}),
	]);
	const manager = new DshAgentManager(host, () => PROJECT);
	assert.equal(await manager.readSystemPrompt(undefined, "session-no-hdr"), undefined);
	// host 无该会话：history 返回空页 → undefined（不抛错）
	assert.equal(await manager.readSystemPrompt(undefined, "session-missing-9"), undefined);
	assert.equal(await manager.readSystemPrompt(undefined, undefined), undefined);
});

test("readHistoryPage host 冷启动：先 ensureStarted 等 boot，不抛「DSH host is not started」", async () => {
	const { host, sessions, historyBySession, calls } = makeColdStartHost();
	sessions.set("session-cold-1", { sessionId: "session-cold-1", cwd: PROJECT.path, running: false, blank: false });
	historyBySession.set("session-cold-1", [
		event("user/message", 1, {
			content: [{ type: "text", text: "重启前的提问" }],
			source: { kind: "user", rpcId: "rpc-1" },
		}),
		event("assistant/message", 2, {
			message: { content: [{ type: "text", text: "重启前的回复" }] },
		}),
	]);
	const manager = new DshAgentManager(host, () => PROJECT);
	// 冷启动打开会话：渲染层首屏拉历史页 → host 未 boot → 必须等 ensureStarted 而不是抛错
	const page = await manager.readHistoryPage("session-cold-1", undefined, 100);
	assert.equal(page.messages.length, 2, "冷启动历史页必须返回会话消息");
	assert.equal(page.messages[0].text, "重启前的提问");
	assert.equal(page.messages[1].text, "重启前的回复");
	assert.equal(calls.history, 1);
});

test("create attach 从 list 投影取 host 标题（侧栏显示真实标题而非 draft 占位名）", async () => {
	const { host, sessions, historyBySession } = makeFakeHost();
	sessions.set("session-old-1", {
		sessionId: "session-old-1",
		cwd: PROJECT.path,
		running: false,
		blank: false,
		// dsh-session-title 的 fold 投影：session.list 行携带最新标题
		projections: { asOfSeq: 10, values: { title: "打包的体积是否能优化一下呢" } },
	});
	historyBySession.set("session-old-1", []);
	const titles = [];
	const manager = new DshAgentManager(host, () => PROJECT, undefined, (dshSessionId, title) => {
		titles.push([dshSessionId, title]);
	});
	const tab = await manager.create({
		projectId: "project-1",
		backend: "dsh",
		dshSessionId: "session-old-1",
		title: "pi-desktop DSH",
	});
	assert.equal(tab.title, "打包的体积是否能优化一下呢", "attach 后 tab 标题应为 host 真实标题");
	assert.deepEqual(titles, [["session-old-1", "打包的体积是否能优化一下呢"]], "标题初值应通知 catalog 同步");
});

test("mux session/title 事件实时更新 tab 标题并通知 catalog 同步", async () => {
	const { host } = makeFakeHost({
		muxFrames: [
			sessionEventFrame("session-fake-1", event("session/title", 5, { title: "帮我看看这个报错" })),
		],
	});
	const emitted = [];
	const titles = [];
	const manager = new DshAgentManager(host, () => PROJECT, undefined, (dshSessionId, title) => {
		titles.push([dshSessionId, title]);
	});
	manager.onOutput((channel, payload) => emitted.push([channel, payload]));
	const tab = await manager.create({ projectId: "project-1", backend: "dsh" });
	await flush();
	assert.equal(tab.title, "帮我看看这个报错", "session/title 事件应更新 runtime tab 标题");
	assert.deepEqual(titles, [["session-fake-1", "帮我看看这个报错"]], "标题变化应通知 catalog 同步");
	const state = emitted.filter(([channel]) => channel === "agents:state");
	assert.equal(state.length, 2, "create 全量 + 标题变化各推一次 agents:state");
	assert.equal(state.at(-1)[1][0].title, "帮我看看这个报错", "标题变化推送应带新标题");
});

test("getForkMessages 收集用户消息并以 seq 编码 entryId", async () => {
	const { host, sessions, historyBySession } = makeFakeHost();
	sessions.set("session-fork-src", { sessionId: "session-fork-src", cwd: PROJECT.path, running: false, blank: false });
	historyBySession.set("session-fork-src", [
		event("turn/start", 1),
		event("user/message", 2, {
			content: [{ type: "text", text: "第一问" }],
			source: { kind: "user", rpcId: "rpc-1" },
		}),
		event("assistant/message", 3, { message: { content: [{ type: "text", text: "答1" }] } }),
		event("turn/start", 4),
		event("user/message", 5, {
			content: [{ type: "text", text: "第二问" }],
			source: { kind: "user", rpcId: "rpc-2" },
		}),
		event("assistant/message", 6, { message: { content: [{ type: "text", text: "答2" }] } }),
	]);
	const manager = new DshAgentManager(host, () => PROJECT);
	const tab = await manager.create({ projectId: "project-1", backend: "dsh", dshSessionId: "session-fork-src" });
	const forkMessages = await manager.getForkMessages(tab.id);
	assert.equal(forkMessages.length, 2);
	assert.equal(forkMessages[0].entryId, "seq:2");
	assert.equal(forkMessages[0].text, "第一问");
	assert.equal(forkMessages[1].entryId, "seq:5");
	assert.equal(forkMessages[1].text, "第二问");
});

test("forkSession 在 atSeq 裁剪出新会话并换绑 runtime", async () => {
	const { host, sessions, historyBySession, calls } = makeFakeHost();
	sessions.set("session-fork-src", { sessionId: "session-fork-src", cwd: PROJECT.path, running: false, blank: false });
	historyBySession.set("session-fork-src", [
		event("turn/start", 1),
		event("user/message", 2, {
			content: [{ type: "text", text: "第一问" }],
			source: { kind: "user", rpcId: "rpc-1" },
		}),
		event("assistant/message", 3, { message: { content: [{ type: "text", text: "答1" }] } }),
		event("turn/start", 4),
		event("user/message", 5, {
			content: [{ type: "text", text: "第二问" }],
			source: { kind: "user", rpcId: "rpc-2" },
		}),
		event("assistant/message", 6, { message: { content: [{ type: "text", text: "答2" }] } }),
	]);
	const manager = new DshAgentManager(host, () => PROJECT);
	const tab = await manager.create({ projectId: "project-1", backend: "dsh", dshSessionId: "session-fork-src" });
	assert.equal(tab.sessionId, "session-fork-src");

	// 从「第一问」(seq:2) fork：新会话只带 seq ≤ 2 的历史
	const result = await manager.forkSession(tab.id, "seq:2");
	assert.equal(calls.fork, 1);
	assert.equal(result.text, "第一问", "fork 返回被 fork 的用户消息文本（渲染层预填输入框）");
	// runtime 换绑：agentId 不变，sessionId 指向新 fork 会话
	const newTab = manager.list().find((candidate) => candidate.id === tab.id);
	assert.ok(newTab, "fork 后 agentId 保持存在");
	assert.notEqual(newTab.sessionId, "session-fork-src");
	assert.match(newTab.sessionId, /^session-forked-/);
	// 新会话历史 = fork 点前内容（seq 1..2）
	const messages = manager.getMessages(tab.id);
	assert.equal(messages.length, 1);
	assert.equal(messages[0].text, "第一问");
	// 旧会话不再被 runtime 持有（可从 catalog 重新打开）
	assert.equal(manager.list().length, 1);
});

test("forkSession 拒绝非法 entryId", async () => {
	const { host, sessions } = makeFakeHost();
	sessions.set("session-fork-bad", { sessionId: "session-fork-bad", cwd: PROJECT.path, running: false, blank: true });
	const manager = new DshAgentManager(host, () => PROJECT);
	const tab = await manager.create({ projectId: "project-1", backend: "dsh", dshSessionId: "session-fork-bad" });
	await assert.rejects(() => manager.forkSession(tab.id, "not-a-seq"));
	await assert.rejects(() => manager.forkSession(tab.id, "seq:abc"));
});

test("compact 以 /compact 提示词触发 host 命令并返回 runtime state", async () => {
	const { host, client, sessions, calls, promptCalls } = makeFakeHost();
	sessions.set("session-compact", { sessionId: "session-compact", cwd: PROJECT.path, running: false, blank: false });
	const manager = new DshAgentManager(host, () => PROJECT);
	const tab = await manager.create({ projectId: "project-1", backend: "dsh", dshSessionId: "session-compact" });
	const state = await manager.compact(tab.id);
	assert.equal(calls.prompt, 1);
	assert.equal(promptCalls[0], "/compact", "无参 compact 发送裸 /compact");
	assert.equal(state.isStreaming, false);
	assert.equal(state.isCompacting, true);
	await assert.rejects(
		() => manager.compact(tab.id, "keep focus on refactor"),
		/already compacting/,
		"压缩进行中拒绝第二次 compact，避免拼进命令回合",
	);
	assert.equal(calls.prompt, 1, "拒绝重复 compact 不得再发 prompt");
	client.pushFrames(sessionEventFrame("session-compact", event("turn/end", 1)));
	await flush();
	assert.equal((await manager.getRuntimeState(tab.id)).isCompacting, false);
	await manager.compact(tab.id, "keep focus on refactor");
	assert.equal(calls.prompt, 2);
	assert.equal(promptCalls[1], "/compact keep focus on refactor");
});

test("capabilities 声明 fork/getForkMessages/compact/getCommands/exportHtml 且不含 pi 专属能力", () => {
	const { host, sessions } = makeFakeHost();
	sessions.set("session-cap", { sessionId: "session-cap", cwd: PROJECT.path, running: false, blank: true });
	const manager = new DshAgentManager(host, () => PROJECT);
	const caps = manager.capabilities;
	assert.ok(caps.has("fork"));
	assert.ok(caps.has("getForkMessages"));
	assert.ok(caps.has("compact"));
	// D15：host 命令注册表枚举桥；G10：投影式导出（两者均为 S6 新增能力）
	assert.ok(caps.has("getCommands"));
	assert.ok(caps.has("exportHtml"));
	assert.ok(!caps.has("editMessage"), "DSH 不支持编辑历史消息");
	assert.ok(!caps.has("deleteMessage"));
});

test("审批自动放行开启：approval 帧直接应答 allowed-once，不弹 agents:ui-request", async () => {
	const { host, respondCalls } = makeFakeHost({
		muxFrames: [approvalFrame("rpc-1", "session-fake-1", "appr-1", { toolName: "shell" })],
	});
	const emitted = [];
	const manager = new DshAgentManager(host, () => PROJECT, () => true);
	manager.onOutput((channel, payload) => emitted.push([channel, payload]));
	await manager.create({ projectId: "project-1", backend: "dsh" });
	await flush();
	// 注意：respondCalls 里的对象来自 VM 编译的 DshAgentManager（跨 realm），
	// deepStrictEqual 会因 prototype 不同报 "not reference-equal"，故分字段断言。
	assert.equal(respondCalls.length, 1);
	assert.equal(respondCalls[0].type, "client-response");
	assert.equal(respondCalls[0].rpcId, "rpc-1");
	assert.equal(respondCalls[0].result.ok, true);
	const value = respondCalls[0].result.value;
	assert.equal(value.sessionId, "session-fake-1");
	assert.equal(value.approvalId, "appr-1");
	assert.equal(value.outcome, "allowed-once");
	assert.equal(
		emitted.some(([channel]) => channel === "agents:ui-request"),
		false,
		"自动放行时不弹审批 UI",
	);
});

test("审批自动放行关闭（缺省）：approval 帧走人工审批（弹 UI、不 respond）", async () => {
	const { host, respondCalls } = makeFakeHost({
		muxFrames: [approvalFrame("rpc-2", "session-fake-1", "appr-2")],
	});
	const emitted = [];
	const manager = new DshAgentManager(host, () => PROJECT);
	manager.onOutput((channel, payload) => emitted.push([channel, payload]));
	const tab = await manager.create({ projectId: "project-1", backend: "dsh" });
	await flush();
	assert.equal(respondCalls.length, 0, "人工审批路径不应自动应答");
	const ui = emitted.find(([channel]) => channel === "agents:ui-request");
	assert.ok(ui, "应弹 agents:ui-request");
	assert.equal(ui[1].agentId, tab.id);
	assert.equal(ui[1].method, "confirm");
	assert.equal(ui[1].requestId, "rpc-2");
});

test("审批自动放行失败（host 通道异常）：回退人工审批避免请求丢失", async () => {
	const { host, respondCalls } = makeFakeHost({
		muxFrames: [approvalFrame("rpc-3", "session-fake-1", "appr-3")],
		failRespond: true,
	});
	const emitted = [];
	const manager = new DshAgentManager(host, () => PROJECT, () => true);
	manager.onOutput((channel, payload) => emitted.push([channel, payload]));
	await manager.create({ projectId: "project-1", backend: "dsh" });
	await flush();
	assert.equal(respondCalls.length, 0, "respond 抛错不应有成功记录");
	const ui = emitted.find(([channel]) => channel === "agents:ui-request");
	assert.ok(ui, "自动放行失败应回退弹审批 UI");
	assert.equal(ui[1].requestId, "rpc-3");
});

/** 构造与 DSH mux 实测一致的 session/event 帧（会话事件走 mux 流）。 */
const sessionEventFrame = (sessionId, evt) => ({
	payload: { type: "session/event", sessionId, event: evt },
});

/** 构造 DSH 官方 session/projection 帧（每个 key 按 seq higher-seq-wins）。 */
const projectionFrame = (sessionId, key, value, seq) => ({
	payload: { type: "session/projection", sessionId, key, value, seq },
});

test("contextPressure 的零 usage 不得擦掉最后一个有效上下文值", async () => {
	const { host, client } = makeFakeHost({
		muxFrames: [projectionFrame("session-fake-1", "contextPressure", {
			pressureTokens: 120_000,
			projectedTokens: 120_000,
			contextWindow: 1_000_000,
		}, 10)],
	});
	const manager = new DshAgentManager(host, () => PROJECT);
	const tab = await manager.create({ projectId: "project-1", backend: "dsh" });
	await flush();
	assert.equal((await manager.getRuntimeState(tab.id)).contextTokens, 120_000);

	// 失败 retry 的 usage 可能把两个 pressure 字段都写成 0；这不是当前会话的真实上下文。
	client.pushFrames(projectionFrame("session-fake-1", "contextPressure", {
		pressureTokens: 0,
		projectedTokens: 0,
		contextWindow: 1_000_000,
	}, 11));
	await flush();
	assert.equal((await manager.getRuntimeState(tab.id)).contextTokens, 120_000);
});

test("已有消息但首次 contextPressure 为零时使用消息估算，不显示 0", async () => {
	const { host } = makeFakeHost({
		muxFrames: [
			sessionEventFrame("session-fake-1", event("user/message", 1, {
				content: [{ type: "text", text: "x".repeat(400) }],
			})),
			projectionFrame("session-fake-1", "contextPressure", {
				pressureTokens: 0,
				projectedTokens: 0,
				contextWindow: 1_000_000,
			}, 2),
		],
	});
	const manager = new DshAgentManager(host, () => PROJECT);
	const tab = await manager.create({ projectId: "project-1", backend: "dsh" });
	await flush();
	assert.equal((await manager.getRuntimeState(tab.id)).contextTokens, 100);
});

test("session/projection 旧 seq 不得覆盖较新的 contextPressure", async () => {
	const { host, client } = makeFakeHost({
		muxFrames: [projectionFrame("session-fake-1", "contextPressure", {
			pressureTokens: 180_000,
			projectedTokens: 180_000,
			contextWindow: 1_000_000,
		}, 20)],
	});
	const manager = new DshAgentManager(host, () => PROJECT);
	const tab = await manager.create({ projectId: "project-1", backend: "dsh" });
	await flush();
	client.pushFrames(projectionFrame("session-fake-1", "contextPressure", {
		pressureTokens: 90_000,
		projectedTokens: 90_000,
		contextWindow: 1_000_000,
	}, 19));
	await flush();
	assert.equal((await manager.getRuntimeState(tab.id)).contextTokens, 180_000);

	client.pushFrames(projectionFrame("session-fake-1", "contextPressure", {
		pressureTokens: 210_000,
		projectedTokens: 210_000,
		contextWindow: 1_000_000,
	}, 21));
	await flush();
	assert.equal((await manager.getRuntimeState(tab.id)).contextTokens, 210_000);
});

test("attach projection baseline 的 seq 不得被旧实时帧覆盖", async () => {
	const { host, sessions, historyBySession } = makeFakeHost({
		muxFrames: [projectionFrame("session-attached", "contextPressure", {
			pressureTokens: 90_000,
			projectedTokens: 90_000,
			contextWindow: 1_000_000,
		}, 19)],
	});
	sessions.set("session-attached", {
		sessionId: "session-attached",
		cwd: PROJECT.path,
		running: false,
		blank: false,
		projections: {
			asOfSeq: 20,
			values: {
				contextPressure: {
					pressureTokens: 180_000,
					projectedTokens: 180_000,
					contextWindow: 1_000_000,
				},
			},
		},
	});
	historyBySession.set("session-attached", []);
	const manager = new DshAgentManager(host, () => PROJECT);
	const tab = await manager.create({
		projectId: "project-1",
		backend: "dsh",
		dshSessionId: "session-attached",
	});
	await flush();
	assert.equal((await manager.getRuntimeState(tab.id)).contextTokens, 180_000);
});

test("流式正文按累积语义发 agents:text-stream（渲染层 streamingTextByIdAtom 按累积存储）", async () => {
	const { host } = makeFakeHost({
		muxFrames: [
			sessionEventFrame("session-fake-1", event("assistant/chunk", 1, { chunk: { type: "text-delta", text: "你" } })),
			sessionEventFrame("session-fake-1", event("assistant/chunk", 2, { chunk: { type: "text-delta", text: "好" } })),
			sessionEventFrame("session-fake-1", event("turn/end", 3)),
		],
	});
	const streams = [];
	const manager = new DshAgentManager(host, () => PROJECT);
	manager.onOutput((channel, payload) => {
		if (channel === "agents:text-stream") streams.push(payload);
	});
	await manager.create({ projectId: "project-1", backend: "dsh" });
	await flush();
	const texts = streams.filter((item) => !item.done).map((item) => item.text);
	assert.deepEqual(texts, ["你", "你好"], "text 应为累积文本而非单帧增量（增量会被渲染层逐帧覆盖）");
	assert.equal(streams.at(-1).done, true, "turn/end 补发 done:true");
	assert.equal(streams.at(-1).text, "你好", "done 必须带上已累积正文，空 text 会抹掉 live 槽");
});

test("reasoning delta 走 agents:thinking 独立通道，不进正文流", async () => {
	const { host } = makeFakeHost({
		muxFrames: [
			sessionEventFrame("session-fake-1", event("assistant/chunk", 1, { chunk: { type: "reasoning-delta", text: "先" } })),
			sessionEventFrame("session-fake-1", event("assistant/chunk", 2, { chunk: { type: "reasoning-delta", text: "想" } })),
			sessionEventFrame("session-fake-1", event("assistant/message", 3, { message: { content: [{ type: "text", text: "答" }] } })),
		],
	});
	const thoughts = [];
	const streams = [];
	const manager = new DshAgentManager(host, () => PROJECT);
	manager.onOutput((channel, payload) => {
		if (channel === "agents:thinking") thoughts.push(payload);
		if (channel === "agents:text-stream") streams.push(payload);
	});
	await manager.create({ projectId: "project-1", backend: "dsh" });
	await flush();
	assert.equal(thoughts.length, 3);
	assert.equal(thoughts[0].done, false);
	assert.equal(thoughts[0].text, "先");
	assert.equal(thoughts[1].text, "先想", "thinking 文本也应累积");
	assert.equal(thoughts[0].id, thoughts[1].id, "turn 内思考段 id 稳定");
	assert.equal(thoughts[2].done, true, "assistant/message 清空 pending 后补发 done");
	// 正文流只允许出现「assistant/message 落定时关闭流式槽」的 done 信号，
	// 推理文本绝不能进正文流（否则正文与思考双显）。
	assert.equal(streams.length, 1, "正文流只收到关闭信号");
	assert.equal(streams[0].done, true);
	assert.equal(streams[0].text, "答", "done 带终态正文，避免空快照抹掉 live 槽");
});

test("tool/call 帧携带 arguments 与 host view：投影进工具消息 meta（args/view）", async () => {
	const { host } = makeFakeHost({
		muxFrames: [{
			payload: {
				type: "session/event",
				sessionId: "session-fake-1",
				event: event("tool/call", 1, {
					toolName: "pwsh",
					callId: "call-1",
					arguments: JSON.stringify({ command: "Get-Location", description: "看当前目录" }),
				}),
				// host 计算的工具卡片 view（dsh-web 同源数据）：透传进 meta.view
				view: { for: "call", view: { card: "terminal", title: "Get-Location", description: "看当前目录" } },
			},
		}],
	});
	const messages = [];
	const manager = new DshAgentManager(host, () => PROJECT);
	manager.onOutput((channel, payload) => {
		if (channel === "agents:message") messages.push(payload);
	});
	await manager.create({ projectId: "project-1", backend: "dsh" });
	await flush();
	const tool = messages.at(-1).messages.at(-1);
	assert.equal(tool.role, "tool");
	// 跨 realm 对象不能 deepStrictEqual，逐字段断言
	assert.equal(tool.meta.args.command, "Get-Location");
	assert.equal(tool.meta.args.description, "看当前目录");
	assert.equal(tool.meta.status, "running");
	assert.equal(tool.meta.view.for, "call");
	assert.equal(tool.meta.view.view.card, "terminal");
});

test("host 进程退出后 mux 自动重连（流中断 → 退避 → 重新订阅，不再静默悬挂）", async () => {
	const { host, muxCalls } = makeFakeHost({
		muxFrames: [sessionEventFrame("session-fake-1", event("turn/start", 1))],
	});
	const manager = new DshAgentManager(host, () => PROJECT);
	await manager.create({ projectId: "project-1", backend: "dsh" });
	await flush();
	assert.equal(muxCalls.length, 1, "首条 mux 订阅已建立");
	// 模拟 host 运行中崩溃：DshHost 联动 abortAllPending → mux 流中断 → pump 捕获后退避重连。
	host.triggerExit();
	// 崩溃自动重启需要时间（DshHostProcess 重启 + host-ready），期间 pump 应等待而非空转。
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(muxCalls.length, 1, "host 未就绪前不应重复订阅");
	host.restartHost();
	// 指数退避首档 250ms：跨过退避窗口后应完成重连。
	await new Promise((resolve) => setTimeout(resolve, 400));
	assert.ok(muxCalls.length >= 2, `应自动重连 mux（实际订阅 ${muxCalls.length} 次）`);
});

test("getAvailableModels 透传模型支持的思考档位（reasoningEfforts）", async () => {
	// host 的 models catalog 带 reasoning.efforts：llm-deepseek 只声明 off/high/max，
	// llm-pi-ai 按模型声明——选择器按它过滤档位，避免选不支持的档位导致回合失败。
	const { host } = makeFakeHost({
		modelsValue: {
			current: { provider: "llm-deepseek", model: "deepseek-v4-flash" },
			routable: true,
			failures: [],
			groups: [{
				id: "llm-deepseek",
				name: "DeepSeek",
				models: [{
					id: "deepseek-v4-flash",
					name: "DeepSeek V4 Flash",
					reasoning: {
						efforts: [
							{ id: "off", name: "Off" },
							{ id: "high", name: "High" },
							{ id: "max", name: "Max" },
						],
						defaultEffort: "high",
					},
				}],
			}],
		},
	});
	const manager = new DshAgentManager(host, () => PROJECT);
	await manager.create({ projectId: "project-1", backend: "dsh" });
	const models = await manager.getAvailableModels("dsh:session-fake-1");
	assert.equal(models.length, 1);
	assert.deepEqual(models[0].reasoningEfforts?.map((effort) => effort.id), ["off", "high", "max"]);
	assert.equal(models[0].reasoningEfforts?.[1].name, "High");
});


test("sendPrompt rejects only when DSH sessions.models reports routable=false", async () => {
	const { host, calls } = makeFakeHost({
		modelsValue: {
			current: { provider: "gone-provider", model: "gone-model" },
			routable: false,
			groups: [],
			failures: [],
		},
	});
	const manager = new DshAgentManager(host, () => PROJECT);
	const tab = await manager.create({ projectId: "project-1", backend: "dsh" });
	const result = await manager.sendPrompt({ agentId: tab.id, message: "should not be sent" });
	assert.equal(result.accepted, false);
	assert.equal(result.i18nKey, "session.sendDshModelRouteUnavailable");
	assert.equal(calls.prompt, 0);
	assert.equal((await manager.getRuntimeState(tab.id)).modelRoutable, false);
});

test("setPermission 只在 permission/preset 事件到达后报告成功，且命令不投影为用户消息", async () => {
	const { host, client, promptCalls } = makeFakeHost();
	const manager = new DshAgentManager(host, () => PROJECT);
	const tab = await manager.create({ projectId: "project-1", backend: "dsh" });
	await flush();

	const changing = manager.setPermission(tab.id, "workspace-write");
	// 事件必须在 prompt 受理之后到达，模拟 host 命令桥完成 apply 后的 mux 推送。
	await new Promise((resolve) => setTimeout(resolve, 20));
	client.pushFrames(
		sessionEventFrame("session-fake-1", event("permission/preset", 2, { preset: "workspace-write" })),
	);
	await changing;
	assert.deepEqual(promptCalls, ["/permission workspace-write"]);
	assert.equal((await manager.getRuntimeState(tab.id)).permissionPreset, "workspace-write");
	assert.equal(manager.getMessages(tab.id).some((message) => message.text.includes("/permission")), false);
});

test("setPermission 拒绝未知预设，避免把非法值送进 DSH 命令桥", async () => {
	const { host, calls } = makeFakeHost();
	const manager = new DshAgentManager(host, () => PROJECT);
	const tab = await manager.create({ projectId: "project-1", backend: "dsh" });

	await assert.rejects(
		() => manager.setPermission(tab.id, "project-write"),
		/Unsupported DSH permission preset: project-write/,
	);
	assert.equal(calls.prompt, 0);
});

test("setModel 按官方语义使用新模型默认档位，不携带旧模型的 thinkingLevel", async () => {
	const { host, client } = makeFakeHost({
		modelsValue: {
			current: { provider: "llm-deepseek", model: "deepseek-v4-flash" },
			routable: true,
			failures: [],
			groups: [
				{
					id: "llm-deepseek",
					name: "DeepSeek",
					models: [{
						id: "deepseek-v4-flash",
						name: "DeepSeek V4 Flash",
						reasoning: {
							efforts: [
								{ id: "off", name: "Off" },
								{ id: "high", name: "High" },
								{ id: "max", name: "Max" },
							],
							defaultEffort: "high",
						},
					}],
				},
				{
					id: "jiyuan",
					name: "Jiyuan",
					models: [{
						id: "jiyuan-model",
						name: "Jiyuan Model",
						reasoning: {
							efforts: [
								{ id: "off", name: "Off" },
								{ id: "low", name: "Low" },
							],
							defaultEffort: "low",
						},
					}],
				},
			],
		},
	});
	const manager = new DshAgentManager(host, () => PROJECT);
	await manager.create({ projectId: "project-1", backend: "dsh" });
	const agentId = "dsh:session-fake-1";
	const selectModelCalls = [];
	client.sessions.selectModel = async (input) => {
		selectModelCalls.push(input);
		const selected = {
			provider: input.provider,
			model: input.model,
			...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
		};
		return { result: { ok: true, value: { selected } } };
	};
	// 先选一个支持 max 的模型，再把思考档位设成 max
	await manager.setModel(agentId, "llm-deepseek", "deepseek-v4-flash");
	await manager.setThinking(agentId, "max");
	selectModelCalls.length = 0;
	// 切到 jiyuan：不能再带 max，应使用 jiyuan 模型自己的默认档位 low
	await manager.setModel(agentId, "jiyuan", "jiyuan-model");
	assert.equal(selectModelCalls.length, 1);
	assert.equal(selectModelCalls[0].reasoningEffort, "low");
});

test("setThinking 在 host 拒绝时回滚旧档位并抛出错误", async () => {
	const { host, client } = makeFakeHost({
		modelsValue: {
			current: { provider: "llm-deepseek", model: "deepseek-v4-flash" },
			routable: true,
			failures: [],
			groups: [{
				id: "llm-deepseek",
				name: "DeepSeek",
				models: [{
					id: "deepseek-v4-flash",
					name: "DeepSeek V4 Flash",
					reasoning: {
						efforts: [
							{ id: "off", name: "Off" },
							{ id: "high", name: "High" },
							{ id: "max", name: "Max" },
						],
						defaultEffort: "high",
					},
				}],
			}],
		},
	});
	const manager = new DshAgentManager(host, () => PROJECT);
	await manager.create({ projectId: "project-1", backend: "dsh" });
	const agentId = "dsh:session-fake-1";
	client.sessions.selectModel = async (input) => {
		if (input.reasoningEffort === "max") {
			return {
				result: {
					ok: false,
					error: { code: "model-unavailable", message: "does not support reasoning effort max" },
				},
			};
		}
		const selected = {
			provider: input.provider,
			model: input.model,
			...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
		};
		return { result: { ok: true, value: { selected } } };
	};
	await manager.setModel(agentId, "llm-deepseek", "deepseek-v4-flash");
	assert.equal((await manager.getRuntimeState(agentId)).thinkingLevel, "high");
	// host 拒绝必须保留原始错误文案（档位错误折叠成 model-unavailable 时
	// 不能转译成笼统的 Model not found）：断言真实原因透传、且不出现笼统文案。
	await assert.rejects(
		() => manager.setThinking(agentId, "max"),
		(error) => {
			const message = error instanceof Error ? error.message : String(error);
			assert.match(message, /does not support reasoning effort max/);
			assert.doesNotMatch(message, /Model not found/);
			return true;
		},
	);
	assert.equal((await manager.getRuntimeState(agentId)).thinkingLevel, "high");
});

test("setThinking 无当前模型时不写入 runtime.thinkingLevel，避免污染后续换模型", async () => {
	const { host } = makeFakeHost();
	const manager = new DshAgentManager(host, () => PROJECT);
	await manager.create({ projectId: "project-1", backend: "dsh" });
	const agentId = "dsh:session-fake-1";
	await manager.setThinking(agentId, "high");
	assert.equal((await manager.getRuntimeState(agentId)).thinkingLevel, undefined);
});

// ── 停止（abort）竞态回归：旧回合残留事件不得串台、不得重开流式 ───────────────

test("abort 后旧回合的终态回答与工具事件不上屏：只留已流式的部分文本", async () => {
	const { host, client, calls } = makeFakeHost();
	const emitted = [];
	const manager = new DshAgentManager(host, () => PROJECT);
	manager.onOutput((channel, payload) => emitted.push([channel, payload]));
	const tab = await manager.create({ projectId: "project-1", backend: "dsh" });
	await flush();
	// 回合进行中：turn/start + 一段正文已流式
	client.pushFrames(
		sessionEventFrame("session-fake-1", event("turn/start", 1)),
		sessionEventFrame("session-fake-1", event("assistant/chunk", 2, { chunk: { type: "text-delta", text: "旧" } })),
	);
	await flush();
	assert.equal(manager.getMessages(tab.id).length, 1, "chunk 已建立流式骨架");

	// 用户停止：抬世代 + 发 cancel RPC
	await manager.abort(tab.id);
	assert.equal(calls.cancel, 1, "abort 必须发 session.cancel");
	// host 收尾期残留事件：完整回答、工具调用、工具结果、回合结束
	client.pushFrames(
		sessionEventFrame("session-fake-1", event("assistant/message", 3, {
			message: { content: [{ type: "text", text: "旧回合的完整回答（不应出现）" }] },
		})),
		sessionEventFrame("session-fake-1", event("tool/call", 4, { toolName: "pwsh", callId: "call-1", arguments: "{}" })),
		sessionEventFrame("session-fake-1", event("tool/result", 5, { message: { content: [{ type: "text", text: "ok" }] } })),
		sessionEventFrame("session-fake-1", event("turn/end", 6)),
	);
	await flush();
	const messages = manager.getMessages(tab.id);
	assert.equal(messages.length, 1, "旧回合只留一条已流式骨架消息");
	assert.equal(messages[0].role, "assistant");
	assert.equal(messages[0].text, "旧", "turn/end 把部分文本落回骨架，完整回答不得上屏");
	assert.ok(!messages.some((m) => m.role === "tool"), "abort 后工具事件不得投影");
	// 正文流：turn/start reset 空槽 + chunk 累积 + abort/turn/end 带已出的字收口。
	// 完整回答不得作为新的非 done 快照上屏。
	const streams = emitted
		.filter(([channel]) => channel === "agents:text-stream")
		.map(([, payload]) => payload);
	assert.ok(streams.some((item) => item.text === "旧" && item.done === false), "chunk 应推累积正文");
	assert.ok(streams.some((item) => item.reset === true && item.done === true), "turn/start 应 reset 上一轮 live 槽");
	assert.ok(
		streams.filter((item) => item.done).every((item) => item.text === "" || item.text === "旧"),
		"收口不得带上 abort 后的完整回答",
	);
	assert.ok(!streams.some((item) => item.text.includes("完整回答")), "完整回答不得进正文流");
	// 停止后不得重新点亮 streaming
	const states = emitted
		.filter(([channel]) => channel === "agents:runtime-state")
		.map(([, payload]) => payload.state);
	assert.equal(states.at(-1).isStreaming, false);
});

test("abort 后立刻发送：必须等旧回合 turn/end 收口才真正发 prompt（防 followup 拼接串台）", async () => {
	const { host, client, calls, promptCalls } = makeFakeHost();
	const manager = new DshAgentManager(host, () => PROJECT);
	const tab = await manager.create({ projectId: "project-1", backend: "dsh" });
	await flush();
	client.pushFrames(
		sessionEventFrame("session-fake-1", event("turn/start", 1)),
		sessionEventFrame("session-fake-1", event("assistant/chunk", 2, { chunk: { type: "text-delta", text: "旧" } })),
	);
	await flush();
	await manager.abort(tab.id);

	// 停止后立刻发下一条：cancelled 未收口前不得发给 host（否则被拼进旧回合）
	const sendPromise = manager.sendPrompt({ agentId: tab.id, message: "新问题" });
	await flush();
	assert.equal(calls.prompt, 0, "旧回合 turn/end 未到，新消息不得发给 host");

	// 旧回合收尾：用户新消息文本仍投影（不能丢），随后 turn/end 收口 cancelled
	client.pushFrames(
		sessionEventFrame("session-fake-1", event("user/message", 3, {
			content: [{ type: "text", text: "新问题" }],
			source: { kind: "user", rpcId: "rpc-new" },
		})),
		sessionEventFrame("session-fake-1", event("turn/end", 4)),
	);
	await sendPromise;
	assert.equal(calls.prompt, 1, "turn/end 收口后新消息才放行");
	assert.equal(promptCalls[0], "新问题");
	const messages = manager.getMessages(tab.id);
	assert.ok(
		messages.some((m) => m.role === "user" && m.text === "新问题"),
		"abort 期间到达的 user/message 仍投影（用户消息不能丢）",
	);
});

test("idle 时 abort 不置 cancelled：下次发送不被卡（cancelled 无 turn/end 可等）", async () => {
	const { host, client, calls } = makeFakeHost();
	const manager = new DshAgentManager(host, () => PROJECT);
	const tab = await manager.create({ projectId: "project-1", backend: "dsh" });
	await flush();
	// 回合已结束后点停止：beginDshCancel no-op，cancelled 保持 false
	await manager.abort(tab.id);
	const result = await manager.sendPrompt({ agentId: tab.id, message: "你好" });
	assert.equal(result.accepted, true);
	assert.equal(calls.prompt, 1, "idle abort 后发送立即放行，不被 cancelled 卡 30s");
});

test("abort 立即收口 Live 思考流（停止后思考块不再转）", async () => {
	const { host, client } = makeFakeHost();
	const thoughts = [];
	const manager = new DshAgentManager(host, () => PROJECT);
	manager.onOutput((channel, payload) => {
		if (channel === "agents:thinking") thoughts.push(payload);
	});
	const tab = await manager.create({ projectId: "project-1", backend: "dsh" });
	await flush();
	client.pushFrames(
		sessionEventFrame("session-fake-1", event("turn/start", 1)),
		sessionEventFrame("session-fake-1", event("assistant/chunk", 2, { chunk: { type: "reasoning-delta", text: "想" } })),
	);
	await flush();
	assert.equal(thoughts.filter((t) => !t.done).length, 1, "思考流已点亮");
	// 停止：思考块必须随 abort 立即收口（旧回合残留 reasoning 帧会被丢弃，
	// 不能等 turn/end——否则「停止后思考还在转」）
	await manager.abort(tab.id);
	assert.equal(thoughts.at(-1).done, true, "abort 必须立即补发 thinking done");
	assert.equal(thoughts.at(-1).text, "");
	assert.equal(thoughts.at(-1).id, thoughts[0].id, "思考段 id 保持一致（渲染层原位收口）");
});

test("stop 先 cancel 再解绑，且不打断共享 mux", async () => {
	const { host, client, calls, muxCalls } = makeFakeHost();
	const manager = new DshAgentManager(host, () => PROJECT);
	const first = await manager.create({ projectId: "project-1", backend: "dsh" });
	const second = await manager.create({ projectId: "project-1", backend: "dsh" });
	await flush();
	assert.equal(muxCalls.length, 1, "两个 runtime 只订阅一条共享 mux");
	await manager.stop(first.id);
	assert.equal(calls.cancel, 1, "stop 必须先发 session.cancel");
	assert.equal(manager.list().some((tab) => tab.id === first.id), false);
	assert.equal(manager.list().some((tab) => tab.id === second.id), true);
	assert.equal(muxCalls.length, 1, "停一个会话不得重开/掐断共享 mux");
});

test("sendPrompt 默认 queue；steer 映射 host mode 且不等 idle", async () => {
	const { host, client, calls, promptCalls, promptModes } = makeFakeHost();
	const manager = new DshAgentManager(host, () => PROJECT);
	const tab = await manager.create({ projectId: "project-1", backend: "dsh" });
	await flush();

	const queued = await manager.sendPrompt({ agentId: tab.id, message: "下一轮" });
	assert.equal(queued.accepted, true);
	assert.equal(promptModes[0], "queue");
	assert.equal(promptCalls[0], "下一轮");

	// followUp 与未指定行为一样走 queue（host followup），不是 steer。
	const followUp = await manager.sendPrompt({
		agentId: tab.id,
		message: "也排队",
		streamingBehavior: "followUp",
	});
	assert.equal(followUp.accepted, true);
	assert.equal(promptModes[1], "queue");

	client.pushFrames(sessionEventFrame("session-fake-1", event("turn/start", 1)));
	await flush();
	const steered = await manager.sendPrompt({
		agentId: tab.id,
		message: "插入当前回合",
		streamingBehavior: "steer",
	});
	assert.equal(steered.accepted, true);
	assert.equal(calls.prompt, 3, "steer 不得被 waitForIdle 卡住");
	assert.equal(promptModes[2], "steer");
	assert.equal(promptCalls[2], "插入当前回合");
});

test("abort 收尾期的 steer 也要等 turn/end，避免插进已停止回合", async () => {
	const { host, client, calls, promptModes } = makeFakeHost();
	const manager = new DshAgentManager(host, () => PROJECT);
	const tab = await manager.create({ projectId: "project-1", backend: "dsh" });
	await flush();
	client.pushFrames(
		sessionEventFrame("session-fake-1", event("turn/start", 1)),
		sessionEventFrame("session-fake-1", event("assistant/chunk", 2, { chunk: { type: "text-delta", text: "旧" } })),
	);
	await flush();
	await manager.abort(tab.id);

	const sendPromise = manager.sendPrompt({
		agentId: tab.id,
		message: "停止后插入",
		streamingBehavior: "steer",
	});
	await flush();
	assert.equal(calls.prompt, 0, "cancelled 未收口时 steer 也不得发给 host");

	client.pushFrames(sessionEventFrame("session-fake-1", event("turn/end", 3)));
	await sendPromise;
	assert.equal(calls.prompt, 1);
	assert.equal(promptModes[0], "steer");
});

test("sendPrompt 仍拒绝 DSH 不支持的宿主指令", async () => {
	const { host, calls } = makeFakeHost();
	const manager = new DshAgentManager(host, () => PROJECT);
	const tab = await manager.create({ projectId: "project-1", backend: "dsh" });
	const result = await manager.sendPrompt({
		agentId: tab.id,
		message: "hi",
		agentMessage: "plan mode marker",
	});
	assert.equal(result.accepted, false);
	assert.equal(result.i18nKey, "session.sendDshUnsupportedPayload");
	assert.equal(calls.prompt, 0, "宿主指令不得发给 host");
});

test("模型与思考强度在运行中交给后端，后续 step 使用已接受的选择", async () => {
	const { host, client } = makeFakeHost({
		modelsValue: {
			current: { provider: "llm-deepseek", model: "deepseek-v4-flash" },
			routable: true,
			groups: [],
		},
	});
	const manager = new DshAgentManager(host, () => PROJECT);
	const tab = await manager.create({ projectId: "project-1", backend: "dsh" });
	await flush();
	client.pushFrames(sessionEventFrame("session-fake-1", event("turn/start", 1)));
	await flush();
	const selectModelCalls = [];
	client.sessions.selectModel = async (input) => {
		selectModelCalls.push(input);
		return {
			result: {
				ok: true,
				value: {
					selected: {
						provider: input.provider,
						model: input.model,
						...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
					},
				},
			},
		};
	};

	await manager.setThinking(tab.id, "max");
	await manager.setModel(tab.id, "llm-deepseek", "deepseek-v4-flash");
	assert.equal(selectModelCalls[0].reasoningEffort, "max");
	assert.equal(selectModelCalls[1].provider, "llm-deepseek");
	assert.equal(selectModelCalls[1].model, "deepseek-v4-flash");
});

test("todos projection 帧 → runtime state.todos（整表快照 + higher-seq-wins + 清空）", async () => {
	const { host, client } = makeFakeHost();
	const manager = new DshAgentManager(host, () => PROJECT);
	const tab = await manager.create({ projectId: "project-1", backend: "dsh" });
	await flush();
	assert.equal((await manager.getRuntimeState(tab.id)).todos, undefined, "未推送前无 todo");

	// 官方 tool-todo 的 session/projection 帧（value 是整表快照，seq 用于 higher-seq-wins）
	client.pushFrames({
		payload: {
			type: "session/projection",
			sessionId: "session-fake-1",
			key: "todos",
			value: [
				{ content: "定位根因", status: "completed" },
				{ content: "补齐接线", status: "in_progress" },
				{ content: "验证恢复", status: "pending" },
			],
			seq: 2,
		},
	});
	await flush();
	// vm 跨 realm 对象与测试字面量 prototype 不同，deepStrictEqual 需 JSON 往返归一
	assert.deepEqual(JSON.parse(JSON.stringify((await manager.getRuntimeState(tab.id)).todos)), [
		{ content: "定位根因", status: "completed" },
		{ content: "补齐接线", status: "in_progress" },
		{ content: "验证恢复", status: "pending" },
	]);

	// 低 seq 迟到帧按 higher-seq-wins 丢弃
	client.pushFrames({
		payload: {
			type: "session/projection",
			sessionId: "session-fake-1",
			key: "todos",
			value: [{ content: "过期", status: "pending" }],
			seq: 1,
		},
	});
	await flush();
	assert.equal((await manager.getRuntimeState(tab.id)).todos.length, 3, "低 seq 不得覆盖");

	// null = 显式清空（standing plan / 首写前），较高 seq 生效
	client.pushFrames({
		payload: {
			type: "session/projection",
			sessionId: "session-fake-1",
			key: "todos",
			value: null,
			seq: 3,
		},
	});
	await flush();
	assert.equal((await manager.getRuntimeState(tab.id)).todos, null, "高 seq null 清空");

	// 非法值（非数组/null）不改变已有状态
	client.pushFrames({
		payload: {
			type: "session/projection",
			sessionId: "session-fake-1",
			key: "todos",
			value: [{ content: "", status: "pending" }],
			seq: 4,
		},
	});
	await flush();
	assert.equal((await manager.getRuntimeState(tab.id)).todos, null, "非法整表保持原值");
});

test("历史重放恢复 todo（todo/write + turn/start standing plan 语义）", async () => {
	const { host, sessions, historyBySession } = makeFakeHost();
	sessions.set("session-todo-1", { sessionId: "session-todo-1", cwd: PROJECT.path, running: false, blank: false });
	// 上一轮写完清单、本轮 turn/start 已开（旧计划清空）；list 无 projections 兜底
	historyBySession.set("session-todo-1", [
		event("turn/start", 1),
		event("todo/write", 2, { todos: [{ content: "第一轮计划", status: "completed" }] }),
		event("turn/end", 3, { reason: { kind: "stop" } }),
		event("turn/start", 4),
	]);
	const manager = new DshAgentManager(host, () => PROJECT);
	const tab = await manager.create({
		projectId: "project-1",
		backend: "dsh",
		dshSessionId: "session-todo-1",
	});
	assert.equal((await manager.getRuntimeState(tab.id)).todos, null, "新一轮已开 → 计划清空");

	// 活跃一轮内写入清单（无后续 turn/start）→ 恢复为有效计划
	historyBySession.set("session-todo-2", [
		event("turn/start", 1),
		event("todo/write", 2, { todos: [{ content: "当前计划", status: "in_progress" }] }),
	]);
	sessions.set("session-todo-2", { sessionId: "session-todo-2", cwd: PROJECT.path, running: false, blank: false });
	const tab2 = await manager.create({
		projectId: "project-1",
		backend: "dsh",
		dshSessionId: "session-todo-2",
	});
	assert.deepEqual(JSON.parse(JSON.stringify((await manager.getRuntimeState(tab2.id)).todos)), [
		{ content: "当前计划", status: "in_progress" },
	]);
});

test("attach 用 host list projections.values.todos 兜底（历史窗口截断时仍恢复计划）", async () => {
	const { host, sessions } = makeFakeHost();
	// 官方 list 行携带 projections values（history 尾部截断时，最早 todo/write 可能不在窗口内）
	sessions.set("session-todo-base", {
		sessionId: "session-todo-base",
		cwd: PROJECT.path,
		running: false,
		blank: false,
		projections: {
			asOfSeq: 500,
			values: {
				todos: [
					{ content: "窗口外写入的计划", status: "completed" },
					{ content: "窗口外进行中项", status: "in_progress" },
				],
			},
		},
	});
	const manager = new DshAgentManager(host, () => PROJECT);
	const tab = await manager.create({
		projectId: "project-1",
		backend: "dsh",
		dshSessionId: "session-todo-base",
	});
	assert.deepEqual(JSON.parse(JSON.stringify((await manager.getRuntimeState(tab.id)).todos)), [
		{ content: "窗口外写入的计划", status: "completed" },
		{ content: "窗口外进行中项", status: "in_progress" },
	]);
});

test("history 尾页 projections baseline 恢复 todo（无 list projections 的 attach 路径）", async () => {
	const { host, sessions, historyBySession, historyProjections } = makeFakeHost();
	sessions.set("session-todo-tail", { sessionId: "session-todo-tail", cwd: PROJECT.path, running: false, blank: false });
	// 事件窗口里没有 todo/write（计划在截断窗口之前，已被后续多轮对话挤出尾页）
	historyBySession.set("session-todo-tail", [
		event("turn/start", 10),
		event("user/message", 11, { content: [{ type: "text", text: "继续" }], source: { kind: "user", rpcId: "rpc-tail" } }),
		event("assistant/message", 12, { message: { content: [{ type: "text", text: "好的" }] } }),
	]);
	// 但尾页 projections baseline 携带完整折叠（官方 host 行为）
	historyProjections.set("session-todo-tail", {
		asOfSeq: 12,
		values: {
			todos: [{ content: "尾页基线计划", status: "in_progress" }],
		},
	});
	const manager = new DshAgentManager(host, () => PROJECT);
	const tab = await manager.create({
		projectId: "project-1",
		backend: "dsh",
		dshSessionId: "session-todo-tail",
	});
	assert.deepEqual(JSON.parse(JSON.stringify((await manager.getRuntimeState(tab.id)).todos)), [
		{ content: "尾页基线计划", status: "in_progress" },
	]);
});

test("todo/write 实时事件折叠进 runtime state（mux 事件 < projection 帧优先级）", async () => {
	const { host, client } = makeFakeHost();
	const manager = new DshAgentManager(host, () => PROJECT);
	const tab = await manager.create({ projectId: "project-1", backend: "dsh" });
	await flush();

	client.pushFrames(sessionEventFrame("session-fake-1", event("todo/write", 2, {
		todos: [{ content: "事件源计划", status: "in_progress" }],
	})));
	await flush();
	assert.deepEqual(JSON.parse(JSON.stringify((await manager.getRuntimeState(tab.id)).todos)), [
		{ content: "事件源计划", status: "in_progress" },
	]);
});


test("create attach 混合内联图片与 durable ref 时会补齐缺失图片", async () => {
	const { host, sessions, historyBySession, attachments, calls } = makeFakeHost();
	sessions.set("session-img-mixed", { sessionId: "session-img-mixed", cwd: PROJECT.path, running: false, blank: false });
	historyBySession.set("session-img-mixed", [event("user/message", 1, {
		content: [
			{ type: "text", text: "两张图" },
			{ type: "image", mediaType: "image/png", data: "inline-data" },
			{ type: "image", attachment: { attachmentId: "att-mixed", mediaType: "image/jpeg" } },
		],
		source: { kind: "user", rpcId: "rpc-mixed" },
	})]);
	attachments.set("session-img-mixed:att-mixed", {
		attachment: { attachmentId: "att-mixed", mediaType: "image/jpeg" },
		data: "durable-data",
	});
	const manager = new DshAgentManager(host, () => PROJECT);
	const tab = await manager.create({ projectId: "project-1", backend: "dsh", dshSessionId: "session-img-mixed" });
	const images = manager.getMessages(tab.id)[0].images;
	assert.equal(images.length, 2);
	assert.equal(images[0].data, "inline-data");
	assert.equal(images[1].data, "durable-data");
	assert.equal(calls.attachment, 1);
});


test("运行中 mux 后续事件不会清掉已回填图片", async () => {
	const { host, client, attachments } = makeFakeHost();
	attachments.set("session-fake-1:att-live", {
		attachment: { attachmentId: "att-live", mediaType: "image/png" },
		data: "runtime-data",
	});
	const manager = new DshAgentManager(host, () => PROJECT);
	const tab = await manager.create({ projectId: "project-1", backend: "dsh" });
	await flush();

	client.pushFrames(sessionEventFrame("session-fake-1", event("user/message", 1, {
		content: [{ type: "image", attachment: { attachmentId: "att-live", mediaType: "image/png" } }],
		source: { kind: "user", rpcId: "rpc-live" },
	})));
	await flush();
	assert.equal(manager.getMessages(tab.id)[0].images?.[0]?.data, "runtime-data");

	client.pushFrames(sessionEventFrame("session-fake-1", event("assistant/chunk", 2, {
		chunk: { type: "text-delta", text: "正在回答" },
	})));
	await flush();
	assert.equal(manager.getMessages(tab.id)[0].images?.[0]?.data, "runtime-data");
});
