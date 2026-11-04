import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// 编辑器查找快捷键（Ctrl/Cmd+F）的兜底规则。
// 背景：CM 的 searchKeymap 只在编辑器持有 DOM 焦点时才跑；从文件树/标签栏/会话链接打开
// 文件后焦点还停在原处，按键既进不了编辑器 keymap，也没有别的监听者（窗口没有原生菜单，
// Electron 不提供内置查找栏），用户看到的就是「Ctrl+F 完全没反应」。
const { isEditorFindShortcut } = loadTsCommonJs("src/renderer/src/utils/editorFindShortcut.ts");

test("ctrl/cmd+F is claimed regardless of letter case", () => {
	assert.equal(isEditorFindShortcut({ key: "f", ctrlKey: true }), true);
	assert.equal(isEditorFindShortcut({ key: "F", metaKey: true }), true);
});

test("other keys and modifier combos stay with their owners", () => {
	assert.equal(isEditorFindShortcut({ key: "f" }), false); // 裸 f 是输入
	assert.equal(isEditorFindShortcut({ key: "v", ctrlKey: true }), false); // Ctrl+V 粘贴
	assert.equal(isEditorFindShortcut({ key: "f", ctrlKey: true, altKey: true }), false); // ⌘⌥F 交给系统
	// 上游已经处理过（编辑器自身 keymap / 文件面板搜索）就不重复接管
	assert.equal(isEditorFindShortcut({ key: "f", ctrlKey: true, defaultPrevented: true }), false);
});

test("editor module installs the global find fallback", () => {
	const src = readFileSync("src/renderer/src/components/app/CodeMirrorEditor.tsx", "utf8");
	// 必须挂窗口级监听并真正打开查找面板：只留 searchKeymap 时焦点不在编辑器里就彻底没入口
	assert.match(src, /window\.addEventListener\("keydown", handleGlobalFindShortcut\)/);
	assert.match(src, /openSearchPanel\(view\)/);
	// 焦点在编辑器里 / 在输入框里时必须让位，不能抢上游的处理权
	assert.match(src, /closest\("\.cm-editor"\)/);
	assert.match(src, /isEditableTarget\(target\)/);
});

// 文件面板与编辑器抢同一个 Ctrl+F（issue #215 让面板用它开文件名搜索）。用户从文件树点开
// 文件后焦点仍在树行上，按 Ctrl+F 得到的是「按文件名搜文件」而不是「在当前文件里找」——
// 反馈就是「编辑器里根本没有搜索」。仲裁规则：有编辑器可查时归编辑器，否则回落到面板搜索。
const bridge = loadTsCommonJs("src/renderer/src/utils/editorFindBridge.ts");

test("editor find bridge reports whether an editor took the shortcut", () => {
	assert.equal(bridge.requestEditorFind(), false); // 还没有编辑器登记
	bridge.setEditorFindHandler(() => true);
	assert.equal(bridge.requestEditorFind(), true);
	bridge.setEditorFindHandler(() => false); // 编辑器在但实例已销毁
	assert.equal(bridge.requestEditorFind(), false);
	bridge.setEditorFindHandler(null);
	assert.equal(bridge.requestEditorFind(), false);
});

test("file panel yields Ctrl+F to the editor before opening its own name search", () => {
	const surface = readFileSync("src/renderer/src/components/session/WorkspaceSurface.tsx", "utf8");
	// requestEditorFind 必须在 setSearchOpen 之前，且命中后直接 return（不能两个搜索都开）
	assert.match(surface, /if \(requestEditorFind\(\)\) return;\s*setSearchOpen\(true\);/);
	// 编辑器侧必须把入口登记进桥，否则面板永远收不到「有人在查」
	const editor = readFileSync("src/renderer/src/components/app/CodeMirrorEditor.tsx", "utf8");
	assert.match(editor, /setEditorFindHandler\(openActiveEditorFind\)/);
});
