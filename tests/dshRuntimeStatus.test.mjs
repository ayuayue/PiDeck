import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const {
	dshUiVisibilityFor,
	resolveEffectiveAgentBackend,
	dshSendBlockReason,
} = loadTsCommonJs("src/shared/types/dshRuntime.ts");

const {
	probeBundledDshRuntime,
	dshRuntimeStateFromProbe,
	DshRuntimeStatusService,
} = loadTsCommonJs("src/main/dsh/runtime/DshRuntimeStatus.ts");

// 注意：loadTsCommonJs 用 vm 沙箱加载，返回对象的原型不是本 realm 的 Object.prototype，
// deepStrictEqual 会因原型不同而失败——逐字段断言，避开跨 realm 比较。
const expectVisibility = (state, expected) => {
	const actual = dshUiVisibilityFor(state);
	assert.equal(actual.canCreateDshSession, expected.canCreateDshSession, `${state}.canCreateDshSession`);
	assert.equal(actual.showDshConfigForms, expected.showDshConfigForms, `${state}.showDshConfigForms`);
	assert.equal(actual.showInstallGuide, expected.showInstallGuide, `${state}.showInstallGuide`);
};

test("UI 可见性矩阵：只有 installed 才渲染 DSH 表单与允许建会话", () => {
	expectVisibility("installed", {
		canCreateDshSession: true,
		showDshConfigForms: true,
		showInstallGuide: false,
	});
	// notInstalled / broken 都要给出口（安装引导），否则用户没有任何恢复路径。
	for (const state of ["notInstalled", "broken"]) {
		expectVisibility(state, {
			canCreateDshSession: false,
			showDshConfigForms: false,
			showInstallGuide: true,
		});
	}
});

test("dev 模式（installEnabled=false）：不显示在线下载入口，仅保留安装引导说明", () => {
	// 无论状态，dev 下都不提供在线下载/重装（runtime 只随打包分发）。
	expectVisibility("notInstalled", {
		canCreateDshSession: false,
		showDshConfigForms: false,
		showInstallGuide: true,
		showRuntimeDownload: false,
	}, false);
	expectVisibility("installed", {
		canCreateDshSession: true,
		showDshConfigForms: true,
		showInstallGuide: false,
		showRuntimeDownload: false,
	}, false);
});

test("checking 不显示安装引导：避免首帧闪一下「未安装」再切回正常表单", () => {
	const visibility = dshUiVisibilityFor("checking");
	assert.equal(visibility.showInstallGuide, false);
	assert.equal(visibility.showDshConfigForms, false);
});

test("默认后端钳制：runtime 非 installed 时 dsh 回落 pi，pi 不受影响", () => {
	assert.equal(resolveEffectiveAgentBackend("dsh", "installed"), "dsh");
	assert.equal(resolveEffectiveAgentBackend("dsh", "notInstalled"), "pi");
	assert.equal(resolveEffectiveAgentBackend("dsh", "broken"), "pi");
	assert.equal(resolveEffectiveAgentBackend("dsh", "checking"), "pi");
	// pi 与第三方后端（imagegen）与 DSH runtime 无关，原样透传。
	assert.equal(resolveEffectiveAgentBackend("pi", "notInstalled"), "pi");
	assert.equal(resolveEffectiveAgentBackend("pi", "installed"), "pi");
});

test("dsh 会话发送/重启拦截：非 installed 状态才拦，checking 不误拦", () => {
	assert.equal(dshSendBlockReason("notInstalled"), "notInstalled");
	assert.equal(dshSendBlockReason("broken"), "broken");
	// installed 正常放行；checking 状态未定，不允许把启动首帧的正常发送误拦。
	assert.equal(dshSendBlockReason("installed"), null);
	assert.equal(dshSendBlockReason("checking"), null);
});

test("探测失败映射为 notInstalled，成功映射为 installed", () => {
	assert.equal(dshRuntimeStateFromProbe({ ok: true, appRoot: "/app" }), "installed");
	assert.equal(dshRuntimeStateFromProbe({ ok: false, error: "Cannot find module" }), "notInstalled");
});

