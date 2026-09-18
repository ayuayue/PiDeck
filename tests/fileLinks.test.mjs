import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// 迁自 tests/file-links.test.ts（该文件从未被 npm test 的 *.test.mjs glob 执行）。
// 关键修正：经 loadTsCommonJs 直接加载生产模块 src/renderer/src/utils/fileLinks.ts，
// 不再复制函数副本；fileLinks.ts 本身是零依赖纯函数模块，无需 stub。
const { filePathFromHref, normalizeLocalFilePath, stripFileLocation, toInternalFileHref } =
 loadTsCommonJs("src/renderer/src/utils/fileLinks.ts");

test("本地文件目标可规范化并往返 href", () => {
 const localTargets = [
  "C:/Users/Administrator/.pi/agent/settings.json",
  "C:\\Users\\Administrator\\.pi\\agent\\settings.json",
  "/C:/Users/Administrator/project/src/App.tsx:392",
  "/home/user/project/src/app.py:12:4",
  "./src/app.ts",
  "../docs/README.md",
  "src/components/App.tsx:42",
  "settings.json",
  "settings.json:8",
 ];
 for (const target of localTargets) {
  const normalized = normalizeLocalFilePath(target);
  assert.ok(normalized, `expected local file target: ${target}`);
  const href = toInternalFileHref(target);
  assert.ok(href?.startsWith("file://"), `expected internal href: ${target}`);
  assert.equal(filePathFromHref(href), normalized);
 }
});

test("外部目标一律拒绝", () => {
 const externalTargets = [
  "https://example.com/docs/readme.md",
  "http://example.com/file.json",
  "mailto:user@example.com",
  "#section",
  "/docs/getting-started",
  "//example.com/docs/file.md",
 ];
 for (const target of externalTargets) {
  assert.equal(normalizeLocalFilePath(target), null, `expected external target: ${target}`);
  assert.equal(toInternalFileHref(target), null);
 }
});

test("行号剥离与 href 解码", () => {
 assert.equal(normalizeLocalFilePath("/C:/Users/Test/file.ts:9"), "C:/Users/Test/file.ts:9");
 assert.equal(stripFileLocation("C:/Users/Test/file.ts:9:3"), "C:/Users/Test/file.ts");
 assert.equal(stripFileLocation("C:/Users/Test/file.ts"), "C:/Users/Test/file.ts");
 assert.equal(
  filePathFromHref("file://C%3A%2FUsers%2FTest%2FMy%20File.ts%3A9"),
  "C:/Users/Test/My File.ts:9",
 );
});

test("Markdown 链接目标同样识别为本地文件", () => {
 const markdownTargets = [
  "[settings.json](C:/Users/Administrator/.pi/agent/settings.json)",
  "[App.tsx](/C:/Users/Administrator/project/src/App.tsx:392)",
  "[app.py](/home/user/project/app.py:12:4)",
  "[README](../docs/README.md)",
 ];
 // 原 .ts 版用 unified+remark-parse 提取链接，但 unified 不在 node_modules 根
 // （仅传递依赖）；提取行为本身用正则等价替代，去掉该依赖。
 const mdLinkRe = /\]\(([^)]+)\)/;
 for (const markdown of markdownTargets) {
  const url = mdLinkRe.exec(markdown)?.[1];
  assert.ok(url, `expected markdown link: ${markdown}`);
  assert.ok(toInternalFileHref(url), `expected Markdown file target: ${url}`);
 }
});
