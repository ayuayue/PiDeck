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

/**
 * 加载 shared/shortcuts.ts 纯模块（无依赖），供 appShortcuts 与断言共用。
 * 两套平台规则：darwin（⌘）与 win32/linux（Ctrl+Alt / Ctrl）。
 */
function loadSharedShortcuts({ platform = "win32" } = {}) {
	const sharedSandbox = {
		exports: {},
		process: { platform },
		require,
	};
	vm.runInNewContext(transpile("src/shared/shortcuts.ts"), sharedSandbox, {
		filename: "shared/shortcuts.ts",
	});
	return sharedSandbox.exports;
}

/**
 * 加载 src/main/appShortcuts.ts。electron 依赖用 require 兜底，
 * shared/shortcuts 用注入的沙箱实例（保证同一进程内 shared 只有一份）。
 */
function loadAppShortcuts({ platform = "win32" } = {}) {
	const shared = loadSharedShortcuts({ platform });
	const sandbox = {
		exports: {},
		process: { platform },
		require: (id) => {
			if (id === "../shared/shortcuts") return shared;
			return require(id);
		},
	};
	vm.runInNewContext(transpile("src/main/appShortcuts.ts"), sandbox, {
		filename: "appShortcuts.ts",
	});
	return { mod: sandbox.exports, shared };
}

/** 构造 before-input-event 输入形状 */
function input(overrides) {
	return {
		key: "s",
		type: "keyDown",
		control: false,
		meta: false,
		shift: false,
		alt: false,
		isComposing: false,
		...overrides,
	};
}

test("Windows/Linux 默认：Ctrl+Alt+S 打开设置，F12 开发者工具，Ctrl+Shift+M 快捷消息", () => {
	const { mod } = loadAppShortcuts({ platform: "win32" });
	assert.equal(mod.isShortcutInput("openSettings", input({ control: true, alt: true })), true);
	assert.equal(mod.isShortcutInput("toggleDevTools", input({ key: "F12" })), true);
	// 快捷消息：带 Shift 避开 cycleModel 的 Ctrl+M
	assert.equal(mod.isShortcutInput("openQuickMessages", input({ key: "m", control: true, shift: true })), true);
	// 缺 Shift 不算（那是模型循环键）
	assert.equal(mod.isShortcutInput("openQuickMessages", input({ key: "m", control: true })), false);
	assert.equal(mod.isShortcutInput("openQuickMessages", input({ key: "m", control: true, shift: true, alt: true })), false);
	// 缺 Alt / 缺 Ctrl 都不触发
	assert.equal(mod.isShortcutInput("openSettings", input({ control: true })), false);
	assert.equal(mod.isShortcutInput("openSettings", input({ alt: true })), false);
	// 叠加 Shift / Meta 不算
	assert.equal(mod.isShortcutInput("openSettings", input({ control: true, alt: true, shift: true })), false);
	// 别的键不算
	assert.equal(mod.isShortcutInput("openSettings", input({ key: "a", control: true, alt: true })), false);
});

test("macOS 默认：Cmd+, 打开设置，F12 开发者工具", () => {
	const { mod } = loadAppShortcuts({ platform: "darwin" });
	assert.equal(mod.isShortcutInput("openSettings", input({ key: ",", meta: true })), true);
	// Ctrl+,（Windows 习惯键）在 macOS 上不生效
	assert.equal(mod.isShortcutInput("openSettings", input({ key: ",", control: true })), false);
	assert.equal(mod.isShortcutInput("openSettings", input({ key: ",", meta: true, alt: true })), false);
	assert.equal(mod.isShortcutInput("openSettings", input({ key: ",", meta: true, shift: true })), false);
	assert.equal(mod.isShortcutInput("openSettings", input({ key: ".", meta: true })), false);
	assert.equal(mod.isShortcutInput("toggleDevTools", input({ key: "F12" })), true);
	// macOS 快捷消息：Cmd+Shift+M（裸 ⌘M 是系统惯例「最小化窗口」，必须带 Shift）
	assert.equal(mod.isShortcutInput("openQuickMessages", input({ key: "m", meta: true, shift: true })), true);
	assert.equal(mod.isShortcutInput("openQuickMessages", input({ key: "m", meta: true })), false);
});

