import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const bridgeSource = readFileSync("src/main/feishu/FeishuBridge.ts", "utf8");
const mainSource = readFileSync("src/main/index.ts", "utf8");
// 飞书 IPC 处理器已随主进程拆分迁入 ipc/feishuIpc.ts（2027-02），契约同步改读新模块。
const feishuIpcSource = readFileSync("src/main/ipc/feishuIpc.ts", "utf8");

/**
 * 真实加载 FeishuI18n：它现在依赖繁体词典与简繁判定，手写沙箱会因缺 require 桥失败，
 * 统一交给按源文件目录解析的加载器。
 */
function compileFeishuI18n() {
	return createTsSandbox()("src/main/feishu/FeishuI18n.ts");
}

/** 真实加载 AskCard（卡片构建/action 解析必须走真实现，mock 会丢断言）。 */
function compileAskCard(feishuI18n) {
	const output = ts.transpileModule(readFileSync("src/main/feishu/AskCard.ts", "utf8"), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	}).outputText;
	const sandbox = {
		exports: {},
		require: (name) => {
			if (name === "./FeishuI18n") return feishuI18n;
			throw new Error(`unexpected require: ${name}`);
		},
	};
	vm.runInNewContext(output, sandbox, { filename: "AskCard.ts" });
	return sandbox.exports;
}

