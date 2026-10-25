import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * ACP 首启失败回收（2026-10 用户反馈）：激活从未成功（仍 draft 且被 agent 拒收，
 * 如 session/new -32602 / spawn 失败）的 acp 会话没有任何可恢复内容——agent 侧
 * 会话未建、无消息——必须从历史列表删除并把回填草稿搬回引导页，不能留
 * 「xxx agent」空标题残留。
 */
const sendHook = readFileSync("src/renderer/src/hooks/useSessionSend.ts", "utf8");
const controller = readFileSync("src/renderer/src/hooks/useSessionComposerController.ts", "utf8");

test("useSessionSend: 拒收时对从未激活的 acp draft 会话触发回收", () => {
	// 只回收 backend=acp 且 status 仍 draft 的会话：active 会话（历史会话发送失败）
	// 有真实内容，必须保留供重试/查看
	assert.match(sendHook, /record\?\.backend === "acp" && record\.status === "draft"/);
	// 且必须 result 无 agentId（激活从未成功）。2026-10 回归：runtime 已激活、只是 prompt 被
	// agent 拒收（-32000 Authentication required）时也会走到这里，而 catalog 的 promoteToActive
	// 是 void 异步写、record 常仍停在 draft——漏掉 !result.agentId 会把唯一错误现场删掉并弹回引导页。
	assert.match(sendHook, /!staleRuntime && !result\.agentId && record\?\.backend === "acp" && record\.status === "draft"/);
	assert.match(sendHook, /options\.pruneFailedAcpDraft\?\.\(sessionId\)/);
	// 回收成功立即结算：后续 sendState 不再写给已删除的会话
	assert.match(sendHook, /if \(pruned\) \{\s*\n\s*sendingSessionIdsRef\.current\.delete\(sourceSessionId\);\s*\n\s*return;/);
});

test("controller: 回调先搬草稿回引导页再删会话（反序丢输入）", () => {
	assert.match(controller, /pruneFailedAcpDraft: async \(failedSessionId\)/);
	// 判定与 useSessionSend 同源：非 acp / 已激活的会话不删
	assert.match(controller, /failed\.backend !== "acp" || failed\.status !== "draft"/);
	// 顺序：promote（搬 restoreRejectedPrompt 回填的草稿）→ deleteRecord → removeSessionState
	const promote = controller.indexOf("store.set(promoteSessionComposerStateAtom, { fromSessionId: failedSessionId, toSessionId: GUIDE_BOOTSTRAP_SESSION_ID })");
	const del = controller.indexOf("desktopApi.sessions.deleteRecord(failedSessionId)");
	const remove = controller.indexOf("store.set(removeSessionStateAtom, failedSessionId)");
	assert.ok(promote >= 0 && del > promote && remove > del, "回收顺序必须是 promote → deleteRecord → removeSessionState");
	// 删的是当前会话时必须把选中清空回引导页：`undefined` 是「没有当前会话」的唯一表达，
	// 写 GUIDE_BOOTSTRAP_SESSION_ID 会让 App 给一个没有 catalog 记录的虚拟会话挂真实会话面板，
	// 面板里 session=undefined → 渲染「开始新的 Session」空态（2026‑10 用户反馈：acp 首启失败后
	// 「跳到了这个页面」，回填的草稿也看不见）。
	assert.match(controller, /if\s*\(store\.get\(currentSessionIdAtom\)\s*===\s*failedSessionId\)\s*\{\s*\n\s*store\.set\(currentSessionIdAtom,\s*undefined\);/, "删当前会话必须清空选中，landing 在真正的引导页");
	assert.doesNotMatch(controller, /store\.set\(currentSessionIdAtom,\s*GUIDE_BOOTSTRAP_SESSION_ID\)/, "currentSessionId 不得指向引导页虚拟会话（无 record，会渲染空态面板）");
});
