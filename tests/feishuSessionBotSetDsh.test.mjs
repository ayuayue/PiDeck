import assert from "node:assert/strict";
import { test } from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// 「输入框飞书图标 → 选择 Bot」在多后端会话上的绑定契约（issue #388）。
//
// feishuSessionBotSet 处理器要先拿到当前 runtime 的 AgentTab 才能建镜像群，
// 它此前用 pi 专属的 AgentManager.list() 查 tab；DSH 会话的 agentId 形如
// dsh:session-<uuid>，tab 只在 CompositeAgentGateway（pi + dsh + acp）里，于是
// 每次都在「找不到 tab → session.runtimeUnavailable」静默失败。
// 桥接侧分发（FeishuBridge/WeChatBridge）早已改用网关的统一查找，
// 只有这个建绑定的入口漏了——本测试钉住：拿 tab 必须走网关，不再回退到 pi 专属列表。

const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");

const BOT_ID = "bot-1";

function createHarness(options) {
	const handlers = new Map();
	const calls = { mirror: [], setSessionBotId: [] };
	const targets = options.targets ?? {};
	const runtimeTabs = options.runtimeTabs ?? {};

	const bridge = {
		getStatus: () => ({ status: "connected", botId: BOT_ID, activeBindings: 0 }),
		ensureSessionMirrorForSession: async (sessionId, agentId, sessionTitle, sessionPath) => {
			calls.mirror.push({ sessionId, agentId, sessionTitle, sessionPath });
			return "chat-mirror-1";
		},
		removeBindingBySessionId: () => {},
	};

	const { registerFeishuIpc } = loadTsCommonJs("src/main/ipc/feishuIpc.ts", {
		stubs: {
			electron: { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } },
			"../feishu/FeishuBridge": { FeishuBridge: class FeishuBridgeStub {} },
			"../feishu/FeishuConfig": {
				listBots: () => [],
				getBot: () => undefined,
				addBot: () => {},
				removeBot: () => {},
				updateBot: () => {},
				getDecryptedBotAppSecret: () => "",
				getSessionBotId: () => undefined,
				setSessionBotId: (sessionId, botId) => calls.setSessionBotId.push([sessionId, botId]),
			},
			"../feishu/FeishuI18n": { feishuT: (_locale, key) => key },
			"../logging/sharedLogger": { getAppLogger: () => null },
		},
	});

	registerFeishuIpc({
		getMainWindow: () => null,
		feishuBridgeRef: { current: bridge },
		agentManager: { list: () => options.piAgentTabs ?? [] },
		projectStore: { list: () => [] },
		sessionRuntimeCoordinator: { getTarget: (sessionId) => targets[sessionId] },
		feishuSessionRuntimeBindings: {
			findRuntimeAgent: (agentId) => runtimeTabs[agentId],
			activateRuntime: async () => {},
		},
		getCurrentLocale: () => "zh-CN",
	});

	return { handlers, calls };
}

const setBotHandler = (harness) => harness.handlers.get(ipcChannels.feishuSessionBotSet);

test("DSH 会话：tab 只在统一网关里也必须能绑定（pi AgentManager 为空）", async () => {
	const harness = createHarness({
		targets: { "session-dsh": { sessionId: "session-dsh", agentId: "dsh:session-dsh", runtimeGeneration: 3 } },
		runtimeTabs: { "dsh:session-dsh": { id: "dsh:session-dsh", title: "DSH 会话", sessionPath: "/repo/.pideck/dsh/session-dsh.zstd" } },
		// pi 的 AgentManager 里没有 DSH runtime —— 这正是改动前每次必失败的原因
		piAgentTabs: [],
	});

	const result = await setBotHandler(harness)({}, "session-dsh", BOT_ID);

	// 返回值在 VM realm 里构造，逐字段断言（deepStrictEqual 会因原型不同而失配）
	assert.equal(result.success, true);
	assert.equal(result.chatId, "chat-mirror-1");
	assert.deepEqual(harness.calls.mirror, [{ sessionId: "session-dsh", agentId: "dsh:session-dsh", sessionTitle: "DSH 会话", sessionPath: "/repo/.pideck/dsh/session-dsh.zstd" }]);
	// 会话 id 与 runtime id 不同：两处都要落（会话本身挂新 Bot，旧 runtime 键清空）
	assert.deepEqual(harness.calls.setSessionBotId, [
		["session-dsh", BOT_ID],
		["dsh:session-dsh", undefined],
	]);
});

test("pi 会话：仍然用当前 runtime 的标题与会话路径建镜像群", async () => {
	const harness = createHarness({
		targets: { "session-pi": { sessionId: "session-pi", agentId: "agent-uuid", runtimeGeneration: 1 } },
		runtimeTabs: { "agent-uuid": { id: "agent-uuid", title: "重构 Git 面板", sessionPath: "/repo/.pi/session.jsonl" } },
		piAgentTabs: [{ id: "agent-uuid", title: "重构 Git 面板", sessionPath: "/repo/.pi/session.jsonl" }],
	});

	const result = await setBotHandler(harness)({}, "session-pi", BOT_ID);

	assert.equal(result.success, true);
	assert.equal(result.chatId, "chat-mirror-1");
	assert.deepEqual(harness.calls.mirror, [{ sessionId: "session-pi", agentId: "agent-uuid", sessionTitle: "重构 Git 面板", sessionPath: "/repo/.pi/session.jsonl" }]);
});

test("runtime 确实不在时仍然拒绝，不建空镜像", async () => {
	const harness = createHarness({
		targets: { "session-dead": { sessionId: "session-dead", agentId: "dsh:session-dead", runtimeGeneration: 1 } },
		runtimeTabs: {},
		piAgentTabs: [],
	});

	const result = await setBotHandler(harness)({}, "session-dead", BOT_ID);

	assert.equal(result.success, false);
	assert.equal(result.message, "session.runtimeUnavailable");
	assert.deepEqual(harness.calls.mirror, []);
	assert.deepEqual(harness.calls.setSessionBotId, []);
});
