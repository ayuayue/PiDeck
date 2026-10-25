/**
 * AgentManager.setModel 的「Model not found」分类回归测试。
 *
 * 背景（2026-08 用户反馈）：deepseek 官方 provider 的目录模型
 * （deepseek-v4-flash-vision-exp，在 auth.json 有 key、pi --list-models 可见、
 * pi TUI 可用）在 PiDeck 中选择失败，报「模型未找到：…可能尚未在本地
 * models.json 中配置」。根因：运行中 Agent 的模型快照在启动时固化，若目录
 * （models-store.json 等）在 Agent 启动后才更新，set_model 会被 pi 拒绝；
 * 旧实现只检查 models.json（无该 provider）→ 误报「未配置」而非引导重启。
 *
 * 修复：setModel 失败时同时检查注入的目录回调（resolveModelInCatalog，
 * 与选择器同源的 pi --list-models 结果），命中 → needsRestart 引导重启 Agent。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts");

/** 构造一个 set_model 会返回指定 error 的运行时。 */
function runtimeRejectingModel(error) {
	return {
		tab: {
			id: "agent-1",
			projectId: "project-1",
			cwd: "C:/project",
			title: "Session",
			status: "idle",
			sessionPath: "C:/sessions/session-1.jsonl",
			sessionEnvironment: "native",
			sessionSource: "pi",
			createdAt: 1,
		},
		process: { client: { request: async () => ({ success: false, error }) } },
	};
}

/** configManager 替身：models.json 中指定 provider 含指定模型。 */
const configWithModels = (provider, modelId) => ({
	getModelsConfig: async () => ({
		parsed: { providers: { [provider]: { models: [{ id: modelId }] } } },
	}),
});

/** configManager 替身：models.json 无任何模型（模拟无该 provider）。 */
const configWithoutModels = () => ({
	getModelsConfig: async () => ({ parsed: { providers: {} } }),
});

function createManager({ configManager = configWithoutModels(), resolveModelInCatalog } = {}) {
	const manager = new AgentManager(
		() => ({ id: "project-1", name: "Project", path: "C:/project" }),
		() => null,
		{ get: () => ({}) },
		configManager,
		undefined, // rpcLogger
		undefined, // appLogger
		undefined, // sessionFileEditor
		undefined, // translate
		undefined, // onBeforeAgentSpawn
		undefined, // securityStore
		undefined, // repairSessionFile
		undefined, // isFeishuSession
		undefined, // resolveSessionId
		undefined, // resolveSessionProxy
		resolveModelInCatalog, // 目录回调（新增，见构造函数注释）
	);
	manager.agents.set("agent-1", runtimeRejectingModel("Model not found: deepseek/deepseek-v4-flash-vision-exp"));
	return manager;
}

test("setModel: model in local models.json → needsRestart (existing behavior)", async () => {
	const manager = createManager({
		configManager: configWithModels("deepseek", "deepseek-v4-flash"),
	});
	const error = await manager.setModel("agent-1", "deepseek", "deepseek-v4-flash").then(
		() => null,
		(err) => err,
	);
	assert.ok(error && typeof error === "object", "setModel 应抛出错误");
	assert.equal(error.needsRestart, true, "本地 models.json 有模型时引导重启 Agent");
});

test("setModel: model absent from models.json but in pi catalog → needsRestart (regression: deepseek official provider)", async () => {
	// 复现用户场景：models.json 无 deepseek provider，但 pi 目录（--list-models，
	// 含 auth.json provider 目录模型）能识别该模型 → 快照过期而非模型不存在。
	const manager = createManager({
		configManager: configWithoutModels(),
		resolveModelInCatalog: async (provider, modelId) => provider === "deepseek" && modelId === "deepseek-v4-flash-vision-exp",
	});
	const error = await manager.setModel("agent-1", "deepseek", "deepseek-v4-flash-vision-exp").then(
		() => null,
		(err) => err,
	);
	assert.ok(error && typeof error === "object", "setModel 应抛出错误");
	assert.equal(error.needsRestart, true, "模型在 pi 目录（选择器可见）但不在运行中 Agent 快照 → 引导重启而非误报未配置");
});

test("setModel: model in neither models.json nor catalog → plain error (no needsRestart)", async () => {
	const manager = createManager({
		configManager: configWithoutModels(),
		resolveModelInCatalog: async () => false,
	});
	const error = await manager.setModel("agent-1", "deepseek", "deepseek-v4-flash-vision-exp").then(
		() => null,
		(err) => err,
	);
	assert.ok(error && typeof error === "object", "setModel 应抛出错误");
	assert.match(String(error?.message ?? error), /Model not found: deepseek\/deepseek-v4-flash-vision-exp/);
	assert.equal(error.needsRestart, undefined, "真正不存在的模型不应引导重启");
});

test("setModel: catalog callback absent and model not in models.json → plain error", async () => {
	// 未注入目录回调（旧装配/其他调用方）：行为与修复前一致，不抛 undefined。
	const manager = createManager({ configManager: configWithoutModels() });
	const error = await manager.setModel("agent-1", "deepseek", "deepseek-v4-flash-vision-exp").then(
		() => null,
		(err) => err,
	);
	assert.ok(error && typeof error === "object", "setModel 应抛出错误");
	assert.equal(error.needsRestart, undefined);
});

test("setModel and setThinking send only selection commands, never get_state", async () => {
	const requests = [];
	const manager = new AgentManager(
		() => ({ id: "project-1", name: "Project", path: "C:/project" }),
		() => null,
		{ get: () => ({}) },
		configWithoutModels(),
	);
	manager.agents.set("agent-1", {
		tab: {
			id: "agent-1",
			projectId: "project-1",
			cwd: "C:/project",
			title: "Session",
			status: "idle",
			sessionEnvironment: "native",
			sessionSource: "pi",
			createdAt: 1,
		},
		process: {
			client: {
				request: async (request) => {
					requests.push(request.type);
					return { success: true, data: {} };
				},
			},
		},
	});

	await manager.setModel("agent-1", "router9", "qd/qfmodel");
	await manager.setThinking("agent-1", "max");

	assert.deepEqual(requests, ["set_model", "set_thinking_level"]);
});
