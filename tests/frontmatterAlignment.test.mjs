import test from "node:test";
import assert from "node:assert/strict";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * frontmatter 剥离与 pi 对齐（`dist/utils/frontmatter.js`）。
 *
 * 背景：模板正文由 PiDeck 本地展开后原样发给模型，pi 自己展开时用的是它的
 * stripFrontmatter。两边规则不一致就会出现「pi 干净、PiDeck 漏出 YAML 头」。
 * 2026-10 实测漏的两个边界：BOM 开头、裸 `\r` 换行（Windows 编辑器常见）。
 */

const { extractFrontmatter, stripFrontmatter } = loadTsCommonJs("src/renderer/src/utils/frontmatter.ts");
const behavior = loadTsCommonJs("src/renderer/src/composerBehavior.ts");

test("BOM 开头也要剥掉 frontmatter（pi 先 stripBom）", () => {
	assert.equal(stripFrontmatter("\uFEFF---\ndescription: 描述\n---\n正文"), "正文");
});

test("裸 \r 换行要归一（pi 把 \r\n 与 \r 都变 \n）", () => {
	assert.equal(stripFrontmatter("---\rdescription: 描述\r---\r正文"), "正文");
	assert.equal(stripFrontmatter("---\r\ndescription: 描述\r\n---\r\n正文"), "正文");
});

test("结束标记带尾空格也能剥（pi 用 indexOf('\n---') 不看尾随空白）", () => {
	assert.equal(stripFrontmatter("---\ndescription: 描述\n--- \n正文"), "正文");
});

test("正文按 pi 的规则 trim（首尾空白都去）", () => {
	assert.equal(stripFrontmatter("---\na: 1\n---\n\n  正文  \n\n"), "正文");
});

test("没有 frontmatter / 没有闭合标记：原样当正文（与 pi 一致）", () => {
	assert.equal(stripFrontmatter("直接正文"), "直接正文");
	assert.equal(stripFrontmatter("---\na: 1\n正文没有闭合"), "---\na: 1\n正文没有闭合");
});

test("extractFrontmatter 同时给出 yaml 与 body", () => {
	const out = extractFrontmatter("---\ndescription: 描述\nargument-hint: <file>\n---\n正文");
	assert.equal(out.yaml, "description: 描述\nargument-hint: <file>");
	assert.equal(out.body.trim(), "正文");
	assert.equal(extractFrontmatter("无头").yaml, null);
});

test("argument-hint 解析走同一套 frontmatter（BOM 文件也能显示）", () => {
	assert.equal(behavior.parseArgumentHint("\uFEFF---\nargument-hint: <file>\n---\n正文"), "<file>");
});

test("模板展开：BOM 文件的 YAML 头不会漏进消息", () => {
	const { expandPromptTemplates } = behavior;
	const out = expandPromptTemplates("/t", [{ name: "t", description: "", content: "\uFEFF---\ndescription: 描述\n---\n正文" }]).message;
	assert.ok(!out.includes("description:"), `YAML 头漏了: ${JSON.stringify(out)}`);
	assert.ok(out.includes("正文"));
});

test("插入全文：保留原换行风格，但去掉 BOM 与结束标记尾空格", () => {
	const strip = behavior.stripMarkdownFrontmatter;
	assert.equal(strip("\uFEFF---\r\nname: y\r\n---\r\n\r\nCRLF 正文\r\n"), "CRLF 正文\r\n");
	assert.equal(strip("---\nname: x\n--- \n\n正文\n"), "正文\n");
	assert.equal(strip("---\nname: x\n---\n\n正文内容\n"), "正文内容\n");
	assert.equal(strip("没有头"), "没有头");
});

test("没有 frontmatter 时正文不 trim（pi 实测：只有带 YAML 头的分支才 trim）", () => {
	// 期望值来自 pi 1.4.0 dist/utils/frontmatter.js 的直接调用结果
	assert.equal(stripFrontmatter("  正文前后有空白  "), "  正文前后有空白  ");
	assert.equal(stripFrontmatter("---\na: 1\n正文没有闭合"), "---\na: 1\n正文没有闭合");
	// 带 YAML 头时照 pi 的行为 trim
	assert.equal(stripFrontmatter("---\na: 1\n---\n\n  正文  \n"), "正文");
});
