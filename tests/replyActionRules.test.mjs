import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// 声明式规则求值与清洗的回归测试：信号归约 × 规则匹配 × 文件清洗三层都要钉住。
// loadTsCommonJs 在独立 VM realm 执行，跨 realm 数组 deepEqual 会报
// “same structure but not reference-equal”，统一用 plain()（JSON 往返）比较。
const { replySignalsForMessages, replyActionTextsForMessages, mergeReplyActionRules } = loadTsCommonJs("src/renderer/src/utils/replyActionRules.ts");
const { sanitizeReplyActionRuleList, sanitizeReplyActionsFile } = loadTsCommonJs("src/shared/replyActions.ts");

const plain = (value) => JSON.parse(JSON.stringify(value));
const message = (role, text, extra = {}) => ({ id: `${role}-${text}`, agentId: "agent-a", role, text, timestamp: 1, ...extra });
const user = message("user", "修复问题");
const answer = (text = "已完成。", stopReason = "stop") => message("assistant", text, { stopReason });
const diagnostic = (i18nKey) => message("error", "", { meta: { i18nKey } });
const texts = (rules, messages) => plain(replyActionTextsForMessages(rules, messages));
const stopRule = { text: "继续", triggers: [{ kind: "onStop" }] };
const failRule = { text: "重试", triggers: [{ kind: "onFailure" }] };
const alwaysRule = { text: "收尾", triggers: [{ kind: "always" }] };
const matchRule = { text: "提交", triggers: [{ kind: "textMatch", patterns: ["完成", "搞定"] }] };

test("onStop 规则在正常收场出现，失败与空轮不出现", () => {
	assert.deepEqual(texts([stopRule], [user, answer()]), ["继续"]);
	assert.deepEqual(texts([stopRule], [user, answer("", "error")]), []);
	assert.deepEqual(texts([stopRule], []), []);
});

test("onFailure 规则只在失败轮出现（请求失败诊断与 stopReason error 等价）", () => {
	assert.deepEqual(texts([failRule], [user, diagnostic("diagnostic.requestFailed")]), ["重试"]);
	assert.deepEqual(texts([failRule], [user, answer("文本", "error")]), ["重试"]);
	assert.deepEqual(texts([failRule], [user, answer()]), []);
});

test("always 规则在收场后就显示：成功、失败、被中止都出现；运行中仍不出", () => {
	assert.deepEqual(texts([alwaysRule], [user, answer()]), ["收尾"]);
	assert.deepEqual(texts([alwaysRule], [user, answer("", "error")]), ["收尾"]);
	assert.deepEqual(texts([alwaysRule], [user, answer("文本", "error")]), ["收尾"]);
	assert.deepEqual(texts([alwaysRule], [user, answer("被中止", "aborted")]), ["收尾"]);
	assert.deepEqual(texts([alwaysRule], []), []);
	assert.deepEqual(texts([alwaysRule], [user]), []);
});

test("textMatch 规则按回复散文命中，代码块里的词不算意图，大小写不敏感", () => {
	assert.deepEqual(texts([matchRule], [user, answer("已经完成全部改动。")]), ["提交"]);
	assert.deepEqual(texts([matchRule], [user, answer("已经搞定")]), ["提交"]);
	assert.deepEqual(texts([matchRule], [user, answer("Done with everything")]), []);
	assert.deepEqual(texts([{ ...matchRule, triggers: [{ kind: "textMatch", patterns: ["DONE"] }] }], [user, answer("all done")]), ["提交"]);
	// 代码块里出现「完成」不代表整轮意图
	assert.deepEqual(texts([matchRule], [user, answer("代码如下：```js\n// 完成\n```")]), []);
});

test("多 trigger 规则要求全部命中；全部规则按文件顺序输出且去重", () => {
	const both = { text: "收尾", triggers: [{ kind: "onStop" }, { kind: "textMatch", patterns: ["完成"] }] };
	assert.deepEqual(texts([matchRule, stopRule, both, { ...stopRule }], [user, answer("已完成")]), ["提交", "继续", "收尾"]);
	assert.deepEqual(texts([both], [user, answer("还没好")]), []);
});

test("坏正则被丢弃而不是抛错；自动重试排程中不出任何建议", () => {
	const bad = { text: "坏正则", triggers: [{ kind: "textMatch", patterns: ["([ unclosed"] }] };
	assert.deepEqual(texts([bad], [user, answer("任意文本")]), []);
	assert.deepEqual(texts([stopRule], [user, answer("", "error"), diagnostic("diagnostic.retryScheduled")]), []);
});

test("signals 归约：截断/中止轮既非失败也非收场，历史 user 消息终止倒查", () => {
	assert.deepEqual(plain(replySignalsForMessages([user, answer("", "length")])), { failed: false, stopped: false, finalText: "" });
	assert.deepEqual(plain(replySignalsForMessages([user, answer("好", "aborted")])), { failed: false, stopped: false, finalText: "" });
	assert.equal(replySignalsForMessages([user]), null);
});

// ── shared 清洗层 ────────────────────────────────────────────────

