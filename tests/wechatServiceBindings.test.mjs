/**
 * WeChatService：绑定快照的「当前会话模型」视图。
 *
 * 用户报的问题是「链为空时设置页只说『使用会话当前模型』，看不到到底是哪个模型」，
 * 修法是把会话当前模型随绑定快照推给渲染层。这里钉住三件事：
 * 视图要带模型、拿不到运行时就不带（不能拿旧值冒充）、只读字段不落盘也不影响推送路径。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const BINDING = { chatId: "wxid_me", userId: "wxid_me", sessionId: "s1", sessionPath: "/tmp/s1.jsonl", workspaceId: "p1", createdAt: 1, backend: "pi" };

/** 真加载 WeChatService，只把桥接/登录/配置换成可控替身。 */
function makeService({ models = {}, lookupFails = false } = {}) {
	const bindings = [{ ...BINDING }];
	const broadcasts = [];
	const logs = [];
	const saved = [];
	const sandbox = createTsSandbox({
		stubs: {
			"./IlinkClient": { IlinkClient: class {} },
			"./ilinkProtocol": { ILINK_CHANNEL_VERSION: 1 },
			"./WeChatLogin": {
				WeChatLogin: class {
					async prepare() {
						return { phase: "idle" };
					}
					run() {
						return Promise.resolve({ ok: false });
					}
					cancel() {}
					submitVerifyCode() {
						return false;
					}
					getState() {
						return { phase: "idle" };
					}
				},
			},
			"./WeChatConfig": {
				getSettings: () => ({ enabled: true, account: null }),
				loadBindings: () => bindings.map((binding) => ({ ...binding })),
				removeBinding: () => false,
				setEnabled: () => undefined,
				updateSettings: (patch) => patch,
				saveAccount: (account) => {
					saved.push(account);
					return null;
				},
				clearAccount: () => undefined,
				setDisplayName: () => undefined,
			},
			"./WeChatBridge": {
				WeChatBridge: class {
					deps;
					constructor(deps) {
						this.deps = deps;
					}
					getStatus() {
						return { status: "connected", activeBindings: bindings.length };
					}
					async start() {}
					async stop() {}
					refresh() {}
					async getBindingModel(binding) {
						if (lookupFails) throw new Error("runtime exploded");
						return models[binding.sessionId];
					}
				},
			},
		},
	});
	const { WeChatService } = sandbox("src/main/wechat/WeChatService.ts");
	const service = new WeChatService({
		getProjects: () => [{ id: "p1", name: "PiDeck" }],
		runtimeBindings: {},
		getLocale: () => "zh-CN",
		getWindow: () => ({ isDestroyed: () => false, webContents: { send: (channel, payload) => broadcasts.push([channel, payload]) } }),
		logger: (level, message) => logs.push([level, message]),
	});
	return { service, bridge: service.bridge, bindings, broadcasts, logs, saved };
}

const waitFor = async (predicate, label, timeoutMs = 2000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`timed out waiting for ${label}`);
};

test("绑定快照带上会话当前模型，且只读字段不进落盘绑定", async () => {
	const { service, bindings } = makeService({ models: { s1: { provider: "p1", modelId: "fast", modelName: "Fast" } } });

	const [view] = await service.bindingsWithModel();
	assert.equal(JSON.stringify(view.currentModel), JSON.stringify({ provider: "p1", modelId: "fast", modelName: "Fast" }), "设置页要靠它显示「当前会话模型」");
	assert.equal(view.chatId, "wxid_me", "视图必须是绑定的完整拷贝，字段不能被吞");
	assert.equal(bindings[0].currentModel, undefined, "currentModel 是运行时现算的只读字段，不能写进绑定记录");
});

test("拿不到运行时就不带 currentModel（不拿旧值冒充当前模型）", async () => {
	const { service } = makeService({ models: {} });

	const [view] = await service.bindingsWithModel();
	assert.equal("currentModel" in view, false, "会话没起/状态未就绪时宁可不显示，也不能显示上次用过的模型");
});

test("绑定变化推送的是同一份带模型的视图", async () => {
	const { bridge, broadcasts } = makeService({ models: { s1: { provider: "p1", modelId: "fast", modelName: "Fast" } } });

	bridge.deps.onBindingsChange();
	await waitFor(() => broadcasts.some(([channel]) => channel === "wechat:bindings-changed"), "the bindings push");
	const [, payload] = broadcasts.find(([channel]) => channel === "wechat:bindings-changed");
	assert.equal(JSON.stringify(payload[0].currentModel), JSON.stringify({ provider: "p1", modelId: "fast", modelName: "Fast" }), "推送与快照必须是同一份数据，否则界面一刷新就倒退");
});

test("模型查询抛错只丢这一份快照，不把绑定动作带崩", async () => {
	const { service, bridge, broadcasts, logs } = makeService({ lookupFails: true });

	await assert.rejects(() => service.bindingsWithModel(), /runtime exploded/);
	bridge.deps.onBindingsChange();
	await waitFor(() => logs.some(([level]) => level === "warn"), "the warn log");
	assert.equal(
		broadcasts.some(([channel]) => channel === "wechat:bindings-changed"),
		false,
		"推送是 fire-and-forget：查询失败只能记日志，不能把异常抛回业务动作",
	);
	assert.equal(logs[0][1], "微信绑定快照推送失败");
});
