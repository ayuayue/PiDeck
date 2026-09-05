import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync("src/renderer/src/hooks/useFileEditor.ts", "utf8");
const viewer = readFileSync(
  "src/renderer/src/components/app/FileDiffViewer.tsx",
  "utf8",
);

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
  assert.match(viewer, /props\.readContent\(props\.filePath, maxFileSize, props\.fileAccessScope\)/);
  assert.match(viewer, /FILE_TOO_LARGE:\(\\d\+\):\(\\d\+\)/);
  assert.match(viewer, /props\.saveContent\(savePath, latest, props\.fileAccessScope\)/);
  assert.match(viewer, /\[getLatestContent, isDiffMode, props\.saveContent, props\.filePath, props\.fileAccessScope\?\.projectId\]/);
  assert.match(viewer, /async function loadMediaPreview\(\)/);
  assert.match(viewer, /if \(cancelled \|\| !base64\)/);
  assert.doesNotMatch(viewer, /loadMediaPreview\(cancelled\)|isCancelled: boolean/);
});
