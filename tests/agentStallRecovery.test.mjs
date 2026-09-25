import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 回归护栏：「工具返回后卡住 / 会话永久 running」在 PiDeck 侧的两条成因。
 *
 * 用户报的现象是「自己规划了几步任务，1、2 完成后卡住，需要停止一下再让它继续」。
 * 关键线索是 workaround 本身：abort → cancelPendingUIRequests 会给 pi 发
 * extension_ui_response { value: null }，把 pi 从「等一个 UI 回答」里拽出来。
 * 也就是说卡住时 pi 正阻塞在等 PiDeck 回包，而不是「忘了发下一次模型请求」。
 *
 * 这两处修复都依赖 pi 的协议事实，无法用行为测试覆盖（需要真 pi 进程），
 * 因此按仓库既有惯例用空白容忍的源码契约锁定关键修复点。
 */
const agentManager = readFileSync("src/main/pi/AgentManager.ts", "utf8");

test("扩展 UI 请求没有显式 timeout 时必须有兜底上限，否则 pi 永久阻塞", () => {
	// pi 侧没有任何默认超时：createDialogPromise 只把 opts.timeout 原样透传（扩展不传即 undefined），
	// editor 更是从不带 timeout 字段，而 pending 请求只在收到 extension_ui_response 时才 settle。
	// PiDeck 自有的 ask-question / security-gate / plan-mode / request-size-recovery 四个扩展都没传 timeout。
	assert.match(agentManager, /DEFAULT_UI_REQUEST_TIMEOUT_MS\s*=\s*30\s*\*\s*60\s*\*\s*1000/);
	// 扩展显式指定的 timeout 仍然优先，缺失时退回兜底值
	assert.match(agentManager, /effectiveTimeout\s*=\s*explicitTimeout\s*\?\?\s*AgentManager\.DEFAULT_UI_REQUEST_TIMEOUT_MS/);
	// 旧实现「timeout 非法就直接 return」= 没有 timeout 就永不武装定时器，必须已移除
	assert.doesNotMatch(agentManager, /typeof timeout !== "number"/);
	// 超时取消必须留痕，便于下次复现定位（此前只有「用户点停止」这一条出口，静默不可观测）
	assert.match(agentManager, /Extension UI request timed out; cancelling to unblock pi/);
});

test("兜底判空闲不得被本地 toolExecutingByAgent 否决", () => {
	// pi 的 isStreaming 就是 `_isAgentRunActive`（工具执行期间为 true），
	// 因此 get_state 已经覆盖「工具还在跑」；本地标志一旦因丢事件卡在 true，
	// 用它否决会让 markIdleIfPiReportsNoWork 永远提前返回 → 会话永久 running。
	const idleFn = agentManager.slice(agentManager.indexOf("private async markIdleIfPiReportsNoWork"));
	assert.ok(idleFn.length > 0, "markIdleIfPiReportsNoWork 必须存在");
	assert.doesNotMatch(idleFn, /if\s*\(\s*this\.toolExecutingByAgent\.get\(agentId\)\s*\)\s*return;/);
	assert.match(idleFn, /staleToolFlag/);
	// 恢复时必须清掉过期工具状态，否则底栏会一直显示一个早已结束的工具名
	assert.match(idleFn, /applyActiveToolCallState\s*\(/);
	assert.match(agentManager, /Recovered idle while local tool flag was still set/);
});

test("tool_execution_end 缺 toolCallId 时把 toolName 交给归并逻辑", () => {
	// start 缺 id 用 `${toolName}-${timestamp}` 兜底 key，end 缺 id 只有空串；
	// 不把 toolName 传下去就永远删不掉该 key（行为细节见 tests/toolRuntimeState.test.mjs）。
	assert.match(agentManager, /type:\s*"end",[\s\S]{0,400}?toolCallId:\s*String\(typed\.toolCallId \?\? ""\),[\s\S]{0,400}?toolName:\s*endedToolName \|\| undefined/);
});
