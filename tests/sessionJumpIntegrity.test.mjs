import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
const shared = loadTsCommonJs("src/shared/sessionJumpAnchor.ts");
const target = loadTsCommonJs("src/renderer/src/components/session/timeline/jumpTarget.ts");
const turns = loadTsCommonJs("src/renderer/src/components/session/timeline/turnRenderWindow.ts");
const m = (id, role = "assistant", text = id) => ({ id: "viewer-history-" + id, agentId: "a", role, text, timestamp: 1, meta: { entryId: id } });

test("搜索投影ID与裸ID必须选中同一锚点，不能默默选页尾", () => {
	const page = [m("first"), m("wanted"), m("last")];
	assert.equal(target.pickJumpAnchorEntryId(page, "other-agent-history-wanted"), "wanted");
});
test("深层工具与思考成员、不同投影前缀共用同一轮定位", () => {
	const rows = [{ kind: "agent-run", id: "run", items: [{ kind: "tool-group", id: "group", messages: [m("one"), m("wanted")] }] }];
	assert.equal(turns.findAgentRunIndexByItemId(rows, "old-agent-history-wanted"), 0);
	assert.equal(turns.findAgentRunIndexByItemId(rows, "absent"), -1);
});
test("跳转右边界保留整轮而不是24条：长工具回合的最终回复必须在页里", () => {
	const { resolveJumpPageBefore } = loadTsCommonJs("src/main/pi/sessionReader/sessionTurnWindow.ts");
	const entries = [{ role: "user", byteLength: 1 }, ...Array.from({ length: 80 }, () => ({ role: "assistant", byteLength: 1 })), { role: "user", byteLength: 1 }, { role: "assistant", byteLength: 1 }, { role: "user", byteLength: 1 }];
	assert.equal(resolveJumpPageBefore(entries, 0, 0), 81);
	assert.equal(resolveJumpPageBefore(entries, 30, 0), 81);
	assert.equal(resolveJumpPageBefore(entries, 0, 1), 83);
	assert.equal(resolveJumpPageBefore(entries, 83, 2), 84);
});
test("连续user与系统卡不被当成多个回合，最后三条不越界", () => {
	const { resolveJumpPageBefore } = loadTsCommonJs("src/main/pi/sessionReader/sessionTurnWindow.ts");
	const entries = ["user", "system", "user", "assistant", "toolResult", "user", "assistant"].map((role) => ({ role, byteLength: 1 }));
	assert.equal(resolveJumpPageBefore(entries, 0, 0), 5);
	for (const i of [4, 5, 6]) assert.ok(resolveJumpPageBefore(entries, i, 2) > i);
});
test("读盘等待期间有新输出：提交跳转页不得降级runtime来源或丢失最新回复", () => {
	const { mergeJumpPageWithCurrent } = loadTsCommonJs("src/renderer/src/atoms/session-jump-page-atoms.ts");
	const live = [m("recent-user", "user"), m("live-answer", "assistant", "运行时刚到的完整回复")];
	const current = { source: "runtime", revision: 12, updatedAt: 1, messages: live, windowStart: 300, cardCount: 2, windowStartFilePos: 500, history: { messages: [m("already")], nextBefore: 20, version: "1:100" } };
	const page = { messages: [m("wanted", "user"), m("answer")], total: 600, nextBefore: 10, indexVersion: "1:100" };
	const result = mergeJumpPageWithCurrent(current, page);
	assert.equal(result.source, "runtime");
	assert.equal(result.messages, live);
	for (const key of ["revision", "windowStart", "cardCount", "windowStartFilePos"]) assert.equal(result[key], current[key]);
	assert.ok(result.history.messages.some((x) => shared.jumpEntryKey(x) === "wanted"));
	assert.ok(result.history.messages.some((x) => shared.jumpEntryKey(x) === "already"));
	assert.equal(current.history.messages.length, 1, "原缓存不可原地改写");
});
test("跳转页与runtime尾部重叠时不得重复、不得以旧正文覆盖流式正文", () => {
	const { mergeJumpPageWithCurrent } = loadTsCommonJs("src/renderer/src/atoms/session-jump-page-atoms.ts");
	const live = m("live", "assistant", "不断增长的新正文");
	const current = { source: "runtime", revision: 8, updatedAt: 1, messages: [live] };
	const result = mergeJumpPageWithCurrent(current, { messages: [m("wanted", "user"), m("live", "assistant", "旧")], total: 20, nextBefore: null, indexVersion: "1:100" });
	assert.equal(result.messages[0], live);
	assert.equal(result.history.messages.filter((x) => shared.jumpEntryKey(x) === "live").length, 0);
});
test("缓存已被清除时迟到跳转不能复活它，文件缩短时拒绝旧页", () => {
	const { mergeJumpPageWithCurrent } = loadTsCommonJs("src/renderer/src/atoms/session-jump-page-atoms.ts");
	const page = { messages: [m("old")], total: 20, nextBefore: null, indexVersion: "1:100" };
	assert.equal(mergeJumpPageWithCurrent(undefined, page), undefined);
	const current = { source: "runtime", revision: 8, updatedAt: 1, messages: [m("live")], history: { messages: [], version: "2:50", nextBefore: null } };
	assert.equal(mergeJumpPageWithCurrent(current, page, "1:100"), undefined, "请求时的文件代际已被改写，不得混入旧正文");
});
test("历史超预算且目标页落在最旧处时，预算不得把它裁掉", () => {
	const { mergeJumpPageWithCurrent } = loadTsCommonJs("src/renderer/src/atoms/session-jump-page-atoms.ts");
	// 目标页与已有历史在**最前**处重叠：合并后目标排在头部，正是预算动手的位置。
	const wanted = m("old0", "user");
	const huge = Array.from({ length: 9000 }, (_, i) => m("old" + i));
	const current = { source: "runtime", revision: 3, updatedAt: 1, messages: [m("live")], history: { messages: huge, nextBefore: null, version: "1:100" } };
	const result = mergeJumpPageWithCurrent(current, { messages: [wanted, m("answer")], total: 20000, nextBefore: null, indexVersion: "1:100" });
	assert.ok(
		result.history.messages.some((x) => shared.jumpEntryKey(x) === "old0"),
		"目标页在头部也必须留下，否则「跳过去了看不到」",
	);
	assert.ok(result.history.messages.length <= 8000, "预算仍然生效");
});

