/**
 * /api/agents 与 /api/agents/:id/use 的接线（直接驱动路由，假 port + 假响应）。
 *
 * 这两条是 Web 端「智能体」面板的全部写入面：读目录（只读投影）与「使用」（建草稿 + 落绑定）。
 * 重点守的行为：
 * - 未装配目录时回 503（Web 端不展示能点却点不开的入口）；
 * - 「使用」的标题/后端/模型取智能体配置，绑定失败要把刚建的草稿删掉；
 * - 未知智能体在建设会话之前就 404。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { WebApiRoutes } = loadTsCommonJs("src/main/web/WebApiRoutes.ts");

function fakeResponse() {
	return {
		statusCode: 0,
		headers: {},
		body: null,
		headersSent: false,
		req: { headers: {} },
		writeHead(status, headers) {
			this.statusCode = status;
			this.headers = headers ?? {};
			this.headersSent = true;
			return this;
		},
		end(body) {
			this.body = body ?? null;
			try {
				this.json = body ? JSON.parse(body) : null;
			} catch {
				this.json = null;
			}
		},
	};
}

function makeRoutes(deps = {}, options = {}) {
	const calls = { created: [], bound: [], deleted: [] };
	const port = {
		deps: {
			createSessionDraft: async (input) => {
				calls.created.push(input);
				return { id: "session-new", projectId: input.projectId, title: input.title, status: "draft" };
			},
			deleteSessionRecord: async (sessionId) => {
				calls.deleted.push(sessionId);
				return true;
			},
			...deps,
		},
		sendJson: (response, body) => {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify(body));
		},
		sendError: (response, statusCode, code, error) => {
			response.writeHead(statusCode, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: { code, message: error } }));
		},
		sendNoContent: (response) => response.writeHead(204, {}),
		readJson: async () => options.body ?? {},
		queryNumber: () => undefined,
		getState: async () => ({ projects: [], sessions: [], runtimes: [], pendingUiRequests: [] }),
		runtimeAgentIdForSession: () => undefined,
		runtimeTargetForSession: () => undefined,
		executeRestartWithProgress: async () => {},
		handleStream: () => {},
		writeStreamError: () => {},
	};
	return { routes: new WebApiRoutes(port), calls };
}

const AGENT = {
	id: "agent-1",
	name: "代码审查",
	description: "审 diff",
	icon: "🔍",
	category: "coding",
	builtin: false,
	backend: "dsh",
	model: { provider: "openai", modelId: "gpt-5" },
	systemPrompt: "你是审查员",
	createdAt: 1,
	updatedAt: 2,
	usageCount: 3,
};

test("GET /api/agents 投影目录：内置标记布尔化、角色设定一并下发、内部时间戳不外泄", async () => {
	const { routes } = makeRoutes({ listAgentProfiles: () => [AGENT] });
	const response = fakeResponse();
	const handled = await routes.handle(new URL("http://127.0.0.1/api/agents"), { method: "GET", headers: {} }, response);
	assert.equal(handled, true);
	assert.equal(response.statusCode, 200);
	assert.equal(response.json.agents.length, 1);
	const [agent] = response.json.agents;
	assert.equal(agent.id, "agent-1");
	assert.equal(agent.name, "代码审查");
	assert.equal(agent.icon, "🔍");
	assert.equal(agent.backend, "dsh");
	assert.deepEqual(agent.model, { provider: "openai", modelId: "gpt-5" });
	assert.equal(agent.systemPrompt, "你是审查员", "详情面板要展示角色设定");
	assert.equal(agent.builtin, false);
	assert.equal("createdAt" in agent, false, "内部时间戳没有消费方，不下发");
});

test("GET /api/agents：目录未装配时 503（Web 端据此不展示入口）", async () => {
	const { routes } = makeRoutes({ listAgentProfiles: undefined });
	const response = fakeResponse();
	await routes.handle(new URL("http://127.0.0.1/api/agents"), { method: "GET", headers: {} }, response);
	assert.equal(response.statusCode, 503);
	assert.equal(response.json.error.code, "webError.agentsUnavailable");
});

test("POST /api/agents/:id/use：按智能体配置建草稿并落绑定", async () => {
	const bound = [];
	const { routes, calls } = makeRoutes(
		{
			listAgentProfiles: () => [AGENT],
			bindSessionAgent: async (sessionId, agentId) => bound.push({ sessionId, agentId }),
		},
		{ body: { projectId: "p1" } },
	);
	const response = fakeResponse();
	const handled = await routes.handle(new URL("http://127.0.0.1/api/agents/agent-1/use"), { method: "POST", headers: {} }, response);
	assert.equal(handled, true);
	assert.equal(response.statusCode, 200);
	assert.equal(calls.created.length, 1);
	const draft = calls.created[0];
	assert.equal(draft.projectId, "p1");
	assert.equal(draft.title, "🔍 代码审查", "emoji 前缀进标题，侧栏一眼识别");
	assert.equal(draft.backend, "dsh", "智能体指定后端时透传");
	assert.equal(draft.model, undefined, "DSH 的模型是 host route，不能塞 pi 的 provider/modelId");
	assert.deepEqual(bound, [{ sessionId: "session-new", agentId: "agent-1" }]);
	assert.equal(response.json.session.id, "session-new");
	assert.equal(response.json.agent.id, "agent-1");
});

test("POST /api/agents/:id/use：pi 智能体的偏好模型随草稿带入", async () => {
	const { routes, calls } = makeRoutes({ listAgentProfiles: () => [{ ...AGENT, backend: "pi" }], bindSessionAgent: async () => {} }, { body: { projectId: "p1" } });
	const response = fakeResponse();
	await routes.handle(new URL("http://127.0.0.1/api/agents/agent-1/use"), { method: "POST", headers: {} }, response);
	assert.equal(response.statusCode, 200);
	assert.deepEqual(calls.created[0].model, { provider: "openai", modelId: "gpt-5" });
	assert.equal(calls.created[0].backend, undefined, "pi 是默认后端，不显式写 backend");
});

test("POST /api/agents/:id/use：绑定失败删掉刚建的草稿并 400", async () => {
	const { routes, calls } = makeRoutes(
		{
			listAgentProfiles: () => [AGENT],
			bindSessionAgent: async () => {
				throw new Error("binding rejected");
			},
		},
		{ body: { projectId: "p1" } },
	);
	const response = fakeResponse();
	await routes.handle(new URL("http://127.0.0.1/api/agents/agent-1/use"), { method: "POST", headers: {} }, response);
	assert.equal(response.statusCode, 400);
	assert.equal(response.json.error.code, "webError.agentBindFailed");
	assert.deepEqual(calls.deleted, ["session-new"], "不能留下「用了智能体却没人设」的会话");
});

test("POST /api/agents/:id/use：未知智能体在建设会话之前 404", async () => {
	const { routes, calls } = makeRoutes({ listAgentProfiles: () => [AGENT], bindSessionAgent: async () => {} }, { body: { projectId: "p1" } });
	const response = fakeResponse();
	await routes.handle(new URL("http://127.0.0.1/api/agents/missing/use"), { method: "POST", headers: {} }, response);
	assert.equal(response.statusCode, 404);
	assert.equal(calls.created.length, 0, "先校验再建，不留脏草稿");
});

test("POST /api/agents/:id/use：缺 projectId 时 400", async () => {
	const { routes, calls } = makeRoutes({ listAgentProfiles: () => [AGENT], bindSessionAgent: async () => {} });
	const response = fakeResponse();
	await routes.handle(new URL("http://127.0.0.1/api/agents/agent-1/use"), { method: "POST", headers: {} }, response);
	assert.equal(response.statusCode, 400);
	assert.equal(response.json.error.code, "webError.projectIdRequired");
	assert.equal(calls.created.length, 0);
});
