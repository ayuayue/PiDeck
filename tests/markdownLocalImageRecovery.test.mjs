import assert from "node:assert/strict";
import test from "node:test";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { remarkRecoverLocalImages } from "../src/renderer/src/utils/markdownPlugins.ts";

/**
 * `remarkRecoverLocalImages` 回归（2026-10 对话内图片渲染改造）。
 *
 * 触发场景：`![架构图](/tmp/a b.png)` 这种目标里带空格的写法不符合 CommonMark 的
 * 链接目标语法，解析器把整段降级成纯文本，用户看到的是一行原始语法。
 * 插件只在「解析器确实拆坏了」时动手，其余情况必须零改动——
 * 一旦放宽，正文里的 `![说明](…)` 示例、代码围栏、带括号的路径都会被改写成图片。
 */

function run(markdown) {
	const processor = unified().use(remarkParse).use(remarkGfm, { singleTilde: false }).use(remarkRecoverLocalImages);
	// 与 streamdown 的调用形态一致：runSync(tree, source) —— 插件靠 file.value 判断作者是否写了转义
	return processor.runSync(processor.parse(markdown), markdown);
}

function collectImages(node, found = []) {
	if (!node || typeof node !== "object") return found;
	if (node.type === "image") found.push({ url: node.url, alt: node.alt });
	if (Array.isArray(node.children)) for (const child of node.children) collectImages(child, found);
	return found;
}

function collectText(node, out = []) {
	if (!node || typeof node !== "object") return out;
	if ((node.type === "text" || node.type === "inlineCode" || node.type === "code") && typeof node.value === "string") out.push(node.value);
	if (Array.isArray(node.children)) for (const child of node.children) collectText(child, out);
	return out;
}

test("带空格的 POSIX 绝对路径被还原成 image 节点", () => {
	const images = collectImages(run("![架构图](/tmp/pideck shots/a.png)"));
	assert.deepEqual(images, [{ url: "/tmp/pideck shots/a.png", alt: "架构图" }]);
});

test("带空格的 Windows 盘符路径与 ./ 相对路径同样被还原", () => {
	assert.deepEqual(collectImages(run("![x](C:\\Users\\a b\\shot.png)")), [{ url: "C:\\Users\\a b\\shot.png", alt: "x" }]);
	assert.deepEqual(collectImages(run("![x](./charts/a b.png)")), [{ url: "./charts/a b.png", alt: "x" }]);
});

test("没有空格的正常写法本来就解析成功，插件不重复处理", () => {
	const images = collectImages(run("![x](/tmp/a.png)"));
	assert.equal(images.length, 1);
	assert.equal(images[0].url, "/tmp/a.png");
});

test("作者写了转义：保持纯文本，不还原", () => {
	const tree = run("\\![x](/tmp/a b.png)");
	assert.deepEqual(collectImages(tree), []);
	assert.equal(collectText(tree).join(""), "![x](/tmp/a b.png)");
});

test("路径含括号/尖括号：歧义太大，不还原", () => {
	assert.deepEqual(collectImages(run("![x](/tmp/a(1) b.png)")), []);
	assert.deepEqual(collectImages(run("![x](/tmp/<a> b.png)")), []);
});

test("扩展名不是图片：留给文件链接，不还原", () => {
	assert.deepEqual(collectImages(run("![x](/tmp/a b.txt)")), []);
	assert.deepEqual(collectImages(run("![x](/tmp/a b)")), []);
});

test("段落里还有其它正文：不还原（只处理图片独占一段）", () => {
	assert.deepEqual(collectImages(run("见下图 ![x](/tmp/a b.png) 说明")), []);
});

test("代码围栏里的同样写法不受影响", () => {
	const markdown = "```\n![x](/tmp/a b.png)\n```";
	assert.deepEqual(collectImages(run(markdown)), []);
});

test("远程路径与裸文件名不在处理范围", () => {
	assert.deepEqual(collectImages(run("![x](https://example.com/a b.png)")), []);
	assert.deepEqual(collectImages(run("![x](a b.png)")), []);
});
