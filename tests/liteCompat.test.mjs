import assert from "node:assert/strict";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// PiDeck Lite 移动端兼容层：只测纯投影与客户端识别，不起 HTTP 服务。
const loadModule = (rel) => loadTsCommonJs(rel);

test("isLiteClientUserAgent 只认 Go 默认客户端，浏览器 UA 不误判", () => {
	const { isLiteClientUserAgent } = loadModule("src/main/web/LiteCompatRoutes.ts");
	assert.equal(isLiteClientUserAgent("Go-http-client/1.1"), true);
	assert.equal(isLiteClientUserAgent("Go-http-client/2.0"), true);
	assert.equal(isLiteClientUserAgent(["Go-http-client/1.1"]), true);
	assert.equal(isLiteClientUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)"), false);
	assert.equal(isLiteClientUserAgent("curl/8.0"), false);
	assert.equal(isLiteClientUserAgent(""), false);
	assert.equal(isLiteClientUserAgent(undefined), false);
});

test("flattenChatMessage 跳过思考副本，保留原角色", () => {
	const { flattenChatMessage } = loadModule("src/main/web/LiteCompatRoutes.ts");
	assert.deepEqual(JSON.parse(JSON.stringify(flattenChatMessage({ role: "assistant", text: "raw <thinking>x</thinking>", textWithoutThinking: "clean" }))), { role: "assistant", text: "clean" });
	assert.deepEqual(JSON.parse(JSON.stringify(flattenChatMessage({ role: "user", text: "hello" }))), { role: "user", text: "hello" });
	assert.deepEqual(JSON.parse(JSON.stringify(flattenChatMessage({ role: "tool", text: "ran" }))), { role: "tool", text: "ran" });
});

test("toLiteSnapshot 按 projectId 分组、推导 running、保留本地/远端路径", () => {
	const { toLiteSnapshot } = loadModule("src/main/web/LiteCompatRoutes.ts");
	const state = {
		projects: [
			{ id: "p1", name: "Alpha", path: "C:/work/alpha" },
			{ id: "p2", name: "Remote", locator: { kind: "ssh", hostId: "h1", remotePath: "/srv/beta" } },
		],
		sessions: [
			{ id: "s1", projectId: "p1", title: "One", status: "idle", updatedAt: 10, projectPath: "C:/work/alpha" },
			{ id: "s2", projectId: "p1", title: "Two", status: "running", updatedAt: 20, projectPath: "C:/work/alpha" },
			{ id: "s3", projectId: "p2", title: "Three", status: "idle", updatedAt: 123.456, projectPath: "/srv/beta" },
			{ id: "s4", projectId: "gone", title: "Orphan", status: "idle", updatedAt: 1, projectPath: "C:/elsewhere/orphan" },
		],
		runtimes: [{ sessionId: "s2", status: "running" }],
	};
	const snapshot = JSON.parse(JSON.stringify(toLiteSnapshot(state, "9.9.9")));
	assert.equal(snapshot.name, "PiDeck");
	assert.equal(snapshot.version, "9.9.9");
	assert.equal(snapshot.projects.length, 3, "两个目录项目 + 一个孤儿会话合成项目");

	const alpha = snapshot.projects.find((project) => project.name === "Alpha");
	assert.equal(alpha.path, "C:/work/alpha");
	assert.deepEqual(
		alpha.sessions.map((session) => session.id),
		["s2", "s1"],
		"按更新时间倒序",
	);
	assert.equal(alpha.sessions.find((session) => session.id === "s2").running, true);
	assert.equal(alpha.sessions.find((session) => session.id === "s1").running, false);

	const remote = snapshot.projects.find((project) => project.name === "Remote");
	assert.equal(remote.path, "/srv/beta", "远端项目取 locator.remotePath");
	assert.deepEqual(
		remote.sessions.map((session) => session.id),
		["s3"],
	);
	assert.equal(remote.sessions[0].updated, 123, "updated 必须是整数：Lite Go 端 int64 不接受小数");

	const orphan = snapshot.projects.find((project) => project.path === "C:/elsewhere/orphan");
	assert.equal(orphan.name, "orphan", "目录缺失时用路径末段命名，会话不丢");
	assert.deepEqual(
		orphan.sessions.map((session) => session.id),
		["s4"],
	);
});