test("清洗：去空白、按 text 去重、坏 trigger 与空文案丢弃、合并同 kind patterns", () => {
	const cleaned = plain(
		sanitizeReplyActionRuleList([
			"  继续  ",
			{ text: "继续", triggers: [{ kind: "onStop" }] },
			{ text: " ", triggers: [{ kind: "onStop" }] },
			{ text: "无触发", triggers: [] },
			{ text: "坏kind", triggers: [{ kind: "nope" }] },
			{ text: "textMatch缺patterns", triggers: [{ kind: "textMatch" }] },
			{
				text: "合并patterns",
				triggers: [
					{ kind: "textMatch", patterns: ["a"] },
					{ kind: "textMatch", patterns: ["b"] },
				],
			},
		]),
	);
	assert.deepEqual(cleaned, [
		{ text: "继续", triggers: [{ kind: "onStop" }] },
		{ text: "合并patterns", triggers: [{ kind: "textMatch", patterns: ["a", "b"] }] },
	]);
	const overflow = Array.from({ length: 70 }, (_, i) => ({ text: `r${i}`, triggers: [{ kind: "onStop" }] }));
	assert.equal(sanitizeReplyActionRuleList(overflow).length, 64, "规则条数要截断到 MAX_REPLY_ACTION_RULES");
});

test("清洗文件：裸数组与 {items} 都接受，items: [] 是合法清空，结构坏返回 null", () => {
	assert.deepEqual(plain(sanitizeReplyActionsFile([{ text: "继续", triggers: [{ kind: "onStop" }] }]).items), [{ text: "继续", triggers: [{ kind: "onStop" }] }]);
	assert.deepEqual(plain(sanitizeReplyActionsFile({ items: [] }).items), []);
	assert.deepEqual(
		plain(
			sanitizeReplyActionsFile({
				items: [{ text: "提交", triggers: [{ kind: "textMatch", patterns: ["(?:完成|搞定|已?实现|已?修复|已?支持|改完|写完|测试通过|全部通过|验证通过)"] }] }],
			}).items,
		),
		[
			{
				text: "提交",
				triggers: [{ kind: "textMatch", patterns: ["完成", "搞定", "实现", "已实现", "修复", "已修复", "支持", "已支持", "改完", "写完", "测试通过", "全部通过", "验证通过"] }],
			},
		],
	);
	assert.equal(sanitizeReplyActionsFile({ nope: true }), null);
	assert.equal(sanitizeReplyActionsFile({ items: "继续" }), null);
});

// ── 出厂规则行为（直接加载 resources/reply-actions.default.json，防改 json 丢了匹配语义） ──

import { readFileSync } from "node:fs";
const factoryRules = JSON.parse(readFileSync(new URL("../resources/reply-actions.default.json", import.meta.url), "utf8")).items;

test("出厂规则：普通成功回复只出「继续」，不相关建议不再无条件堆出", () => {
	// 2026-10 优化前：「再确认一下」「运行测试看看结果」是纯 onStop，任何回复都显示
	assert.deepEqual(texts(factoryRules, [user, answer("我看了下这个模块的结构，主要由三部分组成。")]), ["继续"]);
});

test("出厂规则：回复提到完成/测试时才出现提交与测试建议", () => {
	assert.deepEqual(texts(factoryRules, [user, answer("修复完成，针对性测试全部通过。")]), ["继续", "提交", "提交并推送", "运行测试看看结果"]);
	assert.deepEqual(texts(factoryRules, [user, answer("改动已实现，待提交。")]), ["继续", "提交", "提交并推送"]);
});

test("出厂规则：回复带确认语气才出「再确认一下」", () => {
	assert.deepEqual(texts(factoryRules, [user, answer("是否需要我继续处理其余部分？")]), ["继续", "再确认一下"]);
	assert.deepEqual(texts(factoryRules, [user, answer("方案 A 更稳妥。")]), ["继续"]);
});

test("出厂规则：失败轮出 3 条排查建议", () => {
	assert.deepEqual(texts(factoryRules, [user, diagnostic("diagnostic.requestFailed")]), ["重新排查", "检查报错并修复", "重试一次"]);
});

// ── 同步内置（mergeReplyActionRules） ──────────────────────────

test("同步内置：同文案条目触发条件跟内置走，缺项追加，个人顺序与自定义条目保留", () => {
	const current = [
		{ text: "我的自定义", triggers: [{ kind: "always" }] },
		{ text: "提交", triggers: [{ kind: "onStop" }] }, // 旧 seed：无 textMatch 门
		{ text: "继续", triggers: [{ kind: "onStop" }] },
	];
	const defaults = [
		{ text: "继续", triggers: [{ kind: "onStop" }] },
		{ text: "提交", triggers: [{ kind: "onStop" }, { kind: "textMatch", patterns: ["完成"] }] },
		{ text: "新建议", triggers: [{ kind: "onFailure" }] },
	];
	assert.deepEqual(plain(mergeReplyActionRules(current, defaults)), [
		{ text: "我的自定义", triggers: [{ kind: "always" }] },
		{ text: "提交", triggers: [{ kind: "onStop" }, { kind: "textMatch", patterns: ["完成"] }] },
		{ text: "继续", triggers: [{ kind: "onStop" }] },
		{ text: "新建议", triggers: [{ kind: "onFailure" }] },
	]);
});
