/**
 * Web SSE 断线恢复决策单测（第二批）：decideStreamRecovery 的守卫组合 ——
 * 页面不可见/离线/ready 态不恢复；error 态立即恢复并提示；防抖窗口内不重复。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { decideStreamRecovery, WEB_RECOVERY_DEBOUNCE_MS } = loadTsCommonJs("src/renderer/src/web/webStreamRecovery.ts");

const base = {
	status: "streaming",
	documentVisible: true,
	online: true,
	lastAttemptAt: 0,
	now: 100_000,
};

test("页面不可见时不恢复（回前台才算用户回来了）", () => {
	assert.equal(decideStreamRecovery({ ...base, documentVisible: false }).recover, false);
});

test("离线时不恢复（没有网络，拉磁盘窗口也必失败）", () => {
	assert.equal(decideStreamRecovery({ ...base, online: false }).recover, false);
});

test("ready 且无 error 时不恢复（正常态轮询自己会追平）", () => {
	assert.equal(decideStreamRecovery({ ...base, status: "ready" }).recover, false);
});

// 回归：刷新页面/端口中断后 useChat 已回 ready 但 pi 仍在跑（本轮 SSE 已死），
// 此时必须允许落盘追赶，否则页面永远停在旧文本（用户报障：刷新后文本不动）。
test("ready 但 runtime 忙（脱节态）允许静默追赶", () => {
	const decision = decideStreamRecovery({ ...base, status: "ready", runtimeBusy: true });
	assert.equal(decision.recover, true);
	assert.equal(decision.notify, false, "脱节追赶不打扰用户");
});

test("ready + runtime 忙也受防抖限制（不造成追赶风暴）", () => {
	assert.equal(decideStreamRecovery({ ...base, status: "ready", runtimeBusy: true, lastAttemptAt: base.now - 1000 }).recover, false);
	assert.equal(decideStreamRecovery({ ...base, status: "ready", runtimeBusy: true, lastAttemptAt: base.now - WEB_RECOVERY_DEBOUNCE_MS - 1 }).recover, true);
});

test("error 态立即恢复并提示用户", () => {
	const decision = decideStreamRecovery({ ...base, status: "error" });
	assert.equal(decision.recover, true);
	assert.equal(decision.notify, true);
});

test("submitted/streaming 回前台恢复但不打扰（静默补齐）", () => {
	const decision = decideStreamRecovery({ ...base, status: "streaming", documentVisible: true });
	assert.equal(decision.recover, true);
	assert.equal(decision.notify, false);
});

test(`防抖：${WEB_RECOVERY_DEBOUNCE_MS}ms 内不重复恢复`, () => {
	const again = decideStreamRecovery({ ...base, lastAttemptAt: base.now - 1000 });
	assert.equal(again.recover, false);
	const later = decideStreamRecovery({ ...base, lastAttemptAt: base.now - WEB_RECOVERY_DEBOUNCE_MS - 1 });
	assert.equal(later.recover, true);
});

// 回归（用户反馈「手机切后台再回来弹 Network 网络错误」）：断流错误不能常驻。
// 传输层断流只说明本端那条 SSE 断了，不代表这轮失败：磁盘追赶拿到权威内容后必须清掉，
// 外部流接管同一轮期间也不能同时挂红条。
test("回前台/断流恢复会清掉传输层错误条，且外部流接管期间不挂红条", () => {
	const source = readFileSync("src/renderer/src/web/WebChatApp.tsx", "utf8");
	// 磁盘追赶落地（setMessages(history)）之后必须紧跟 clearError：断流 ≠ 这轮失败
	assert.match(source, /setMessages\(history\)[\s\S]{0,400}?clearError\(\)/, "落地权威内容后必须清掉 Network error");
	assert.match(source, /const transportError = error && !externalStreaming && !liveMessage/, "外部流接管时抑制传输层错误条");
	// 回前台停掉已经不可能续上的 POST 流，交给外部流回放接管（只处理 streaming，避免丢掉未投递的 prompt）
	assert.match(source, /hiddenFor > 1000 && statusRef\.current === "streaming"/);
	assert.match(source, /void stop\(\)/);
});
