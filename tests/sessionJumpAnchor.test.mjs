import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const load = createTsSandbox();
const A = load("src/shared/sessionJumpAnchor.ts");
const hasTarget = A.pageHasTargetEntry;
const strip = A.stripProjectionPrefix;

/** 剥投影前缀：三种 id 形状都要还原成裸 entryId。 */
test("剥投影前缀：磁盘/运行时/裸 id 三种形状", () => {
	assert.equal(strip("_viewer-history-1388e1fa"), "1388e1fa");
	assert.equal(strip("9326adf5-cb53-4d0d-b3e4-a604dc60c7c1-history-1388e1fa"), "1388e1fa");
	assert.equal(strip("1388e1fa"), "1388e1fa", "裸 id 原样返回");
	assert.equal(strip("a-history-"), "a-history-", "后缀为空时不能变成空串（会把所有条目判成同一身份）");
});

/**
 * 取页结果里是否已含目标 —— 判错就会注入重复条目。
 *
 * 反例（2026-11-25 真机）：用户只发一条，界面显示两条、搜索面板 57 / 58 两条一模一样。
 * 因为查找面板交来 `_viewer-history-1388e1fa`，页里是裸 `1388e1fa`，直接比字符串判「页里没有」
 * → 补读单条插到页首 → 同一条消息两份。
 */
test("投影 id 与裸 entryId 必须判为同一条（否则注入重复）", () => {
	const page = [{ id: "_viewer-history-1388e1fa", meta: { entryId: "1388e1fa" } }];
	assert.equal(hasTarget(page, "_viewer-history-1388e1fa"), true);
	assert.equal(hasTarget(page, "1388e1fa"), true, "裸 id 也要命中");
	assert.equal(hasTarget(page, "9326adf5-cb53-4d0d-b3e4-a604dc60c7c1-history-1388e1fa"), true, "运行时前缀也要命中");
});

test("页里确实没有目标时返回 false（注入才有意义）", () => {
	const page = [{ id: "_viewer-history-aaaa", meta: { entryId: "aaaa" } }];
	assert.equal(hasTarget(page, "bbbb"), false);
	assert.equal(hasTarget([], "bbbb"), false, "空页不算含目标");
});

test("meta 缺 entryId 时退回消息 id 比较（乐观插入/系统消息）", () => {
	assert.equal(hasTarget([{ id: "_viewer-history-cccc" }], "cccc"), true);
	assert.equal(hasTarget([{ id: "plain-id" }], "plain-id"), true);
});

test("空目标不命中任何页（否则空 id 会命中所有条目）", () => {
	assert.equal(hasTarget([{ id: "_viewer-history-x", meta: { entryId: "x" } }], ""), false);
});
/**
 * 补读单条必须按时间插回原位，不能固定页首。
 *
 * 反例（2026-11-25 真机）：目标被 compaction 移出活动分支，它比取回的那一页都晚，
 * 插到页首后时间线顶部出现最新一条，下面才是更早的消息 —— 用户说「条目怎么直接错乱了」。
 */
const Insert = A.insertByTimestamp;

test("注入单条比整页都晚：追加到末尾，不能插到最前", () => {
	const page = [
		{ id: "p1", timestamp: 1000 },
		{ id: "p2", timestamp: 2000 },
	];
	const out = Insert(page, { id: "target", timestamp: 3000 }).map((m) => m.id);
	assert.equal(out.join(","), "p1,p2,target", "跨 realm 数组用 join 比（vm 沙箱原型不同）；实际 " + JSON.stringify(out));
});

test("注入单条比页首早：插到最前", () => {
	const page = [{ id: "p1", timestamp: 2000 }];
	assert.equal(
		Insert(page, { id: "t", timestamp: 1000 })
			.map((m) => m.id)
			.join(","),
		"t,p1",
	);
});

test("注入单条落在页中间：插到第一个更晚的条目之前", () => {
	const page = [
		{ id: "p1", timestamp: 1000 },
		{ id: "p2", timestamp: 3000 },
	];
	assert.equal(
		Insert(page, { id: "t", timestamp: 2000 })
			.map((m) => m.id)
			.join(","),
		"p1,t,p2",
	);
});

test("空页 / 无时间戳：退化成页首或末尾，不抛", () => {
	assert.equal(
		Insert([], { id: "t", timestamp: 1 })
			.map((m) => m.id)
			.join(","),
		"t",
	);
	assert.equal(
		Insert([{ id: "p1", timestamp: 1 }], { id: "t" })
			.map((m) => m.id)
			.join(","),
		"t,p1",
		"没有时间可比时保持旧行为（页首）",
	);
});
/**
 * 补读单条必须按**文件序号**插回原位，不能按 timestamp。
 *
 * 真机（2026-11-26，点倒数第二条）：界面提示 `{data=109 target=0 page=exact}` ——
 * 目标在已加载数组第 0 位。原因是 pi 的 `message.timestamp` 是「请求开始时刻」，
 * 同一轮里会倒退（实测相邻两条差 -25s），按时间插就把目标送到了页首。
 * 序号来自 readEntryIndex（按文件顺序重编），是唯一可靠的位置真值。
 */
const ord = (map) => (m) => (m.meta?.entryId ? map[m.meta.entryId] : undefined);

test("按序号：目标落在页中间 → 插到第一个序号更大的条目之前", () => {
	const page = [
		{ id: "p1", meta: { entryId: "a" } },
		{ id: "p2", meta: { entryId: "c" } },
	];
	const out = A.insertByOrdinal(page, { id: "t", meta: { entryId: "b" } }, ord({ a: 10, c: 30 }), 20);
	assert.equal(out.map((m) => m.meta.entryId ?? m.id).join(","), "a,b,c");
});

test("按序号：目标比整页都靠后 → 追加末尾（不排首位）", () => {
	const page = [{ id: "p1", meta: { entryId: "a" } }];
	const out = A.insertByOrdinal(page, { id: "t", meta: { entryId: "z" } }, ord({ a: 10 }), 99);
	assert.equal(out.map((m) => m.meta.entryId ?? m.id).join(","), "a,z");
});

test("按序号：目标比整页都靠前 → 插首位", () => {
	const page = [{ id: "p1", meta: { entryId: "a" } }];
	const out = A.insertByOrdinal(page, { id: "t", meta: { entryId: "z" } }, ord({ a: 10 }), 5);
	assert.equal(out.map((m) => m.meta.entryId ?? m.id).join(","), "z,a");
});

test("按序号：查不到目标序号 → 追加末尾，不猜首位", () => {
	const page = [{ id: "p1", meta: { entryId: "a" } }];
	const out = A.insertByOrdinal(page, { id: "t", meta: { entryId: "z" } }, ord({ a: 10 }), undefined);
	assert.equal(out.map((m) => m.meta.entryId ?? m.id).join(","), "a,z");
});

test("按序号：timestamp 倒退不影响位置（回归真机那两条）", () => {
	const page = [
		{ id: "p1", meta: { entryId: "a" }, timestamp: 2000 },
		{ id: "p2", meta: { entryId: "c" }, timestamp: 1000 },
	];
	const out = A.insertByOrdinal(page, { id: "t", meta: { entryId: "b" }, timestamp: 999999 }, ord({ a: 10, c: 30 }), 20);
	assert.equal(out.map((m) => m.meta.entryId ?? m.id).join(","), "a,b,c", "时间更晚也要按序号落中间");
});
