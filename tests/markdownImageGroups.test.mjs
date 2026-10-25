import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { imageCountInChildren } = loadTsCommonJs("src/renderer/src/components/session/MarkdownImageGroup.tsx");

const stream = readFileSync("src/renderer/src/components/session/MarkdownStream.tsx", "utf8");
const image = readFileSync("src/renderer/src/components/session/MarkdownImage.tsx", "utf8");
const plugins = readFileSync("src/renderer/src/utils/markdownPlugins.ts", "utf8");

/**
 * 同段多图的布局上下文契约（布置照 dsh：单图按内容尺寸、同段多图缩成 64px 瓷砖）。
 *
 * 传递通道为什么是 context 而不是 HTML 属性：streamdown 内部会跑 `rehype-sanitize`
 * 的 defaultSchema，**只保留白名单属性**——实测 `{src, alt, data-md-image-count}`
 * 过一遍后只剩 `{alt}`（2026-10-20 真机 smoke 复现：首版用 data-* 标注，全按单图渲染）。
 * 所以由 `p` 组件数出直接子级图片数，经 context 传给子树里的每个 MarkdownImage。
 */

const img = () => ({ type: "element", tagName: "img", properties: {}, children: [] });
const text = (value) => ({ type: "text", value });
const anchor = (...children) => ({ type: "element", tagName: "a", properties: {}, children });
const paragraph = (...children) => ({ type: "element", tagName: "p", properties: {}, children });

test("imageCountInChildren：只数直接子级的 img", () => {
	assert.equal(imageCountInChildren(undefined), 0);
	assert.equal(imageCountInChildren(null), 0);
	assert.equal(imageCountInChildren({}), 0);
	assert.equal(imageCountInChildren(paragraph(text("说明"))), 0);
	assert.equal(imageCountInChildren(paragraph(img())), 1);
	assert.equal(imageCountInChildren(paragraph(text("说明"), img())), 1);
	assert.equal(imageCountInChildren(paragraph(img(), text(" "), img())), 2);
	assert.equal(imageCountInChildren(paragraph(img(), img(), img())), 3);
	// 图套链接不算直接子级（由 a 包裹，段落里只有 1 个直接子级）
	assert.equal(imageCountInChildren(paragraph(anchor(img()))), 0);
});

test("p 组件负责数图并经 context 下发", () => {
	assert.match(stream, /p:\s*\(paragraphProps\)\s*=>\s*\(\s*<MarkdownImageGroupProvider\s+count=\{imageCountInChildren\(paragraphProps\.node\)\}/s);
	assert.match(stream, /<\/MarkdownImageGroupProvider>/);
});

test("MarkdownImage 从 context 读张数，≥2 走瓷砖", () => {
	assert.match(image, /const tiled = useMarkdownImageGroupCount\(\) > 1/);
	assert.match(image, /size-24[^"]*object-cover/, "瓷砖态 96px cover");
	assert.match(image, /max-w-\[min\(100%,640px\)\]/, "单图上宽 640");
	assert.match(image, /max-h-\[360px\]/, "单图高 360");
});

test("回归护栏：不要再把分组信息挂在 HTML 属性上（会被 rehype-sanitize 剥掉）", () => {
	assert.ok(!plugins.includes("data-md-image-count"), "mdast 插件不得再写 data-md-image-count");
	assert.ok(!stream.includes("data-md-image-count"), "MarkdownStream 不得依赖该属性");
});
