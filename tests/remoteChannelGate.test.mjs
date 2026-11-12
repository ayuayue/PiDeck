// tests/remoteChannelGate.test.mjs
// 远端能力与更新通道解耦后的发布契约：正式包与 dev 包都提供，
// 主进程通过 update:get-channel 下发单一能力位，渲染入口不再读 devBuild。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

import { previewApiSource } from "./helpers/previewApiSources.mjs";
import { systemIpcSource } from "./helpers/systemIpcSources.mjs";
import { mainAssemblySource } from "./helpers/mainIpcSources.mjs";

const VISIBILITY_MODULE = "src/renderer/src/hooks/remoteFeatureVisibility.ts";

function devChannelBuild(packaged, devBuild) {
	const load = createTsSandbox({ globals: { __PIDECK_DEV_BUILD__: devBuild }, stubs: { electron: { app: { isPackaged: packaged } } } });
	return load("src/main/update/channelIdentity.ts").isDevChannelBuild();
}

test("远端发布策略不随更新通道变化", () => {
	const { REMOTE_FEATURE_AVAILABLE } = loadTsCommonJs("src/main/remote/remoteFeaturePolicy.ts");
	assert.equal(REMOTE_FEATURE_AVAILABLE, true, "正式包与 dev 包都必须提供远端能力");

	assert.equal(devChannelBuild(false, false), true, "未打包运行必须开（dev / e2e）");
	assert.equal(devChannelBuild(false, true), true, "未打包且带 dev 标记仍为开");
	assert.equal(devChannelBuild(true, true), true, "dev 通道安装包必须开");
	assert.equal(devChannelBuild(true, false), false, "stable 包的构建身份仍为 false，但远端策略独立为 true");
});