test("FeishuBridge receives a narrow Session runtime binding gateway", () => {
	assert.match(bridgeSource, /export interface SessionRuntimeBindingGateway/);
	assert.match(bridgeSource, /private runtimeBindings: SessionRuntimeBindingGateway/);
	assert.doesNotMatch(bridgeSource, /sessionRuntimeByIdAtom|bindSessionRuntimeAtom/);
	assert.doesNotMatch(bridgeSource, /this\.agentManager\.(sendPrompt|abort|getRuntimeState|getAvailableModels|setModel)\(/);
});

test("Feishu commands resolve a fresh Session target instead of persisting a generation", () => {
	const gateway = mainSource.match(/const feishuSessionRuntimeBindings:[\s\S]*?\n\};/)?.[0] ?? "";
	assert.match(gateway, /sessionRuntimeCoordinator\.getTarget\(sessionId\)/);
	assert.match(gateway, /sessionRuntimeCoordinator\.send\(/);
	assert.match(gateway, /sessionRuntimeCoordinator\.abortRuntime\(target\)/);
	assert.match(gateway, /sessionRuntimeCoordinator\.setRuntimeModel\(target, provider, modelId\)/);
	assert.doesNotMatch(bridgeSource, /runtimeGeneration/);
});

// 回归（用户点会话连接飞书时未启动 Agent）：feishuSessionBotSet 必须先自动启动 runtime，
// 再建飞书镜像；否则无 runtime 的会话（仅浏览过历史）永远报 runtimeUnavailable。
test("session bot bind auto-starts a missing runtime before mirroring", () => {
	const bindBlock = feishuIpcSource.match(/feishuSessionBotSet, async[\s\S]*?session\.bindFailed"/)?.[0] ?? "";
	assert.ok(bindBlock, "feishuSessionBotSet handler must exist");
	// target 必须可重新赋值（const 无法在启动后更新）
	assert.match(bindBlock, /let target = deps\.sessionRuntimeCoordinator\.getTarget\(sessionId\);/);
	// 未启动时走与桌面端相同的 activateRuntime 链路
	assert.match(bindBlock, /deps\.feishuSessionRuntimeBindings\.activateRuntime\(sessionId\)/);
	assert.match(bindBlock, /target = deps\.sessionRuntimeCoordinator\.getTarget\(sessionId\);/);
	// 启动失败仍要给出 runtimeUnavailable，不能静默继续
	assert.match(bindBlock, /session\.runtimeUnavailable"/);
	const activateIndex = bindBlock.indexOf("deps.feishuSessionRuntimeBindings.activateRuntime(sessionId)");
	// 激活后重新解析 target 的位置必须晚于激活调用（取最后一次出现，避开 let 声明行）
	const targetRefreshIndex = bindBlock.lastIndexOf("target = deps.sessionRuntimeCoordinator.getTarget(sessionId)");
	assert.ok(activateIndex >= 0 && targetRefreshIndex > activateIndex, "target must be re-resolved after activation");
});

test("Feishu creation is Catalog-first and never owns Agent lifecycle", () => {
	assert.doesNotMatch(bridgeSource, /this\.agentManager\.create\(/);
	assert.match(bridgeSource, /this\.runtimeBindings\.ensureSession\(/);
	assert.match(bridgeSource, /this\.runtimeBindings\.activateRuntime\(session\.sessionId\)/);
	const createBlock = bridgeSource.match(/private async createNewSession[\s\S]*?\n\t}/)?.[0] ?? "";
	assert.match(createBlock, /runtimeBindings\.ensureSession/);
	assert.doesNotMatch(createBlock, /activateRuntime|agentManager\.create/);
});

test("main injects an origin-safe catalog gateway into every Feishu bridge", () => {
	assert.match(mainSource, /const feishuSessionRuntimeBindings/);
	assert.match(mainSource, /const existing = sessionCatalog\.get\(input\.existingSessionId\)/);
	assert.match(mainSource, /input\.agent\.sessionPath && !canAttachRuntimeMetadata\(existing, input\.agent\)/);
	assert.match(mainSource, /Existing Session origin does not match runtime/);
	assert.match(mainSource, /if \(!sessionId && input\.agent\.sessionPath\)/);
	const guardIndex = mainSource.indexOf("input.agent.sessionPath && !canAttachRuntimeMetadata(existing, input.agent)");
	const attachIndex = mainSource.indexOf("await sessionCatalog.attachRuntime(", guardIndex);
	assert.ok(guardIndex >= 0 && attachIndex > guardIndex, "origin guard must precede runtime metadata attachment");
	// FeishuBridge 构造点已随 IPC 域拆分分布在 index.ts 与 ipc/feishuIpc.ts，
	// 注入面统计需跨两文件合计，防止新增构造点漏接 gateway。
	const combined = `${mainSource}\n${feishuIpcSource}`;
	const constructors = [...combined.matchAll(/new FeishuBridge\(/g)].length;
	const injections = [...combined.matchAll(/feishuSessionRuntimeBindings/g)].length - 1;
	assert.ok(constructors >= 4);
	assert.ok(injections >= constructors);
});

test("main gateway rejects terminal or differently coordinated runtimes before binding", () => {
	const gateway = mainSource.match(/const feishuSessionRuntimeBindings:[\s\S]*?\n\};/)?.[0] ?? "";
	assert.match(gateway, /input\.agent\.status === "error" \|\| input\.agent\.status === "closed"/);
	assert.match(gateway, /sessionRuntimeCoordinator\.getRuntimeBinding\(input\.agent\.id\)/);
	assert.match(gateway, /currentBinding\.sessionId !== existing\.id/);
	assert.match(gateway, /Runtime is already bound to a different Session/);
	assert.ok(gateway.indexOf("currentBinding.sessionId !== existing.id") < gateway.indexOf("sessionRuntimeCoordinator.bindExistingAgent"), "coordinator mismatch must reject before bind");
});

test("main gateway keeps a pathless existing Session and attaches metadata without file origin", () => {
	const gateway = mainSource.match(/const feishuSessionRuntimeBindings:[\s\S]*?\n\};/)?.[0] ?? "";
	assert.match(gateway, /if \(input\.agent\.sessionPath && !canAttachRuntimeMetadata/);
	assert.match(gateway, /sessionId = existing\.id/);
	// 块结构可能被 formatter 重排：用缩进无关的锚点在整段里定位 pathless 分支。
	const pathlessBranch = gateway.match(/:\s*\{\s*sessionId,\s*piSessionId:\s*input\.agent\.sessionId,?\s*\};?/)?.[0] ?? "";
	assert.ok(pathlessBranch, "pathless branch must attach only runtime metadata");
	assert.doesNotMatch(pathlessBranch, /filePath|origin/);
	assert.doesNotMatch(pathlessBranch, /title/, "runtime metadata must not overwrite Session title");
});

function compileBridge(loadBindings = [], options = {}) {
	const output = ts.transpileModule(bridgeSource, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	}).outputText;
	const module = { exports: {} };
	const feishuI18n = compileFeishuI18n();
	const askCard = compileAskCard(feishuI18n);
	const richText = { chooseMessageMode: () => "text", buildPostMessages: () => [], buildMarkdownCards: () => [] };
	const cardState = {
		createInitialState: () => ({ terminal: "running", outputText: "" }),
		reduceFromPiEvent: (state) => state,
		markInterrupted: (state) => state,
		markError: (state) => state,
		markDone: (state) => state,
	};
	const imports = {
		electron: { app: { getPath: () => "." } },
		"../../shared/ipc": { ipcChannels: {} },
		"./FeishuConnection": {
			FeishuConnection: class {
				async start() {
					return { botOpenId: "test-open-id" };
				}
				stop() {}
				async testConnection() {
					return { success: true, message: "ok" };
				}
				onCardAction() {}
				onMessage() {}
				client = null;
			},
		},
		"./FeishuConfig": {
			listBots: () => [],
			addBot: () => undefined,
			removeBot: () => false,
			updateBot: () => undefined,
			getDecryptedBotAppSecret: () => "",
			loadBindings: () => loadBindings,
			saveBindings: () => undefined,
			getPersistentChatId: options.getPersistentChatId ?? (() => undefined),
			setPersistentChatId: () => undefined,
		},
		"node:fs": { existsSync: options.existsSync ?? (() => false) },
		"./rich-text": richText,
		"./CardStream": { CardStream: { open: async () => ({}) } },
		"./docActions": { buildFeishuTextChildren: () => [], stripFeishuActionMarkers: (text) => text, wantsFeishuDoc: () => undefined },
		"./fileIntent": { hasExplicitFeishuFileSendIntent: () => false },
		"./CardRunState": cardState,
		"./CardRenderer": { renderRunCard: () => ({}) },
		"./ModelPickerCard": { buildModelPickerCard: () => ({}), parseModelActionValue: () => undefined },
		"./AskCard": askCard,
		"./FeishuI18n": feishuI18n,
	};
	vm.runInNewContext(
		output,
		{
			module,
			exports: module.exports,
			require: (specifier) =>
				imports[specifier] ??
				(() => {
					throw new Error(`unexpected import: ${specifier}`);
				})(),
			console,
			Buffer,
			setTimeout,
			clearTimeout,
			Promise,
		},
		{ filename: "FeishuBridge.ts" },
	);
	return module.exports;
}

function makeAgent(id, projectId = "p", sessionPath = `/sessions/${id}.json`) {
	return { id, projectId, sessionPath, title: id, cwd: ".", status: "idle", createdAt: 1 };
}

function makeBridge(agents, gateway, calls = {}) {
	const { FeishuBridge } = compileBridge();
	const manager = {
		list: () => agents,
		create: async () => {
			const tab = manager.list()[0];
			calls.create = (calls.create ?? 0) + 1;
			return tab;
		},
		stop: async (id) => calls.stop?.push(id),
		abort: async (id) => calls.abort?.push(id),
		sendPrompt: async (input) => calls.prompts?.push(input.agentId),
		getAvailableModels: async (id) => {
			calls.models?.push(id);
			return [];
		},
		getRuntimeState: async (id) => {
			calls.states?.push(id);
			return undefined;
		},
		setModel: async (id, provider, modelId) => calls.setModel?.push([id, provider, modelId]),
		getMessages: () => [],
		addLocalEventListener: () => () => undefined,
	};
	const runtimeGateway = {
		ensureSession: async (input) => {
			calls.ensureSession?.push(input);
			return { sessionId: input.existingSessionId ?? "S" };
		},
		activateRuntime: async (sessionId) => {
			calls.activate?.push(sessionId);
			const tab = manager.list()[0];
			if (!tab) throw new Error("runtime unavailable");
			return tab;
		},
		sendPrompt: async (input) => calls.prompts?.push(input.sessionId),
		abortRuntime: async (sessionId) => calls.abort?.push(sessionId),
		listRuntimeModels: async (sessionId) => {
			calls.models?.push(sessionId);
			return [];
		},
		getRuntimeState: async (sessionId) => {
			calls.states?.push(sessionId);
			return undefined;
		},
		setRuntimeModel: async (sessionId, provider, modelId) => calls.setModel?.push([sessionId, provider, modelId]),
		...gateway,
	};
	const bridge = new FeishuBridge(
		{ id: "bot", name: "bot", enabled: true, appId: "app", appSecret: "secret" },
		manager,
		() => null,
		() => [{ id: "p", name: "project", path: "." }],
		runtimeGateway,
	);
	bridge.status = { status: "connected", activeBindings: 0 };
	return { bridge, manager };
}

test("/new stores a stable Catalog Session without eagerly creating an Agent", async () => {
	const tab = makeAgent("A");
	const calls = { create: 0, ensureSession: [], activate: [] };
	const { bridge } = makeBridge([tab], {}, calls);
	await bridge.createNewSession({ chatId: "chat", senderOpenId: "user", chatType: "p2p", groupName: "", messageId: "m" });
	assert.equal(JSON.stringify(bridge.listBindings().map(({ sessionId, agentId }) => ({ sessionId, agentId }))), JSON.stringify([{ sessionId: "S" }]));
	assert.equal(calls.create, 0);
	assert.equal(calls.ensureSession.length, 1);
	assert.deepEqual(calls.activate, []);
	assert.equal(bridge.getSessionChatId("S"), "chat");
	assert.equal(bridge.getSessionChatId("A"), undefined);
});

test("first Feishu message activates the existing stable Session through the coordinator gateway", async () => {
	const oldTab = makeAgent("A", "p", "");
	const calls = { create: 0, ensureSession: [], activate: [], abort: [], setModel: [], models: [] };
	const { bridge } = makeBridge([oldTab], {}, calls);
	await bridge.createNewSession({ chatId: "chat", senderOpenId: "user", chatType: "p2p", groupName: "", messageId: "m" });
	const nextTab = makeAgent("B", "p", "");
	bridge.agentManager.list = () => [nextTab];
	const binding = bridge.listBindings()[0];
	const restored = await bridge.resumeOrCreateAgent(binding);
	assert.equal(restored.sessionId, "S");
	assert.equal(restored.agentId, "B");
	assert.equal(calls.create, 0);
	assert.equal(calls.ensureSession.length, 2);
	assert.equal(calls.ensureSession[1].existingSessionId, "S");
	assert.deepEqual(calls.activate, ["S"]);
	assert.equal(bridge.getSessionChatId("A"), undefined);
	assert.equal(bridge.getSessionChatId("B"), "chat");
	await bridge.doSetModel("chat", "provider/model");
	await bridge.handleStopCommand({ chatId: "chat" });
	assert.deepEqual(calls.setModel, [["S", "provider", "model"]]);
	assert.deepEqual(calls.abort, ["S"]);
});

test("existing Feishu binding is reused by ensureSessionMirror without creating or overwriting a mirror", async () => {
	const persisted = [{ chatId: "feishu-chat", botId: "bot", userId: "u", sessionId: "S", agentId: "A", sessionPath: "/sessions/A.json", workspaceId: "", source: "feishu", chatType: "p2p", createdAt: 1 }];
	const { FeishuBridge } = compileBridge(persisted);
	const tab = makeAgent("A");
	let tabs = [tab];
	const bridge = new FeishuBridge(
		{ id: "bot", name: "bot", enabled: true, appId: "app", appSecret: "secret" },
		{
			list: () => tabs,
		},
		() => null,
		() => [],
		{ bindRuntime: async () => ({ sessionId: "S", runtimeGeneration: 1 }) },
	);
	await bridge.loadPersistedBindings();
	let createCount = 0;
	bridge.connection.client = {
		im: {
			chat: {
				create: async () => {
					createCount += 1;
					return { data: { chat_id: "mirror-chat" } };
				},
			},
		},
	};
	bridge.status = { status: "connected", activeBindings: 1 };
	assert.equal(await bridge.ensureSessionMirror("A", "Local prompt", tab.sessionPath), "feishu-chat");
	const replacementTab = makeAgent("B");
	tabs = [replacementTab];
	assert.equal(await bridge.ensureSessionMirror("B", "Local prompt", replacementTab.sessionPath), "feishu-chat");
	assert.equal(createCount, 0);
	assert.equal(JSON.stringify(bridge.listBindings().map(({ chatId, source, sessionId, agentId }) => ({ chatId, source, sessionId, agentId }))), JSON.stringify([{ chatId: "feishu-chat", source: "feishu", sessionId: "S", agentId: "B" }]));
	assert.equal(bridge.getSessionChatId("S"), "feishu-chat");
	assert.equal(bridge.getSessionChatId("A"), undefined);
	assert.equal(bridge.getSessionChatId("B"), "feishu-chat");
});

test("removing a stale binding does not remove another binding's current indexes", async () => {
	const persisted = [
		{ chatId: "current", botId: "bot", userId: "u", sessionId: "S", workspaceId: "", source: "feishu", chatType: "p2p", createdAt: 1 },
		{ chatId: "stale", botId: "bot", userId: "u", sessionId: "S", workspaceId: "", source: "feishu", chatType: "p2p", createdAt: 2 },
	];
	const { FeishuBridge } = compileBridge(persisted);
	const bridge = new FeishuBridge(
		{ id: "bot", name: "bot", enabled: true, appId: "app", appSecret: "secret" },
		{ list: () => [] },
		() => null,
		() => [],
		{ bindRuntime: async () => ({ sessionId: "S", runtimeGeneration: 1 }) },
	);
	await bridge.loadPersistedBindings();
	assert.equal(bridge.getSessionChatId("S"), "current");
	assert.equal(bridge.removeBinding("stale"), true);
	assert.equal(bridge.getSessionChatId("S"), "current");
	assert.equal(bridge.feishuSessions.has("S"), true);
});

test("legacy ID absent from catalog may migrate to a new stable ID during resume", async () => {
	const persisted = [{ chatId: "chat", botId: "bot", userId: "u", sessionId: "legacy", workspaceId: "", source: "feishu", chatType: "p2p", createdAt: 1 }];
	const { FeishuBridge } = compileBridge(persisted);
	const tab = makeAgent("B", "p", "");
	const bindInputs = [];
	const manager = {
		list: () => [],
	};
	const bridge = new FeishuBridge(
		{ id: "bot", name: "bot", enabled: true, appId: "app", appSecret: "secret" },
		manager,
		() => null,
		() => [{ id: "p", name: "project", path: "." }],
		{
			ensureSession: async (input) => {
				bindInputs.push(input.existingSessionId);
				return { sessionId: "S2" };
			},
			activateRuntime: async () => tab,
		},
	);
	await bridge.loadPersistedBindings();
	const resumed = await bridge.resumeOrCreateAgent(bridge.listBindings()[0]);
	assert.equal(resumed.sessionId, "S2");
	assert.deepEqual(bindInputs, ["legacy"]);
});

test("a stale S1 handle moved to S2 is cleared without issuing any command to A", async () => {
	const tab = makeAgent("A", "p", "/sessions/S2.json");
	const calls = { create: 0, stop: [], abort: [], prompts: [], models: [], states: [], setModel: [] };
	const bindInputs = [];
	const { bridge } = makeBridge(
		[tab],
		{
			bindRuntime: async (input) => {
				bindInputs.push({ agentId: input.agent.id, existingSessionId: input.existingSessionId });
				throw new Error("runtime already coordinated to S2");
			},
		},
		calls,
	);
	bridge.getProjects = () => [];
	bridge.connection.client = { im: { message: { create: async () => undefined } } };
	const binding = {
		chatId: "chat",
		botId: "bot",
		userId: "u",
		sessionId: "S1",
		agentId: "A",
		sessionPath: "/sessions/S1.json",
		workspaceId: "",
		source: "feishu",
		chatType: "p2p",
		createdAt: 1,
	};
	bridge.chatBindings.set("chat", binding);
	bridge.indexBinding(binding);

	await bridge.runAgent({ chatId: "chat", senderOpenId: "u", chatType: "p2p", messageId: "m" }, "hello", [], []);
	assert.deepEqual(bindInputs, [{ agentId: "A", existingSessionId: "S1" }]);
	assert.equal(binding.agentId, undefined);
	assert.equal(bridge.getSessionChatId("A"), undefined);
	assert.equal(bridge.getSessionChatId("S1"), "chat");
	assert.equal(calls.create, 0);
	assert.deepEqual(
		{ stop: calls.stop, abort: calls.abort, prompts: calls.prompts, models: calls.models, states: calls.states, setModel: calls.setModel },
		{
			stop: [],
			abort: [],
			prompts: [],
			models: [],
			states: [],
			setModel: [],
		},
	);
});

test("gateway verification of the same stable Session authorizes reuse of A", async () => {
	const tab = makeAgent("A");
	const bindInputs = [];
	const { bridge } = makeBridge([tab], {
		bindRuntime: async (input) => {
			bindInputs.push({ agentId: input.agent.id, existingSessionId: input.existingSessionId });
			return { sessionId: "S1", runtimeGeneration: 4 };
		},
	});
	const binding = {
		chatId: "chat",
		botId: "bot",
		userId: "u",
		sessionId: "S1",
		agentId: "A",
		workspaceId: "",
		source: "feishu",
		chatType: "p2p",
		createdAt: 1,
	};
	bridge.chatBindings.set("chat", binding);
	bridge.indexBinding(binding);
	assert.equal(await bridge.ensureRuntimeBinding(binding), "A");
	assert.deepEqual(bindInputs, [{ agentId: "A", existingSessionId: "S1" }]);
	assert.equal(binding.agentId, "A");
});

test("terminal A is cleared without gateway reuse or AgentManager commands", async () => {
	const tab = { ...makeAgent("A"), status: "closed" };
	const calls = { create: 0, stop: [], abort: [], prompts: [], models: [], states: [], setModel: [] };
	let gatewayCalls = 0;
	const { bridge } = makeBridge(
		[tab],
		{
			bindRuntime: async () => {
				gatewayCalls += 1;
				return { sessionId: "S1", runtimeGeneration: 1 };
			},
		},
		calls,
	);
	bridge.getProjects = () => [];
	const binding = {
		chatId: "chat",
		botId: "bot",
		userId: "u",
		sessionId: "S1",
		agentId: "A",
		workspaceId: "",
		source: "feishu",
		chatType: "p2p",
		createdAt: 1,
	};
	bridge.chatBindings.set("chat", binding);
	bridge.indexBinding(binding);
	assert.equal(await bridge.ensureRuntimeBinding(binding), undefined);
	assert.equal(gatewayCalls, 0);
	assert.equal(binding.agentId, undefined);
	assert.equal(bridge.getSessionChatId("A"), undefined);
	assert.deepEqual(
		{ stop: calls.stop, abort: calls.abort, prompts: calls.prompts, models: calls.models, states: calls.states, setModel: calls.setModel },
		{
			stop: [],
			abort: [],
			prompts: [],
			models: [],
			states: [],
			setModel: [],
		},
	);
});

test("gateway stable ID mismatch clears A instead of reusing it", async () => {
	const tab = makeAgent("A");
	const calls = { create: 0, stop: [] };
	const { bridge } = makeBridge([tab], { bindRuntime: async () => ({ sessionId: "S2", runtimeGeneration: 2 }) }, calls);
	bridge.getProjects = () => [];
	const binding = {
		chatId: "chat",
		botId: "bot",
		userId: "u",
		sessionId: "S1",
		agentId: "A",
		workspaceId: "",
		source: "feishu",
		chatType: "p2p",
		createdAt: 1,
	};
	bridge.chatBindings.set("chat", binding);
	bridge.indexBinding(binding);
	assert.equal(await bridge.ensureRuntimeBinding(binding), undefined);
	assert.equal(binding.agentId, undefined);
	assert.equal(bridge.getSessionChatId("A"), undefined);
	assert.deepEqual(calls.stop, []);
});

test("legacy ID and unique path candidates activate only through the Session gateway", async () => {
	const tab = makeAgent("legacy", "p", "/same");
	const calls = { create: 0, stop: [], ensureSession: [], activate: [] };
	const { bridge } = makeBridge([tab], {}, calls);
	const binding = {
		chatId: "chat",
		botId: "bot",
		userId: "u",
		sessionId: "legacy",
		sessionPath: "/same",
		workspaceId: "",
		source: "feishu",
		chatType: "p2p",
		createdAt: 1,
	};
	bridge.chatBindings.set("chat", binding);
	const agentId = await bridge.ensureRuntimeBinding(binding);
	assert.equal(agentId, "legacy");
	assert.equal(calls.create, 0);
	assert.equal(calls.ensureSession[0].existingSessionId, "legacy");
	assert.equal(calls.ensureSession[0].sessionPath, "/same");
	assert.deepEqual(calls.activate, ["legacy"]);
	assert.equal(binding.agentId, "legacy");
});

test("gateway activation rejection leaves the binding unowned without AgentManager cleanup", async () => {
	const tab = makeAgent("B", "p", "");
	const calls = { create: 0, stop: [] };
	const { bridge } = makeBridge(
		[tab],
		{
			activateRuntime: async () => {
				throw new Error("active origin mismatch");
			},
		},
		calls,
	);
	const binding = {
		chatId: "chat",
		botId: "bot",
		userId: "u",
		sessionId: "S",
		workspaceId: "",
		source: "feishu",
		chatType: "p2p",
		createdAt: 1,
	};
	bridge.chatBindings.set("chat", binding);
	assert.equal(await bridge.ensureRuntimeBinding(binding), undefined);
	assert.equal(calls.create, 0);
	assert.deepEqual(calls.stop, []);
	assert.equal(binding.agentId, undefined);
});

test("persisted path collision with a different source stays unowned when gateway rejects it", async () => {
	const persisted = [
		{
			chatId: "chat",
			botId: "bot",
			userId: "u",
			sessionId: "S",
			sessionPath: "/same",
			workspaceId: "",
			source: "feishu",
			chatType: "p2p",
			createdAt: 1,
		},
	];
	const { FeishuBridge } = compileBridge(persisted);
	const tab = { ...makeAgent("B", "p", "/same"), sessionSource: "codex" };
	let gatewayCalls = 0;
	const bridge = new FeishuBridge(
		{ id: "bot", name: "bot", enabled: true, appId: "app", appSecret: "secret" },
		{ list: () => [tab] },
		() => null,
		() => [],
		{
			bindRuntime: async () => {
				gatewayCalls += 1;
				throw new Error("source mismatch");
			},
		},
	);
	await bridge.loadPersistedBindings();
	assert.equal(gatewayCalls, 1);
	assert.equal(bridge.listBindings()[0].sessionId, "S");
	assert.equal(bridge.listBindings()[0].agentId, undefined);
});

test("a persisted path candidate cannot migrate to a different stable Session ID", async () => {
	const persisted = [{ chatId: "chat", botId: "bot", userId: "u", sessionId: "A", sessionPath: "/same", workspaceId: "", source: "feishu", chatType: "p2p", createdAt: 1 }];
	const tab = makeAgent("B", "p", "/same");
	const { bridge } = makeBridge([tab], { bindRuntime: async () => ({ sessionId: "S", runtimeGeneration: 3 }) });
	const { FeishuBridge } = compileBridge(persisted);
	const manager = bridge.agentManager;
	const bindInputs = [];
	const loaded = new FeishuBridge(
		{ id: "bot", name: "bot", enabled: true, appId: "app", appSecret: "secret" },
		manager,
		() => null,
		() => [],
		{
			bindRuntime: async (input) => {
				bindInputs.push(input.existingSessionId);
				return { sessionId: "S", runtimeGeneration: 3 };
			},
		},
	);
	await loaded.loadPersistedBindings();
	assert.equal(JSON.stringify(loaded.listBindings().map(({ sessionId, agentId }) => ({ sessionId, agentId }))), JSON.stringify([{ sessionId: "A" }]));
	assert.deepEqual(bindInputs, ["A"]);
});

test("two persisted rows sharing a path stay unowned even with one runtime candidate", async () => {
	const legacy = { botId: "bot", userId: "u", sessionPath: "/same", workspaceId: "", chatType: "p2p", createdAt: 1 };
	const ambiguous = [
		{ ...legacy, chatId: "one", sessionId: "old-one", source: "feishu" },
		{ ...legacy, chatId: "two", sessionId: "old-two", source: "session-mirror" },
	];
	const { FeishuBridge } = compileBridge(ambiguous);
	const bindInputs = [];
	const bridge = new FeishuBridge(
		{ id: "bot", name: "bot", enabled: true, appId: "app", appSecret: "secret" },
		{
			list: () => [makeAgent("B", "p", "/same")],
		},
		() => null,
		() => [],
		{
			bindRuntime: async (input) => {
				bindInputs.push(input);
				return { sessionId: "unexpected", runtimeGeneration: 1 };
			},
		},
	);
	await bridge.loadPersistedBindings();
	assert.equal(JSON.stringify(bridge.listBindings().map(({ sessionId, agentId }) => ({ sessionId, agentId }))), JSON.stringify([{ sessionId: "old-one" }, { sessionId: "old-two" }]));
	assert.equal(bindInputs.length, 0);
});

// ===== 飞书 ask/confirm 交互（extension_ui_request → 卡片 → 按钮/文本回答 → 写回 pi） =====

function bindChatForAsk(bridge, agentId = "A") {
	bridge.chatBindings.set("chat", {
		chatId: "chat",
		botId: "bot",
		userId: "u",
		sessionId: "S",
		agentId,
		workspaceId: "",
		source: "feishu",
		chatType: "p2p",
		createdAt: 1,
	});
	bridge.sessionToChat.set(agentId, "chat");
}

function mockFeishuClient(sent) {
	return {
		im: {
			message: {
				create: async (args) => {
					sent.push(args);
					return { data: { message_id: `m-${sent.length}` } };
				},
				reply: async () => ({ data: { message_id: "m-reply" } }),
			},
		},
	};
}

test("Feishu select ask renders option card; button click answers via sendUIResponse", async () => {
	const uiResponses = [];
	const { bridge } = makeBridge([makeAgent("A")], {
		sendUIResponse: (agentId, requestId, response) => uiResponses.push([agentId, requestId, response]),
	});
	bindChatForAsk(bridge);
	const sent = [];
	bridge.connection.client = mockFeishuClient(sent);

	// pi 发出 select 提问 → 飞书应渲染一张带选项按钮的交互卡片
	bridge.handleAgentEvent("A", { type: "extension_ui_request", method: "select", id: "req-1", title: "选择部署环境？", options: ["生产", "测试"] });
	assert.equal(sent.length, 1, "ask card should be sent once");
	const card = JSON.parse(sent[0].data.content);
	assert.equal(card.header.template, "orange");
	assert.equal(card.header.title.content, "❓ 请选择一个选项");
	const optionButtons = card.elements.flatMap((e) => (e.tag === "action" ? e.actions : [])).filter((a) => a.value?.kind === "option");
	assert.equal(optionButtons.length, 2);
	assert.equal(optionButtons[0].value.option, "生产");

	// 用户点击选项按钮 → 答案写回 pi，待答记录清除，用户收到确认
	await bridge.handleCardAction({
		chatId: "chat",
		messageId: "card-1",
		operator: { openId: "u" },
		action: { tag: "button", value: { action: "pideck.ask", requestId: "req-1", kind: "option", option: "生产" } },
	});
	assert.equal(JSON.stringify(uiResponses), JSON.stringify([["A", "req-1", { value: "生产" }]]));
	assert.equal(bridge.getPendingAskForChat("chat"), undefined, "pending ask must be cleared");
	assert.ok(
		sent.some((s) => s.data.content.includes("已选择: 生产")),
		"user should get an answer confirmation",
	);
});

test("Feishu select ask preserves object options and sends their values", async () => {
	const uiResponses = [];
	const { bridge } = makeBridge([makeAgent("A")], {
		sendUIResponse: (agentId, requestId, response) => uiResponses.push([agentId, requestId, response]),
	});
	bindChatForAsk(bridge);
	const sent = [];
	bridge.connection.client = mockFeishuClient(sent);

	// ask_question 扩展协议允许对象选项；不能因为 Feishu 只识别 string 而降级成无选项输入卡。
	bridge.handleAgentEvent("A", {
		type: "extension_ui_request",
		method: "select",
		id: "req-object-1",
		title: "选择环境？",
		options: [
			{ label: "生产环境", value: "prod", description: "线上" },
			{ label: "测试环境", value: "staging", description: "预发布" },
		],
	});
	assert.equal(sent.length, 1, "object-option ask card should be sent once");
	const card = JSON.parse(sent[0].data.content);
	const optionButtons = card.elements.flatMap((e) => (e.tag === "action" ? e.actions : [])).filter((a) => a.value?.kind === "option");
	assert.equal(optionButtons.length, 2);
	// 按钮带卡片列表同序号前缀（完整 label 在 markdown 列表里）
	assert.equal(optionButtons[0].text.content, "1. 生产环境");
	assert.equal(optionButtons[0].value.option, "prod");
	assert.ok(
		card.elements.some((element) => element.tag === "markdown" && element.content.includes("线上")),
		"option description should remain visible",
	);

	await bridge.handleCardAction({
		chatId: "chat",
		messageId: "card-object-1",
		operator: { openId: "u" },
		action: { tag: "button", value: { action: "pideck.ask", requestId: "req-object-1", kind: "option", option: "prod" } },
	});
	assert.equal(JSON.stringify(uiResponses), JSON.stringify([["A", "req-object-1", { value: "prod" }]]));
});

test("Feishu confirm ask: confirm/reject buttons map to confirmed flags", async () => {
	const uiResponses = [];
	const { bridge } = makeBridge([makeAgent("A")], {
		sendUIResponse: (agentId, requestId, response) => uiResponses.push([agentId, requestId, response]),
	});
	bindChatForAsk(bridge);
	const sent = [];
	bridge.connection.client = mockFeishuClient(sent);

	bridge.handleAgentEvent("A", { type: "extension_ui_request", method: "confirm", id: "req-2", title: "允许执行 git push 吗？" });
	assert.equal(sent.length, 1);
	assert.equal(sent[0].data.content.includes("需要你的确认"), true);

	// 点「拒绝」→ confirmed:false
	await bridge.handleCardAction({
		chatId: "chat",
		messageId: "card-2",
		operator: { openId: "u" },
		action: { tag: "button", value: { action: "pideck.ask", requestId: "req-2", kind: "confirm", confirmed: false } },
	});
	assert.equal(JSON.stringify(uiResponses), JSON.stringify([["A", "req-2", { confirmed: false }]]));
});

test("Feishu ask cancel button sends cancelled; expired ask shows hint without sending", async () => {
	const uiResponses = [];
	const { bridge } = makeBridge([makeAgent("A")], {
		sendUIResponse: (agentId, requestId, response) => uiResponses.push([agentId, requestId, response]),
	});
	bindChatForAsk(bridge);
	const sent = [];
	bridge.connection.client = mockFeishuClient(sent);

	bridge.handleAgentEvent("A", { type: "extension_ui_request", method: "input", id: "req-3", title: "请描述需求" });
	await bridge.handleCardAction({
		chatId: "chat",
		messageId: "card-3",
		operator: { openId: "u" },
		action: { tag: "button", value: { action: "pideck.ask", requestId: "req-3", kind: "cancel" } },
	});
	assert.equal(JSON.stringify(uiResponses), JSON.stringify([["A", "req-3", { cancelled: true }]]));

	// 已清理后再点同一按钮 → 只提示已过期，不重复发送
	await bridge.handleCardAction({
		chatId: "chat",
		messageId: "card-3b",
		operator: { openId: "u" },
		action: { tag: "button", value: { action: "pideck.ask", requestId: "req-3", kind: "cancel" } },
	});
	assert.equal(uiResponses.length, 1, "expired ask must not send a second response");
	assert.ok(
		sent.some((s) => s.data.content.includes("已超时")),
		"user should see the expired hint",
	);
});

test("Feishu text reply answers a pending input ask instead of queuing a prompt", async () => {
	const uiResponses = [];
	const prompts = [];
	const { bridge } = makeBridge([makeAgent("A")], {
		sendUIResponse: (agentId, requestId, response) => uiResponses.push([agentId, requestId, response]),
		sendPrompt: async (input) => prompts.push(input),
	});
	bindChatForAsk(bridge);
	const sent = [];
	bridge.connection.client = mockFeishuClient(sent);

	bridge.handleAgentEvent("A", { type: "extension_ui_request", method: "input", id: "req-4", title: "请描述需求" });

	// 用户直接回复文本 → 作为答案，不进入 runAgent/sendPrompt
	await bridge.handleMessage({
		event_id: "e-1",
		message: { message_id: "m-1", chat_id: "chat", message_type: "text", chat_type: "p2p", content: JSON.stringify({ text: "帮我写一个脚本" }) },
		sender: { sender_type: "user", sender_id: { open_id: "user" } },
	});
	assert.equal(JSON.stringify(uiResponses), JSON.stringify([["A", "req-4", { value: "帮我写一个脚本" }]]));
	assert.equal(prompts.length, 0, "text reply must not be queued as a new prompt");
	assert.ok(sent.some((s) => s.data.content.includes("已选择: 帮我写一个脚本")));
});

test("Feishu confirm pending: text reply shows guidance instead of answering", async () => {
	const uiResponses = [];
	const { bridge } = makeBridge([makeAgent("A")], {
		sendUIResponse: (agentId, requestId, response) => uiResponses.push([agentId, requestId, response]),
	});
	bindChatForAsk(bridge);
	const sent = [];
	bridge.connection.client = mockFeishuClient(sent);

	bridge.handleAgentEvent("A", { type: "extension_ui_request", method: "confirm", id: "req-5", title: "允许吗？" });
	await bridge.handleMessage({
		event_id: "e-2",
		message: { message_id: "m-2", chat_id: "chat", message_type: "text", chat_type: "p2p", content: JSON.stringify({ text: "好的" }) },
		sender: { sender_type: "user", sender_id: { open_id: "user" } },
	});
	assert.equal(uiResponses.length, 0, "confirm must not be answered by free text");
	assert.ok(
		sent.some((s) => s.data.content.includes("请点击上方卡片中的按钮")),
		"user should get button guidance",
	);
});

test("Feishu agent_end clears stale pending asks", async () => {
	const uiResponses = [];
	const { bridge } = makeBridge([makeAgent("A")], {
		sendUIResponse: (agentId, requestId, response) => uiResponses.push([agentId, requestId, response]),
	});
	bindChatForAsk(bridge);
	bridge.connection.client = mockFeishuClient([]);

	bridge.handleAgentEvent("A", { type: "extension_ui_request", method: "input", id: "req-6", title: "请描述需求" });
	assert.ok(bridge.getPendingAskForChat("chat"), "ask pending before agent end");

	bridge.handleAgentEvent("A", { type: "agent_end", stopReason: "done" });
	assert.equal(bridge.getPendingAskForChat("chat"), undefined, "agent end must clear stale ask");
});

// 回归（飞书卡片 input 组件提交）：回调 raw.action.input_value 必须作为待答 ask 的答案写回 pi。
test("Feishu card input submit answers the pending ask via input_value", async () => {
	const uiResponses = [];
	const { bridge } = makeBridge([makeAgent("A")], {
		sendUIResponse: (agentId, requestId, response) => uiResponses.push([agentId, requestId, response]),
	});
	bindChatForAsk(bridge);
	const sent = [];
	bridge.connection.client = mockFeishuClient(sent);

	bridge.handleAgentEvent("A", { type: "extension_ui_request", method: "input", id: "req-7", title: "请描述需求" });
	// SDK normalize 后 action.value 无 ask 标识；input_value 只在 raw 里
	await bridge.handleCardAction({
		messageId: "m-7",
		chatId: "chat",
		operator: { openId: "user" },
		action: { value: null, tag: "input" },
		raw: { action: { input_value: "  卡片里输入的回答  " } },
	});
	assert.equal(JSON.stringify(uiResponses), JSON.stringify([["A", "req-7", { value: "卡片里输入的回答" }]]));
	assert.equal(bridge.getPendingAskForChat("chat"), undefined, "pending ask must be consumed");
	assert.ok(sent.some((s) => s.data.content.includes("已收到回答: 卡片里输入的回答")));
});

// 回归（select 编号回复）：卡片列表带编号，纯数字文本回复必须映射到对应选项值。
test("Feishu numeric text reply maps to the select option value", async () => {
	const uiResponses = [];
	const { bridge } = makeBridge([makeAgent("A")], {
		sendUIResponse: (agentId, requestId, response) => uiResponses.push([agentId, requestId, response]),
	});
	bindChatForAsk(bridge);
	bridge.connection.client = mockFeishuClient([]);

	bridge.handleAgentEvent("A", {
		type: "extension_ui_request",
		method: "select",
		id: "req-8",
		title: "选哪个？",
		options: [{ label: "方案一", value: "plan-a" }, "方案二"],
	});
	await bridge.handleMessage({
		event_id: "e-8",
		message: { message_id: "m-8", chat_id: "chat", message_type: "text", chat_type: "p2p", content: JSON.stringify({ text: "2" }) },
		sender: { sender_type: "user", sender_id: { open_id: "user" } },
	});
	assert.equal(JSON.stringify(uiResponses), JSON.stringify([["A", "req-8", { value: "方案二" }]]), "numeric reply must map to option value");
});
