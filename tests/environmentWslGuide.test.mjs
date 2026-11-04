/**
 * 回归：WSL 模式下没有 pi 时，环境检测弹窗必须给 WSL 相关的引导。
 *
 * 用户报障原文：「pi 引导加载，如果没检测到，没有 WSL 相关的检测和引导」。
 * 成因：引导面板只有「一键安装」这一条主线，而 runtimeNodeCheck / runtimeNodeInstall /
 * piRuntimePiInstall 全部操作宿主机；检测却跟随全局 WSL 设置（去发行版里找 pi）。
 * 于是 WSL 模式下用户看到的是一套装了也用不上的宿主机 Node/npm/pi 流程。
 *
 * 契约（本轮定下）：
 * 1. 引导面板收到 wsl 三件套后换成 WSL 内的安装指令，隐藏「一键安装」与镜像开关；
 * 2. 弹窗与 App 必须把这组信息透传下去（漏一层就等于没做）；
 * 3. 主进程 piRuntimePiInstall 在 WSL 模式下不装宿主机副本（见 systemIpcWslPiProbe.test.mjs）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const panel = readFileSync("src/renderer/src/components/overlays/EnvironmentSetupPanel.tsx", "utf8");
const overlay = readFileSync("src/renderer/src/components/overlays/OverlayComponents.tsx", "utf8");
const app = readFileSync("src/renderer/src/App.tsx", "utf8");
const zhCN = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
const enUS = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");
const zhTW = readFileSync("src/renderer/src/i18n/rendererCopy.zh-TW.ts", "utf8");

test("引导面板接收 WSL 目标并按 WSL 模式切成发行版内安装指令", () => {
	assert.match(panel, /wsl\?: \{ enabled: boolean; distro\?: string; user\?: string \}/, "EnvironmentSetupPanel 缺 wsl prop");
	assert.match(panel, /const wslMode = props\.wsl\?\.enabled === true;/);
	// 标题/说明换文案，代码块给发行版内的安装命令
	assert.match(panel, /t\(wslMode \? "environment\.setupWslTitle" : "environment\.setupTitle"\)/);
	assert.match(panel, /wslMode \? t\("environment\.setupWslDesc", \{ distro: wslDistro \}\) : t\("environment\.setupDesc"\)/);
	assert.match(panel, /t\("environment\.setupWslCommandHint"\)/);
	assert.match(panel, /t\("environment\.setupWslRecheckHint"\)/);
	// 宿主机三步行（Node/npm/pi）与一键安装按钮只在非 WSL 模式出现
	const hostRows = panel.indexOf("<SetupStepRow state={nodeState}");
	const oneClick = panel.indexOf("onClick={guide.installAll}");
	assert.ok(hostRows > 0 && oneClick > 0, "宿主机引导行/一键安装按钮不见了？");
	assert.match(panel.slice(0, oneClick), /\{wslMode \? null : \(\s*<div className="flex flex-wrap items-center gap-3">[\s\S]*$/, "一键安装按钮必须包在 !wslMode 分支里");
	// 高级区的安装器同理：它只会在宿主机上跑
	assert.match(panel, /t\(wslMode \? "environment\.setupAdvancedDescWsl" : "environment\.setupAdvancedDesc"\)/);
	const installCommandLabel = panel.indexOf("environment.installCommandLabel");
	assert.ok(installCommandLabel > 0, "手动安装命令行不见了？");
	assert.ok(panel.lastIndexOf("{wslMode ? null : (", installCommandLabel) > panel.indexOf("environment.setupAdvancedDescWsl"), "手动安装命令行必须包在 !wslMode 分支里");
});

test("弹窗与 App 把 WSL 目标透传到引导面板", () => {
	assert.match(overlay, /wsl\?: EnvironmentSetupPanelProps\["wsl"\]/);
	assert.match(overlay, /wsl=\{props\.wsl\}/);
	assert.match(app, /wsl=\{\{ enabled: settings\.wslEnabled === true, distro: settings\.wslDistro, user: settings\.wslUser \}\}/);
});

test("WSL 引导文案三语齐全（zh-CN 源 + en-US + 生成的 zh-TW）", () => {
	const keys = ["setupWslTitle", "setupWslDesc", "setupWslCommandHint", "setupWslMirrorHint", "setupWslRecheckHint", "setupAdvancedDescWsl"];
	for (const key of keys) {
		assert.match(zhCN, new RegExp(`"environment\\.${key}":`), `zh-CN 缺 environment.${key}`);
		assert.match(enUS, new RegExp(`"environment\\.${key}":`), `en-US 缺 environment.${key}`);
		assert.match(zhTW, new RegExp(`"environment\\.${key}":`), `zh-TW 生成物缺 environment.${key}（改完 zh-CN 要重跑生成脚本）`);
	}
	// 命令必须是能在发行版里直接跑的 npm 全局安装
	assert.match(zhCN, /"environment\.setupWslCommandHint": "npm i -g @earendil-works\/pi-coding-agent"/);
});
