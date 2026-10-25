import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("App: attach refs read the authoritative Session draft atom (no stale previous)", () => {
	// setPromptForAgent（previous 权威源）已迁入 useSessionPromptDispatch。
	const app = readFileSync("src/renderer/src/hooks/session/useSessionPromptDispatch.ts", "utf8");
	// 回归：右键引用 → 删除 → 再引用不得把已删除的旧引用带回输入框。
	// previous 必须来自 draft atom（输入框编辑/删除的权威源），而不是只在
	// setPromptForAgent 内更新的 livePromptByAgentRef。
	assert.match(app, /import \{[^}]*sessionDraftByIdAtom/);
	assert.match(app, /previous = store\.get\(sessionDraftByIdAtom\)\[targetAgentId\] \?\? ""/);
	assert.doesNotMatch(app, /const previous = livePromptByAgentRef\.current\[targetAgentId\]/);
});

test("App: listens to composer-attach-refs and appends refs with spacer", () => {
	const app = readFileSync("src/renderer/src/App.tsx", "utf8");
	assert.match(app, /window\.addEventListener\("composer-attach-refs"/);
	assert.match(app, /refs\.join\(" "\)/);
	// 与文件树右键 onAttach 相同的尾部追加 + 补空格语义
	assert.match(app, /endsWith\(" "\) \|\| current\.length === 0 \? "" : " "}/);
});

test("CodeMirrorEditor: right-click with selection opens attach menu with line range", () => {
	const editor = readFileSync("src/renderer/src/components/app/CodeMirrorEditor.tsx", "utf8");
	// 选区右键：无选区不接管（保留浏览器菜单），有选区时算起止行号
	assert.match(editor, /onAttachSelection\?: \(startLine: number, endLine: number\) => void/);
	assert.match(editor, /handleContextMenu/);
	assert.match(editor, /main\.from === main\.to/);
	assert.match(editor, /doc\.lineAt\(main\.from\)\.number/);
	assert.match(editor, /doc\.lineAt\(main\.to\)\.number/);
	// Radix DropdownMenu 虚拟锚点（与 FileContextMenu 同模式）
	assert.match(editor, /DropdownMenuTrigger/);
	assert.match(editor, /editor\.attachSelectionRange/);
	assert.match(editor, /onAttachSelectionRef\.current\?\.\(menu\.startLine, menu\.endLine\)/);
});

test("FileDiffViewer: attach selection dispatches @path:start-end ref event", () => {
	const viewer = readFileSync("src/renderer/src/components/app/FileDiffViewer.tsx", "utf8");
	// 引用格式与 pi 的 read 语法对齐：@path:start-end（单行时 @path:start）
	assert.match(viewer, /formatFilePathRef\(props\.filePath\)/);
	assert.match(viewer, /`\$\{formatFilePathRef\(props\.filePath\)\}:\$\{range\}`/);
	assert.match(viewer, /composer-attach-refs/);
	assert.match(viewer, /onAttachSelection=\{handleAttachSelection\}/);
});
