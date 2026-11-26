import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const load = createTsSandbox();
const M = load("src/renderer/src/components/session/timeline/mergeHistoryWindow.ts");
const key = M.messageIdentityKey;
const merge = M.mergeHistoryAndWindow;
const mergeInterleaved = M.mergeInterleavedHistory;

/** 断言用：跨投影的身份（entryId 优先），避免被 id 前缀差异干扰。 */
const k = (m) => m.meta?.entryId ?? m.id;
const keysOf = (list) => list.map(k).join(",");

/**
 * 两条真机事故决定了本文件的判据：
 *
 * ① 「同一条消息出现两份」——搜索面板 81/82 一模一样（2026-11-26 09:33）。
 *    live 消息刚产生时没有 entryId，id 是 requestId；页里同一条是 `<agentId>-history-<entryId>`。
 *
 * ② 「最新一条跑到最上面」——点刻度第 2973 条，`jump/settle rectTop=-64 scrollTop=214`、
 *    `jump/entry foundIndex=0`（2026-11-26 09:32）。曾用 timestamp 校正顺序，而 pi 的
 *    timestamp 是请求开始时刻，同一轮里可以倒退（窗口实测末 6 条里倒退 25 秒）。
 */

test("身份优先用 meta.entryId（跨投影稳定），缺省回退消息 id", () => {
	assert.equal(key({ id: "_viewer-history-a1", meta: { entryId: "a1" } }), "a1");
	assert.equal(key({ id: "msg-1" }), "msg-1");
	assert.equal(key({ id: "msg-2", meta: {} }), "msg-2");
	assert.equal(key({ id: "msg-3", meta: { entryId: "" } }), "msg-3", "空字符串不算身份");
	assert.equal(key({ id: "old-agent-history-a1" }), key({ id: "new-agent-history-a1", meta: { entryId: "a1" } }));
});

test("前缀：重叠部分只留窗口那一份（否则界面两条一样）", () => {
	const history = [
		{ id: "_viewer-history-a1", meta: { entryId: "a1" } },
		{ id: "_viewer-history-a2", meta: { entryId: "a2" } },
	];
	const window = [
		{ id: "agent-history-a2", meta: { entryId: "a2" } },
		{ id: "agent-history-a3", meta: { entryId: "a3" } },
	];
	assert.equal(keysOf(merge(history, window)), "a1,a2,a3", "重复的 a2 只保留窗口那份");
});

test("前缀：无重叠时不改顺序也不丢项", () => {
	const history = [{ id: "_viewer-history-a1", meta: { entryId: "a1" } }];
	const window = [{ id: "agent-history-a2", meta: { entryId: "a2" } }];
	assert.equal(keysOf(merge(history, window)), "a1,a2");
});

test("前缀：任一段为空时原样返回（不额外分配，memo 依赖引用相等）", () => {
	const window = [{ id: "agent-history-a1", meta: { entryId: "a1" } }];
	assert.equal(merge([], window), window);
	const history = [{ id: "_viewer-history-a1", meta: { entryId: "a1" } }];
	assert.equal(merge(history, []), history);
});

test("前缀：从第一个重叠处整体交接，不逐个过滤（否则窗口外较早项留到末尾）", () => {
	const history = [
		{ id: "_viewer-history-a1", meta: { entryId: "a1" } },
		{ id: "_viewer-history-a2", meta: { entryId: "a2" } },
		{ id: "_viewer-history-a3", meta: { entryId: "a3" } },
	];
	const window = [
		{ id: "agent-history-a2", meta: { entryId: "a2" } },
		{ id: "agent-history-a4", meta: { entryId: "a4" } },
	];
	// 窗口从 a2 开始接管：a3 属于窗口覆盖的区间，不再由前缀提供。
	assert.equal(keysOf(merge(history, window)), "a1,a2,a4");
});

test("前缀：顺序不按 timestamp 重排（时间不是顺序真值，可以倒退）", () => {
	const history = [{ id: "_viewer-history-a1", meta: { entryId: "a1" }, timestamp: 5000 }];
	const window = [{ id: "agent-history-a2", meta: { entryId: "a2" }, timestamp: 1000 }];
	assert.equal(keysOf(merge(history, window)), "a1,a2", "时间倒退也要保持文件顺序");
});

/**
 * 真机 A（2026-11-26 09:32）：页 128 条里 127 条与窗口重复，只有目标 1 条是新的。
 * 旧实现把页里的新项排在数组首位 → 目标渲染在文档 150px 处（rectTop=-64, scrollTop=214）。
 * 正确定位：目标在页里后面紧跟的重叠项是 w4，所以它必须插在窗口的 w4 之前。
 */
