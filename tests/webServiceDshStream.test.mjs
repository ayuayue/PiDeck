import assert from "node:assert/strict";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * Web 端 DSH 后端流式链路（真实 WebServiceManager + 真实 HTTP 连接）。
 *
 * 回归背景：DSH 的正文/思考/工具流不在 pi 事件源里，之前 Web 端只能靠状态轮询 +
 * 磁盘重拉追赶——表现为「输出很慢」，且整轮没有 finish 帧，useChat 永远停在
 * streaming，表现为「察觉不到结束/停止」。这里断言端到端的真实行为：
 * 1) /api/chat（useChat 一次性流）按 UIMessageStream 帧流式返回，并在整轮结束
 *    （DSH turnEnded）时 finish + [DONE] + 关闭连接；
 * 2) /api/sessions/:id/stream（外部流，keepAlive）整轮结束后连接保留，下一轮继续可收；
 * 3) /api/events 在 DSH 通道事件到达时立刻推送状态快照（忙闲翻转不必等 5s tick）。
 */

const AGENT_ID = "dsh:session-1";
const SESSION_ID = "session-1";

function loadWebServiceManager() {
	return loadTsCommonJs("src/main/web/WebServiceManager.ts", {
		globals: {
			fetch: globalThis.fetch,
			Response: globalThis.Response,
			ReadableStream: globalThis.ReadableStream,
		},
	}).WebServiceManager;
}

function fixture(overrides = {}) {
	let piHandler = null;
	let channelHandler = null;
	const project = { id: "project-1", name: "Project", path: "C:/project" };
	const session = {
		id: SESSION_ID,
		projectId: "project-1",
		title: "DSH Session",
		source: "dsh",
		environment: "native",
		preview: "",
		messageCount: 0,
		status: "draft",
		createdAt: 1,
		updatedAt: 1,
	};
	const runtime = {
		sessionId: SESSION_ID,
		agentId: AGENT_ID,
		runtimeGeneration: 1,
		projectId: "project-1",
		cwd: "C:/project",
		status: "running",
		createdAt: 2,
	};
	const deps = {
		subscribePiEvents: (handler) => {
			piHandler = handler;
			return () => {
				piHandler = null;
			};
		},
		subscribeAgentChannelEvents: (handler) => {
			channelHandler = handler;
			return () => {
				channelHandler = null;
			};
		},
		getSessionIdForAgent: (agentId) => (agentId === AGENT_ID ? SESSION_ID : undefined),
		listProjects: () => [project],
		listAgents: () => [],
		listModels: async () => [],
		listSessions: async () => [session],
		listCatalogSessions: async () => [session],
		listSessionRuntimes: () => [runtime],
		listPendingUiRequests: () => [],
		sendSessionPrompt: async () => ({ accepted: true }),
		...overrides,
	};
	return {
		deps,
		emit: (channel, payload) => {
			assert.equal(typeof channelHandler, "function", "subscribeAgentChannelEvents 必须被绑定");
			channelHandler(AGENT_ID, channel, payload);
		},
		emitPi: (event) => {
			assert.equal(typeof piHandler, "function", "subscribePiEvents 必须被绑定");
			piHandler(AGENT_ID, event);
		},
		setRuntimeStatus: (status) => {
			runtime.status = status;
		},
	};
}

/**
 * SSE 读取器：把响应体切成 `data:` 块。/api/chat 的帧没有 event 名，
 * /api/events 带 `event: state`；两者都返回 { name, data }，data 已按需解析。
 */
