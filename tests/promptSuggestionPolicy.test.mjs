/**
 * 输入预测的纯策略：文本净化、可见性、采纳键。
 *
 * 这些是产品规则（模型乱输出时留哪句、什么时候画 ghost、哪个键算采纳），
 * 在 JSX 里各写一份就再也无法回归——所以锁在纯函数与这里。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { normalizePromptSuggestion, shouldShowPromptSuggestion, isPromptSuggestionAcceptKey } = loadTsCommonJs("src/renderer/src/utils/promptSuggestion.ts");

test("模型输出只保留一句：首行、去列表符号与包裹引号、句末截断、压平空白", () => {
	assert.equal(normalizePromptSuggestion("  帮我再补个用例  "), "帮我再补个用例");
	assert.equal(normalizePromptSuggestion("1. 把测试跑一遍"), "把测试跑一遍");
	assert.equal(normalizePromptSuggestion("- 看看这个报错"), "看看这个报错");
	assert.equal(normalizePromptSuggestion("「继续修下一个问题」"), "继续修下一个问题");
	assert.equal(normalizePromptSuggestion("先看日志。然后再说"), "先看日志。");
	assert.equal(normalizePromptSuggestion("为什么失败？ 顺便看下别的"), "为什么失败？");
	assert.equal(normalizePromptSuggestion("第一行\n第二行解释"), "第一行");
	assert.equal(normalizePromptSuggestion("多个   空格\t合并"), "多个 空格 合并");
	assert.equal(normalizePromptSuggestion(""), "");
	assert.equal(normalizePromptSuggestion("   \n  "), "");
});

test("超长建议按 200 字符截断，且不劈开 emoji 代理对", () => {
	const long = normalizePromptSuggestion("a".repeat(300));
	assert.equal(long.length, 200);
	// 199 个字符 + emoji（2 个 UTF-16 单元）：上限落在高代理上，必须退回一位。
	const emoji = `😀${"b".repeat(300)}`;
	const cut = normalizePromptSuggestion(emoji);
	assert.equal(cut, "😀" + "b".repeat(198));
	assert.equal(/[\uD800-\uDBFF]$/.test(cut), false);
});

test("可见性四条件缺一不可：有文案、草稿空、不在跑、开关与模型都可用", () => {
	const base = { text: "看看测试", draftEmpty: true, turnRunning: false, requestEnabled: true };
	assert.equal(shouldShowPromptSuggestion(base), true);
	for (const patch of [{ text: "" }, { text: "   " }, { draftEmpty: false }, { turnRunning: true }, { requestEnabled: false }]) {
		assert.equal(shouldShowPromptSuggestion({ ...base, ...patch }), false, JSON.stringify(patch));
	}
});

test("采纳键是裸 Tab 与 →：带修饰键或其他键都不算，没有建议时一律不拦", () => {
	const key = (overrides = {}) => ({ key: "Tab", shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...overrides });
	assert.equal(isPromptSuggestionAcceptKey(key(), { hasSuggestion: true }), true);
	assert.equal(isPromptSuggestionAcceptKey(key({ key: "ArrowRight" }), { hasSuggestion: true }), true);
	for (const keyName of ["Enter", "ArrowLeft", "Escape", " ", "a"]) {
		assert.equal(isPromptSuggestionAcceptKey(key({ key: keyName }), { hasSuggestion: true }), false, keyName);
	}
	for (const modifier of ["shiftKey", "altKey", "ctrlKey", "metaKey"]) {
		assert.equal(isPromptSuggestionAcceptKey(key({ [modifier]: true }), { hasSuggestion: true }), false, modifier);
	}
	assert.equal(isPromptSuggestionAcceptKey(key(), { hasSuggestion: false }), false);
});
