/**
 * 后端切换锁定规则（2026-10 用户反馈）：
 * 1. 锁定判据只能是「会话已有真实内容」（catalog 抬 active 或消息缓存里已出现用户消息），
 *    不能是「runtime 已绑定」——预热/认领出来的 pi 进程还没产生任何消息，按 runtime 锁会让
 *    「新建会话 → 切生图/生视频」永久锁死（连生视频模式都退不出来）；
 * 2. 未开始对话的会话换后端前必须停掉已绑定 runtime：主进程边界防御要求「无绑定 runtime」
 *    才接受 backend 变更，且没人用的预热进程必须回收（否则挂到会话被删）。
 * 源码正则契约（空白容忍），与 tests/acpBackendSwitch.test.mjs 同风格。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const controller = readFileSync("src/renderer/src/hooks/useSessionComposerController.ts", "utf8");

test("锁定判据 = 已有真实内容（active 或已出现用户消息），不再看 runtime 绑定", () => {
	assert.match(controller, /const hasUserMessage = \(messageCache\?\.messages \?\? \[\]\)\.some\(\(message\) => message\.role === "user"\)/, "必须用消息缓存里的用户消息兜住「已发送但尚未抬 active」的窗口");
	const lockedLine = controller.split("\n").find((line) => line.includes("const backendLocked ="));
	assert.ok(lockedLine, "必须有 backendLocked 定义");
	assert.match(lockedLine, /record\?\.status === "active" \|\| hasUserMessage/, "锁定判据只能是 active 或已有用户消息");
	// 旧判据不得回归：runtime 绑定即锁（预热进程会误锁）、imagegen/videogen 永久锁（生视频模式退不出来）
	assert.doesNotMatch(lockedLine, /runtime/, "锁定判据不得再看 runtime 绑定");
	assert.doesNotMatch(lockedLine, /imagegen|videogen/, "生图/生视频后端未发消息时也必须可切走");
});

test("changeBackend 在改 record 前回收未使用的 runtime", () => {
	const start = controller.indexOf("const changeBackend = useCallback");
	const end = controller.indexOf("const changeAcpTool");
	assert.ok(start >= 0 && end > start, "必须能定位 changeBackend");
	const change = controller.slice(start, end);
	assert.match(change, /const boundAgentId = runtime\?\.agentId;/, "必须取当前绑定的 agentId");
	const stop = change.indexOf("await desktopApi.system.stopAgent(boundAgentId)");
	const update = change.indexOf("desktopApi.sessions.updateRecord(sessionId,");
	assert.ok(stop >= 0, "切换前必须停掉已绑定 runtime（回收预热进程）");
	assert.ok(update > stop, "必须先停进程再改 record：主进程要求无绑定 runtime 才接受 backend 变更");
	// 停不掉不拦：交给主进程守卫给出明确报错
	assert.match(change, /await desktopApi\.system\.stopAgent\(boundAgentId\);\s*\n\s*\} catch \{/, "stopAgent 必须自带兜底，失败不阻断切换链");
	assert.match(change, /\[backendLocked, isGuideBootstrapSession, record, runtime\?\.agentId, sessionId, store, upsertSession\]/, "deps 必须带 runtime?.agentId");
});
