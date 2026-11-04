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
