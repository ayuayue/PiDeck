import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { resolveJumpMessageIndex } = loadTsCommonJs("src/renderer/src/components/session/timeline/jumpTarget.ts");

/**
 * 归一判据的形状表。
 *
 * 事故（2026-11-26 真机日志，entryId cd9540b6，用户原话「我跳转过去，上下文都没了」）：
 *   entry requested=cd9540b6 foundIndex=-1 messages=138
 *   merge pageMessages=36 merged=138 pageHasTarget=true cacheWrite=true   ← 主进程：页里有它
 *   page  outcome=exact anchorEntryId=cd9540b6                            ← 取到了
 *   tick  messages=138 stillInData=false                                  ← 渲染层：认不出它
 *   give-up route=load-page-after-fetch hasMorePages=true pageOutcome=exact ← 还报「没有更早的页」
 *   row-exhausted frames=120                                              ← 干等 2 秒
 *
 * 一句话：**同一条消息「是不是目标」，主进程与渲染层各写了一套判据**（主进程用
 * stripProjectionPrefix 比 meta.entryId 或 id，渲染层只比全等）。两处判据不一致，
 * 于是主进程说「页里有」，渲染层说「数据里没有」，中间那 2 秒就是用户看到的空白。
 *
 * 这里把渲染层的判据钉成「与 shared/sessionJumpAnchor 同一套键归一」的形状表。
 */

// 两条真实形状：只给投影 id，或投影 id + 裸 entryId。
// 反例（我第一版写错的就是签名）：三参形态 (agentId, entryId, meta) 让第一个参数被丢掉，
// 于是「坏样本自己不会红」——判据也是代码，写完必须先看到它红。

const proj = (id, entryId) => (entryId === undefined ? { id } : { id, meta: { entryId } });

test("形状①：投影 id 带 agentId 前缀 + meta.entryId（常规历史消息）", () => {
	assert.equal(resolveJumpMessageIndex([proj("agent-1-history-e1", "e1")], "e1"), 0);
});

test("形状②：_viewer 前缀（历史浏览/只读会话）", () => {
	// 反例：只比全等时这里返回 -1，而主进程的 pageHasTargetEntry 剥前缀后认为命中。
	assert.equal(resolveJumpMessageIndex([proj("_viewer-history-cd9540b6", "cd9540b6")], "cd9540b6"), 0);
});

test("形状③：投影 id 有前缀、meta 里没有 entryId（activeEntryIds 缺槽位时投影器只写 index）", () => {
	// 反例（本轮真机最可能的形状）：meta.entryId 缺失 → 旧实现两条判据都不命中。
	assert.equal(resolveJumpMessageIndex([proj("_viewer-history-cd9540b6")], "cd9540b6"), 0);
	assert.equal(resolveJumpMessageIndex([proj("agent-1-history-cd9540b6")], "cd9540b6"), 0);
});

test("形状④：入口给的是投影 id，数据里只有裸条目 id（反向也要归一）", () => {
	assert.equal(resolveJumpMessageIndex([proj("_viewer-history-cd9540b6")], "_viewer-history-cd9540b6"), 0);
	assert.equal(resolveJumpMessageIndex([proj("cd9540b6")], "_viewer-history-cd9540b6"), 0);
});

test("形状⑤：精确 id 命中优先于剥前缀（两条同 entryId 的消息不得改变既有语义）", () => {
	const messages = [proj("agent-1-history-e1", "e1"), proj("agent-2-history-e1", "e1")];
	assert.equal(resolveJumpMessageIndex(messages, "agent-2-history-e1"), 1, "精确命中必须优先");
	assert.equal(resolveJumpMessageIndex(messages, "e1"), 0, "按 entryId 命中取第一条（既有语义）");
});

test("形状⑥：运行时 UUID 消息不参与剥前缀（没有 -history- 标记，不得误配）", () => {
	const messages = [proj("4d9ba94a-5b17-4ade-a43b-858cad9a07e9"), proj("_viewer-history-e1", "e1")];
	assert.equal(resolveJumpMessageIndex(messages, "4d9ba94a-5b17-4ade-a43b-858cad9a07e9"), 0);
	assert.equal(resolveJumpMessageIndex(messages, "cd9540b6"), -1, "不在数据里必须如实返回 -1");
});

test("形状⑦：空输入/空目标不抛", () => {
	assert.equal(resolveJumpMessageIndex([], "e1"), -1);
	assert.equal(resolveJumpMessageIndex([proj("_viewer-history-e1")], ""), -1);
	assert.equal(resolveJumpMessageIndex([{ id: "" }], "e1"), -1);
});

test("⑧ 同一对 id：主进程判「页里有」与渲染层判「数据里有」必须同答", () => {
	// 这就是事故本身（2026-11-26）：主进程 pageHasTargetEntry=true，渲染层 resolveJumpMessageIndex=-1。
	// 两边各写一套判据时，这张表必然有一行两列不同；共用 shared/sameJumpEntry 后不可能不同。
	const { pageHasTargetEntry } = loadTsCommonJs("src/shared/sessionJumpAnchor.ts");
	const cases = [
		["_viewer-history-cd9540b6", "cd9540b6"],
		["agent-1-history-e1", "e1"],
		["_viewer-history-731cee61", "_viewer-history-731cee61"],
		["4d9ba94a-5b17-4ade-a43b-858cad9a07e9", "cd9540b6"],
		["b8f9702a-c4af-4526-a9fd-75f9a2cdcf10-history-118bbe10", "118bbe10"],
	];
	for (const [id, wanted] of cases) {
		const meta = id.includes("-history-") ? { entryId: id.slice(id.lastIndexOf("-history-") + 9) } : undefined;
		const page = [{ id, ...(meta ? { meta } : {}) }];
		const mainSays = pageHasTargetEntry(page, wanted);
		const rendererSays = resolveJumpMessageIndex(page, wanted) >= 0;
		assert.equal(rendererSays, mainSays, `两处判据不一致：${id} vs ${wanted}（主进程 ${mainSays} / 渲染层 ${rendererSays}）`);
	}
});

test("⑨ 去重键与判定键同源：同一条消息在页与窗口两侧给同一个键", () => {
	// 反例（2026-11-26 真机）：merge pageMessages=36 merged=138 visibleBefore=138 pageHasTarget=true
	// —— 页里 36 条一条都没新增，目标却仍认不出。去重键与判定键各算一套时就是这个形状。
	const shared = loadTsCommonJs("src/shared/sessionJumpAnchor.ts");
	const pageMessage = { id: "_viewer-history-cd9540b6", meta: { entryId: "cd9540b6" } };
	const windowMessage = { id: "agent-1-history-cd9540b6", meta: { entryId: "cd9540b6" } };
	assert.equal(shared.jumpEntryKey(pageMessage), shared.jumpEntryKey(windowMessage), "同一条消息两侧必须同键");
	assert.equal(shared.jumpEntryKey(pageMessage), "cd9540b6");
	// 判定也用这个键：同键 ⇒ 必定认得出（否则「合并去重了、目标却认不出」又回来了）。
	assert.equal(shared.sameJumpEntry(shared.jumpEntryKey(pageMessage), "cd9540b6"), true);
	// runtime UUID 没有 -history- 标记：键是它自己，不得与任何条目 id 相撞。
	assert.equal(shared.jumpEntryKey({ id: "4d9ba94a-5b17-4ade-a43b-858cad9a07e9" }), "4d9ba94a-5b17-4ade-a43b-858cad9a07e9");
});