test("LiteCompatRoutes.handle 只对 Go 客户端接管 /api/state，其余端点无条件接管", async () => {
	const { LiteCompatRoutes } = loadModule("src/main/web/LiteCompatRoutes.ts");
	const sent = [];
	const routes = new LiteCompatRoutes({
		getState: async () => ({ projects: [], sessions: [], runtimes: [] }),
		readSessionMessages: async () => ({ messages: [], truncated: false }),
		getAppVersion: () => "1.0",
		sendJson: (_response, body) => sent.push(body),
		sendError: () => {},
	});
	const makeRequest = (userAgent) => ({ method: "GET", headers: { "user-agent": userAgent } });
	const response = {};

	// 浏览器 UA 访问 /api/state：不接管，交还 PiDeck 原路由
	assert.equal(await routes.handle(new URL("http://host/api/state"), makeRequest("Mozilla/5.0"), response), false);
	// Go 客户端访问 /api/state：接管并返回 Lite Snapshot
	assert.equal(await routes.handle(new URL("http://host/api/state"), makeRequest("Go-http-client/1.1"), response), true);
	assert.equal(sent.at(-1).name, "PiDeck");
	// /api/ping 与 /api/session/{id} 不与 PiDeck 现有路径冲突，无条件接管
	assert.equal(await routes.handle(new URL("http://host/api/ping"), makeRequest("Mozilla/5.0"), response), true);
	assert.equal(await routes.handle(new URL("http://host/api/session/s1"), makeRequest("Mozilla/5.0"), response), true);
	// 非 GET 不接管
	assert.equal(await routes.handle(new URL("http://host/api/ping"), { method: "POST", headers: {} }, response), false);
});

test("toLiteOptions 输出模型目录、当前模型与思考档位", () => {
	const { toLiteOptions } = loadModule("src/main/web/LiteCompatRoutes.ts");
	const models = [
		{ id: "m1", name: "Model One", provider: "prov", reasoning: true, thinkingLevels: ["low", "high"] },
		{ id: "m2", provider: "prov2" },
	];
	const session = { id: "s1", projectId: "p1", title: "T", status: "idle", model: { provider: "prov", modelId: "m1" }, thinkingLevel: "high" };
	const options = JSON.parse(JSON.stringify(toLiteOptions(models, session)));
	assert.deepEqual(options.models, [
		{ id: "m1", name: "Model One", provider: "prov", reasoning: true },
		{ id: "m2", name: "m2", provider: "prov2", reasoning: false },
	]);
	assert.equal(options.model, "m1");
	assert.equal(options.provider, "prov");
	assert.equal(options.thinking, "high");
	assert.deepEqual(options.levels, ["low", "high"], "优先用模型自己的 thinkingLevels");
	assert.equal(options.ready, true);
	// 没有会话/模型时回落静态档位表，避免选择器为空
	const fallback = JSON.parse(JSON.stringify(toLiteOptions([], undefined)));
	assert.equal(fallback.ready, false);
	assert.ok(fallback.levels.length > 0);
});

test("toLiteSnapshot / toLiteTranscript 携带待回答 ask", () => {
	const { toLiteSnapshot, toLiteTranscript } = loadModule("src/main/web/LiteCompatRoutes.ts");
	const pending = { sessionId: "s1", agentId: "a1", runtimeGeneration: 2, requestId: "r1", method: "confirm", title: "Allow?", options: ["yes", "no"] };
	const state = {
		projects: [{ id: "p1", name: "Demo", path: "/work/demo" }],
		sessions: [{ id: "s1", projectId: "p1", title: "One", status: "idle", updatedAt: 1, projectPath: "/work/demo" }],
		runtimes: [],
		pendingUiRequests: [pending],
	};
	const snapshot = JSON.parse(JSON.stringify(toLiteSnapshot(state, "1.0")));
	assert.deepEqual(snapshot.projects[0].sessions[0].ask, { method: "confirm", title: "Allow?", message: "", options: ["yes", "no"] });

	const transcript = JSON.parse(JSON.stringify(toLiteTranscript({ sessionId: "s1", messages: [], ask: { method: "confirm", title: "Allow?", message: "", options: ["yes", "no"] } })));
	assert.equal(transcript.ask.title, "Allow?");
});

