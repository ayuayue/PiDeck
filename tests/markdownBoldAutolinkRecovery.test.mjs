import assert from "node:assert/strict";
import test from "node:test";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { remarkRecoverBoldAutolinks } from "../src/renderer/src/utils/markdownRecoverBoldAutolinks.ts";

/**
 * `remarkRecoverBoldAutolinks` 回归（issue #543）。
 *
 * 触发场景：`**http://host:port**（…）`——GFM autolink literal 会把闭合 `**` 和后续
 * 非空白字符一起吞进 URL（spec 只在 URL 末尾裁 `*`），导致星号字面化、href 被污染。
 * 插件只在「确实是 autolink literal 产物 + 前面有未转义 `**`」时动手；正常写法、
 * 转义星号、普通链接、代码都必须零改动。
 */

function run(markdown) {
	const processor = unified().use(remarkParse).use(remarkGfm, { singleTilde: false }).use(remarkRecoverBoldAutolinks);
	return processor.runSync(processor.parse(markdown), markdown);
}

test("裸 URL 加粗后紧跟全角括号：星号归位、链接只含 URL、残余按行内语法解析", () => {
	const tree = run("- 打开 **http://127.0.0.1:18765**（`8765` 被 PiDeck 占了，已避开；PID `649202`）\n");
	// list > listItem > paragraph
	const paragraph = tree.children[0].children[0].children[0];
	assert.deepEqual(
		paragraph.children.slice(0, 4).map((node) => node.type),
		["text", "strong", "text", "inlineCode"],
	);
	assert.equal(paragraph.children[0].value, "打开 ");
	assert.equal(paragraph.children[1].children[0].url, "http://127.0.0.1:18765");
	assert.equal(paragraph.children[1].children[0].children[0].value, "http://127.0.0.1:18765");
	assert.equal(paragraph.children[2].value, "（");
	assert.equal(paragraph.children[3].value, "8765");
});

test("`**` 后紧跟半角括号 / 字母 / 全角句号都能救回", () => {
	for (const suffix of ["(", "abc", "。"]) {
		const tree = run(`**https://example.com/x**${suffix}`);
		const [strong, rest] = tree.children[0].children;
		assert.equal(strong.type, "strong");
		assert.equal(strong.children[0].type, "link");
		assert.equal(strong.children[0].url, "https://example.com/x");
		assert.equal(rest.value, suffix);
	}
});

test("正常写法、普通链接与转义星号保持原样", () => {
	// 末尾有空白：GFM 本来就裁掉尾部 `**`，加粗与链接都正常。
	const normal = run("**https://example.com** 后续");
	assert.equal(normal.children[0].children[0].type, "strong");
	assert.equal(normal.children[0].children[0].children[0].url, "https://example.com");

	const plainLink = run("[文档](https://example.com) 后续");
	assert.equal(plainLink.children[0].children[0].type, "link");

	// 作者显式转义：源文末两字符是 `\*`，不是未转义的 `**`。
	const escaped = run("\\*\\*https://example.com**abc");
	assert.equal(escaped.children[0].children[0].type, "text");
	assert.equal(
		escaped.children[0].children.some((node) => node.type === "strong"),
		false,
	);
});

test("行内代码与围栏代码里的同形文本不被改写", () => {
	const inlineCode = run("`**https://example.com**x`");
	assert.equal(inlineCode.children[0].children[0].type, "inlineCode");
	const fenced = run("```\n**https://example.com**x\n```\n");
	assert.equal(fenced.children[0].type, "code");
});
