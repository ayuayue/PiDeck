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

/** 跨 VM realm 的对象先 JSON 归一化再断言（原型不同，直接 deepEqual 恒失败） */
function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

function keyEvent(overrides) {
	return {
		key: "s",
		ctrlKey: false,
		metaKey: false,
		shiftKey: false,
		altKey: false,
		...overrides,
	};
}

/** 构造 before-input-event 形状（matchesAccelerator 用） */
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

test("parseAccelerator：合法组合解析为布尔修饰位 + 规范化主键", () => {
	const s = loadShortcuts();
	assert.deepEqual(plain(s.parseAccelerator("Ctrl+Alt+S", "win32")), {
		ctrl: true,
		meta: false,
		alt: true,
		shift: false,
		key: "s",
	});
	assert.deepEqual(plain(s.parseAccelerator("Cmd+,", "darwin")), {
		ctrl: false,
		meta: true,
		alt: false,
		shift: false,
		key: ",",
	});
	assert.deepEqual(plain(s.parseAccelerator("F12", "win32")), {
		ctrl: false,
		meta: false,
		alt: false,
		shift: false,
		key: "f12",
	});
	assert.deepEqual(plain(s.parseAccelerator("Ctrl+Shift+Space", "win32")), {
		ctrl: true,
		meta: false,
		alt: false,
		shift: true,
		key: "space",
	});
	// CmdOrCtrl 按平台落位
	assert.equal(s.parseAccelerator("CmdOrCtrl+S", "darwin").meta, true);
	assert.equal(s.parseAccelerator("CmdOrCtrl+S", "win32").ctrl, true);
	// 非法：空串 / 只有修饰键 / 多个主键 / 未知修饰键
	assert.equal(s.parseAccelerator("", "win32"), null);
	assert.equal(s.parseAccelerator("Ctrl", "win32"), null);
	// 修饰键可出现在主键后（Electron 兼容），但两个主键不行
	assert.equal(s.parseAccelerator("Ctrl+S+1", "win32"), null);
	assert.equal(s.parseAccelerator("Hyper+Shift+S", "win32"), null);
});

test("matchesAccelerator：修饰键精确匹配、主键大小写不敏感、命名键归一", () => {
	const s = loadShortcuts({ platform: "win32" });
	const match = (acc, ev) => s.matchesAccelerator(acc, ev, "win32");
	assert.equal(match("Ctrl+Alt+S", input({ key: "s", control: true, alt: true })), true);
	assert.equal(match("Ctrl+Alt+S", input({ key: "S", control: true, alt: true })), true);
	// 多一个修饰键不算
	assert.equal(match("Ctrl+Alt+S", input({ key: "s", control: true, alt: true, shift: true })), false);
	assert.equal(match("Ctrl+Alt+S", input({ key: "s", control: true })), false);
	// F 键无修饰
	assert.equal(match("F12", input({ key: "F12" })), true);
	assert.equal(match("F12", input({ key: "F12", control: true })), false);
	// 非 keyDown / 输入法组合期不触发
	assert.equal(match("Ctrl+Alt+S", input({ key: "s", control: true, alt: true, type: "keyUp" })), false);
	assert.equal(match("Ctrl+Alt+S", input({ key: "s", control: true, alt: true, isComposing: true })), false);
	// 命名键：KeyboardEvent key "ArrowUp" ↔ accelerator "Alt+Up"（accelerator 用 "Up" 拼写）
	assert.equal(match("Alt+Up", input({ key: "ArrowUp", alt: true })), true);
	assert.equal(match("Ctrl+Space", input({ key: " ", control: true })), true);
});

test("macOS 修饰键映射：Cmd=Meta，Ctrl 独立，主键 ','", () => {
	const s = loadShortcuts({ platform: "darwin" });
	const match = (acc, ev) => s.matchesAccelerator(acc, ev, "darwin");
	assert.equal(match("Cmd+,", input({ key: ",", meta: true })), true);
	assert.equal(match("Cmd+,", input({ key: ",", control: true })), false);
	assert.equal(match("Ctrl+,", input({ key: ",", control: true })), true);
	assert.equal(match("Cmd+,", input({ key: ",", meta: true, control: true })), false);
});

test("buildAcceleratorFromKeyEvent：从浏览器 KeyboardEvent 构造 accelerator", () => {
	const s = loadShortcuts({ platform: "win32" });
	const build = (ev) => s.buildAcceleratorFromKeyEvent(keyEvent(ev), "win32");
	assert.equal(build({ key: "s", ctrlKey: true, altKey: true }), "Ctrl+Alt+S");
	assert.equal(build({ key: "S", ctrlKey: true }), "Ctrl+S");
	assert.equal(build({ key: "ArrowUp", altKey: true }), "Alt+Up");
	assert.equal(build({ key: "+", shiftKey: true }), "Shift+Plus");
	// 修饰键位顺序固定：Ctrl、Alt、Shift，最后是平台主修饰键
	assert.equal(build({ key: "s", shiftKey: true, ctrlKey: true }), "Ctrl+Shift+S");
	assert.equal(build({ key: "s", metaKey: true }), "Super+S"); // Windows 上 Meta 记 Super
	// 纯修饰键 / 无键值 / 不支持的键：继续等待下一个键
	assert.equal(build({ key: "Control" }), null);
	assert.equal(build({ key: "" }), null);
	assert.equal(build({ key: "Unidentified" }), null);
});

