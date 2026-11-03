/**
 * 回归：全局 WSL 设置恢复后（5ee923a8f），systemIpc 各 pi 检测入口必须把
 * settings.wslEnabled/wslDistro/wslUser 传给 PiLocator。
 *
 * 2bc73a783 曾把这些调用点硬编码成 false/undefined/undefined，5ee923a8f 恢复
 * 全局 WSL 设置与设置页 UI 时漏了恢复调用点——表现为：WSL 验证成功、保存后
 * 设置页状态卡的路径/版本仍是宿主机 pi，点「检测环境」也检测不到 WSL 里的 pi
 * （用户反馈：root 在 Debian 可用、pi 0.80.8，但设置页还显示老的 win pi）。
 *
 * 例外：piInstall 的一键安装防重装扫描必须仍按宿主机扫（安装器装在宿主机，
 * 列表不能跟随 WSL 开关变成空数组，否则防重装形同虚设）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const systemIpc = readFileSync("src/main/ipc/systemIpc.ts", "utf8");
const modelListCache = readFileSync("src/main/pi/modelListCache.ts", "utf8");
const devTab = readFileSync("src/renderer/src/components/app/settings/DevTab.tsx", "utf8");
const settingsModal = readFileSync("src/renderer/src/components/app/SettingsModal.tsx", "utf8");

function handlerBody(source, channel) {
	const hit = source.match(new RegExp(String.raw`ipcMain\.handle\(ipcChannels\.${channel},[\s\S]*?\n\t\}\);`));
	assert.ok(hit, `handler ${channel} 未找到`);
	return hit[0];
}

test("piCheck 按 settings 的 WSL 三件套探测，不回落宿主机", () => {
	const body = handlerBody(systemIpc, "piCheck");
	assert.match(
		body,
		/piLocator\.check\(settings\.customPiPath, settings\.wslEnabled, settings\.wslDistro, settings\.wslUser, \{ forceWslProbe \}\)/,
		"piCheck 必须传 settings.wslEnabled/wslDistro/wslUser，硬编码 false 会让 WSL 模式永远检测宿主机 pi",
	);
});

test("piInstallations / piCheckCustom 同样跟随 WSL 设置", () => {
	assert.match(handlerBody(systemIpc, "piInstallations"), /listInstallations\(settings\.customPiPath, settings\.wslEnabled, settings\.wslDistro, settings\.wslUser/);
	assert.match(handlerBody(systemIpc, "piCheckCustom"), /validateCustomPath\(customPath, settings\.wslEnabled, settings\.wslDistro, settings\.wslUser\)/);
});

test("关于弹框与反馈环境的 pi 版本探测也跟随 WSL 设置", () => {
	const count = [...systemIpc.matchAll(/piLocator\.check\(settings\.customPiPath, settings\.wslEnabled/g)].length;
	// piCheck + resolveAppInfo + appFeedbackEnvironment = 3 处
	assert.ok(count >= 3, `appInfo 与反馈环境的探测也应传 WSL 设置，实际匹配 ${count} 处`);
});

test("模型列表失败归因的健康检查跟随 WSL 设置", () => {
	assert.match(
		modelListCache,
		/piLocator\.check\(settings\.customPiPath, settings\.wslEnabled, settings\.wslDistro, settings\.wslUser\)/,
		"失败归因不跟随 WSL 时，宿主机 pi 存在会把 WSL 侧失败误判成「pi 正常」",
	);
});

test("一键安装防重装扫描仍按宿主机（不跟随 WSL 开关）", () => {
	assert.match(
		systemIpc,
		/listInstallations\(settings\.customPiPath\)/,
		"安装器装在宿主机：防重装扫描必须保持单参宿主机语义",
	);
	assert.doesNotMatch(
		handlerBody(systemIpc, "piInstallations"),
		/listInstallations\(settings\.customPiPath\)/,
		"设置页列表 handler 已跟随 WSL 设置，不应再出现单参宿主机调用",
	);
});

test("DevTab「验证并保存」验证通过即落盘 WSL 字段并重检 pi", () => {
	assert.match(devTab, /onEnsureWslSettingsSaved: \(extra\?: Partial<AppSettings>\) => Promise<boolean>/);
	const savedAt = devTab.indexOf("props.onEnsureWslSettingsSaved({ wslUser: wslUserInput })");
	const checkAt = devTab.indexOf("props.onCheckPi();", savedAt);
	assert.ok(savedAt >= 0, "验证通过后必须以刚验证的 wslUser 落盘（extra 直传，避开 setState 闭包时序）");
	assert.ok(checkAt > savedAt, "落盘成功后必须紧接触发 pi 重检，否则状态卡停留在宿主机 pi");
});

test("SettingsModal 的 WSL 落盘通道支持立即值覆盖（extra）", () => {
	assert.match(settingsModal, /commitWslDraftFields = useCallback\(\s*async \(extra\?: Partial<AppSettings>\)/);
	assert.match(settingsModal, /const patch: Partial<AppSettings> = \{ \.\.\.extra \};/);
});
