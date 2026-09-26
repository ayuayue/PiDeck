import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { QUOTE_EXCLUDED_SELECTOR, MAX_QUOTE_CHARS, isQuotableRange, computeToolbarPosition } = loadTsCommonJs("src/renderer/src/components/session/timeline/selectionToolbarPolicy.ts");

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
