import assert from "node:assert/strict";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// PiDeck Lite 兼容层接线验收：真实起一个 WebServiceManager，按 UA 分流 /api/state，
// 并验证写路径确实接到了 PiDeck 的依赖。不依赖 Electron。
function makeManager() {
	const { WebServiceManager } = loadTsCommonJs("src/main/web/WebServiceManager.ts", {
		globals: { fetch: globalThis.fetch },
	});
	const calls = {};
	const manager = new WebServiceManager({
		subscribePiEvents: () => () => undefined,
		getSessionIdForAgent: () => undefined,
		listProjects: () => [{ id: "p1", name: "Demo", path: "/work/demo" }],
		listCatalogSessions: async () => [{ id: "s1", projectId: "p1", title: "Hello", status: "idle", updatedAt: 7, projectPath: "/work/demo" }],
		listSessionRuntimes: () => [{ sessionId: "s1", agentId: "a1", runtimeGeneration: 1, projectId: "p1", cwd: "/work/demo", status: "idle", createdAt: 1 }],
		listPendingUiRequests: () => [{ sessionId: "s1", agentId: "a1", runtimeGeneration: 1, requestId: "r1", method: "confirm", title: "Allow?", options: ["yes", "no"] }],
		readSessionMessages: async () => ({
			messages: [{ id: "m1", agentId: "a1", role: "user", text: "hi", timestamp: 1 }],
			total: 1,
			windowStart: 0,
			truncated: false,
		}),
		getAppVersion: () => "9.9.9",
		getLiveText: (sessionId) => (sessionId === "s1" ? "partial reply" : ""),
		listModels: async () => [{ id: "m1", name: "Model", provider: "prov", reasoning: true, thinkingLevels: ["low", "high"] }],
		createSessionDraft: async (input) => {
			calls.create = input;
			return { id: "s2", title: "New", projectId: input.projectId, status: "idle" };
		},
		sendSessionPrompt: async (input) => {
			calls.prompt = input;
			return { accepted: true, sessionId: input.sessionId, requestId: input.requestId };
		},
		setSessionRuntimeModel: async (target, provider, modelId) => {
			calls.model = { target, provider, modelId };
			return { ok: true, value: {} };
		},
		setSessionRuntimeThinking: async (target, level) => {
			calls.thinking = { target, level };
			return { ok: true, value: {} };
		},
		stopSessionRuntime: async (target) => {
			calls.stop = target;
			return { ok: true, value: {} };
		},
		updateSessionRecord: async (sessionId, patch) => {
			calls.rename = { sessionId, patch };
			return { id: sessionId, ...patch };
		},
		respondToUi: async (input) => {
			calls.answer = input;
		},
	});
	return { manager, calls };
}

test("Lite 兼容层：Go 客户端拿到 Lite 形状，浏览器仍拿 PiDeck 形状", async () => {
	const { manager } = makeManager();
	await manager.start("127.0.0.1", 0, false);
	const port = manager.current.port;
	const base = `http://127.0.0.1:${port}`;
	try {
		await manager.applySettings({ webServiceEnabled: true, webServiceHost: "127.0.0.1", webServicePort: port, webServiceRequiresAuth: false, webLiteCompatEnabled: true });

		const ping = await fetch(`${base}/api/ping`, { headers: { "user-agent": "Go-http-client/1.1" } });
		assert.equal(ping.status, 200);
		const pingBody = await ping.json();
		assert.equal(pingBody.name, "PiDeck");
		assert.equal(pingBody.version, "9.9.9");

		// Go 客户端：Lite Snapshot，projects[].sessions[] 嵌套
		const liteState = await fetch(`${base}/api/state`, { headers: { "user-agent": "Go-http-client/1.1" } });
		const liteBody = await liteState.json();
		assert.equal(liteBody.projects[0].name, "Demo");
		assert.equal(liteBody.projects[0].sessions[0].id, "s1");
		assert.equal(liteBody.projects[0].sessions[0].title, "Hello");

		// 浏览器：仍是 PiDeck 扁平形状（sessions 在顶层，projects 不嵌套 sessions）
		const browserState = await fetch(`${base}/api/state`, { headers: { "user-agent": "Mozilla/5.0" } });
		const browserBody = await browserState.json();
		assert.ok(Array.isArray(browserBody.sessions));
		assert.equal(browserBody.sessions[0].id, "s1");
		assert.equal(browserBody.projects[0].sessions, undefined);

		// 会话对话：Lite Transcript
		const transcript = await fetch(`${base}/api/session/s1`, { headers: { "user-agent": "Go-http-client/1.1" } });
		const transcriptBody = await transcript.json();
		assert.equal(transcriptBody.id, "s1");
		assert.equal(transcriptBody.messages[0].role, "user");
		assert.equal(transcriptBody.messages[0].text, "hi");
		assert.equal(transcriptBody.messages[1].role, "assistant", "轮询时追加运行中正文");
		assert.equal(transcriptBody.messages[1].text, "partial reply");
		assert.equal(transcriptBody.before, 0);
	} finally {
		await manager.stop();
	}
});