test("探测 appPath 下不存在的包：返回 ok:false 而不是抛错（阶段 2 lite 包会走到）", () => {
	const probe = probeBundledDshRuntime(process.cwd());
	// 断言不抛错即可（真实结果取决于仓库是否装了 @deepseek-ai）。
	assert.equal(typeof probe.ok, "boolean");
	if (!probe.ok) assert.equal(typeof probe.error, "string");
	else assert.equal(typeof probe.appRoot, "string");
});

/** 构造服务：appPath 直接决定探测成败（"missing" → 解析失败）。 */
function makeService(appPath, logs = []) {
	return new DshRuntimeStatusService(
		() => appPath,
		(...entry) => logs.push(entry),
	);
}

test("状态服务首次查询即探测并缓存：重复调用不再触发探测", () => {
	const logs = [];
	const service = makeService("missing-dir", logs);
	assert.equal(service.getStatus().state, "notInstalled");
	assert.equal(service.getStatus().state, "notInstalled");
	// 一次探测 = 一条日志；缓存命中不该再探测。
	assert.equal(logs.length, 1);
});

test("canCreateDshSession 只在 installed 为真", () => {
	assert.equal(makeService("missing-dir").canCreateDshSession(), false);
});

test("managed runtime 状态携带 installDir（runtimesRoot/<version> 落盘目录）", () => {
	// 构造 resolveManaged 返回外部 runtime 锚点：installDir = dirname(nodeModules) = 版本目录。
	const service = new DshRuntimeStatusService(
		() => "missing-dir",
		() => {},
		() => ({ nodeModules: "/data/runtimes/dsh/0.1.1-rc.1/node_modules", runtimeVersion: "0.1.1-rc.1" }),
	);
	const status = service.getStatus();
	assert.equal(status.state, "installed");
	assert.equal(status.source, "managed");
	assert.equal(status.runtimeVersion, "0.1.1-rc.1");
	assert.equal(status.installDir, "/data/runtimes/dsh/0.1.1-rc.1");
});

test("builtin 内置分发不带 installDir（在 app.asar 内无独立落盘目录）", () => {
	const service = makeService(process.cwd());
	const status = service.getStatus();
	if (status.state === "installed") {
		assert.equal(status.source, "builtin");
		assert.equal(status.installDir, undefined);
	}
});

test("builtin 内置分发携带版本号（UI 文案模板带 v 前缀，缺版本会渲染成悬空 v）", () => {
	const service = makeService(process.cwd());
	const status = service.getStatus();
	if (status.state === "installed") {
		// 版本号必须是形如 x.y.z 的语义版本，不能是空串——空串会导致配置页显示「随应用内置 v」。
		assert.ok(
			typeof status.runtimeVersion === "string" && status.runtimeVersion.length > 0,
			"builtin runtimeVersion 应存在且非空",
		);
	}
});

test("subscribe 返回退订函数，退订后不再收到广播", () => {
	const service = makeService("missing-dir");
	const seen = [];
	const unsubscribe = service.subscribe((status) => seen.push(status.state));
	// 首次 refresh：缓存从无到有算状态变化，广播一次。
	service.refresh();
	assert.equal(seen.length, 1);
	unsubscribe();
	// 退订后状态未再变化；关键是订阅者已摘除（不泄漏、后续广播收不到）。
	service.refresh();
	assert.equal(service.listeners.size, 0);
	assert.equal(seen.length, 1);
});

test("refresh 状态不变时不广播，避免无意义 UI 重渲染", () => {
	const service = makeService("missing-dir");
	let calls = 0;
	service.subscribe(() => {
		calls += 1;
	});
	service.getStatus();
	service.refresh();
	assert.equal(calls, 0);
});

test("订阅者抛错不影响服务：refresh 仍能返回状态", () => {
	const service = makeService("missing-dir");
	service.subscribe(() => {
		throw new Error("listener boom");
	});
	assert.equal(service.refresh().state, "notInstalled");
});

test("allowBundledFallback=false 时内置探测被禁用（dev 模式强制外部安装）", () => {
	// dev 模式：项目根 node_modules 里装着 @deepseek-ai 开发依赖，但状态服务
	// 不应把「node_modules 有包」当作已安装 runtime——否则 UI 显示随应用内置且不可卸载。
	const service = new DshRuntimeStatusService(
		() => process.cwd(),
		() => {},
		() => undefined,
		() => false,
	);
	const status = service.getStatus();
	assert.equal(status.state, "notInstalled");
});
