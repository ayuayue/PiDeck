/**
 * issue #397 回归：模型回复里的 HTML/SVG 不能污染应用页面。
 *
 * 现象：模型回一段带 `<style>svg{width:100%}</style>` 的 HTML/SVG 后，标题栏/时间线所有图标被放大，
 * 切到别的会话（该消息卸载）才恢复 —— 根因是 MarkdownStream 只挂了 rehype-raw，没有 sanitize，
 * `<style>` 元素进了 DOM 就是全局 CSS。
 *
 * 这里断言统一净化管线（markdownSanitize.ts）的真实行为：危险子树整棵丢弃、全局样式不泄漏、
 * 同时不能误伤本应用依赖的能力（本地图片、本地文件链接、details/任务列表/表格、内联 SVG 图形）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { toHtml } from "hast-util-to-html";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { UNTRUSTED_MARKDOWN_REHYPE_PLUGINS, pruneDangerousHtml } = loadTsCommonJs("src/renderer/src/components/session/markdownSanitize.ts");

/** 用生产插件序列跑一遍 markdown → html（与 MarkdownStream settle 路径同构）。 */
function render(markdown) {
	const processor = unified().use(remarkParse).use(remarkGfm).use(remarkRehype, { allowDangerousHtml: true }).use(UNTRUSTED_MARKDOWN_REHYPE_PLUGINS);
	return toHtml(processor.runSync(processor.parse(markdown)));
}

test("顶层 <style> 整棵丢弃，不再把全局 CSS 注入页面（#397 根因）", () => {
	const html = render("前文\n\n<div><style>svg{width:100%;height:auto} * {font-size:20px}</style><span>hi</span></div>\n\n后文");
	assert.doesNotMatch(html, /<style/);
	assert.doesNotMatch(html, /width:100%/);
	assert.doesNotMatch(html, /font-size:20px/);
	// 同时不能把 CSS 源码当正文文字漏出来
	assert.match(html, /<span>hi<\/span>/);
});

test("内联 SVG 里的 <style> 同样丢弃，几何图形保留", () => {
	const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="200" height="200"><style>svg{width:100%}</style><circle cx="50" cy="60" r="10" fill="#f00"/><path d="M0 0 L10 10" stroke="black" fill="none"/></svg>';
	const html = render(svg);
	assert.doesNotMatch(html, /<style/);
	assert.doesNotMatch(html, /width:100%/);
	assert.match(html, /<svg[^>]*viewBox="0 0 100 100"/);
	assert.match(html, /<circle[^>]*fill="#f00"/);
	assert.match(html, /<path[^>]*d="M0 0 L10 10"/);
});

test("script / iframe / 事件属性 / 内联 style 全部进不来", () => {
	const html = render('<iframe src="https://evil.test"></iframe><img src="https://x/y.png" onerror="alert(1)"><script>alert(1)</script><div style="font-size:40px" onclick="alert(2)">big</div>');
	assert.doesNotMatch(html, /<iframe/);
	assert.doesNotMatch(html, /<script/);
	assert.doesNotMatch(html, /onerror/i);
	assert.doesNotMatch(html, /onclick/i);
	assert.doesNotMatch(html, /style="font-size:40px"/);
	assert.match(html, /<div>big<\/div>/);
});

test("本地图片地址不被协议白名单清空（盘符 / 相对路径 / pideck-file）", () => {
	assert.match(render("![a](pideck-file://local/?path=C%3A%5Cx.png)"), /src="pideck-file:\/\/local\/\?path=C%3A%5Cx\.png"/);
	assert.match(render("![a](./out/chart.png)"), /src="\.\/out\/chart\.png"/);
	assert.match(render("![a](C:\\shots\\x.png)"), /<img[^>]*src="C:/);
});

test("本地文件链接与非 http 危险协议的区别对待", () => {
	assert.match(render("[open](file:///C:/a.txt)"), /href="file:\/\/\/C:\/a\.txt"/);
	assert.match(render("[open](./src/a.ts#L10)"), /href="\.\/src\/a\.ts#L10"/);
	assert.match(render("[jump](#sec)"), /href="#sec"/);
	assert.doesNotMatch(render("[x](javascript:alert(1))"), /javascript:/);
});

test("常用 HTML 结构继续可用：details / 表格 / 任务列表", () => {
	const html = render("<details open><summary>more</summary>body</details>\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n- [x] done");
	assert.match(html, /<details open>/);
	assert.match(html, /<summary>more<\/summary>/);
	assert.match(html, /<table>/);
	assert.match(html, /<input[^>]*type="checkbox"[^>]*checked/);
});

test("pruneDangerousHtml 返回摘除个数并连内容一起丢", () => {
	const tree = {
		type: "root",
		children: [
			{ type: "element", tagName: "style", children: [{ type: "text", value: "svg{width:100%}" }] },
			{ type: "element", tagName: "p", children: [{ type: "text", value: "keep" }] },
		],
	};
	assert.equal(pruneDangerousHtml(tree), 1);
	assert.equal(tree.children.length, 1);
	assert.equal(tree.children[0].tagName, "p");
	assert.equal(pruneDangerousHtml({ type: "root", children: [] }), 0);
});

test("会话/文件预览都接上统一净化序列（源码契约）", () => {
	const stream = readFileSync("src/renderer/src/components/session/MarkdownStream.tsx", "utf8");
	assert.match(stream, /UNTRUSTED_MARKDOWN_REHYPE_PLUGINS/);
	// 只挂 raw 不挂 sanitize 就是 #397 的原始写法，禁止回退
	assert.doesNotMatch(stream, /\[\s*defaultRehypePlugins\.raw\s*\]/);
	const preview = readFileSync("src/renderer/src/components/app/FileDiffViewer.tsx", "utf8");
	assert.match(preview, /\.\.\.UNTRUSTED_MARKDOWN_REHYPE_PLUGINS/);
});
