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
 *
 * 第三轮（用户报障：WSL 模式下检测不到 pi 时，引导页没有 WSL 相关检测/引导）：
 * 「一键安装」整条链路（runtimeNodeCheck/runtimeNodeInstall/piRuntimePiInstall）
 * 只在宿主机装，WSL 模式下装出来的副本用不上。因此清单扫描改为跟随 WSL（已装就用），
 * 否则返回「请在发行版内安装」的结构化失败，渲染层引导页同时给出 WSL 内的安装指令。
 * 旧用例「防重装扫描保持单参」已被这条契约取代。
 *
 * 第二轮回归（同族，用户报障：点「检查更新」又变回宿主机 pi 1.5）：
 * piSelfUpdateRunner（check / update 末尾核验）与 ExtensionManager
 * （updateExtensions / detectPiVersion / runPi）的同族调用点也必须传三件套，
 * 否则检查更新、扩展更新、版本探测全部命中宿主机安装。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { systemIpcSource } from "./helpers/systemIpcSources.mjs";

const systemIpc = systemIpcSource;
const modelListCache = readFileSync("src/main/pi/modelListCache.ts", "utf8");
const devTab = readFileSync("src/renderer/src/components/app/settings/DevTab.tsx", "utf8");
const settingsModal = readFileSync("src/renderer/src/components/app/SettingsModal.tsx", "utf8");
const piSelfUpdateRunner = readFileSync("src/main/pi/piSelfUpdateRunner.ts", "utf8");
const extensionManager = readFileSync("src/main/extensions/ExtensionManager.ts", "utf8");

function handlerBody(source, channel) {
	const hit = source.match(new RegExp(String.raw`ipcMain\.handle\(ipcChannels\.${channel},[\s\S]*?\n\t\}\);`));
	assert.ok(hit, `handler ${channel} 未找到`);
	return hit[0];
}

test("piCheck 按 settings 的 WSL 三件套探测，不回落宿主机", () => {
	const body = handlerBody(systemIpc, "piCheck");
	assert.match(body, /piLocator\.check\(settings\.customPiPath, settings\.wslEnabled, settings\.wslDistro, settings\.wslUser, \{ forceWslProbe \}\)/, "piCheck 必须传 settings.wslEnabled/wslDistro/wslUser，硬编码 false 会让 WSL 模式永远检测宿主机 pi");
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
	assert.match(modelListCache, /piLocator\.check\(settings\.customPiPath, settings\.wslEnabled, settings\.wslDistro, settings\.wslUser\)/, "失败归因不跟随 WSL 时，宿主机 pi 存在会把 WSL 侧失败误判成「pi 正常」");
});

test("一键安装在 WSL 模式下不装宿主机副本，防重装扫描跟随 WSL 设置", () => {
	const body = handlerBody(systemIpc, "piRuntimePiInstall");
	// 发行版内的 pi 才是用户实际用的那份：扫描必须命中它，否则 WSL 模式下会再装一份宿主机副本。
	assert.match(body, /listInstallations\(settings\.customPiPath, wslEnabled, settings\.wslDistro, settings\.wslUser\)/);
	assert.match(body, /const wslEnabled = process\.platform === "win32" && settings\.wslEnabled === true/);
	// 发行版里确实没装时，宿主机 npm 装的副本用不上：直接返回带说明的失败，不装作成功。
	assert.match(body, /if \(wslEnabled\) \{[\s\S]*?mainCopy\("wsl\.hostInstallBlocked"\)[\s\S]*?return \{ success: false/);
	assert.doesNotMatch(systemIpc, /listInstallations\(settings\.customPiPath\)/, "不得再出现不带 WSL 三件套的探测");
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

test("Pi 自更新检查与更新后核验跟随 WSL 设置（否则检查更新永远显示宿主机版本）", () => {
	// check() 与 update() 末尾的版本核验都要命中发行版内的 pi
	assert.equal([...piSelfUpdateRunner.matchAll(/locator\.check\(settings\.customPiPath, settings\.wslEnabled, settings\.wslDistro, settings\.wslUser\)/g)].length, 2);
	assert.doesNotMatch(piSelfUpdateRunner, /locator\.check\(settings\.customPiPath\)\s*;?\s*\n/, "不得再出现只传 customPiPath 的宿主机探测");
});

test("扩展更新/版本探测/runPi 跟随 WSL 设置", () => {
	assert.equal([...extensionManager.matchAll(/locator\.check\(settings\.customPiPath, settings\.wslEnabled, settings\.wslDistro, settings\.wslUser\)/g)].length, 2, "updateExtensions 与 detectPiVersion 两处");
	assert.match(extensionManager, /locator\.resolveCommand\(settings\.customPiPath, settings\.wslEnabled, settings\.wslDistro, settings\.wslUser\)/, "runPi 必须解析到发行版内的 pi，否则扩展操作落在宿主机安装上");
	assert.match(extensionManager, /await this\.locator\.warmWslCommand\(settings\.wslDistro, settings\.wslUser\)/, "resolveCommand 同步拿不到冷缓存，必须先预热");
});

test("listInstallations 的 WSL 分支返回发行版内正则匹配的那一份（不再是空数组）", () => {
	const piLocator = readFileSync("src/main/pi/PiLocator.ts", "utf8");
	const hit = piLocator.match(/async listInstallations\([\s\S]*?\n\t\}/);
	assert.ok(hit, "listInstallations 未找到");
	assert.match(hit[0], /source: "wsl"/);
	assert.match(hit[0], /isActive: true/);
});
