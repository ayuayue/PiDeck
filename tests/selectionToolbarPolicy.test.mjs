import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { QUOTE_EXCLUDED_SELECTOR, MAX_QUOTE_CHARS, isQuotableRange, computeToolbarPosition, selectionIntegrityKey } = loadTsCommonJs("src/renderer/src/components/session/timeline/selectionToolbarPolicy.ts");

test("isQuotableRange requires a single message and non-excluded endpoints", () => {
	const base = {
		messageIdA: "m1",
		messageIdB: "m1",
		excludedA: false,
		excludedB: false,
		text: "一段引用",
	};
	assert.equal(isQuotableRange(base), true);
	// 跨消息边界：忽略（对齐 assistant-ui/Codex）
	assert.equal(isQuotableRange({ ...base, messageIdB: "m2" }), false);
	// 缺少来源消息 id
	assert.equal(isQuotableRange({ ...base, messageIdA: null }), false);
	// 任一端落在排除区域（流式/工具卡/折叠过程）
	assert.equal(isQuotableRange({ ...base, excludedB: true }), false);
	// 空文本 / 超长文本
	assert.equal(isQuotableRange({ ...base, text: "   " }), false);
	const longText = "x".repeat(MAX_QUOTE_CHARS + 1);
	assert.equal(isQuotableRange({ ...base, text: longText }), false);
});

test("excluded selector covers streaming turns and per-component regions", () => {
	// 与时间线 DOM 契约对齐：流式 turn + 逐项排除（工具卡/重试/错误/思考/过程组头体）。
	// 注意：不再整体排除 .execution-summary-details——中间回复就在折叠区内，需可引用。
	assert.doesNotMatch(QUOTE_EXCLUDED_SELECTOR, /execution-summary-details/);
	assert.match(QUOTE_EXCLUDED_SELECTOR, /\.turn-row--pending/);
	assert.match(QUOTE_EXCLUDED_SELECTOR, /\[data-tool-kind\]/);
	assert.match(QUOTE_EXCLUDED_SELECTOR, /\[data-retry-step\]/);
	assert.match(QUOTE_EXCLUDED_SELECTOR, /\[data-error-step\]/);
	assert.match(QUOTE_EXCLUDED_SELECTOR, /\[data-thinking-step\]/);
	assert.match(QUOTE_EXCLUDED_SELECTOR, /\[data-process-group-head\]/);
	assert.match(QUOTE_EXCLUDED_SELECTOR, /\[data-process-group-body\]/);
});

test("live answer copy is permanently excluded (settle handover guard)", () => {
	// B 点守卫：run 结束后 live 副本残留窗口内，轮样式已切 complete、.turn-row--pending
	// 不再命中，live 副本必须靠自身 data-live-answer 戳排除，否则划选会归属到 run id。
	assert.match(QUOTE_EXCLUDED_SELECTOR, /\[data-live-answer\]/);
});

test("interim answers inside a completed turn are quotable while cross-message is not", () => {
	// 中间回复场景：同一轮内选区两端都在同一条中间回复（data-message-id=消息 id）内。
	const interim = {
		messageIdA: "msg-interim-1",
		messageIdB: "msg-interim-1",
		excludedA: false,
		excludedB: false,
		text: "中间回复正文",
	};
	assert.equal(isQuotableRange(interim), true);
	// 跨到另一条中间回复 / 最终回答：拒绝（closest 解析出不同消息 id）。
	assert.equal(isQuotableRange({ ...interim, messageIdB: "msg-final" }), false);
	// live 流式中的中间回复：turn 仍为 pending，两端命中排除。
	assert.equal(isQuotableRange({ ...interim, excludedA: true, excludedB: true }), false);
});