function makeWriteRoutes() {
	const { LiteCompatRoutes } = loadModule("src/main/web/LiteCompatRoutes.ts");
	const calls = {};
	const sent = [];
	const errors = [];
	let body = null;
	let state = { projects: [], sessions: [], runtimes: [], pendingUiRequests: [] };
	const routes = new LiteCompatRoutes({
		getState: async () => state,
		readSessionMessages: async () => ({ messages: [], truncated: false }),
		getAppVersion: () => "1.0",
		listProjects: () => [{ id: "p1", name: "Demo", path: "C:/work/demo" }],
		listModels: async () => [],
		createSession: async (input) => {
			calls.create = input;
			return { id: "s1", title: "New" };
		},
		sendPrompt: async (input) => {
			calls.prompt = input;
			return { accepted: true };
		},
		getRuntimeTarget: (sessionId) => ({ sessionId, agentId: "a1", runtimeGeneration: 1 }),
		activateRuntime: undefined,
		setModel: async (target, provider, modelId, modelName) => {
			calls.model = { target, provider, modelId, modelName };
			return { ok: true };
		},
		setThinking: async (target, level) => {
			calls.thinking = { target, level };
			return { ok: true };
		},
		stopRuntime: async (target) => {
			calls.stop = target;
			return { ok: true };
		},
		updateSession: async (sessionId, patch) => {
			calls.rename = { sessionId, patch };
			return {};
		},
		respondToUi: async (input) => {
			calls.answer = input;
		},
		readJson: async () => body,
		sendJson: (_response, payload) => sent.push(payload),
		sendError: (_response, statusCode, code, error) => errors.push({ statusCode, code, error }),
	});
	return {
		routes,
		calls,
		sent,
		errors,
		setBody: (value) => {
			body = value;
		},
		setState: (value) => {
			state = value;
		},
	};
}

const post = (userAgent) => ({ method: "POST", headers: { "user-agent": userAgent } });

test("写入路径：建会话 / 发消息 / 切模型思考 / 停止 / 改名", async () => {
	const { routes, calls, sent, setBody } = makeWriteRoutes();
	const response = {};

	setBody({ project: "C:/work/demo" });
	assert.equal(await routes.handle(new URL("http://host/api/sessions"), post("Go-http-client/1.1"), response), true);
	assert.deepEqual(JSON.parse(JSON.stringify(calls.create)), { projectId: "p1" });
	assert.deepEqual(JSON.parse(JSON.stringify(sent.at(-1))), { id: "s1", title: "New" });
	// 浏览器 UA 不接管同路径，交还 PiDeck
	assert.equal(await routes.handle(new URL("http://host/api/sessions"), post("Mozilla/5.0"), response), false);

	setBody({ text: "hi", images: [{ mime: "image/png", data: "AAA" }] });
	assert.equal(await routes.handle(new URL("http://host/api/sessions/s1/prompt"), post("Go-http-client/1.1"), response), true);
	assert.equal(calls.prompt.message, "hi");
	assert.equal(calls.prompt.images[0].mimeType, "image/png");
	assert.ok(calls.prompt.requestId, "必须补 requestId");

	setBody({ provider: "prov", id: "m1" });
	assert.equal(await routes.handle(new URL("http://host/api/sessions/s1/model"), post("Go-http-client/1.1"), response), true);
	assert.deepEqual(JSON.parse(JSON.stringify(calls.model)), { target: { sessionId: "s1", agentId: "a1", runtimeGeneration: 1 }, provider: "prov", modelId: "m1" });

	setBody({ level: "high" });
	assert.equal(await routes.handle(new URL("http://host/api/sessions/s1/thinking"), post("Go-http-client/1.1"), response), true);
	assert.equal(calls.thinking.level, "high");

	assert.equal(await routes.handle(new URL("http://host/api/sessions/s1/stop"), post("Go-http-client/1.1"), response), true);
	assert.deepEqual(JSON.parse(JSON.stringify(calls.stop)), { sessionId: "s1", agentId: "a1", runtimeGeneration: 1 });

	setBody({ title: "Renamed" });
	assert.equal(await routes.handle(new URL("http://host/api/sessions/s1/rename"), post("Go-http-client/1.1"), response), true);
	assert.deepEqual(JSON.parse(JSON.stringify(calls.rename)), { sessionId: "s1", patch: { title: "Renamed" } });
});

