import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("startup Pi update check is removed", () => {
	const hook = readFileSync("src/renderer/src/hooks/usePiUpdate.ts", "utf8");
	const app = readFileSync("src/renderer/src/App.tsx", "utf8");

	// 回归：启动时不再自动检查 pi CLI 更新（曾在应用打开 1.2s 后弹
	// 「Pi 不是最新版本」toast 打扰启动流程）；版本检测只保留设置页手动入口。
	assert.doesNotMatch(app, /checkPiCliUpdateOnStartup/);
	assert.doesNotMatch(hook, /checkPiCliUpdateOnStartup|startupUpdateCheckDoneRef/);
});

test("opening dev settings does not auto-detect pi; cached result is shown directly", () => {
	const hook = readFileSync("src/renderer/src/hooks/usePiUpdate.ts", "utf8");
	const devTab = readFileSync("src/renderer/src/components/app/settings/DevTab.tsx", "utf8");
	const settings = readFileSync("src/shared/types/settings.ts", "utf8");

	// 回归：打开开发设置 tab 曾自动触发一次 pi 路径检测（spawn 探测），
	// 现在只有手动点「检测环境」才检测；已检测成功的结果从 settings 缓存直接恢复显示。
	assert.doesNotMatch(devTab, /activeTab === "dev" && props\.piStatus === null/);
	assert.match(devTab, /不自动检测 pi/);
	// settings 持久化字段 + 恢复逻辑（piStatus 为 null 时从缓存回填）
	assert.match(settings, /piInstall\?: \{ command: string; version: string \}/);
	assert.match(hook, /settings\.piInstall && piStatus === null/);
	assert.match(hook, /persistPiInstall/);
	// 未检测到时清除旧缓存，避免残留旧路径
	assert.match(hook, /清除旧缓存，避免残留/);
});

test("cached pi version is silently revalidated once per session (stale-while-revalidate)", () => {
	const hook = readFileSync("src/renderer/src/hooks/usePiUpdate.ts", "utf8");

	// 回归：缓存版本曾永久过期——startup 检测只在首次引导跑（piEnvironmentChecked 之后
	// 没人纠正 settings.piInstall），pi 被外部升级后开发页一直显示旧版本（实测 0.84.4 vs 1.0.2）。
	// 修复：缓存照常立即显示，但每渲染会话静默复核一次并回写缓存；
	// 会话级闸门保证不会在打开设置页时重复 spawn（上面的测试约束不被破坏）。
	assert.match(hook, /piStatusRevalidatedRef/);
	assert.match(hook, /api\.pi\.check\(false\)/);
	// 探测失败/未安装时不得静默盖掉上次成功结果
	assert.match(hook, /if \(!next\.installed\) return;/);
});

/**
 * 找某个 `<SettingsSection>` 在文件里的起始偏移。
 * 不要用字面量 `'<SettingsSection title={t("...")}>'` 做 indexOf：锚点补全（20fdfcf40）给这些
 * 分区都加了 `id="settings-section-…"`，属性一多/一换位、或多个空格就永远找不到（红灯）。
 */
function sectionStart(source, titleKey) {
	return source.search(new RegExp(`<SettingsSection[^>]*t\\(\\s*"${titleKey}"\\s*\\)[^>]*>`));
}

