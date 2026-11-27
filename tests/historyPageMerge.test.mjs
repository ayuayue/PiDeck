import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const load = createTsSandbox();
const { mergeHistorySegments, reanchorWindow } = load("src/renderer/src/components/session/timeline/historyPageMerge.ts");

const msg = (entryId) => ({ id: "id-" + entryId, meta: { entryId } });
const keyOf = (item) => "e:" + item.meta.entryId;
const ids = (list) => list.map((item) => item.meta.entryId);
/** 沙箱里创建的对象原型不同，deepStrictEqual 会误判，按值比较。 */
const same = (actual, expected, message) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);

/** 坏样本：按到达顺序拼，正是被替换掉的旧实现。 */
function mergeByArrival(segments) {
	return segments.flatMap((segment) => segment.messages);
}

test("后页先到：合并结果按文件顺序，不按到达顺序", () => {
	const p1 = { nextBefore: 0, before: 10, messages: [msg("a"), msg("b")] };
	const p2 = { nextBefore: 10, before: 20, messages: [msg("c"), msg("d")] };
	const merged = mergeHistorySegments([p2, p1], keyOf);
	same(ids(merged.messages), ["a", "b", "c", "d"]);
	assert.equal(merged.reordered, true);
	same(merged.gaps, []);
	assert.notEqual(JSON.stringify(ids(merged.messages)), JSON.stringify(ids(mergeByArrival([p2, p1]))));
});

test("到达顺序与文件顺序一致时不报 reordered", () => {
	const p1 = { nextBefore: 0, before: 10, messages: [msg("a")] };
	const p2 = { nextBefore: 10, before: 20, messages: [msg("b")] };
	const merged = mergeHistorySegments([p1, p2], keyOf);
	same(ids(merged.messages), ["a", "b"]);
	assert.equal(merged.reordered, false);
});

test("重叠回合只留一份，丢弃条数如实报出", () => {
	const older = { nextBefore: 0, before: 10, messages: [msg("a"), msg("b")] };
	const newer = { nextBefore: 10, before: 20, messages: [msg("b"), msg("c")] };
	const merged = mergeHistorySegments([older, newer], keyOf);
	same(ids(merged.messages), ["a", "b", "c"]);
	assert.equal(merged.dropped, 1);
});

test("有缺口时不静默填空：报出缺口边界与跨度", () => {
	const older = { nextBefore: 0, before: 10, messages: [msg("a")] };
	const gapPage = { nextBefore: 25, before: 30, messages: [msg("z")] };
	const merged = mergeHistorySegments([older, gapPage], keyOf);
	same(ids(merged.messages), ["a", "z"]);
	same(merged.gaps, [{ before: 25, size: 15 }]);
});

test("文件头页（nextBefore 为 null）接在最前", () => {
	const head = { nextBefore: null, before: 5, messages: [msg("h")] };
	const tail = { nextBefore: 5, before: 9, messages: [msg("t")] };
	const merged = mergeHistorySegments([tail, head], keyOf);
	same(ids(merged.messages), ["h", "t"]);
	assert.equal(merged.reordered, true);
});

test("空输入返回空结果", () => {
	const merged = mergeHistorySegments([], keyOf);
	same(merged, { messages: [], gaps: [], dropped: 0, reordered: false });
});

test("补页后窗口锚点不动：首条还在，就返回以它开头的那一批", () => {
	const window = [msg("c"), msg("d")];
	const merged = [msg("a"), msg("b"), msg("c"), msg("d"), msg("e")];
	const result = reanchorWindow({ window, merged, keyOf });
	same(ids(result.window), ["c", "d"]);
	assert.equal(result.kept, true);
	// 坏样本对照：按「尾部 N 条」切会得到 d,e，用户正看着的 c,d 被顶走
	assert.notEqual(JSON.stringify(ids(result.window)), JSON.stringify(ids(merged.slice(-2))));
});

test("坏样本：首条被压缩移出，必须退回尾部切片并报 kept=false", () => {
	// 压缩把 a、b 整段换成摘要卡片，用户正看着的 c 之前那条已经不在了
	const window = [msg("b"), msg("c")];
	const afterCompaction = [msg("summary"), msg("c")];
	const result = reanchorWindow({ window, merged: afterCompaction, keyOf });
	assert.equal(result.kept, false);
	same(ids(result.window), ["summary", "c"]);
	// 旧实现（直接尾部切片）在这里恰好也是这两条，但 kept 标志缺失——
	// 调用方无法区分「锚住了」与「被压缩挤走了」，这就是要判的那件事
	assert.equal(ids(afterCompaction.slice(-2)).join(","), ids(result.window).join(","));
});

test("尾部追加新消息时窗口跟着最新，不被钉死", () => {
	const window = [msg("c"), msg("d")];
	const merged = [msg("c"), msg("d"), msg("e")];
	const result = reanchorWindow({ window, merged, keyOf });
	same(ids(result.window), ["c", "d"]);
	assert.equal(result.kept, true);
	// 窗口长度不变，首条仍在原位：新消息在窗口之外，不把用户钉住
	assert.equal(result.window.length, 2);
});