test("computeToolbarPosition prefers above the selection and clamps into viewport", () => {
	const viewport = { width: 1000, height: 800 };
	const size = { width: 132, height: 32 };
	// 选区在中间：浮层居中悬于上方，留 6px gap
	const mid = computeToolbarPosition({ top: 400, left: 400, width: 200, height: 24 }, viewport, size);
	assert.equal(mid.top, 400 - 6 - 32);
	assert.equal(mid.left, 400 + (200 - 132) / 2);

	// 选区贴近顶部：翻转到下方
	const top = computeToolbarPosition({ top: 10, left: 100, width: 300, height: 24 }, viewport, size);
	assert.equal(top.top, 10 + 24 + 6);

	// 水平溢出夹紧到视口右边距内
	const edge = computeToolbarPosition({ top: 400, left: 950, width: 200, height: 24 }, viewport, size);
	assert.equal(edge.left, 1000 - 8 - 132);
});

/** 假选区：只实现 selectionIntegrityKey 真正用到的三个成员（测试里不需要真 DOM）。 */
function fakeSelection(options) {
	if (options === "none") return null;
	if (options === "collapsed") return { isCollapsed: true, rangeCount: 0, getRangeAt: () => assert.fail("折叠选区不应再取 Range") };
	if (options === "empty") return { isCollapsed: false, rangeCount: 0, getRangeAt: () => assert.fail("rangeCount=0 不应再取 Range") };
	return { isCollapsed: false, rangeCount: 1, getRangeAt: () => ({ toString: () => options.rangeText }) };
}

test("selectionIntegrityKey always reads the live Range text (never Selection.toString())", () => {
	// 跨段落划选的两侧真实取值（Electron 43 实测）：同一段选区，两个 API 的原文不同。
	// 键必须固定取 Range 侧——它是逐帧都能从同一个选区对象重算的那个值。
	const rangeText = "第一段正文。第二段正文。";
	const selectionText = "第一段正文。\n\n第二段正文。";
	const selection = { ...fakeSelection({ rangeText }), toString: () => selectionText };
	assert.equal(selectionIntegrityKey(selection), rangeText);
	assert.notEqual(selectionIntegrityKey(selection), selectionText, "键不得取 Selection.toString()（跨段落时与 Range 侧恒不等）");
	// 同一份选区重复取键必须稳定（rAF 每帧都要重算，浮层才能活下来）
	assert.equal(selectionIntegrityKey(selection), selectionIntegrityKey(selection));
});

test("selectionIntegrityKey degrades to empty key when the selection is gone", () => {
	// 空键必然与任何已锁存的键不等 → 跟随循环会正常走 releaseLock（塌陷/选到容器外）
	assert.equal(selectionIntegrityKey(null), "");
	assert.equal(selectionIntegrityKey(undefined), "");
	assert.equal(selectionIntegrityKey(fakeSelection("collapsed")), "");
	assert.equal(selectionIntegrityKey(fakeSelection("empty")), "");
});

test("useTimelineSelection computes the integrity key from one source on both sides", () => {
	// 源码契约（正则空白容忍）：浮层的「锁存」与「逐帧校验」必须调用同一个函数取键。
	// 只测纯函数测不出这条分叉——判定函数返回 true、浮层也确实展示了，但下一帧被自己撤掉；
	// 默认门禁（npm test）不含 e2e/selection-quote.spec.ts，所以这里补一道源码级守卫。
	const source = readFileSync("src/renderer/src/hooks/useTimelineSelection.ts", "utf8");
	assert.match(source, /lockedSelectionKeyRef\.current\s*=\s*selectionIntegrityKey\(\s*selection\s*\)/);
	assert.match(source, /selectionIntegrityKey\(\s*selection\s*\)\s*!==\s*lockedSelectionKeyRef\.current/);
	// 禁止退回「拿两个 API 的文本互比」：那是跨段落引用失效的根因
	assert.doesNotMatch(source, /selection\.toString\(\)\s*!==\s*locked/);
	assert.doesNotMatch(source, /range\.toString\(\)\s*!==\s*locked/);
	// 快照文本仍取 Selection.toString()：块级边界保留 \n\n，跨段落引文才有段落结构
	assert.match(source, /const text = selection\.toString\(\)/);
	assert.match(source, /text: text\.trim\(\)/);
});
