import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// 文件面板搜索入口的按键判定（issue #215 补入口）：纯函数，规则回归在此兜底。
// 背景：抽屉文件面板此前只有工具行那个放大镜图标能进搜索，Ctrl/Cmd+F 与「直接敲字符」
// 都不生效；叠加 projectId 未接线导致图标根本没渲染，用户完全找不到搜索。
const { isFileSearchShortcut, isTypeToSearchKey, isEditableTarget } = loadTsCommonJs("src/renderer/src/utils/fileSearchTrigger.ts");

test("ctrl/cmd+F opens the in-panel file search, plain F does not", () => {
	assert.equal(isFileSearchShortcut({ key: "f", ctrlKey: true }), true);
	assert.equal(isFileSearchShortcut({ key: "F", metaKey: true }), true); // ⌘F 与大小写无关
	assert.equal(isFileSearchShortcut({ key: "f" }), false); // 裸 f 属于「输入即搜索」，不是快捷键
	assert.equal(isFileSearchShortcut({ key: "f", ctrlKey: true, altKey: true }), false); // ⌘⌥F 交给系统
	assert.equal(isFileSearchShortcut({ key: "v", ctrlKey: true }), false); // Ctrl+V 仍是粘贴文件
});

test("type-to-search only fires for a single printable character", () => {
	assert.equal(isTypeToSearchKey({ key: "a" }), true);
	assert.equal(isTypeToSearchKey({ key: "空" }), true);
	assert.equal(isTypeToSearchKey({ key: " " }), false); // 空格留给展开/翻页
	assert.equal(isTypeToSearchKey({ key: "Enter" }), false);
	assert.equal(isTypeToSearchKey({ key: "ArrowDown" }), false);
	assert.equal(isTypeToSearchKey({ key: "a", ctrlKey: true }), false);
	assert.equal(isTypeToSearchKey({ key: "a", metaKey: true }), false);
	assert.equal(isTypeToSearchKey({ key: "a", isComposing: true }), false); // IME 组字中不劫持
});

test("editable targets keep their keystrokes instead of hijacking search", () => {
	// 判定用鸭子类型（node 环境没有 HTMLElement），这里只测形态匹配
	assert.equal(isEditableTarget({ tagName: "INPUT" }), true);
	assert.equal(isEditableTarget({ tagName: "textarea" }), true);
	assert.equal(isEditableTarget({ tagName: "SELECT" }), true);
	assert.equal(isEditableTarget({ tagName: "DIV", isContentEditable: true }), true);
	assert.equal(isEditableTarget({ tagName: "DIV" }), false);
	assert.equal(isEditableTarget({ tagName: "BUTTON" }), false);
	assert.equal(isEditableTarget(null), false);
	assert.equal(isEditableTarget("input"), false);
});
