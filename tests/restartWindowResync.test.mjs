import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sessionIpc = readFileSync("src/main/ipc/sessionIpc.ts", "utf8");
const mainIndex = readFileSync("src/main/index.ts", "utf8");
const hook = readFileSync("src/renderer/src/hooks/useSessionHistoryMutations.ts", "utf8");
const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");

/**
 * 2026-09 用户反馈：开启代理 → 重启会话 → 重发报「消息未找到」。
 * 根因有二：新 runtime 的首次消息 flush 发生在绑定提交之前，
 * emitSessionRuntimeEvent 的 getRuntimeBinding 会把它静默丢弃；且重启只补状态不补窗口，
 * 渲染层一直保留旧 runtime 窗口里的 live 身份（无 entryId），catalog 改写定位失败。
 */
test("edit 的 fork 分支必须与 resend 对称：finally 清 mutation overlay（否则遮罩永久卡死）", () => {
	// 2027-03 排查：runForkMutation 内部 showOverlay(activating/editing/resending) 后有多个
	// 早退路径（activateRuntime 失败 / entryId 缺失 / result.cancelled / 成功切会话），
	// resend 调用方有 finally hideOverlay 兑底，edit 分支缺失 → 全遮罩 overlay 永久挂死。
	// [^}]* 容忍块内注释，避免注释文字变动破坏契约。
	assert.match(hook, /runForkMutation\("edit",\s*message,\s*newText\);?\s*\}\s*catch\s*\(error\)\s*\{[^}]*failToast\(t\("message\.editFailed"\),\s*error\);\s*\}\s*finally\s*\{[^}]*hideOverlay\(sessionId\)/, "editMessage 的 fork-mutation 回调必须 try/catch/finally，finally 里 hideOverlay(sessionId)");
});

test("restart 成功路径必须重下发消息窗口（桌面 IPC 与 web 服务路径一致）", () => {
	// 窗口 id 稳定性由 loadMessages 的会话级身份延续保证（stabilizeProjectedIdsFromIdentities），
	// 重下发不会触发整窗 remount/动画重放；这里只断言两个入口都把窗口带上。
	for (const [file, source] of [
		["src/main/ipc/sessionIpc.ts", sessionIpc],
		["src/main/index.ts", mainIndex],
	]) {
		const index = source.indexOf("emitReplacementState(result.value.runtime,");
		assert.ok(index >= 0, `${file} 的 restart 处理器必须重下发 runtime 状态`);
		assert.match(source.slice(index, index + 64), /emitReplacementState\(result\.value\.runtime, true\)/, `${file} 的 restart 处理器必须带消息窗口重下发`);
	}
});

test("重发/编辑/删除确认文案按 busy 状态区分，zh/en 都提供 idle 变体", () => {
	for (const key of ["historyStopToEditBodyIdle", "historyStopToDeleteBodyIdle", "historyStopToResendBodyIdle"]) {
		assert.match(zh, new RegExp(`"message\\.${key}"`), `zh-CN 缺少 ${key}`);
		assert.match(en, new RegExp(`"message\\.${key}"`), `en-US 缺少 ${key}`);
	}
	// hook 必须按 isAgentCurrentlyBusy（≈running）切文案：idle（含刚重启完）不再谎报「会话正在运行」
	assert.match(hook, /t\("message\.historyStopToEditBodyIdle"\)/);
	assert.match(hook, /t\("message\.historyStopToDeleteBodyIdle"\)/);
	assert.match(hook, /t\("message\.historyStopToResendBodyIdle"\)/);
	assert.match(hook, /isAgentCurrentlyBusy\(\)\s*\n?\s*\? t\("message\.historyStopToEditBody"\)/);
});