test("macOS 录制：Cmd 记为 Meta（⌘），Ctrl 独立", () => {
	const s = loadShortcuts({ platform: "darwin" });
	assert.equal(s.buildAcceleratorFromKeyEvent(keyEvent({ key: ",", metaKey: true }), "darwin"), "Cmd+,");
	assert.equal(s.buildAcceleratorFromKeyEvent(keyEvent({ key: "s", metaKey: true }), "darwin"), "Cmd+S");
	assert.equal(s.buildAcceleratorFromKeyEvent(keyEvent({ key: "s", ctrlKey: true, altKey: true }), "darwin"), "Ctrl+Alt+S");
});

test("isValidAccelerator：必须有修饰键或为功能键，禁止裸字母/裸 Esc", () => {
	const s = loadShortcuts({ platform: "win32" });
	assert.equal(s.isValidAccelerator("Ctrl+Alt+S", "win32"), true);
	assert.equal(s.isValidAccelerator("F12", "win32"), true);
	assert.equal(s.isValidAccelerator("Ctrl+Shift+F5", "win32"), true);
	assert.equal(s.isValidAccelerator("S", "win32"), false);
	assert.equal(s.isValidAccelerator("Escape", "win32"), false); // 抢系统返回键
	assert.equal(s.isValidAccelerator("Enter", "win32"), false);
	assert.equal(s.isValidAccelerator("Ctrl+W", "win32"), true); // 应用内常用组合允许覆盖
	assert.equal(s.isValidAccelerator("Alt+Tab", "win32"), true); // OS 层会抢，但语法合法
});

test("formatAccelerator：macOS 符号化展示，Windows/Linux 文本展示", () => {
	const s = loadShortcuts({ platform: "darwin" });
	assert.equal(s.formatAccelerator("Cmd+Shift+,", "darwin"), "⇧⌘,");
	assert.equal(s.formatAccelerator("Ctrl+Alt+S", "darwin"), "⌃⌥S");
	assert.equal(s.formatAccelerator("F12", "darwin"), "F12");
	const w = loadShortcuts({ platform: "win32" });
	assert.equal(w.formatAccelerator("Ctrl+Alt+S", "win32"), "Ctrl+Alt+S");
	assert.equal(w.formatAccelerator("Super+Shift+Space", "win32"), "Shift+Win+Space");
});

test("注册表：默认键随平台（mac ⌘, / win Ctrl+Alt+S），DevTools 保持 F12", () => {
	const s = loadShortcuts({ platform: "darwin" });
	assert.equal(s.resolveDefaultAccelerator(s.getShortcutDef("openSettings"), "darwin"), "Cmd+,");
	assert.equal(s.resolveDefaultAccelerator(s.getShortcutDef("toggleDevTools"), "darwin"), "F12");
	const w = loadShortcuts({ platform: "win32" });
	assert.equal(w.resolveDefaultAccelerator(w.getShortcutDef("openSettings"), "win32"), "Ctrl+Alt+S");
	assert.equal(w.resolveDefaultAccelerator(w.getShortcutDef("toggleDevTools"), "win32"), "F12");
	assert.equal(w.getShortcutDef("unknown-id"), undefined);
});

test("resolveShortcutBindings：覆盖 ∪ 默认；非法覆盖回退默认；未知 id 丢弃", () => {
	const s = loadShortcuts({ platform: "win32" });
	const bindings = s.resolveShortcutBindings({ openSettings: "Ctrl+K", toggleDevTools: "S", unknown: "Ctrl+L" }, "win32");
	assert.deepEqual(plain(bindings), {
		openSettings: "Ctrl+K",
		openNewSession: "Ctrl+N",
		openSearch: "Ctrl+F",
		openCommandPalette: "Ctrl+P",
		cycleModel: "Ctrl+M",
		cycleThinking: "Ctrl+T",
		openQuickMessages: "Ctrl+Shift+M",
		toggleVoiceRecording: "F9",
		zoomIn: "Ctrl+=",
		zoomOut: "Ctrl+-",
		toggleDevTools: "F12", // 非法裸键回退默认
	});
});

test("sanitizeShortcutOverrides：写盘前清洗，只留已知 id 的合法组合", () => {
	const s = loadShortcuts({ platform: "win32" });
	assert.deepEqual(plain(s.sanitizeShortcutOverrides({ openSettings: " Ctrl+K ", toggleDevTools: "S", unknown: "Ctrl+L" }, "win32")), { openSettings: "Ctrl+K" });
	// 非对象入参 → 空对象
	assert.deepEqual(plain(s.sanitizeShortcutOverrides(null, "win32")), {});
	assert.deepEqual(plain(s.sanitizeShortcutOverrides(["Ctrl+K"], "win32")), {});
});

