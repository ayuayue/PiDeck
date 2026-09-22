import test from "node:test";
import assert from "node:assert/strict";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import { createMathPlugin } from "@streamdown/math";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { normalizeMathDelimiters } = loadTsCommonJs("src/renderer/src/utils/normalizeMathDelimiters.ts");

test("normalized formulas reach the existing KaTeX pipeline as math nodes", async () => {
	const math = createMathPlugin({ singleDollarTextMath: true });
	const processor = unified()
		.use(remarkParse)
		.use(...math.remarkPlugin);
	const tree = await processor.run(processor.parse(normalizeMathDelimiters(String.raw`答案：\(\boxed{21\text{ 个}}\)`)));
	assert.equal(tree.children[0].children[1].type, "inlineMath");
	assert.equal(tree.children[0].children[1].value, String.raw`\boxed{21\text{ 个}}`);
});

test("normalizes screenshot inline formulas including table cells", () => {
	const input = String.raw`因此，\(9+12=\boxed{21}\) 个。
| 数量 |
| --- |
| \(0\le s\le4\) |
答案：\(\boxed{21\text{ 个}}\)`;
	assert.equal(normalizeMathDelimiters(input), input.replaceAll("\\(", "$").replaceAll("\\)", "$"));
});

test("normalizes display formulas and leaves incomplete streaming pairs untouched", () => {
	assert.equal(normalizeMathDelimiters(String.raw`\[x^2\]`), "\n$$\nx^2\n$$\n");
	assert.equal(normalizeMathDelimiters(String.raw`before \(x`), String.raw`before \(x`);
});

test("longer closing fences do not hide subsequent prose math", () => {
	const code = "```tex\ncode\n````\n";
	assert.equal(normalizeMathDelimiters(code + String.raw`\(x\)`), code + "$x$");
});

/** Exercise the same remark-math / rehype-katex plugins used by MarkdownStream. */
async function renderMath(text) {
	const math = createMathPlugin({ singleDollarTextMath: true });
	const processor = unified()
		.use(remarkParse)
		.use(remarkGfm)
		.use(...math.remarkPlugin)
		.use(remarkRehype)
		.use(...math.rehypePlugin);
	return processor.run(processor.parse(text));
}

function findNodes(node, predicate) {
	return [...(predicate(node) ? [node] : []), ...(node.children ?? []).flatMap((child) => findNodes(child, predicate))];
}

test("original screenshot syntax fails before normalization and produces KaTeX after it", async () => {
	const source = String.raw`答案：\(\boxed{21\text{ 个}}\)`;
	const isKatex = (node) => node.properties?.className?.includes("katex");
	assert.equal(findNodes(await renderMath(source), isKatex).length, 0);
	assert.equal(findNodes(await renderMath(normalizeMathDelimiters(source)), isKatex).length, 1);
});

test("display formula does not consume trailing prose", async () => {
	const tree = await renderMath(normalizeMathDelimiters(String.raw`\[x\] 后续正文`));
	assert.equal(findNodes(tree, (node) => node.tagName === "annotation")[0].children[0].value, "x");
	assert.ok(findNodes(tree, (node) => node.type === "text" && node.value.includes("后续正文")).length);
});

test("table formulas render through KaTeX inside their cells", async () => {
	const tree = await renderMath(normalizeMathDelimiters("| 数量 |\n| --- |\n| " + String.raw`\(0\le s\le4\)` + " |"));
	const cell = findNodes(tree, (node) => node.tagName === "td")[0];
	assert.equal(findNodes(cell, (node) => node.properties?.className?.includes("katex")).length, 1);
});

test("preserves code, existing dollar math and escaped delimiters", () => {
	for (const input of ["`\\(x\\)`", "``a ` \\(x\\)``", "```tex\n\\(x\\)\n```", "~~~tex\n\\[x\\]\n~~~", "```tex\n\\(x\\)", String.raw`$\text{\(x\)}$`, String.raw`$$\text{\[x\]}$$`, String.raw`\\(x\\)`, "    \\(x\\)"]) assert.equal(normalizeMathDelimiters(input), input);
});