test("Lite 兼容层关闭时 /api/ping 不存在（零行为变化）", async () => {
	const { manager } = makeManager();
	await manager.start("127.0.0.1", 0, false);
	const port = manager.current.port;
	try {
		await manager.applySettings({ webServiceEnabled: true, webServiceHost: "127.0.0.1", webServicePort: port, webServiceRequiresAuth: false, webLiteCompatEnabled: false });
		const response = await fetch(`http://127.0.0.1:${port}/api/ping`, { headers: { "user-agent": "Go-http-client/1.1" } });
		assert.equal(response.status, 404);
	} finally {
		await manager.stop();
	}
});

test("Lite 兼容层写路径：建会话 / 发消息 / 切模型思考 / 停止 / 改名 / 回答", async () => {
	const { manager, calls } = makeManager();
	await manager.start("127.0.0.1", 0, false);
	const port = manager.current.port;
	const base = `http://127.0.0.1:${port}`;
	const headers = { "user-agent": "Go-http-client/1.1", "content-type": "application/json" };
	try {
		await manager.applySettings({ webServiceEnabled: true, webServiceHost: "127.0.0.1", webServicePort: port, webServiceRequiresAuth: false, webLiteCompatEnabled: true });

		const create = await fetch(`${base}/api/sessions`, { method: "POST", headers, body: JSON.stringify({ project: "/work/demo" }) });
		assert.equal(create.status, 200);
		assert.deepEqual(await create.json(), { id: "s2", title: "New" });
		assert.equal(calls.create.projectId, "p1", "项目路径解析成 projectId");

		const prompt = await fetch(`${base}/api/sessions/s1/prompt`, { method: "POST", headers, body: JSON.stringify({ text: "hello" }) });
		assert.equal(prompt.status, 200);
		assert.equal(calls.prompt.message, "hello");
		assert.ok(calls.prompt.requestId, "兼容层补 requestId");

		const model = await fetch(`${base}/api/sessions/s1/model`, { method: "POST", headers, body: JSON.stringify({ provider: "prov", id: "m1" }) });
		assert.equal(model.status, 200);
		assert.equal(calls.model.modelId, "m1");

		const thinking = await fetch(`${base}/api/sessions/s1/thinking`, { method: "POST", headers, body: JSON.stringify({ level: "high" }) });
		assert.equal(thinking.status, 200);
		assert.equal(calls.thinking.level, "high");

		const stop = await fetch(`${base}/api/sessions/s1/stop`, { method: "POST", headers, body: "{}" });
		assert.equal(stop.status, 200);
		assert.equal(calls.stop.sessionId, "s1");

		const rename = await fetch(`${base}/api/sessions/s1/rename`, { method: "POST", headers, body: JSON.stringify({ title: "Renamed" }) });
		assert.equal(rename.status, 200);
		assert.equal(calls.rename.patch.title, "Renamed");

		const answer = await fetch(`${base}/api/sessions/s1/answer`, { method: "POST", headers, body: JSON.stringify({ confirmed: true }) });
		assert.equal(answer.status, 200);
		assert.equal(calls.answer.requestId, "r1");
		assert.equal(calls.answer.response.confirmed, true);
	} finally {
		await manager.stop();
	}
});