function createSseReader(response) {
	const decoder = new TextDecoder();
	let buffer = "";
	let ended = false;
	const queue = [];
	const waiters = [];
	const push = (message) => {
		const waiter = waiters.shift();
		if (waiter) waiter(message);
		else queue.push(message);
	};
	const pump = async () => {
		const reader = response.body.getReader();
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let separator;
				while ((separator = buffer.indexOf("\n\n")) >= 0) {
					const block = buffer.slice(0, separator);
					buffer = buffer.slice(separator + 2);
					const data = /^data: (.*)$/m.exec(block)?.[1];
					if (data === undefined) continue; // 心跳注释帧（: ping）
					const name = /^event: (.+)$/m.exec(block)?.[1];
					push({ name: name ?? null, data });
				}
			}
		} catch {
			// 服务端关闭连接：读循环抛错与正常结束都算流终止
		}
		ended = true;
		while (waiters.length > 0) waiters.shift()(null);
	};
	void pump();
	const next = (timeoutMs) =>
		new Promise((resolve) => {
			if (queue.length > 0) {
				resolve(queue.shift());
				return;
			}
			if (ended) {
				resolve(null);
				return;
			}
			const waiter = (message) => resolve(message);
			waiters.push(waiter);
			setTimeout(() => {
				const index = waiters.indexOf(waiter);
				if (index >= 0) waiters.splice(index, 1);
				resolve(null);
			}, timeoutMs);
		});
	return {
		next,
		/** 等 n 条消息；不足（超时/提前结束）时返回已收到的部分。 */
		collect: async (count, timeoutMs = 2000) => {
			const items = [];
			for (let index = 0; index < count; index += 1) {
				const item = await next(timeoutMs);
				if (!item) break;
				items.push(item);
			}
			return items;
		},
		/** 取 n 条 data-only 帧并解析成对象（[DONE] 折成 { type: "[DONE]" }）——见模块级 collectFrames。 */
		waitEnded: (timeoutMs = 2000) =>
			new Promise((resolve) => {
				if (ended) {
					resolve(true);
					return;
				}
				const timer = setTimeout(() => resolve(false), timeoutMs);
				const poll = () => {
					if (ended) {
						clearTimeout(timer);
						resolve(true);
						return;
					}
					setTimeout(poll, 20);
				};
				poll();
			}),
		isEnded: () => ended,
	};
}

/** data-only 帧收集（把 [DONE] 折成帧，解析 JSON）。 */
async function collectFrames(reader, count, timeoutMs = 2000) {
	const frames = [];
	for (let index = 0; index < count; index += 1) {
		const message = await reader.next(timeoutMs);
		if (!message) break;
		frames.push(message.data === "[DONE]" ? { type: "[DONE]" } : JSON.parse(message.data));
	}
	return frames;
}

async function readFrame(reader, timeoutMs = 2000) {
	const message = await reader.next(timeoutMs);
	if (!message) return null;
	return message.data === "[DONE]" ? { type: "[DONE]" } : JSON.parse(message.data);
}

const types = (frames) => frames.map((frame) => frame.type);

test("/api/chat 流式转发 DSH 正文/思考/工具，并在 turnEnded 时 finish 收流", async () => {
	const WebServiceManager = loadWebServiceManager();
	const harness = fixture();
	const manager = new WebServiceManager(harness.deps);
	await manager.start("127.0.0.1", 0, false);
	try {
		const response = await fetch(`http://127.0.0.1:${manager.current.port}/api/chat`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				id: SESSION_ID,
				messageId: "msg-1",
				messages: [{ role: "user", parts: [{ type: "text", text: "你好" }] }],
			}),
		});
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("x-vercel-ai-ui-message-stream"), "v1");
		const reader = createSseReader(response);

		// turn/start 的 reset 帧：清游标但不算收口，不该产出任何 UI 帧
		harness.emit("agents:text-stream", { agentId: AGENT_ID, text: "", done: true, reset: true });
		assert.equal(await readFrame(reader, 300), null, "reset 帧不该产出 UI 帧");

		// 正文按增量上屏（累积快照 → 只发新增部分）
		harness.emit("agents:text-stream", { agentId: AGENT_ID, text: "你好", done: false });
		const first = await collectFrames(reader, 3);
		assert.deepEqual(types(first), ["start", "text-start", "text-delta"]);
		assert.equal(first[2].delta, "你好");
		harness.emit("agents:text-stream", { agentId: AGENT_ID, text: "你好，世界", done: false });
		const second = await collectFrames(reader, 1);
		assert.equal(second[0].type, "text-delta");
		assert.equal(second[0].delta, "，世界");

		// 思考走 reasoning 块
		harness.emit("agents:thinking", { agentId: AGENT_ID, id: "t1", text: "先想", startedAt: 1, done: false });
		assert.deepEqual(types(await collectFrames(reader, 2)), ["reasoning-start", "reasoning-delta"]);

		// 工具卡：运行中开卡，转终态补 output
		const toolMessage = (status) => ({
			id: "dsh:5",
			agentId: AGENT_ID,
			role: "tool",
			text: "read",
			timestamp: 5,
			meta: { toolCallId: "call-1", toolName: "read", status, args: { path: "a.ts" } },
		});
		harness.emit("agents:message", {
			agentId: AGENT_ID,
			totalLength: 2,
			messages: [{ id: "dsh:1", agentId: AGENT_ID, role: "user", text: "你好", timestamp: 1 }, toolMessage("running")],
		});
		assert.deepEqual(types(await collectFrames(reader, 2)), ["tool-input-start", "tool-input-available"]);
		harness.emit("agents:message", {
			agentId: AGENT_ID,
			totalLength: 2,
			messages: [
				{ id: "dsh:1", agentId: AGENT_ID, role: "user", text: "你好", timestamp: 1 },
				{ ...toolMessage("done"), text: "read: ok" },
			],
		});
		assert.deepEqual(types(await collectFrames(reader, 1)), ["tool-output-available"]);

		// 整轮结束：关块 + finish + [DONE]，并且连接必须结束 —— 否则 useChat 永远停在
		// streaming，「结束/停止」在 Web 端永远察觉不到。
		harness.emit("agents:text-stream", { agentId: AGENT_ID, text: "你好，世界", done: true, turnEnded: true });
		assert.deepEqual(types(await collectFrames(reader, 3)), ["text-end", "reasoning-end", "finish"]);
		const done = await readFrame(reader, 2000);
		assert.equal(done?.type, "[DONE]");
		assert.ok(await reader.waitEnded(2000), "整轮结束后 /api/chat 流必须关闭");
	} finally {
		await manager.stop();
	}
});