test("主窗口 before-input-event 广播 openQuickMessages（会话定位交给渲染层）", () => {
	const main = readFileSync("src/main/index.ts", "utf8");
	// 与 cycleModel/cycleThinking 同模式：主进程只匹配 + 广播，不持有会话上下文
	assert.match(main, /isShortcutInput\("openQuickMessages", input\)/);
	assert.match(main, /mainWindow\.webContents\.send\(ipcChannels\.appShortcutTriggered, "openQuickMessages"\)/);
	// 命中时必须 preventDefault：否则按键会继续落到输入框（Ctrl+Shift+M 在编辑器里的默认行为不可控）
	assert.match(main, /isShortcutInput\("openQuickMessages", input\)\) \{\s*event\.preventDefault\(\);/);
});

test("覆盖表生效：自定义 Ctrl+K 后默认键失效，恢复后默认键回来", () => {
	const { mod, shared } = loadAppShortcuts({ platform: "win32" });
	mod.refreshShortcutBindings({ shortcuts: { openSettings: "Ctrl+K" } });
	assert.equal(mod.isShortcutInput("openSettings", input({ key: "k", control: true })), true);
	// 被覆盖的默认键不再触发
	assert.equal(mod.isShortcutInput("openSettings", input({ control: true, alt: true })), false);
	// 覆盖表清空 = 恢复默认
	mod.refreshShortcutBindings({ shortcuts: {} });
	assert.equal(mod.isShortcutInput("openSettings", input({ control: true, alt: true })), true);
	assert.equal(mod.isShortcutInput("openSettings", input({ key: "k", control: true })), false);
});

test("开发者工具保持默认 F12 时兼容 Ctrl+Shift+I/J；自定义后兼容键失效", () => {
	const { mod } = loadAppShortcuts({ platform: "win32" });
	const ctrlShiftI = input({ key: "I", control: true, shift: true });
	const ctrlShiftJ = input({ key: "J", control: true, shift: true });
	assert.equal(mod.isShortcutInput("toggleDevTools", ctrlShiftI), true);
	assert.equal(mod.isShortcutInput("toggleDevTools", ctrlShiftJ), true);
	// 自定义后只认新键
	mod.refreshShortcutBindings({ shortcuts: { toggleDevTools: "Ctrl+D" } });
	assert.equal(mod.isShortcutInput("toggleDevTools", input({ key: "d", control: true })), true);
	assert.equal(mod.isShortcutInput("toggleDevTools", ctrlShiftI), false);
	assert.equal(mod.isShortcutInput("toggleDevTools", input({ key: "F12" })), false);
	// 切换平台：macOS 的 F12 仍生效，Ctrl+Shift+I 不生效
	const mac = loadAppShortcuts({ platform: "darwin" });
	assert.equal(mac.mod.isShortcutInput("toggleDevTools", input({ key: "F12" })), true);
	assert.equal(mac.mod.isShortcutInput("toggleDevTools", ctrlShiftI), false);
});