test("交错：页里只有目标 1 条是新的 → 必须落回窗口对应位置，不能排首位", () => {
	const later = [
		{ id: "agent-history-w1", meta: { entryId: "w1" }, timestamp: 1000 },
		{ id: "agent-history-w2", meta: { entryId: "w2" }, timestamp: 2000 },
		{ id: "agent-history-w3", meta: { entryId: "w3" }, timestamp: 3000 },
		{ id: "agent-history-w4", meta: { entryId: "w4" }, timestamp: 4000 },
		{ id: "agent-history-w5", meta: { entryId: "w5" }, timestamp: 5000 },
	];
	const earlier = [
		{ id: "_viewer-history-w3", meta: { entryId: "w3" }, timestamp: 3000 },
		{ id: "_viewer-history-target", meta: { entryId: "target" }, timestamp: 3500 },
		{ id: "_viewer-history-w4", meta: { entryId: "w4" }, timestamp: 4000 },
	];
	assert.equal(keysOf(mergeInterleaved(earlier, later)), "w1,w2,w3,target,w4,w5");
});

test("交错：同文本但时间相差 60s → 两条都留（不误合并真消息）", () => {
	const earlier = [{ id: "_viewer-history-x9", meta: { entryId: "x9" }, role: "user", text: "继续", timestamp: 5000 }];
	const later = [{ id: "req-2", role: "user", text: "继续", timestamp: 65000 }];
	assert.equal(mergeInterleaved(earlier, later).length, 2);
});

test("交错：文本不同 → 即使都没有 entryId 也不合并", () => {
	const earlier = [{ id: "a", role: "user", text: "甲", timestamp: 5000 }];
	const later = [{ id: "b", role: "user", text: "乙", timestamp: 5000 }];
	assert.equal(mergeInterleaved(earlier, later).length, 2);
});

test("交错：重叠点在中间时，页内重叠点之后的项不得丢", () => {
	const page = [
		{ id: "_viewer-history-p1", meta: { entryId: "e1" }, timestamp: 1000 },
		{ id: "_viewer-history-p3", meta: { entryId: "e3" }, timestamp: 3000 },
	];
	const win = [
		{ id: "agent-history-e3", meta: { entryId: "e3" }, timestamp: 3000 },
		{ id: "agent-history-e4", meta: { entryId: "e4" }, timestamp: 4000 },
	];
	assert.equal(keysOf(mergeInterleaved(page, win)), "e1,e3,e4", "e1 插在 e3 之前，e3 用窗口那份");
});

test("交错：没有任何重叠 → 追加到末尾（不知道位置就不猜）", () => {
	const page = [{ id: "_viewer-history-p2", meta: { entryId: "p2" }, timestamp: 2000 }];
	const win = [
		{ id: "agent-history-w1", meta: { entryId: "w1" }, timestamp: 1000 },
		{ id: "agent-history-w5", meta: { entryId: "w5" }, timestamp: 5000 },
	];
	assert.equal(keysOf(mergeInterleaved(page, win)), "w1,w5,p2");
});

test("交错：完全没有锚点 → 追加末尾，不丢项也不猜位置", () => {
	// 退化路径：页与窗口不相邻（例如中间那段被 compaction 裁掉了）。此时任何位置都是猜，
	// 追加至少保证「页里的东西不会不见」。真机 128 条页里通常 127 条重叠，这条路径很少走到。
	const page = [
		{ id: "_viewer-history-p1", meta: { entryId: "p1" }, timestamp: 100 },
		{ id: "_viewer-history-p2", meta: { entryId: "p2" }, timestamp: 200 },
	];
	const win = [{ id: "agent-history-w1", meta: { entryId: "w1" }, timestamp: 300 }];
	assert.equal(keysOf(mergeInterleaved(page, win)), "w1,p1,p2");
});

test("交错：唯一候选也要时间对得上（1s 容差），差 2s 不合并", () => {
	const win = [{ id: "live-1", role: "user", text: "继续", timestamp: 5000 }];
	const page = [{ id: "_viewer-history-a", meta: { entryId: "a" }, role: "user", text: "继续", timestamp: 7000 }];
	assert.equal(mergeInterleaved(page, win).length, 2, "时间差 2s 不是同一条");
});
/**
 * 反例（2026-11-26 真机，用户：「改了后有时候都不实时刷新」）：前缀整段被窗口覆盖时，
 * 每次都 concat 新数组 → 下游 useMemo / jotai 拿到新引用 → 输入没变也重算整条时间线。
 * 判据：这种最常见情形必须返回窗口**原引用**。
 */