test("远端域注册开关只有一个来源，且不允许写死", () => {
	const main = mainAssemblySource;
	// 策略位只允许在装配层读一次：域内再读一次就会与这个开关漂移。
	assert.equal([...main.matchAll(/const remoteFeatureEnabled\s*=\s*REMOTE_FEATURE_AVAILABLE;/g)].length, 1, "策略位应只在装配层派生一次");
	const registrations = [...main.matchAll(/registerRemote\w+Ipc\(\{/g)].length;
	const switches = [...main.matchAll(/enabled:\s*remoteFeatureEnabled\b/g)].length;
	assert.equal(registrations, 10, "远端域注册点数量变化时，同步更新本条断言与 docs/remote-release-readiness.md 的口径");
	assert.equal(switches, registrations, "每个远端注册点都必须用同一个开关，否则翻策略位只关掉一部分域");
	assert.doesNotMatch(main, /enabled:\s*true\b/, "不允许出现写死的 enabled: true（策略位会形同虚设）");
});

test("浏览器预览的能力位与写面成对，不是野值", () => {
	const preview = previewApiSource;
	// 预览要能渲染「连接」与远端入口，所以能力位为 true；但它没有主进程/SSH，
	// 写面必须报稳定码而不是假装成功——这两件事必须同时成立，才是可解释的预览口径。
	assert.match(preview, /remoteAvailable:\s*true/);
	assert.match(preview, /connect: async \(hostId\) => \(\{ ok: false as const, hostId, code: "REMOTE_FEATURE_DISABLED" \}\)/);
	assert.match(preview, /start: async \(\) => \(\{ ok: false as const, code: "REMOTE_FEATURE_DISABLED", outcome: "rejected" as const \}\)/);
});

test("能力契约只在 remoteAvailable=false 时隐藏入口", () => {
	const type = readFileSync("src/shared/types/app.ts", "utf8");
	const main = systemIpcSource;
	const hook = readFileSync("src/renderer/src/hooks/useRemoteFeatureAvailable.ts", "utf8");
	const preview = previewApiSource;
	assert.match(type, /remoteAvailable:\s*boolean/);
	assert.match(main, /remoteAvailable:\s*REMOTE_FEATURE_AVAILABLE/);
	assert.match(hook, /\?\.remoteAvailable/);
	assert.doesNotMatch(hook, /\?\.devBuild/);
	assert.match(preview, /remoteAvailable:\s*true/);

	const { isRemoteEntryVisible } = loadTsCommonJs(VISIBILITY_MODULE);
	assert.equal(isRemoteEntryVisible(false), false, "能力明确关闭时不暴露入口");
	assert.equal(isRemoteEntryVisible(true), true, "能力可用时暴露入口");
	assert.equal(isRemoteEntryVisible(undefined), true, "能力信息未到时不先藏入口");
});

test("添加项目的远端入口：能力可用且真有一台可用主机时才出现", () => {
	const { isRemoteAddProjectVisible, readRemoteHostsConfigured } = loadTsCommonJs(VISIBILITY_MODULE);
	const host = (verified, disabled) => ({ id: "11111111-1111-4111-8111-111111111111", label: "h", sshHost: "h", verified, disabled });

	// 清单 → 是否有可用主机（口径与登记弹框一致：已验证且未禁用）。
	assert.equal(readRemoteHostsConfigured({ ok: true, status: "ready", hosts: [] }), false, "一台主机都没有 -> 没有");
	assert.equal(readRemoteHostsConfigured({ ok: true, status: "ready", hosts: [host(false, false)] }), false, "未验证的主机不算可用（没有信任锚）");
	assert.equal(readRemoteHostsConfigured({ ok: true, status: "ready", hosts: [host(true, true)] }), false, "已禁用的主机不算可用");
	assert.equal(readRemoteHostsConfigured({ ok: true, status: "ready", hosts: [host(false, false), host(true, false)] }), true, "有一台可用就算配置过");
	assert.equal(readRemoteHostsConfigured({ ok: false, code: "REMOTE_FEATURE_DISABLED" }), undefined, "读不到清单不能当成「没有主机」");

	// 入口可见性：能力 + 主机清单两条都要满足。
	assert.equal(isRemoteAddProjectVisible(true, true), true, "能力可用且已配主机 -> 出现");
	assert.equal(isRemoteAddProjectVisible(true, false), false, "没有可用主机 -> 不出现（点进去只会落到 no-host）");
	assert.equal(isRemoteAddProjectVisible(true, undefined), false, "清单还没读到 -> 先不出现，也就不用先给一层空下拉");
	assert.equal(isRemoteAddProjectVisible(false, true), false, "能力关闭时即使配了主机也不提供远端入口");
});

test("设置页布局：能力关闭时剔除「连接」，可用与未知状态原样返回", () => {
	const { applyRemoteGateToSettingsLayout } = loadTsCommonJs(VISIBILITY_MODULE);
	const { SETTINGS_TAB_LAYOUT } = loadTsCommonJs("src/renderer/src/components/app/settings/settingsTabLayout.ts");
	const ids = (layout) => layout.map((entry) => entry.id);

	// 真布局里必须还有「连接」这项，否则下面的剔除断言会空转通过（tab 改名后这里先红）。
	assert.ok(ids(SETTINGS_TAB_LAYOUT).includes("connections"), "SETTINGS_TAB_LAYOUT 应含 connections tab");

	assert.deepEqual(
		ids(applyRemoteGateToSettingsLayout(SETTINGS_TAB_LAYOUT, false)),
		ids(SETTINGS_TAB_LAYOUT).filter((id) => id !== "connections"),
		"能力关闭：只少「连接」，其余顺序不变",
	);
	assert.equal(applyRemoteGateToSettingsLayout(SETTINGS_TAB_LAYOUT, true), SETTINGS_TAB_LAYOUT, "能力可用时原样返回（不重建数组，避免每次渲染都换引用）");
	assert.equal(applyRemoteGateToSettingsLayout(SETTINGS_TAB_LAYOUT, undefined), SETTINGS_TAB_LAYOUT, "能力信息未到时不改布局");

	// 分组分割线是布局的一部分：剔除中间项后，后续项自带的分割线标记必须保留。
	assert.deepEqual(applyRemoteGateToSettingsLayout([{ id: "common" }, { id: "connections", dividerBefore: true }, { id: "git", dividerBefore: true }], false), [{ id: "common" }, { id: "git", dividerBefore: true }], "剔除后保留其余条目的 dividerBefore");
});