test("缩放保持默认时兼容 Ctrl++ / 数字键盘；自定义后只认新绑定", () => {
	const { mod } = loadAppShortcuts({ platform: "win32" });
	// 默认 Ctrl+= 命中
	assert.equal(mod.isShortcutInput("zoomIn", input({ key: "=", control: true })), true);
	// 等价键：Ctrl+Shift+=（物理键盘上的 Ctrl++）与数字键盘 +（无 Shift）
	assert.equal(mod.isShortcutInput("zoomIn", input({ key: "+", control: true, shift: true })), true);
	assert.equal(mod.isShortcutInput("zoomIn", input({ key: "+", control: true })), true);
	assert.equal(mod.isShortcutInput("zoomOut", input({ key: "-", control: true })), true);
	assert.equal(mod.isShortcutInput("zoomOut", input({ key: "_", control: true, shift: true })), true);
	// 叠加 Alt / Meta 不算，避免抢 Ctrl+Alt+= 这类组合
	assert.equal(mod.isShortcutInput("zoomIn", input({ key: "+", control: true, alt: true })), false);
	assert.equal(mod.isShortcutInput("zoomIn", input({ key: "+", control: true, meta: true })), false);
	// 自定义后等价键与默认键都失效
	mod.refreshShortcutBindings({ shortcuts: { zoomIn: "Ctrl+9", zoomOut: "Ctrl+0" } });
	assert.equal(mod.isShortcutInput("zoomIn", input({ key: "9", control: true })), true);
	assert.equal(mod.isShortcutInput("zoomIn", input({ key: "+", control: true, shift: true })), false);
	assert.equal(mod.isShortcutInput("zoomIn", input({ key: "=", control: true })), false);
	// macOS 默认 Cmd+= 及其等价键
	const mac = loadAppShortcuts({ platform: "darwin" });
	assert.equal(mac.mod.isShortcutInput("zoomIn", input({ key: "=", meta: true })), true);
	assert.equal(mac.mod.isShortcutInput("zoomIn", input({ key: "+", meta: true, shift: true })), true);
	assert.equal(mac.mod.isShortcutInput("zoomIn", input({ key: "=", control: true })), false);
});

test("设置里写入非法覆盖时回退默认；未知快捷键 id 直接忽略", () => {
	const { mod } = loadAppShortcuts({ platform: "win32" });
	// 裸键（无修饰）在设置页应被拦下，这里模拟绕过校验写入，匹配端必须兜底
	mod.refreshShortcutBindings({ shortcuts: { openSettings: "S" } });
	assert.equal(mod.isShortcutInput("openSettings", input({ control: true, alt: true })), true);
	// 未知 id 不影响已知键
	mod.refreshShortcutBindings({ shortcuts: { openSettings: "Ctrl+K", "not-a-shortcut": "Ctrl+L" } });
	assert.equal(mod.isShortcutInput("openSettings", input({ key: "k", control: true })), true);
});

test("keyUp / char / 输入法组合期（isComposing）事件永不触发", () => {
	const { mod } = loadAppShortcuts({ platform: "win32" });
	assert.equal(mod.isShortcutInput("openSettings", input({ type: "keyUp", control: true, alt: true })), false);
	assert.equal(mod.isShortcutInput("openSettings", input({ type: "char", control: true, alt: true })), false);
	assert.equal(mod.isShortcutInput("openSettings", input({ control: true, alt: true, isComposing: true })), false);
	const mac = loadAppShortcuts({ platform: "darwin" });
	assert.equal(mac.mod.isShortcutInput("openSettings", input({ type: "keyUp", key: ",", meta: true })), false);
});

test("主窗口与 webview guest 统一走共享匹配；覆盖表在设置保存/启动时刷新", () => {
	const main = readFileSync("src/main/index.ts", "utf8");
	const systemIpc = readFileSync("src/main/ipc/systemIpc.ts", "utf8");
	const settingsRoot = readFileSync("src/renderer/src/components/app/SettingsFeatureRoot.tsx", "utf8");
	// 主进程统一走 isShortcutInput（含注册表与默认值）与 refreshShortcutBindings
	assert.match(main, /import \{ isShortcutInput, refreshShortcutBindings \} from "\.\/appShortcuts"/);
	// 主窗口 + webview guest 两处 before-input-event 都命中并广播
	assert.match(main, /isShortcutInput\("openSettings", input\)/);
	assert.match(main, /mainWindow\.webContents\.send\(ipcChannels\.appOpenSettings\)/);
	assert.match(main, /window\.webContents\.send\(ipcChannels\.appOpenSettings\)/);
	// 设置保存（systemIpc）与启动装配（index.ts）各刷新一次绑定
	assert.match(systemIpc, /refreshShortcutBindings\(settings\)/);
	// 渲染层打开设置页的订阅契约
	assert.match(settingsRoot, /api\.app\.onOpenSettings\(/);
	assert.match(settingsRoot, /setOpen\(true\)/);
});
