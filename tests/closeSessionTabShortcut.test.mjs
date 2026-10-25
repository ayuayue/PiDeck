import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

function transpile(filePath) {
	return ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText;
}

/** 加载 shared/shortcuts.ts（纯函数，无依赖），platform 只影响默认键与展示 */
function loadShortcuts({ platform = "win32" } = {}) {
	const sandbox = { exports: {}, process: { platform }, require };
	vm.runInNewContext(transpile("src/shared/shortcuts.ts"), sandbox, {
		filename: "shared/shortcuts.ts",
	});
	return sandbox.exports;
}

/**
 * Cmd/Ctrl+W 关闭当前会话标签页（Chrome 关标签页惯例）：
 * 注册表默认键 → 主进程两处 before-input-event 转发 → 渲染层 hook 消费（回答中先确认：
 * 确认 = 停止 + 关闭，取消 = 保持；空闲直接关）→ 三语词典文案齐全。
 * 源码正则断言全部空白容忍（\s*），避免格式化整组断言失败。
 */

test("注册表：closeSessionTab 默认键 win32=Ctrl+W / darwin=Cmd+W，可被覆盖", () => {
	const win = loadShortcuts({ platform: "win32" });
	const mac = loadShortcuts({ platform: "darwin" });
	const winDef = win.getShortcutDef("closeSessionTab");
	const macDef = mac.getShortcutDef("closeSessionTab");
	assert.ok(winDef && macDef, "注册表必须包含 closeSessionTab");
	assert.equal(win.resolveDefaultAccelerator(winDef, "win32"), "Ctrl+W");
	assert.equal(mac.resolveDefaultAccelerator(macDef, "darwin"), "Cmd+W");
	// 用户覆盖生效、非法覆盖回退默认
	assert.equal(win.resolveShortcutBindings({ closeSessionTab: "Ctrl+Shift+W" }, "win32").closeSessionTab, "Ctrl+Shift+W");
	assert.equal(win.resolveShortcutBindings({ closeSessionTab: "W" }, "win32").closeSessionTab, "Ctrl+W");
});

test("主进程：主窗口与内置浏览器 webview 两处 before-input-event 都命中并广播 closeSessionTab", () => {
	const main = readFileSync("src/main/index.ts", "utf8");
	// 主窗口：isShortcutInput("closeSessionTab", input) → send(..., "closeSessionTab")
	assert.match(main, /isShortcutInput\("closeSessionTab",\s*input\)/);
	assert.match(main, /webContents\.send\(ipcChannels\.appShortcutTriggered,\s*"closeSessionTab"\)/);
	// 两处转发（主窗口 + webview guest）都必须在命中后 preventDefault，避免按键漏进页面
	const hits = main.match(/isShortcutInput\("closeSessionTab",\s*input\)/g) ?? [];
	assert.equal(hits.length, 2, "主窗口与 webview guest 各一处转发");
	const guards = main.match(/isShortcutInput\("closeSessionTab",\s*input\)\)\s*\{\s*event\.preventDefault\(\);/g) ?? [];
	assert.equal(guards.length, 2, "两处命中后都要 preventDefault");
});

test("渲染层 hook：空闲直接关 Tab；回答中先弹确认，确认 = 停止回答 + 关闭，取消不动", () => {
	const hook = readFileSync("src/renderer/src/hooks/useCloseSessionTabShortcut.ts", "utf8");
	// 订阅快捷键广播并过滤 closeSessionTab
	assert.match(hook, /onShortcutTriggered\(/);
	assert.match(hook, /id\s*!==\s*"closeSessionTab"/);
	// busy 判定与时间线 isBusy 同口径（activating/sending/runtime busy）
	assert.match(hook, /isSessionRuntimeBusy/);
	assert.match(hook, /"activating"/);
	assert.match(hook, /"sending"/);
	// 空闲：直接 closeTab，不弹确认
	assert.match(hook, /if\s*\(!busy\)\s*\{\s*closeTab\(sessionId\);\s*return;/);
	// 回答中：确认框文案走 i18n，确认后先 abort 再关（取消 = 保持，由 overlays 自身承担）
	assert.match(hook, /showConfirm\(\{/);
	assert.match(hook, /t\("tabs\.closeRunningTitle"\)/);
	assert.match(hook, /t\("tabs\.closeRunningConfirm"\)/);
	assert.match(hook, /abortAgent\(target\.agentId\)/);
	// App.tsx 已装配（closeTab/abortAgent/overlays 三依赖齐全）
	const app = readFileSync("src/renderer/src/App.tsx", "utf8");
	assert.match(app, /useCloseSessionTabShortcut\(\{\s*closeTab:\s*workspaceChrome\.closeTab,\s*abortAgent,\s*overlays\s*\}\)/);
});

test("词典：三语的确认框文案与快捷键说明键齐全", () => {
	for (const file of ["zh-CN", "en-US", "zh-TW"]) {
		const dict = readFileSync(`src/renderer/src/i18n/rendererCopy.${file}.ts`, "utf8");
		for (const key of ["tabs.closeRunningTitle", "tabs.closeRunningBody", "tabs.closeRunningConfirm", "settings.shortcuts.closeSessionTabLabel", "settings.shortcuts.closeSessionTabDesc"]) {
			assert.ok(dict.includes(`"${key}"`), `${file} 缺少 ${key}`);
		}
	}
});
