/**
 * 微信 IPC 信封回归（src/main/ipc/wechatIpc.ts）。
 *
 * 渲染层 WeChatSection 用 WeChatIpcResult 的 ok 判定「是否应用快照」，主进程漏掉 ok 时
 * result.ok 是 undefined → 快照永远不落地，界面停在「尚未登录 + 开关关闭」，扫码成功后
 * 点开关也看不出任何变化（2026-10 用户报的「微信连上后无法开启」）。这里从 IPC 边界断言
 * 信封型方法的返回形状，锁住契约而不是实现。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

// electron 桩：捕获 ipcMain.handle 注册表，直测各 handler 的返回信封。
const handlers = new Map();
const load = createTsSandbox({ stubs: { electron: { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } } } });
const { registerWeChatIpc } = load("src/main/ipc/wechatIpc.ts");
const { ipcChannels } = load("src/shared/ipc.ts");
const { MODEL_CHAIN_MAX } = load("src/main/wechat/WeChatConfig.ts");

/** 沙箱产物的原型属于另一个 realm，结构相同也会被判不等；比较前先降级成纯数据。 */
const plain = (value) => JSON.parse(JSON.stringify(value));

const ACCOUNT = { ilinkBotId: "bot-1", ilinkUserId: "user-1", displayName: "微信 ClawBot", baseUrl: "https://ilinkai.weixin.qq.com", loggedInAt: 1 };

/** 假 WeChatService：只覆盖 handler 用到的方法，业务顺序不在本测试范围内。 */
function makeService(overrides = {}) {
	const settings = { enabled: true, account: ACCOUNT, defaultWorkspaceId: "p1" };
	return {
		getSettings: () => settings,
		getStatus: () => ({ status: "connected", account: ACCOUNT, activeBindings: 0 }),
		// 绑定快照改为带「当前模型」的视图方法（WeChatService.bindingsWithModel）：get-settings / get-bindings
		// 都用它，桩里保留旧名会让 handler 直接 TypeError。
		bindingsWithModel: async () => [],
		getLoginState: () => ({ phase: "idle" }),
		setEnabled: async () => settings,
		updateSettings: (patch) => ({ ...settings, ...patch }),
		renameAccount: (name) => ({ ...settings, account: { ...ACCOUNT, displayName: name } }),
		logout: async () => ({ enabled: false, account: null }),
		beginLogin: async () => ({ phase: "waiting", qrcodeContent: "https://liteapp.weixin.qq.com/q/x" }),
		cancelLogin: () => {},
		submitVerifyCode: () => ({ phase: "waiting" }),
		unbindChat: () => true,
		...overrides,
	};
}

function register(service) {
	handlers.clear();
	registerWeChatIpc({ getMainWindow: () => null, wechatService: service, getProjects: () => [{ id: "p1", name: "demo" }] });
}

test("wechat:get-settings 返回带 ok:true 的完整快照（渲染层据此应用设置）", async () => {
	register(makeService());
	const result = await handlers.get(ipcChannels.wechatGetSettings)();
	assert.equal(result.ok, true, "缺 ok 会让设置页永远停在「未登录 + 开关关闭」");
	assert.deepEqual(Object.keys(result).sort(), ["bindings", "ok", "projects", "settings", "status"]);
	assert.equal(result.settings.enabled, true);
	assert.equal(result.settings.account.displayName, "微信 ClawBot");
	assert.deepEqual(result.projects, [{ id: "p1", name: "demo" }]);
});

test("信封型方法成功时都带 ok:true（渲染层统一按 ok 判定）", async () => {
	register(makeService());
	const cases = [
		[ipcChannels.wechatSetEnabled, [true]],
		[ipcChannels.wechatUpdateSettings, [{ defaultWorkspaceId: "p1" }]],
		[ipcChannels.wechatRenameAccount, ["新名字"]],
		[ipcChannels.wechatLogout, []],
		[ipcChannels.wechatBeginLogin, []],
		[ipcChannels.wechatCancelLogin, []],
		[ipcChannels.wechatSubmitVerifyCode, ["1234"]],
		[ipcChannels.wechatUnbindChat, ["user-1"]],
	];
	for (const [channel, args] of cases) {
		const result = await handlers.get(channel)({}, ...args);
		assert.equal(result.ok, true, `${channel} 成功时必须回 ok:true`);
	}
});

test("失败折成 {ok:false,message}；原始值通道保持原样", async () => {
	register(
		makeService({
			getSettings: () => {
				throw new Error("boom");
			},
		}),
	);
	// 沙箱是独立 vm realm：跨 realm 的 Error 过不了生产代码的 `instanceof Error`，
	// message 会退化成 String(error)，所以这里只钉「形状 + 原因文本带上」。
	const failed = await handlers.get(ipcChannels.wechatGetSettings)();
	assert.equal(failed.ok, false);
	assert.match(failed.message, /boom/);

	register(makeService());
	assert.deepEqual(await handlers.get(ipcChannels.wechatGetStatus)(), { status: "connected", account: ACCOUNT, activeBindings: 0 });
	assert.deepEqual(await handlers.get(ipcChannels.wechatGetBindings)(), []);
	assert.deepEqual(await handlers.get(ipcChannels.wechatGetLoginState)(), { phase: "idle" });
});

test("wechat:update-settings 在边界拦下非法模型链，不落到 service 上", async () => {
	// 渲染层数据一律不可信：超长/缺字段/类型不对必须在 IPC 边界就拒，
	// 否则非法链会被写进设置文件，桥接下一轮会在顺延时直接报错。
	const patches = [];
	register(
		makeService({
			updateSettings: (patch) => {
				patches.push(patch);
				return { enabled: true, account: ACCOUNT, ...patch };
			},
		}),
	);
	const handler = handlers.get(ipcChannels.wechatUpdateSettings);
	const tooLong = Array.from({ length: MODEL_CHAIN_MAX + 1 }, (_, index) => ({ provider: "p1", modelId: `m${index}` }));
	const invalid = [{ modelChain: "not-an-array" }, { modelChain: tooLong }, { modelChain: ["字符串"] }, { modelChain: [{ provider: "p1" }] }, { modelChain: [{ provider: "p1", modelId: "   " }] }, { modelChain: [{ provider: "p1", modelId: 42 }] }];
	for (const patch of invalid) {
		const result = await handler({}, patch);
		assert.equal(result.ok, false, `必须拒绝：${JSON.stringify(patch)}`);
	}
	assert.deepEqual(patches, [], "非法输入不得落到 service 上");

	// 合法输入照旧通过，并且在边界再洗一次（重复项不进设置）。
	const accepted = await handler(
		{},
		{
			modelChain: [
				{ provider: "p1", modelId: "fast", modelName: "Fast" },
				{ provider: "p1", modelId: "fast" },
			],
		},
	);
	assert.equal(accepted.ok, true);
	assert.deepEqual(plain(patches[0].modelChain), [{ provider: "p1", modelId: "fast", modelName: "Fast" }], "边界上再洗一次：重复项不会进设置");
	assert.equal((await handler({}, { modelChain: [] })).ok, true, "空数组 = 清空模型链，是合法输入");
});