test("事务读的是最新缓存：迟到取页不能把 runtime 降级成 disk", async () => {
	const { createStore } = await import("jotai/vanilla");
	const atoms = loadTsCommonJs("src/renderer/src/atoms/session-jump-page-atoms.ts");

	const store = createStore();
	const live = m("live", "assistant", "运行时刚到的正文");
	store.set(atoms.sessionMessagesCacheAtom, { s: { source: "runtime", revision: 9, updatedAt: 1, messages: [live], windowStart: 300, history: { messages: [], nextBefore: null, version: "1:100" } } });
	store.set(atoms.mergeSessionJumpPageAtom, { sessionId: "s", page: { messages: [m("wanted", "user")], total: 40, nextBefore: null, indexVersion: "1:100" } });
	const entry = store.get(atoms.sessionMessagesCacheAtom).s;
	assert.equal(entry.source, "runtime", "流式会话不能被跳转读盘改成 disk");
	assert.equal(entry.messages[0], live, "实时窗口那条必须原样保留");
	assert.equal(entry.history.messages.length, 1, JSON.stringify({ keys: entry.history.messages.map((x) => shared.jumpEntryKey(x)), source: entry.source }));
});

test("两次跳转页互不重叠：按文件索引排序，逆向点击不能把早期消息追加到尾部", () => {
	const { mergeJumpPageWithCurrent } = loadTsCommonJs("src/renderer/src/atoms/session-jump-page-atoms.ts");
	const current = { source: "runtime", revision: 1, messages: [m("live")], history: { messages: [m("u5", "user"), m("a5")], nextBefore: 10, version: "1:100" } };
	const page = { messages: [m("u1", "user"), m("a1")], entryOrder: ["u1", "a1", "u5", "a5", "live"], nextBefore: null, total: 20, indexVersion: "1:100" };
	const next = mergeJumpPageWithCurrent(current, page);
	assert.equal(next.history.messages.map(shared.jumpEntryKey).join(","), "u1,a1,u5,a5");
	assert.equal(next.messages[0], current.messages[0]);
});

test("同一文件条目有无meta都必须去重，不能显示两份相同卡片", () => {
	const { mergeInterleavedHistory } = loadTsCommonJs("src/renderer/src/components/session/timeline/mergeHistoryWindow.ts");
	const disk = m("same");
	const projected = { ...disk, id: "other-agent-history-same", meta: undefined };
	const result = mergeInterleavedHistory([disk], [projected]);
	assert.equal(result.length, 1);
});

test("请求后文件缩短但缓存尚未刷新：不得把新分支页混入旧缓存", () => {
	const { mergeJumpPageWithCurrent } = loadTsCommonJs("src/renderer/src/atoms/session-jump-page-atoms.ts");
	const current = { source: "disk", revision: 1, messages: [m("old")], page: { nextBefore: 10, total: 30, indexVersion: "1:100" } };
	const page = { messages: [m("new")], nextBefore: null, total: 10, indexVersion: "2:50" };
	assert.equal(mergeJumpPageWithCurrent(current, page, "1:100"), undefined);
});
