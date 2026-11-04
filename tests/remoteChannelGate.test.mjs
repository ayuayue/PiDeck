// tests/remoteChannelGate.test.mjs
// 远端能力的通道门禁（2026-10-27 用户裁定：只在 dev 通道提供，正式包不启用也不暴露入口）。
// 只做行为断言：判据按真模块跑真值表，渲染层的取舍在真布局上跑真函数——
// 不靠「源码里长什么样」来验证，搬迁/改名/换实现不会误红，写错行为不会误绿。
import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const VISIBILITY_MODULE = "src/renderer/src/hooks/remoteFeatureVisibility.ts";

function devChannelBuild(packaged, devBuild) {
	const load = createTsSandbox({ globals: { __PIDECK_DEV_BUILD__: devBuild }, stubs: { electron: { app: { isPackaged: packaged } } } });
	return load("src/main/update/channelIdentity.ts").isDevChannelBuild();
}

test("远端门禁判据：未打包运行与 dev 通道包为真，stable 通道包为假", () => {
	// 未打包运行 = npm run dev / Playwright E2E：本机验收与自动化用例都在这条路径上，必须开。
	assert.equal(devChannelBuild(false, false), true, "未打包运行必须开（dev / e2e）");
	assert.equal(devChannelBuild(false, true), true, "未打包且带 dev 标记仍为开");
	// dev 通道安装包（dist:win:dev 等，编译期 __PIDECK_DEV_BUILD__）。
	assert.equal(devChannelBuild(true, true), true, "dev 通道安装包必须开");
	// 正式发布产物：远端关闭，且不再读 PIDECK_REMOTE_EXPERIMENTAL。
	assert.equal(devChannelBuild(true, false), false, "stable 通道安装包必须关");
});

test("入口可见性：只有明确拿到 devBuild=false 才隐藏", () => {
	const { isRemoteEntryVisible } = loadTsCommonJs(VISIBILITY_MODULE);
	assert.equal(isRemoteEntryVisible(false), false, "正式包不暴露入口");
	assert.equal(isRemoteEntryVisible(true), true, "dev 通道照常");
	// undefined = update:get-channel 还没回来：先照常渲染，等真值到达再收口，否则 dev 通道会闪。
	assert.equal(isRemoteEntryVisible(undefined), true, "通道信息未到不先藏入口");
});

test("添加项目的远端入口：通道允许且真有一台可用主机时才出现", () => {
	const { isRemoteAddProjectVisible, readRemoteHostsConfigured } = loadTsCommonJs(VISIBILITY_MODULE);
	const host = (verified, disabled) => ({ id: "11111111-1111-4111-8111-111111111111", label: "h", sshHost: "h", verified, disabled });

	// 清单 → 是否有可用主机（口径与登记弹框一致：已验证且未禁用）。
	assert.equal(readRemoteHostsConfigured({ ok: true, status: "ready", hosts: [] }), false, "一台主机都没有 -> 没有");
	assert.equal(readRemoteHostsConfigured({ ok: true, status: "ready", hosts: [host(false, false)] }), false, "未验证的主机不算可用（没有信任锚）");
	assert.equal(readRemoteHostsConfigured({ ok: true, status: "ready", hosts: [host(true, true)] }), false, "已禁用的主机不算可用");
	assert.equal(readRemoteHostsConfigured({ ok: true, status: "ready", hosts: [host(false, false), host(true, false)] }), true, "有一台可用就算配置过");
	assert.equal(readRemoteHostsConfigured({ ok: false, code: "REMOTE_FEATURE_DISABLED" }), undefined, "读不到清单不能当成「没有主机」");

	// 入口可见性：通道 + 主机清单两条都要满足。
	assert.equal(isRemoteAddProjectVisible(true, true), true, "dev 通道且已配主机 -> 出现");
	assert.equal(isRemoteAddProjectVisible(true, false), false, "没有可用主机 -> 不出现（点进去只会落到 no-host）");
	assert.equal(isRemoteAddProjectVisible(true, undefined), false, "清单还没读到 -> 先不出现，也就不用先给一层空下拉");
	assert.equal(isRemoteAddProjectVisible(false, true), false, "正式包即使配了主机也不提供远端入口");
});

test("设置页布局：正式包把「连接」tab 整条剔除，dev 与未知状态原样返回", () => {
	const { applyRemoteGateToSettingsLayout } = loadTsCommonJs(VISIBILITY_MODULE);
	const { SETTINGS_TAB_LAYOUT } = loadTsCommonJs("src/renderer/src/components/app/settings/settingsTabLayout.ts");
	const ids = (layout) => layout.map((entry) => entry.id);

	// 真布局里必须还有「连接」这项，否则下面的剔除断言会空转通过（tab 改名后这里先红）。
	assert.ok(ids(SETTINGS_TAB_LAYOUT).includes("connections"), "SETTINGS_TAB_LAYOUT 应含 connections tab");

	assert.deepEqual(
		ids(applyRemoteGateToSettingsLayout(SETTINGS_TAB_LAYOUT, false)),
		ids(SETTINGS_TAB_LAYOUT).filter((id) => id !== "connections"),
		"正式包：只少「连接」，其余顺序不变",
	);
	assert.equal(applyRemoteGateToSettingsLayout(SETTINGS_TAB_LAYOUT, true), SETTINGS_TAB_LAYOUT, "dev 通道原样返回（不重建数组，避免每次渲染都换引用）");
	assert.equal(applyRemoteGateToSettingsLayout(SETTINGS_TAB_LAYOUT, undefined), SETTINGS_TAB_LAYOUT, "通道信息未到时不改布局");

	// 分组分割线是布局的一部分：剔除中间项后，后续项自带的分割线标记必须保留。
	assert.deepEqual(applyRemoteGateToSettingsLayout([{ id: "common" }, { id: "connections", dividerBefore: true }, { id: "git", dividerBefore: true }], false), [{ id: "common" }, { id: "git", dividerBefore: true }], "剔除后保留其余条目的 dividerBefore");
});