test("写入路径：回答待确认问题，缺少待答请求时报 409", async () => {
	const { routes, calls, errors, setBody, setState } = makeWriteRoutes();
	const response = {};

	setState({ projects: [], sessions: [], runtimes: [], pendingUiRequests: [] });
	setBody({ confirmed: true });
	assert.equal(await routes.handle(new URL("http://host/api/sessions/s1/answer"), post("Go-http-client/1.1"), response), true);
	assert.equal(errors.at(-1).statusCode, 409);

	setState({
		projects: [],
		sessions: [],
		runtimes: [],
		pendingUiRequests: [{ sessionId: "s1", agentId: "a1", runtimeGeneration: 3, requestId: "r1", method: "confirm", title: "OK?" }],
	});
	setBody({ confirmed: true });
	assert.equal(await routes.handle(new URL("http://host/api/sessions/s1/answer"), post("Go-http-client/1.1"), response), true);
	assert.deepEqual(JSON.parse(JSON.stringify(calls.answer)), { sessionId: "s1", requestId: "r1", agentId: "a1", runtimeGeneration: 3, response: { confirmed: true } });
});

test("写入路径：模型命令返回 ok:false 时上抛可读错误", async () => {
	const { LiteCompatRoutes } = loadModule("src/main/web/LiteCompatRoutes.ts");
	const errors = [];
	let body = { provider: "prov", id: "m1" };
	const routes = new LiteCompatRoutes({
		getState: async () => ({ projects: [], sessions: [], runtimes: [], pendingUiRequests: [] }),
		readSessionMessages: async () => ({ messages: [], truncated: false }),
		listProjects: () => [],
		listModels: async () => [],
		createSession: async () => ({ id: "", title: "" }),
		sendPrompt: async () => ({ accepted: true }),
		getRuntimeTarget: (sessionId) => ({ sessionId, agentId: "a1", runtimeGeneration: 1 }),
		setModel: async () => ({ ok: false, error: "model not allowed" }),
		setThinking: async () => ({ ok: true }),
		stopRuntime: async () => ({ ok: true }),
		updateSession: async () => ({}),
		respondToUi: async () => {},
		readJson: async () => body,
		sendJson: () => {},
		sendError: (_response, statusCode, code, error) => errors.push({ statusCode, code, error }),
	});
	assert.equal(await routes.handle(new URL("http://host/api/sessions/s1/model"), post("Go-http-client/1.1"), {}), true);
	assert.deepEqual(JSON.parse(JSON.stringify(errors.at(-1))), { statusCode: 400, code: "liteCompat.modelFailed", error: "model not allowed" });
});

test("toLiteTranscript 追加运行中正文，终态已包含时不重复", () => {
	const { toLiteTranscript } = loadModule("src/main/web/LiteCompatRoutes.ts");
	const live = JSON.parse(JSON.stringify(toLiteTranscript({ sessionId: "s1", messages: [{ role: "user", text: "hi" }], liveText: "typing" })));
	assert.deepEqual(live.messages, [
		{ role: "user", text: "hi" },
		{ role: "assistant", text: "typing" },
	]);
	const done = JSON.parse(JSON.stringify(toLiteTranscript({ sessionId: "s1", messages: [{ role: "assistant", text: "typing" }], liveText: "typing" })));
	assert.deepEqual(done.messages, [{ role: "assistant", text: "typing" }], "终态消息已包含实时正文时不重复追加");
});

test("toLiteTranscript 拍平消息并关闭更早分页", () => {
	const { toLiteTranscript } = loadModule("src/main/web/LiteCompatRoutes.ts");
	const transcript = JSON.parse(
		JSON.stringify(
			toLiteTranscript({
				sessionId: "s1",
				title: "One",
				running: true,
				messages: [
					{ role: "assistant", text: "raw", textWithoutThinking: "clean" },
					{ role: "tool", text: "ran" },
				],
				truncated: true,
			}),
		),
	);
	assert.deepEqual(transcript, {
		id: "s1",
		title: "One",
		running: true,
		messages: [
			{ role: "assistant", text: "clean" },
			{ role: "tool", text: "ran" },
		],
		before: 0,
		truncated: true,
	});
});
