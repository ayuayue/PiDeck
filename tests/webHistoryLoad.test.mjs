import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { shouldActivateAcpHistory, shouldApplyHistorySnapshot, isStaleAgainstLiveStream, decideHistorySnapshotApplication } = loadTsCommonJs("src/renderer/src/web/webHistoryLoad.ts");

test("ACP 冷会话需要后台激活以恢复 agent 侧历史", () => {
	assert.equal(shouldActivateAcpHistory({ backend: "acp", hasRuntime: false, attempted: false }), true);
	assert.equal(shouldActivateAcpHistory({ backend: "acp", hasRuntime: true, attempted: false }), false, "已有 runtime 时由 session/load 自己重放");
	assert.equal(shouldActivateAcpHistory({ backend: "acp", hasRuntime: false, attempted: true }), false, "同一页面生命周期只尝试一次，轮询不得反复拉起 CLI");
	assert.equal(shouldActivateAcpHistory({ backend: "pi", hasRuntime: false, attempted: false }), false, "pi 历史在本地文件，不需要激活");
	assert.equal(shouldActivateAcpHistory({ backend: "dsh", hasRuntime: false, attempted: false }), false);
});

test("非 ACP 会话的空结果就是权威空历史", () => {
	assert.equal(shouldApplyHistorySnapshot({ backend: "pi", nextCount: 0, previousCount: 3, acpRuntimePending: false }), true);
	assert.equal(shouldApplyHistorySnapshot({ backend: "dsh", nextCount: 0, previousCount: 3, acpRuntimePending: false }), true);
	assert.equal(shouldApplyHistorySnapshot({ backend: undefined, nextCount: 0, previousCount: 0, acpRuntimePending: false }), true);
});

test("ACP runtime 未就绪时的空结果不得覆盖缓存或结束加载态", () => {
	// 冷会话首次打开：没有缓存也要继续 loading，等激活完成后重拉。
	assert.equal(shouldApplyHistorySnapshot({ backend: "acp", nextCount: 0, previousCount: 0, acpRuntimePending: true }), false);
	// 已有缓存：更不能用空结果抹掉。
	assert.equal(shouldApplyHistorySnapshot({ backend: "acp", nextCount: 0, previousCount: 5, acpRuntimePending: true }), false);
});

test("ACP 已有内容时瞬时空结果保留缓存（切会话/重开页面空白页的根因）", () => {
	assert.equal(shouldApplyHistorySnapshot({ backend: "acp", nextCount: 0, previousCount: 5, acpRuntimePending: false }), false);
	assert.equal(shouldApplyHistorySnapshot({ backend: "acp", nextCount: 0, previousCount: 0, acpRuntimePending: false }), true, "真正没有历史的 ACP 会话仍要落到空态");
	assert.equal(shouldApplyHistorySnapshot({ backend: "acp", nextCount: 2, previousCount: 5, acpRuntimePending: false }), true, "非空结果正常应用");
});

// 回归（用户报障：发消息后最新一条回复消失、过一会才又出现）：
// pi 落盘滞后于在途帧，本端 SSE 还在收帧时拉到的磁盘窗口可能比本地还短，
// 这种「落后快照」不得覆盖时间线，否则正在出的回复会被整段抹掉。
test("本端流还活着时，比本地短的磁盘快照不可用来覆盖", () => {
	assert.equal(isStaleAgainstLiveStream({ localStreamLive: true, nextCount: 3, previousCount: 5 }), true);
	assert.equal(isStaleAgainstLiveStream({ localStreamLive: true, nextCount: 5, previousCount: 5 }), false, "同长说明磁盘已追平");
	assert.equal(isStaleAgainstLiveStream({ localStreamLive: true, nextCount: 7, previousCount: 5 }), false, "磁盘更长说明本轮本地流已死，落盘追赶要生效");
	assert.equal(isStaleAgainstLiveStream({ localStreamLive: false, nextCount: 3, previousCount: 5 }), false, "本地流已结束时磁盘才是权威");
});

/* ── 历史快照落地护栏：异步快照不得回退本地更新的时间线 ── */

