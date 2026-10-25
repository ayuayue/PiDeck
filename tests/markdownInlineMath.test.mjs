import test from "node:test";
import assert from "node:assert/strict";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { createMathPlugin } from "@streamdown/math";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { looksLikeInlineMath, remarkInlineMathGuard } = loadTsCommonJs("src/renderer/src/utils/markdownInlineMath.ts");

/** 与 MarkdownStream 相同的 KaTeX 管线，额外挂行内公式判别插件 */
async function render(text) {
	const math = createMathPlugin({ singleDollarTextMath: true });
	const processor = unified()
		.use(remarkParse)
		.use(...math.remarkPlugin)
		.use(remarkInlineMathGuard)
		.use(remarkRehype)
		.use(...math.rehypePlugin);
	return processor.run(processor.parse(text));
}

function findNodes(node, predicate) {
	return [...(predicate(node) ? [node] : []), ...(node.children ?? []).flatMap((child) => findNodes(child, predicate))];
}

const countKatex = (tree) => findNodes(tree, (node) => node.properties?.className?.includes("katex")).length;
const text = (tree) =>
	findNodes(tree, (node) => node.type === "text")
		.map((node) => node.value)
		.join("");

test("货币写法不再被判为行内公式，原文逐字保留", async () => {
	const source = "报价 $5 元，含税 $6 元，另有 3 项";
	const tree = await render(source);
	assert.equal(countKatex(tree), 0);
	assert.equal(text(tree), source);
});

test("展开后的行内公式内容含乘号等 markdown 标记时按原文输出", async () => {
	const tree = await render("价格 $5 * 2 元$ 起");
	assert.equal(countKatex(tree), 0);
	assert.equal(findNodes(tree, (node) => node.tagName === "em").length, 0);
	assert.equal(text(tree), "价格 $5 * 2 元$ 起");
});

test("真正的公式仍然走 KaTeX", async () => {
	const cases = [
		["答案 $E=mc^2$ 成立", 1],
		[String.raw`长度 $\text{总长度}$ 与 $x$`, 2],
		["区间 $0 \\le s \\le 4$ 内", 1],
	];
	for (const [source, expected] of cases) assert.equal(countKatex(await render(source)), expected, `公式数量不符：${source}`);
});

test("代码里的美元与未成对美元不参与判别", async () => {
	for (const source of ["`$5 元，含税 $6 元`", "```\n$5 元，含税 $6 元\n```", "仅 $5 元", String.raw`\$5 元，含税 \$6 元`]) {
		assert.equal(countKatex(await render(source)), 0);
	}
});

test("$$ 定界符不参与判别", async () => {
	const tree = await render("$$\n5 元，含税 6 元\n$$");
	assert.equal(countKatex(tree), 1);
});

test("判别规则：LaTeX 记号 / 中日韩文字 / 无算符的多词文本", () => {
	assert.equal(looksLikeInlineMath("5 元，含税 "), false);
	assert.equal(looksLikeInlineMath("5 and 6"), false);
	assert.equal(looksLikeInlineMath("5 to "), false);
	assert.equal(looksLikeInlineMath("距离"), false);
	assert.equal(looksLikeInlineMath("总长度 L"), false);
	assert.equal(looksLikeInlineMath(""), false);
	assert.equal(looksLikeInlineMath("   "), false);
	assert.equal(looksLikeInlineMath("x"), true);
	assert.equal(looksLikeInlineMath("E=mc^2"), true);
	assert.equal(looksLikeInlineMath("2 + 3"), true);
	assert.equal(looksLikeInlineMath("a - b"), true);
	assert.equal(looksLikeInlineMath("O(n)"), true);
	assert.equal(looksLikeInlineMath(String.raw`\frac{1}{2}`), true);
	assert.equal(looksLikeInlineMath(String.raw`\text{总长度}`), true);
});