test("前缀整段被窗口覆盖 → 返回窗口原引用（否则流式时整条时间线反复重算）", () => {
	const window = [
		{ id: "agent-history-a1", meta: { entryId: "a1" } },
		{ id: "agent-history-a2", meta: { entryId: "a2" } },
	];
	const history = [{ id: "_viewer-history-a1", meta: { entryId: "a1" } }];
	assert.equal(merge(history, window), window, "firstOverlap=0 时必须复用窗口数组");
});
/**
 * 真机（2026-11-26 13:03，694 轮会话）：`jump/merge {pageMessages: 146, merged: 467,
 * visibleBefore: 467}`、`jump/entry foundIndex: -1`、`give-up no-earlier-pages`。
 *
 * 链是：内容兜底（按 role+text+时间猜身份）把页里的新消息大面积判成「窗口已有」→ 页里一条
 * 没进 → 目标是其中一条 → 反复取同一页。
 *
 * 取舍：猜身份一律删掉，去重只按 entryId/id。代价是刚发出、还没回写 entryId 的 live 消息
 * 可能多一条重复气泡（可见、可再修），而吞掉整页是不可见的信息丢失。
 */
test("交错：页里的新消息一律进结果，不靠文本猜身份（146 条全丢那次）", () => {
	const same = "Script completed Wall time 0.5s";
	const win = Array.from({ length: 40 }, (_, i) => ({
		id: "live-" + i,
		role: "toolResult",
		text: same,
		timestamp: 10000,
	}));
	const page = [{ id: "_viewer-history-target", meta: { entryId: "target" }, role: "toolResult", text: same, timestamp: 10000 }];
	const out = mergeInterleaved(page, win);
	assert.equal(out.length, 41, "目标必须留在结果里，实际 " + out.length);
	assert.equal(
		out.some((m) => m.meta?.entryId === "target"),
		true,
		"目标不能被丢",
	);
});

test("交错：同 id 的项出现多次只留一份（去重仍然生效）", () => {
	const win = [{ id: "agent-history-a", meta: { entryId: "a" }, timestamp: 1000 }];
	const page = [
		{ id: "dup", meta: { entryId: "z" } },
		{ id: "dup", meta: { entryId: "z" } },
	];
	assert.equal(mergeInterleaved(page, win).length, 2, "a + z，z 只一份");
});

/**
 * 反例（2026-11-26 真机「会话思考不见了」）：同一条消息两处都有，窗口那份是运行事件快照
 * （正文有、thinking 还没回填），磁盘/历史那份带完整 thinking。旧实现一律留窗口版本 →
 * 思考正文被静默丢掉，那一轮只剩空思考行。
 */
test("同键两条：留思考/正文更全的那份（内容不能因为「已存在」被丢掉）", () => {
	const window = [
		{ id: "agent-history-a1", meta: { entryId: "a1" }, text: "答案" },
		{ id: "agent-history-a2", meta: { entryId: "a2" }, text: "第二条" },
	];
	const history = [{ id: "_viewer-history-a1", meta: { entryId: "a1" }, text: "答案", thinking: "完整的思考正文" }];
	const merged = merge(history, window);
	assert.equal(merged.length, 2, "数量不变：这是替换内容，不是插一条");
	assert.equal(merged[0].thinking, "完整的思考正文", "窗口那份更瘦时必须换成 history 的");
	assert.equal(merged[1], window[1], "没争议的项保持原引用");
});

test("同键两条：窗口那份同样全或更全 → 原样返回窗口引用（流式期不能平白重算）", () => {
	const window = [{ id: "agent-history-a1", meta: { entryId: "a1" }, text: "答案", thinking: "更长的思考" }];
	const history = [{ id: "_viewer-history-a1", meta: { entryId: "a1" }, text: "答案", thinking: "短" }];
	assert.equal(merge(history, window), window, "contentWeight 不小于就不得换引用");
});

test("交错合并：页里那条 thinking 更全 → 同位置替换，顺序与数量都不变", () => {
	const later = [
		{ id: "agent-history-a1", meta: { entryId: "a1" }, text: "一" },
		{ id: "agent-history-a2", meta: { entryId: "a2" }, text: "二" },
	];
	const earlier = [
		{ id: "_viewer-history-a1", meta: { entryId: "a1" }, text: "一", thinking: "页里带的思考" },
		{ id: "_viewer-history-a3", meta: { entryId: "a3" }, text: "三（新的）" },
	];
	const merged = mergeInterleaved(earlier, later);
	assert.equal(keysOf(merged), "a1,a2,a3", "顺序：a1、a2 原样，新的 a3 追加在后");
	assert.equal(merged[0].thinking, "页里带的思考", "a1 的内容必须取更全的那份");
});
