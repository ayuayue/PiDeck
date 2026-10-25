import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/** 加载纯检测函数（无 React 依赖，直接编译真模块）。 */
const { detectLeakedToolCallXml } = loadTsCommonJs("src/renderer/src/components/session/timeline/leakedToolCallText.ts");

const ATEM_BLOCK = `<atem:function_calls>
<atem:invoke name="default.edit">
<atem:parameter name="newText">line1 /uris/path ~*regex "quoted" text</atem:parameter>
</atem:invoke>
</atem:function_calls>`;

test("整条 ATEM 协议原文命中兜底（issue #315 主场景）", () => {
	assert.equal(detectLeakedToolCallXml(ATEM_BLOCK), true);
});

test("流式半截（只有开标记）不命中，避免抖动切换", () => {
	assert.equal(detectLeakedToolCallXml(ATEM_BLOCK.replace("</atem:function_calls>", "")), false);
});

test("正常回答里顺带提到协议标签（占比低于一半）不折叠", () => {
	const normal = `关于工具调用的说明：${"<p>".repeat(1)}模型会用 <atem:function_calls> 与 </atem:function_calls> 包裹调用参数，其余是大量正常正文内容，比如这段很长的解释文字，足以让协议标签占比低于阈值，不该被折叠。`.repeat(3);
	assert.equal(detectLeakedToolCallXml(normal), false);
});

test("Qwen <tool_call> 与 GLM <function_calls> 变体同样命中", () => {
	assert.equal(detectLeakedToolCallXml('<tool_call>\n{"name":"edit"}\n</tool_call>'), true);
	assert.equal(detectLeakedToolCallXml('<function_calls>{"name":"edit"}</function_calls>'), true);
});

test("普通 markdown / 空文本不命中", () => {
	assert.equal(detectLeakedToolCallXml(""), false);
	assert.equal(detectLeakedToolCallXml("   \n  "), false);
	assert.equal(detectLeakedToolCallXml("# 标题\n\n正文 <b>加粗</b> 结尾"), false);
});

test("契约：AnswerOutput 在 markdown 之前先做泄漏检测，live 与 settled 双路径都接线", () => {
	const answerOutput = readFileSync("src/renderer/src/components/session/AnswerOutput.tsx", "utf8");
	// 空白容忍（格式化契约测试规则）：定位 import 与两处分支渲染
	assert.match(answerOutput, /^[\t ]*import \{ RawToolCallFallback \} from "\.\/RawToolCallFallback";/m);
	assert.match(answerOutput, /^[\t ]*import \{ detectLeakedToolCallXml \} from "\.\/timeline\/leakedToolCallText\.ts";/m);
	const branchCount = [...answerOutput.matchAll(/detectLeakedToolCallXml\(/g)].length;
	assert.ok(branchCount >= 2, `expected >=2 detect call sites (settled + live), got ${branchCount}`);
	// 兜底卡片本体不走 MarkdownStream（纯 pre 渲染）
	const card = readFileSync("src/renderer/src/components/session/RawToolCallFallback.tsx", "utf8");
	assert.match(card, /<pre className=/);
	assert.doesNotMatch(card, /from "\.\/MarkdownStream"/);
	// 文案走 i18n，不硬编码中英文
	assert.match(card, /t\("session\.leakedToolCall\.title"\)/);
});

test("契约：zh/en 文案键同步存在", () => {
	const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
	const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");
	for (const key of ["session.leakedToolCall.title", "session.leakedToolCall.expand", "session.leakedToolCall.collapse"]) {
		assert.ok(zh.includes(`"${key}"`), `zh missing ${key}`);
		assert.ok(en.includes(`"${key}"`), `en missing ${key}`);
	}
});
