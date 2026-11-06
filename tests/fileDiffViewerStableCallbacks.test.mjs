import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync("src/renderer/src/hooks/useFileEditor.ts", "utf8");
const viewer = readFileSync("src/renderer/src/components/app/FileDiffViewer.tsx", "utf8");

test("file viewer IO callbacks are stable across App re-renders", () => {
	assert.match(app, /const readEditorFileContent = useCallback/);
	assert.match(app, /const readEditorOriginalContent = useCallback/);
	assert.match(app, /const saveEditorFileContent = useCallback/);
	assert.match(app, /readFileContent/);
	assert.match(app, /readGitOriginalContent/);
	assert.match(app, /writeFileContent/);
	assert.doesNotMatch(app, /readContent=\{\(path\) => api\.files\.readContent\(path\)\}/);
	assert.doesNotMatch(app, /readOriginalContent=\{\(path\) => api\.git\.originalContent\(path\)\}/);
	assert.doesNotMatch(app, /saveContent=\{\(path, content\) => api\.files\.writeContent\(path, content\)\}/);
});

test("file viewer keeps project scope and drops stale media reads", () => {
	assert.match(viewer, /const fileAccessPath = props\.fileTarget \?\? props\.filePath/);
	assert.match(viewer, /props\.readContent\(fileAccessPath, maxFileSize, props\.fileAccessScope\)/);
	// 错误文案转换已抽出，前缀行为由 fileLoadErrorMessage.test.mjs 验证。
	assert.match(viewer, /import\s*\{\s*fileLoadErrorMessage\s*\}\s*from\s*["']\.\/fileLoadErrorMessage["']/);
	assert.match(viewer, /saveContent\(savePath, latest, props\.fileAccessScope, baselineRevisionRef\.current\)/);
	// 乐观锁：保存时带内容指纹，盘上已被改过就拒绝并给出「已被修改」文案。
	assert.match(viewer, /async function contentRevision\(text: string\)/);
	assert.match(viewer, /baselineRevisionRef\.current = await contentRevision\(latest\)/);
	assert.match(viewer, /t\("editor\.fileChangedOnDisk"\)/);
	assert.match(viewer, /\[isDiffMode, props\.saveContent, props\.filePath, props\.fileTarget\?\.projectId, props\.fileTarget\?\.relativePath, props\.fileAccessScope\?\.projectId\]/);
	assert.match(viewer, /async function loadMediaPreview\(\)/);
	assert.match(viewer, /if \(cancelled \|\| !base64\)/);
	// 回归（2026-10）：主进程 FILE_TOO_LARGE:size:max 结构化前缀必须经
	// fileLoadErrorMessage 转 i18n 文案，直接 setError(e.message) 会裸码给用户。
	assert.match(viewer, /setError\(fileLoadErrorMessage\(e\)\)/);
	assert.doesNotMatch(viewer, /loadMediaPreview\(cancelled\)|isCancelled: boolean/);
});
