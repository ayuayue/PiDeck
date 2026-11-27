import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/**
 * 全量条目索引必须真的接上，而不是只加了个 IPC 没人用。
 *
 * 用户原话：「数据没你想的这么大，反正不上 G，就全量索引」「直接全部建立 index 索引，
 * 跳转过去不就完了」。实测 5254 条 ≈ 292 KB / 0.3 ms，所以索引整份常驻没有顾虑；
 * 缺的一直是「跳转真的去查它」。
 */

const read = (p) => readFileSync(p, "utf8");

/**
 * 门面 2026-11-25 按「新逻辑放新模块」搬进 sessionReader/sessionEntryLookup：
 * 这里对**行为**断言（真模块跑真数据），搬迁/改名都拦不住它，改坏实现会立刻红。
 * 旧写法是 grep 源码字符串，搬迁时红的是断言而不是行为 —— 那类断言该换成运行时。
 */
const loadLookup = createTsSandbox();
const lookup = loadLookup("src/main/pi/sessionReader/sessionEntryLookup.ts");

test("主进程提供全量条目索引（entryId / ordinal / role）", () => {
	const rows = lookup.toEntryIndexRows([
		{ id: "m1", type: "message", role: "user" },
		{ id: "c1", type: "custom", role: "x" },
		{ id: "m2", type: "message", role: "assistant" },
		{ id: "m3", type: "message" },
	]);
	// vm 沙箱里的数组原型与宿主不同，deepEqual 会因原型不同而红 —— 用值比较。
	assert.equal(rows.map((row) => row.entryId).join(","), "m1,m2,m3", "只收 message 条目，且保持文件顺序（非 message 不占序号）");
	assert.equal(rows.map((row) => row.ordinal).join(","), "0,1,2", "ordinal 必须连续重编：拿文件序号当 ordinal 会让跳转落到别的条目");
	assert.equal(rows[2].role, "", "缺 role 时给空串，不给 undefined（IPC 序列化后前端要按字符串比）");
	assert.equal(rows[0].role, "user");
	const reader = read("src/main/pi/SessionHistoryReader.ts");
	assert.equal(reader.includes("readEntryIndex("), true, "reader 必须转发 readEntryIndex");
	const am = read("src/main/pi/AgentManager.ts");
	assert.equal(am.includes("sessionHistory"), true, "AgentManager 必须把 reader 暴露给 IPC（或转发）");
});

test("IPC 通道 + preload + 渲染层 hook 三处都接上", () => {
	assert.equal(read("src/shared/ipc.ts").includes("sessionsCatalogReadEntryIndex"), true, "通道常量");
	assert.equal(read("src/main/ipc/sessionMessageReadIpc.ts").includes("sessionsCatalogReadEntryIndex"), true, "主进程 handler");
	assert.equal(read("src/preload/api/sessions.ts").includes("readEntryIndex"), true, "preload 暴露");
	const hook = read("src/renderer/src/hooks/useSessionEntryIndex.ts");
	assert.equal(hook.includes("new Map(rows.map("), true, "hook 必须建 Map（O(1) 查表）");
});

test("跳转走「按 entryId 一次取页」，不再依赖逐页往前补", () => {
	// 取页 2026-11-25 搬进 useTimelineJumpChain（控制器只剩装配）：两份都要看。
	const controller = read("src/renderer/src/hooks/useSessionTimelineController.ts") + read("src/renderer/src/hooks/session/timeline/useTimelineJumpChain.ts");
	assert.equal(controller.includes("loadPageAroundEntry"), true);
	const paging = read("src/renderer/src/hooks/session/timeline/useTimelineHistoryPaging.ts");
	assert.equal(paging.includes("readPageAroundEntry(sessionId, entryId"), true, "必须按 entryId 定位取页");
	const ipc = read("src/main/ipc/sessionMessageReadIpc.ts");
	assert.equal(ipc.includes("readSessionDisplayJumpPage(filePath, sessionId, rawEntryId"), true, "主进程委托同快照跳转入口");
	const domain = read("src/main/pi/sessionReader/sessionDisplayPaging.ts");
	assert.equal(domain.includes("resolveJumpPageBefore("), true, "完整回合边界由读页领域持有");
});

test("索引与定位覆盖被 compaction 移出的条目（否则「搜到却滚不过去」）", () => {
	// 长会话必然多次压缩，早期消息不在活动分支上。索引走 index.entries（全量条目表），
	// 定位在活动分支找不到时按字节偏移退到锚 —— 否则用户搜到自己说过的话却得到
	// 「这条不在当前会话的活动分支上」。行为断言见文件末尾的 pickAnchorOrdinal 用例。
	const reader = read("src/main/pi/SessionHistoryReader.ts") + read("src/main/pi/sessionReader/sessionEntryLookup.ts");
	const resolve = reader.slice(reader.indexOf("async resolveEntryPosition"));
	assert.equal(resolve.slice(0, 1400).includes("index.entries.get(entryId)"), true, "定位必须有非活动分支兜底");
	assert.equal(resolve.slice(0, 1400).includes("pickAnchorOrdinal("), true, "非活动分支必须走字节偏移锚（文件序号与活动下标是两个空间；算法在 pickAnchorOrdinal，下方有运行时用例）");
});

test("非活动分支的目标按字节偏移定位，不把文件序号当活动下标（运行时）", () => {
	// 活动分支 4 条，偏移 100/200/300/400；目标在第 3 条之后（偏移 350）→ 锚是下标 2。
	const active = [{ offset: 100 }, { offset: 200 }, { offset: 300 }, { offset: 400 }];
	assert.equal(lookup.pickAnchorOrdinal(active, 350), 2, "必须落在「不超过目标的最后一个」");
	assert.equal(lookup.pickAnchorOrdinal(active, 300), 2, "正好等于某条偏移时取该条");
	assert.equal(lookup.pickAnchorOrdinal(active, 10), 0, "早于第一条时取首条，不给负数");
	assert.equal(lookup.pickAnchorOrdinal(active, 99999), 3, "晚于最后一条时取末条，不越界");
	assert.equal(lookup.pickAnchorOrdinal([], 999), 0, "空活动分支退回 0，不抛");
	// 反例（旧实现）：Math.min(文件序号, 活动长度) 会把中间目标全夹到末尾，
	// 表现是「第一页和最后一页能跳，中间全跳不了」（2026-11 真机）。
	const source = read("src/main/pi/SessionHistoryReader.ts");
	assert.equal(/Math\.min\(\s*ordinal/.test(source), false, "不得再用文件序号夹取活动下标");
});
