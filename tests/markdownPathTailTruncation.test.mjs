import assert from "node:assert/strict";
import test from "node:test";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { remarkLinkifyPaths } from "../src/renderer/src/components/session/MarkdownLinkCore.ts";

/**
 * 回归：文件路径链接化不能吞掉「路径之后的文本」。
 *
 * 背景（2026-09-23 线上问题）：用户在会话里看到「/ 后面的文本显示不出来，
 * 目前看着是后面一行的文本也不显示了」。根因在 MarkdownLinkCore.ts 的
 * remarkLinkifyPaths：它把裸路径文本节点拆成 [text, link, text, ...] 段落后
 * 写进 node.__segs，父节点随后用 __segs **整体替换**原文本节点。漏掉
 * 「最后一个命中之后仍有余下正文」这一段的回填，于是整个文本节点从
 * 第一个路径起全部消失——含换行后的后续行（mdast 里 softbreak 也是
 * 同一个 text 节点的一部分，所以用户看到的是「后一行整行不见」）。
 *
 * 回归来历：fb6b5667 feat(markdown): 文件链接存在性校验，失效路径降级纯文本
 * 把 while 循环改成 for-of 时丢掉了尾部回填；成因是表格行等场景下一个
 * text 节点几乎必然以路径结尾，日常只在段中命中路径看不出问题。
 * 用真实会话 jsonl 复现：91 条 assistant 文本，47 条的渲染结果短于原文。
 */

/** 与 MarkdownStream 相同的插件顺序（singleTilde:false 见 markdownTildePath.test.mjs） */
function runPipeline(markdown) {
	const processor = unified().use(remarkParse).use(remarkGfm, { singleTilde: false }).use(remarkLinkifyPaths);
	return processor.runSync(processor.parse(markdown));
}

/** mdast → 渲染后可见文本（text/inlineCode/link 文本都算可见） */
function renderText(node) {
	if (!node || typeof node !== "object") return "";
	if (node.type === "text" || node.type === "inlineCode" || node.type === "code") return node.value ?? "";
	if (Array.isArray(node.children)) return node.children.map(renderText).join("");
	return "";
}

function renderTree(node) {
	if (node.type === "root") return node.children.map(renderText).join("\n");
	return renderText(node);
}

/** mdast → 一次「不跑链接插件」的可见文本，作为原文基线 */
function sourceText(markdown) {
	const tree = unified().use(remarkParse).use(remarkGfm, { singleTilde: false }).parse(markdown);
	return renderTree(tree);
}

const TABLE_ROW = "| 大项列表 | /baseComplianceSetting/groupList | 无 | 6 行，按 SORT 升序 |";

test("链接化后保留路径之后的尾段：表格行不再整段消失", () => {
	const tree = runPipeline(TABLE_ROW);
	const rendered = renderTree(tree);
	assert.equal(rendered, sourceText(TABLE_ROW), `渲染结果应等于原文：${rendered}`);
	// 路径确实被链接化（不是静默降级成纯文本）
	const links = [];
	collectLinks(tree, links);
	assert.deepEqual(links, ["file:///baseComplianceSetting/groupList"], `应产出该路径链接：${links}`);
});

test("多个命中 + 尾段 + 跨行正文都保留", () => {
	// 段中两个路径 + 路径后仍有换行后续行：mdast 是同一个 text 节点，
	// 尾段回填漏掉时后续行整行消失（用户报的就是这个现象）。
	const markdown = `改动 src/renderer/src/foo.ts 与 src/shared/ipc.ts，测试不动。\n下一行 README.md 也该更新。`;
	const tree = runPipeline(markdown);
	assert.equal(renderTree(tree), sourceText(markdown));
	const links = [];
	collectLinks(tree, links);
	// href 就是匹配到的原路径（编码后），由点击侧再解析成绝对路径
	assert.deepEqual(links, ["file://src/renderer/src/foo.ts", "file://src/shared/ipc.ts"], `两段路径都应链接化：${links}`);
});

