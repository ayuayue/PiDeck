import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// issue #369：有序列表的 ::marker（outside）会挂到内容列左侧，被 .markdown-body 的
// overflow-x: clip 裁掉（macOS 自定义字体下 1./2. 只剩右半边）。修复改用 li 内计数器。
const chrome = readFileSync("src/renderer/src/styles/streamdownChrome.css", "utf8");
const timeline = readFileSync("src/renderer/src/styles/timeline.css", "utf8");

test("ordered list numbers are rendered inside the list item (no outside marker clipping)", () => {
	// 从 1 开始的有序列表不再用原生 marker，改用 li 自己的计数器
	assert.match(chrome, /\[data-streamdown="ordered-list"\]:not\(\[start\]\)\s*\{[^}]*list-style:\s*none;[^}]*counter-reset:\s*pideck-ol;[^}]*padding-left:\s*0;/s);
	// 编号绝对定位在 li 左内边距内，编号右对齐、正文与换行统一缩进
	assert.match(chrome, /\[data-streamdown="ordered-list"\]:not\(\[start\]\)\s*>\s*\[data-streamdown="list-item"\]\s*\{[^}]*position:\s*relative;[^}]*counter-increment:\s*pideck-ol;[^}]*padding-left:\s*1\.7em;/s);
	assert.match(chrome, /\[data-streamdown="ordered-list"\]:not\(\[start\]\)\s*>\s*\[data-streamdown="list-item"\]::before\s*\{[^}]*content:\s*counter\(pideck-ol\)\s*"\.";[^}]*position:\s*absolute;[^}]*inset-inline-start:\s*0;/s);
});

test("custom-start ordered lists keep native numbering with extra hanging room", () => {
	// markdown "3." 会生成 <ol start="3">：保留原生 marker 让浏览器按 start 编号，
	// 同时把悬挂余量从 1.5em 加到 2.2em，降低两位数编号被内容列裁掉的概率。
	assert.match(chrome, /\[data-streamdown="ordered-list"\]\s*\{[^}]*list-style-position:\s*outside;[^}]*padding-left:\s*2\.2em;/s);
});

test("unordered list keeps native bullets and the column clip guard stays in place", () => {
	assert.match(chrome, /\[data-streamdown="unordered-list"\]\s*\{[^}]*list-style-position:\s*outside;[^}]*padding-left:\s*1\.5em;/s);
	// 修复不能靠放宽 .markdown-body 的横向裁切（长代码/表格仍需要它）
	assert.match(timeline, /\.markdown-body\s*\{[^}]*overflow-x:\s*clip;/s);
});