test("SHORTCUT_DEFS 注册表完整性：id 唯一、分组合法、默认键双平台可解析", () => {
	const s = loadShortcuts({ platform: "win32" });
	const ids = s.SHORTCUT_DEFS.map((def) => def.id);
	assert.equal(new Set(ids).size, ids.length); // id 唯一
	for (const def of s.SHORTCUT_DEFS) {
		assert.ok(["general", "dev"].includes(def.group), `group 合法: ${def.id}`);
		assert.ok(def.labelKey.startsWith("settings.shortcuts."), `labelKey 前缀: ${def.id}`);
		assert.ok(def.descriptionKey.startsWith("settings.shortcuts."), `descriptionKey 前缀: ${def.id}`);
		// 默认键双平台都合法且可展示
		assert.ok(s.isValidAccelerator(def.defaultAccelerator.other, "win32"), `win32 默认键合法: ${def.id}`);
		assert.ok(s.isValidAccelerator(def.defaultAccelerator.darwin, "darwin"), `darwin 默认键合法: ${def.id}`);
	}
});

test("平台默认键列表完整（覆盖表之外不丢键）", () => {
	const s = loadShortcuts({ platform: "win32" });
	assert.deepEqual(plain(s.resolveShortcutBindings({}, "win32")), {
		openSettings: "Ctrl+Alt+S",
		openNewSession: "Ctrl+N",
		openSearch: "Ctrl+F",
		openCommandPalette: "Ctrl+P",
		cycleModel: "Ctrl+M",
		cycleThinking: "Ctrl+T",
		// 快捷消息：Ctrl+M 已被模型循环占用，必须带 Shift 避让
		openQuickMessages: "Ctrl+Shift+M",
		toggleVoiceRecording: "F9",
		zoomIn: "Ctrl+=",
		zoomOut: "Ctrl+-",
		toggleDevTools: "F12",
	});
	const mac = loadShortcuts({ platform: "darwin" });
	assert.deepEqual(plain(mac.resolveShortcutBindings({}, "darwin")), {
		openSettings: "Cmd+,",
		openNewSession: "Cmd+N",
		openSearch: "Cmd+F",
		openCommandPalette: "Cmd+P",
		// macOS 避开 Cmd+M（最小化窗口）与 Cmd+T（新标签页惯例）
		cycleModel: "Cmd+Alt+M",
		cycleThinking: "Cmd+Alt+T",
		openQuickMessages: "Cmd+Shift+M",
		toggleVoiceRecording: "F9",
		zoomIn: "Cmd+=",
		zoomOut: "Cmd+-",
		toggleDevTools: "F12",
	});
});

test("快捷消息默认键不得与其它快捷键撞键（跨平台逐项对比）", () => {
	for (const platform of ["win32", "darwin"]) {
		const s = loadShortcuts({ platform });
		const bindings = s.resolveShortcutBindings({}, platform);
		// 撞键会让设置页一打开就报冲突并禁止保存，用户得先手工改键才能用
		const quick = bindings.openQuickMessages;
		const collisions = Object.entries(bindings).filter(([id, acc]) => id !== "openQuickMessages" && acc === quick);
		assert.deepEqual(collisions, [], `${platform} 快捷消息默认键 ${quick} 不应与其它快捷键重复`);
		// 必须有修饰键（裸 M 会抢正常输入）
		assert.equal(s.isValidAccelerator(quick, platform), true);
	}
});

test("toAriaKeyShortcuts：产出 WAI-ARIA 语法（Control/Meta 全称），非法键返回 undefined", () => {
	const s = loadShortcuts({ platform: "win32" });
	assert.equal(s.toAriaKeyShortcuts("Ctrl+Shift+M", "win32"), "Control+Shift+M");
	assert.equal(s.toAriaKeyShortcuts("Ctrl+Alt+S", "win32"), "Alt+Control+S");
	assert.equal(s.toAriaKeyShortcuts("Cmd+Shift+M", "darwin"), "Meta+Shift+M");
	assert.equal(s.toAriaKeyShortcuts("Ctrl+Alt+Shift+K", "win32"), "Alt+Control+Shift+K");
	// 不能复用展示用的 formatAccelerator：macOS 会得到 "⌘⇧M"，那不是合法 ARIA 值
	assert.equal(s.toAriaKeyShortcuts("F12", "win32"), "F12");
	// 命名键要 ARIA 拼写（ArrowUp 而不是展示用的 "↑"）
	assert.equal(s.toAriaKeyShortcuts("Alt+Up", "win32"), "Alt+ArrowUp");
	// 无法解析时返回 undefined（调用方整个省略属性，而不是挂非法值）
	assert.equal(s.toAriaKeyShortcuts("Hyper+S", "win32"), undefined);
});
