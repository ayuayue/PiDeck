import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 回归护栏（issue #302）：restart 必须把 catalog 会话身份（deckSessionId）带进新进程。
 *
 * 故障链：restart() → create() 丢 deckSessionId → PiProcess 不注入 PIDECK_SESSION_ID
 * → pi-deck-security-gate 扩展查不到以 catalog 会话 ID 存储的 sessionOverrides
 * → 安全等级回退全局默认（弹确认），而菜单仍按 SecurityStore 显示会话覆盖值——两头查键不一致。
 * reattachProcess（compact 自动重连/崩溃自动重启）复用原 tab，路径正确，此处一并锁定。
 */
test("restart carries deckSessionId so per-session security level survives restart", () => {
	const agentManager = readFileSync("src/main/pi/AgentManager.ts", "utf8");

	// 1) restart 方法块内解构必须带 deckSessionId
	const restartBlock = agentManager.match(/\tasync restart\(agentId: string\)[^\{]*\{[\s\S]*?\n\t\}/)?.[0] ?? "";
	assert.ok(restartBlock.length > 0, "找不到 restart() 方法块");
	assert.match(restartBlock, /const \{[^}]*\bdeckSessionId\b[^}]*\} = runtime\.tab/);

	// 2) 传给 create 的参数必须包含 deckSessionId
	const createCall = restartBlock.match(/return this\.create\(\{[\s\S]*?\n\t\t\}\);/)?.[0] ?? "";
	assert.ok(createCall.length > 0, "找不到 restart 内的 create 调用");
	assert.match(createCall, /\bdeckSessionId\b/);

	// 3) 锁定相邻路径：reattachProcess 按原 tab 重连，必须显式带 deckSessionId
	assert.match(agentManager, /deckSessionId: runtime\.tab\.deckSessionId/);
});
