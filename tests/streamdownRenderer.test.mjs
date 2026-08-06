import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// UI 2.0（#115 U2）：Streamdown 为唯一 markdown 引擎，内置能力交给官方插件。
// 2026-08 内存优化：@streamdown/code（shiki 双主题 + 全语言 grammar）已移除，
// 代码块降级为默认 pre/code 渲染（见 docs/memory-profile-analysis.md 主线 B）。
// 关键点：mermaid/math 由 @streamdown/* 插件接管；a 仍走 MarkdownLink
// （file:// 打开 + 系统浏览器）；Tailwind 已扫描 streamdown 类名保证控件样式完整。
const stream = readFileSync("src/renderer/src/components/session/MarkdownStream.tsx", "utf8");
const surface = readFileSync("src/renderer/src/components/session/SurfaceComponents.tsx", "utf8");
const link = readFileSync("src/renderer/src/components/session/MarkdownLink.tsx", "utf8");
const linkCore = readFileSync("src/renderer/src/components/session/MarkdownLinkCore.ts", "utf8");
const tailwind = readFileSync("src/renderer/src/styles/tailwind.css", "utf8");
const main = readFileSync("src/renderer/src/main.tsx", "utf8");
const packageJson = readFileSync("package.json", "utf8");

test("streamdown pipeline delegates to official plugins (mermaid/math) and keeps link override", () => {
  // 官方插件接管：mermaid、数学
  assert.match(stream, /import \{ mermaid \} from "@streamdown\/mermaid"/);
  assert.match(stream, /import \{ math \} from "@streamdown\/math"/);
  assert.match(stream, /plugins=\{\s*\(props\.light/);
  assert.match(stream, /\{ math \}/);
  // shiki 高亮已移除（内存优化）：不引入 @streamdown/code，代码块走默认 pre/code
  assert.doesNotMatch(stream, /@streamdown\/code/);
  assert.doesNotMatch(stream, /\bcode,\n/);
  // 链接覆盖保留（file:// 打开 + 外链拦截是项目核心能力）
  assert.match(stream, /a: \(linkProps\) =>/);
  assert.match(stream, /MarkdownLink/);
  assert.match(stream, /remarkLinkifyPaths/);
  // 自定义 pre/span 覆盖移除：mermaid 由插件渲染、公式由 math 插件
  assert.doesNotMatch(stream, /pre: \(preProps\) => <CodeBlock/);
  assert.doesNotMatch(stream, /span: \(spanProps\) => <MathSpan/);
  // 流式容错引擎开启
  assert.match(stream, /mode=\{props\.isStreaming \? "streaming" : "static"\}/);
  // mermaid 主题跟随明暗
  assert.match(stream, /theme: isDark \? "dark" : "default"/);
});

test("Tailwind scans streamdown + plugin classes; styles.css imported (table/mermaid control styling)", () => {
  assert.match(tailwind, /@source "\.\.\/\.\.\/\.\.\/\.\.\/node_modules\/streamdown\/dist\/\*\.js"/);
  // @streamdown/code 已随高亮移除，不再扫描也不再依赖
  assert.doesNotMatch(tailwind, /@streamdown\/code/);
  assert.match(tailwind, /@source "\.\.\/\.\.\/\.\.\/\.\.\/node_modules\/@streamdown\/mermaid/);
  assert.match(tailwind, /@source "\.\.\/\.\.\/\.\.\/\.\.\/node_modules\/@streamdown\/math/);
  assert.match(main, /import "streamdown\/styles\.css"/);
  assert.doesNotMatch(packageJson, /"@streamdown\/code"/);
  assert.match(packageJson, /"@streamdown\/mermaid"/);
  assert.match(packageJson, /"@streamdown\/math"/);
  // shiki 高亮链整体移除：运行时依赖树里不允许出现 shiki（vitepress 文档站的 devDependency 除外）
  assert.doesNotMatch(packageJson, /"shiki"/);
  assert.doesNotMatch(packageJson, /"react-markdown"/);
});

test("link handling is the single shared implementation (no react-markdown import)", () => {
  // 单份实现：所有管线从共享模块 import，不允许本地重复定义
  assert.match(surface, /from "\.\/MarkdownStream"/);
  assert.doesNotMatch(surface, /function MarkdownLink\(/);
  assert.doesNotMatch(surface, /const remarkLinkifyPaths = /);
  assert.match(link, /export function MarkdownLink/);
  // 纯逻辑（remarkLinkifyPaths/FILE_PATH_RE/isLocalPathRef）在 MarkdownLinkCore.ts
  assert.match(linkCore, /export const remarkLinkifyPaths/);
  assert.match(linkCore, /export function isLocalPathRef/);
  assert.match(link, /from "\.\/MarkdownLinkCore"/);
  assert.match(linkCore, /export function markdownUrlTransform/);
  // 链接安全过滤已本地复刻，不再依赖 react-markdown 包
  assert.match(linkCore, /export function defaultUrlTransform/);
  assert.doesNotMatch(linkCore, /from "react-markdown"/);
});

test("Streamdown is the only markdown engine (switch, settings field, dependency removed)", () => {
  // AssistantText 无开关分流，直接渲染 MarkdownStream
  assert.doesNotMatch(surface, /useStreamdownRendererAtom/);
  assert.doesNotMatch(surface, /ReactMarkdown/);
  assert.doesNotMatch(surface, /from "react-markdown"/);
  assert.match(surface, /<MarkdownStream/);
});

test("static markdown scenes share the Streamdown engine", () => {
  const diffViewer = readFileSync("src/renderer/src/components/app/FileDiffViewer.tsx", "utf8");
  const updateOverlay = readFileSync("src/renderer/src/components/overlays/AppUpdateOverlay.tsx", "utf8");
  const scratchPad = readFileSync("src/renderer/src/components/scratchPad/ScratchPadPanel.tsx", "utf8");
  assert.doesNotMatch(diffViewer, /ReactMarkdown/);
  assert.doesNotMatch(updateOverlay, /ReactMarkdown/);
  assert.doesNotMatch(scratchPad, /ReactMarkdown/);
  assert.match(diffViewer, /MarkdownStream/);
  assert.match(updateOverlay, /MarkdownStream/);
  assert.match(scratchPad, /MarkdownStream/);
  // 静态场景保留各自插件（草稿本的高亮 mark 与 GFM task list 覆盖）
  assert.match(scratchPad, /rehypeHighlightMark/);
  assert.match(scratchPad, /remarkBreaks/);
});