test("/api/sessions/:id/stream 保活：整轮结束后连接保留，下一轮继续收帧", async () => {
	const WebServiceManager = loadWebServiceManager();
	const harness = fixture();
	const manager = new WebServiceManager(harness.deps);
	await manager.start("127.0.0.1", 0, false);
	try {
		const response = await fetch(`http://127.0.0.1:${manager.current.port}/api/sessions/${SESSION_ID}/stream`);
		assert.equal(response.status, 200);
		const reader = createSseReader(response);

		harness.emit("agents:text-stream", { agentId: AGENT_ID, text: "", done: true, reset: true });
		harness.emit("agents:text-stream", { agentId: AGENT_ID, text: "第一轮", done: false });
		harness.emit("agents:text-stream", { agentId: AGENT_ID, text: "第一轮", done: true, turnEnded: true });
		const firstTurn = await collectFrames(reader, 6);
		assert.deepEqual(types(firstTurn), ["start", "text-start", "text-delta", "text-end", "finish", "[DONE]"]);
		assert.equal(reader.isEnded(), false, "外部流整轮结束后必须保活");

		// 第二轮：reset + 正文 → 新一条消息的 start 帧（客户端据此重置合并器）
		harness.emit("agents:text-stream", { agentId: AGENT_ID, text: "", done: true, reset: true });
		harness.emit("agents:text-stream", { agentId: AGENT_ID, text: "第二轮", done: false });
		const secondTurn = await collectFrames(reader, 3);
		assert.deepEqual(types(secondTurn), ["start", "text-start", "text-delta"]);
		assert.equal(secondTurn[0].messageId, "dsh-run-2");
		assert.equal(secondTurn[2].delta, "第二轮");
		await response.body.cancel().catch(() => undefined);
	} finally {
		await manager.stop();
	}
});

test("/api/events 在 DSH 通道事件到达时推送状态（不必等 5s tick）", async () => {
	const WebServiceManager = loadWebServiceManager();
	const harness = fixture();
	const manager = new WebServiceManager(harness.deps);
	await manager.start("127.0.0.1", 0, false);
	try {
		const response = await fetch(`http://127.0.0.1:${manager.current.port}/api/events`);
		const reader = createSseReader(response);
		const initial = await reader.next(2000);
		assert.equal(initial?.name, "state");
		assert.equal(JSON.parse(initial.data).runtimes[0].status, "running");

		// 忙闲翻转 + 一条 DSH 通道事件：状态推送必须立刻跟到（去抖 400ms 内）
		harness.setRuntimeStatus("idle");
		harness.emit("agents:runtime-state", { agentId: AGENT_ID, state: { isStreaming: false } });
		const pushed = await reader.next(2000);
		assert.ok(pushed, "DSH 通道事件必须触发状态推送");
		assert.equal(pushed.name, "state");
		assert.equal(JSON.parse(pushed.data).runtimes[0].status, "idle");
		await response.body.cancel().catch(() => undefined);
	} finally {
		await manager.stop();
	}
});