test("路径在文本末尾：不产生空尾段，链接文本仍等于原路径", () => {
	const tree = runPipeline("详情见 docs/pi-prompt-templates/enhance-prompt.md");
	assert.equal(renderTree(tree), sourceText("详情见 docs/pi-prompt-templates/enhance-prompt.md"));
	const links = [];
	collectLinks(tree, links);
	assert.deepEqual(links, ["file://docs/pi-prompt-templates/enhance-prompt.md"], `应产出该路径链接：${links}`);
	// 尾段不应产生空 text 节点（空节点会在 rehype 侧多出无意义节点）
	const texts = [];
	collectTexts(tree, texts);
	assert.ok(!texts.includes(""), `不应有空文本节点：${JSON.stringify(texts)}`);
});

test("整个文本节点只有路径：正好命中，无尾段可补", () => {
	// 整段就是一个带目录路径：没有尾段，也不该产出空 text 节点
	const markdown = "docs/pi-prompt-templates/enhance-prompt.md";
	const tree = runPipeline(markdown);
	assert.equal(renderTree(tree), sourceText(markdown));
	const links = [];
	collectLinks(tree, links);
	assert.deepEqual(links, ["file://docs/pi-prompt-templates/enhance-prompt.md"], `整段路径应链接化：${links}`);
	const texts = [];
	collectTexts(tree, texts);
	assert.ok(!texts.includes(""), `不应产生空文本节点：${JSON.stringify(texts)}`);
});

test("纯文本里的单段文件名有意不链接化（inline code 才允许）", () => {
	// 这是 isStandaloneFileReference 的设计边界：不命中 = 不改写文本节点 = 不可能丢文本；
	// 反过来守住它，避免将来为「多链接一点」放宽规则后引入新的误判。
	const markdown = "准则在 AGENTS.md 里说得很清楚，README.md 也要看。";
	const tree = runPipeline(markdown);
	assert.equal(renderTree(tree), sourceText(markdown));
	const links = [];
	collectLinks(tree, links);
	assert.deepEqual(links, [], `纯文本单段文件名不应链接化：${links}`);
});

test("inline code 文件引用链路不受影响（__fileLink 分支）", () => {
	const tree = runPipeline("入口在 `src/renderer/src/main.tsx` 里。");
	assert.equal(renderTree(tree), sourceText("入口在 `src/renderer/src/main.tsx` 里。"));
	const links = [];
	collectLinks(tree, links);
	assert.deepEqual(links, ["file://src/renderer/src/main.tsx"], `inline code 引用应链接化：${links}`);
});

test("真实中文长段落：不丢文本，且并列斜杠不产生文件链接", () => {
	// 2026-09 线上回归原句：`降分辨率/抽帧`、`GDPR/《个保法》` 曾被识别成尾斜杠目录，
	// 存在性判否后整段被降级成灰字（用户看到「斜杠前的字像阴影」）。
	const markdown = "学术上早就有定论：MSR/Princeton 的 VideoStorm（NSDI'17）就是专门研究这个问题——视频分析算力永远不够，必须靠近似（降分辨率/抽帧）和延迟容忍来在集群上同时服务成千上万条查询。\n国内视频 AI 平台论文也实测：只解 I 帧能省约 90% 算力（全量解码 CPU 占用 ~20% → 2%）。";
	const tree = runPipeline(markdown);
	assert.equal(renderTree(tree), sourceText(markdown));
	const links = [];
	collectLinks(tree, links);
	assert.deepEqual(links, [], `中文散文不应产生文件链接：${links}`);
});

function collectLinks(node, out) {
	if (!node || typeof node !== "object") return;
	if (node.type === "link") out.push(node.url ?? "");
	if (Array.isArray(node.children)) node.children.forEach((child) => collectLinks(child, out));
}

function collectTexts(node, out) {
	if (!node || typeof node !== "object") return;
	if (node.type === "text") out.push(node.value ?? "");
	if (Array.isArray(node.children)) node.children.forEach((child) => collectTexts(child, out));
}
