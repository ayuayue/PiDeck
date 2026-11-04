/**
 * 回归：设置里改 WSL 来源 / 发行版 / 用户后，技能/提示词/扩展/配置目录必须立即切换，不再要求重启。
 *
 * 背景：`syncWslConfig` 原先只是启动块里的局部 const，只在启动时跑一次；用户在开发设置里把
 * wslUser 从 root 改成 debian 后，资源页仍绑在旧 HOME（`/root` 0700 → 列表 EPERM，或显示旧用户的技能）。
 * 现在它是模块级函数，启动与 settingsUpdate 共用同一份实现。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const index = readFileSync("src/main/index.ts", "utf8");
const systemIpc = readFileSync("src/main/ipc/systemIpc.ts", "utf8");
const { hasWslSettingsChanged } = loadTsCommonJs("src/main/wsl/WslProjectEnvironment.ts");

test("WSL 热切换只在三元组真的变化时触发", () => {
	const base = { wslEnabled: true, wslDistro: "Ubuntu", wslUser: "root" };
	assert.equal(hasWslSettingsChanged(base, { ...base }), false);
	assert.equal(hasWslSettingsChanged(base, { ...base, wslEnabled: false }), true);
	assert.equal(hasWslSettingsChanged(base, { ...base, wslDistro: "Debian" }), true);
	assert.equal(hasWslSettingsChanged(base, { ...base, wslUser: "debian" }), true);
});

test("WSL 环境切换只有一份模块级实现，启动与热切换共用", () => {
	assert.match(index, /async function syncWslConfig\(\): Promise<void> \{/);
	// 启动路径仍调用同一函数
	assert.match(index, /void syncWslConfig\(\)/);
	// 原生过滤投影必须跟着 config 目录重读，否则开关显示的还是旧用户的设置
	assert.match(index, /await Promise\.all\(\[refreshSkillProjection\(\), refreshPromptProjection\(\), refreshExtensionProjection\(\)\]\)/);
});

test("registerSystemIpc 注入了 applyWslSettings，并同步重指向模型能力快照", () => {
	assert.match(index, /applyWslSettings: async \(\) => \{\s*await syncWslConfig\(\);\s*piModelCapabilityCache\?\.invalidate\(\);\s*piModelCapabilityCache\?\.watchConfigDirectory\(\);\s*\},/);
});

test("settingsUpdate 只在 WSL 三元组真的变化时重放，且切换失败不影响已落盘的设置", () => {
	assert.match(systemIpc, /applyWslSettings\?: \(\) => Promise<void>;/);
	assert.match(systemIpc, /const wslSettingsChanged = hasWslSettingsChanged\(prevSettings, settings\);/);
	assert.match(systemIpc, /if \(wslSettingsChanged && deps\.applyWslSettings\) \{[\s\S]*?await deps\.applyWslSettings\(\);[\s\S]*?catch \(error\) \{[\s\S]*?"Applying WSL settings failed"/);
});