test("live pi version probes refresh the cached version (external upgrade while running)", () => {
	const hook = readFileSync("src/renderer/src/hooks/usePiUpdate.ts", "utf8");
	const rule = readFileSync("src/renderer/src/utils/piStatusSync.ts", "utf8");

	// 回归：用户在命令行升级 pi（npm i -g / pi update）后，顶部「Pi CLI 已找到」一直显示缓存里的旧版本，
	// 而同屏的安装列表（刚跑过 pi --version）已是新版本，点「检查 Pi 更新」还提示「Pi 已是最新版本」
	// ——实测同屏 1.1.0 vs v1.2.0。判定规则抽成纯函数（tests/piStatusSync.test.mjs），
	// 这里钉住「凡是真探测到的版本都要接上这条校正链路」的接线。
	assert.match(rule, /export function resolvePiStatusFromProbe\(/);
	// 「检查 Pi 更新」：checkUpdate 已经真跑过 pi --version，用它的 currentVersion 校正顶部与缓存
	assert.match(hook, /checkUpdate\(\)[\s\S]{0,400}?syncPiStatusFromProbe\(\s*\{\s*command: result\.command,\s*version: result\.currentVersion\s*\},?\s*\)/);
	// 安装列表里「当前使用」那条同理：用户从不点「检测环境」也能看到外部升级后的真实版本
	assert.match(hook, /find\(\(item\) => item\.isActive\)[\s\S]{0,240}?syncPiStatusFromProbe\(\s*\{\s*command: active\.path,\s*version: active\.version\s*\},?\s*\)/);
	// 校正必须连缓存一起写：只改顶部不写 settings.piInstall，下次启动又变回旧版本
	assert.match(hook, /setSettings\(await persistPiInstall\(next\)\)/);
});

test("Pi CLI update notice is anchored to its controls", () => {
	const devTab = readFileSync("src/renderer/src/components/app/settings/DevTab.tsx", "utf8");
	const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
	const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");

	const environmentStart = sectionStart(devTab, "settings.environment");
	const piNoticeStart = devTab.indexOf("{piUpdateNotice &&");
	const updatesStart = sectionStart(devTab, "settings.sectionUpdates");

	assert.ok(environmentStart >= 0, "environment section must exist");
	assert.ok(piNoticeStart > environmentStart && piNoticeStart < updatesStart, "Pi CLI update notice must appear in the environment section beside its action buttons");
	// 手动检查结果比定时后台快照新，且后台已发现更新时“更新 Pi”应可直接操作。
	assert.match(devTab, /const piUpdateStatus = props\.piUpdateCheck \?\? piCliStatus;/);
	assert.match(devTab, /const piUpdateAvailable = Boolean\(piUpdateStatus\?\.hasUpdate\);/);
	assert.match(devTab, /disabled=\{\s*!piUpdateAvailable\s*\}/);
	assert.match(zh, /可使用上方的「更新 Pi」操作更新/);
	assert.match(en, /Use Update Pi above to install it/);
});

test("pi version changes feed back into the background update snapshot (sidebar dot)", () => {
	const systemIpc = readFileSync("src/main/ipc/systemIpc.ts", "utf8");
	const updateService = readFileSync("src/main/update/UpdateService.ts", "utf8");

	// 回归：后台快照每 2h 才刷一轮；应用内「更新 pi」成功后圆点仍停在
	// 「pi 有新版本」（设置页已经显示「已是最新版本」，两处自相矛盾），要等下一轮检查才消失。
	// 修复 = 两条真实探测链路都把结果写回快照：
	// 1) 设置页的「检测 Pi 更新」（也是应用内更新完成后的复核）
	assert.match(updateService, /applyPiCheckResult\(\s*result:\s*PiUpdateCheckResult\s*\)\s*:\s*void/);
	const checkHandler = systemIpc.match(/ipcMain\.handle\(\s*ipcChannels\.piUpdateCheck[\s\S]*?\n\t\}\);/)?.[0] ?? "";
	assert.ok(checkHandler, "piUpdateCheck handler must exist");
	assert.match(checkHandler, /updateService\?\.applyPiCheckResult\(\s*result\s*\)/);

	// 2) 环境检测真跑过 `pi --version`：探测到的版本与快照不一致 = 外部升级，补一轮检查
	const checkPiHandler = systemIpc.match(/ipcMain\.handle\(\s*ipcChannels\.piCheck[\s\S]*?\n\t\}\);/)?.[0] ?? "";
	assert.ok(checkPiHandler, "piCheck handler must exist");
	assert.match(checkPiHandler, /getSnapshot\(\)\.piCli\?\.currentVersion/);
	assert.match(checkPiHandler, /snapshotPiVersion\s*!==\s*status\.version/);
	assert.match(checkPiHandler, /updateService\.checkNow\(\)/);
});
