import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "../helpers/loadTsCommonJs.mjs";

// 页面脚本是 toString 后注入 webview 执行的字符串：单测不会编译它们，
// 语法错误只会在真实页面上炸掉所有 ref 动作。这里用 Function 构造器做编译门（不执行）。

const ps = loadTsCommonJs("src/main/browser/browserPageScripts.ts");
const { buildSnapshotExpression } = loadTsCommonJs("src/main/browser/browserSnapshotScript.ts");

test("every page expression compiles as JavaScript", () => {
	const expressions = [
		["pageState", ps.buildPageStateExpression()],
		["resolveRef", ps.buildResolveRefExpression("e12")],
		["focus", ps.buildFocusExpression("e3")],
		["focusAndSelect", ps.buildFocusAndSelectExpression("e3")],
		["scrollIntoView", ps.buildScrollIntoViewExpression("e3")],
		["fallbackClick", ps.buildFallbackClickExpression("e3")],
		["fallbackType-clear", ps.buildFallbackTypeExpression("e3", 'hello";\\', true)],
		["fallbackType-append", ps.buildFallbackTypeExpression("e3", "line\nbreak", false)],
		["fallbackScroll", ps.buildFallbackScrollExpression(-10, 240)],
		["fallbackKey", ps.buildFallbackKeyExpression("Enter")],
		["waitForText", ps.buildWaitForTextExpression('完成"报价')],
		["highlight", ps.buildHighlightExpression("e7", "e7 · submit")],
		["clearOverlays", ps.buildClearOverlaysExpression()],
		["findHighlight", ps.buildFindHighlightExpression(["e1", "e3"])],
		["snapshotExpr", buildSnapshotExpression({ maxElements: 50, includeBoxes: true })],
	];
	for (const [name, expression] of expressions) {
		assert.doesNotThrow(() => new Function(`return ${expression};`), `${name} 注入页面前必须可编译`);
	}
});

test("fallback type expression honors clear semantics and escapes text", () => {
	const clearTrue = ps.buildFallbackTypeExpression("e1", "x", true);
	const clearFalse = ps.buildFallbackTypeExpression("e1", "x", false);
	assert.ok(clearTrue.includes('el.value = true ? "x" : el.value + "x"'), "clear=true replaces the value");
	assert.ok(clearFalse.includes('el.value = false ? "x" : el.value + "x"'), "clear=false appends to the end");
	const quoted = ps.buildFallbackTypeExpression("e1", 'a"b\\c', false);
	assert.ok(quoted.includes(JSON.stringify('a"b\\c')), "text is JSON-escaped, never string-interpolated");
});

test("highlight expression escapes the label and embeds the ref selector", () => {
	const expression = ps.buildHighlightExpression("e3", '提交"报价');
	assert.ok(expression.includes(JSON.stringify('提交"报价')), "label is JSON-escaped, never string-interpolated");
	assert.ok(expression.includes("data-pideck-ref"), "targets the ref attribute selector");
});

test("wait-for-text expression embeds the text as a JSON string", () => {
	const expression = ps.buildWaitForTextExpression('done"');
	assert.ok(expression.includes("innerText.includes("), "matching happens page-side");
	assert.ok(expression.includes(JSON.stringify('done"')), "the needle is JSON-escaped");
});