const msg = (id) => ({ id });

test("发送前取回的旧窗口（比本地短、且本地有快照外的消息）不得覆盖时间线", () => {
	// 本地：历史两条 + 本轮乐观用户消息 + 流式回复
	const localMessages = [msg("h1"), msg("h2"), msg("msg_live_user"), msg("msg_live_assistant")];
	const incomingMessages = [msg("h1"), msg("h2")];
	assert.equal(decideHistorySnapshotApplication({ localMessages, incomingMessages, localStreamLive: false, requestStartedWhileStreaming: false, hasOlderPagesLoaded: false, authoritative: false }), "skip");
});

test("落盘追平（同长或更长）时照常应用，完成乐观消息到历史 id 的归一", () => {
	const incomingMessages = [msg("h1"), msg("h2"), msg("h3"), msg("h4")];
	// 本地同样的四轮，但本轮用的是乐观/流式 id：快照更长 → 应用（收敛到磁盘真相）
	assert.equal(decideHistorySnapshotApplication({ localMessages: [msg("h1"), msg("h2"), msg("msg_u2"), msg("msg_a2")], incomingMessages, localStreamLive: false, requestStartedWhileStreaming: false, hasOlderPagesLoaded: false, authoritative: false }), "apply");
	// 同长也允许（内容以磁盘为准）
	assert.equal(decideHistorySnapshotApplication({ localMessages: incomingMessages, incomingMessages, localStreamLive: false, requestStartedWhileStreaming: false, hasOlderPagesLoaded: false, authoritative: false }), "apply");
});

test("本端流还活着时，比本地短的历史快照一律不落地", () => {
	assert.equal(decideHistorySnapshotApplication({ localMessages: [msg("a"), msg("b")], incomingMessages: [msg("a")], localStreamLive: true, requestStartedWhileStreaming: false, hasOlderPagesLoaded: false, authoritative: false }), "skip");
});

test("已向前翻过更早分页时，最新窗口不得覆盖（否则旧页与滚动位置丢失）", () => {
	assert.equal(decideHistorySnapshotApplication({ localMessages: [msg("old1"), msg("h1"), msg("h2")], incomingMessages: [msg("h1"), msg("h2")], localStreamLive: false, requestStartedWhileStreaming: false, hasOlderPagesLoaded: true, authoritative: false }), "skip");
});

test("显式重载 / ACP 权威重拉跳过护栏：内容确实变了就以磁盘为准", () => {
	const localMessages = [msg("h1"), msg("h2"), msg("msg_live")];
	const incomingMessages = [msg("h1")];
	assert.equal(decideHistorySnapshotApplication({ localMessages, incomingMessages, localStreamLive: false, requestStartedWhileStreaming: false, hasOlderPagesLoaded: true, authoritative: true }), "apply");
});

test("短快照但本地消息全在快照里（同窗口的裁剪）仍可应用", () => {
	// 反向保护：不要为了“短”而永远拒绝——本地没有快照外的消息时，短快照是同窗口的权威视图。
	assert.equal(decideHistorySnapshotApplication({ localMessages: [msg("h1")], incomingMessages: [msg("h1"), msg("h2")], localStreamLive: false, requestStartedWhileStreaming: false, hasOlderPagesLoaded: false, authoritative: false }), "apply");
});

test("流式期间发起的快照一律不落地：多工具回合里它可能比本地条数更多，却仍缺最终回复", () => {
	// 本地：用户消息 + 带工具片的回复（1 条 UI 消息）；流式中取回的磁盘窗口有 user + 2 条 tool
	assert.equal(
		decideHistorySnapshotApplication({
			localMessages: [msg("msg_u"), msg("msg_a")],
			incomingMessages: [msg("h_u"), msg("h_tool1"), msg("h_tool2")],
			localStreamLive: true,
			requestStartedWhileStreaming: true,
			hasOlderPagesLoaded: false,
			authoritative: false,
		}),
		"skip",
		"条数护栏拦不住工具行，必须按「请求发起时刻」拦截",
	);
});
