import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * #303：手动压缩等待超时的三层修复。
 * 1) 等待上限吃 rpcTimeout 设置（写死 120s 时：rpcTimeout 调大无效，且大上下文
 *    压缩轻松超 2 分钟——真实案例 120s 报「压缩失败」、149.4s 后台实际成功）。
 * 2) 超时≠失败：主进程抛 COMPACT_WAIT_TIMEOUT 稳定标记，渲染层映射「仍在后台
 *    进行」；isCompacting 保持 true 直到 compaction_end 事件收尾（防重复触发）。
 * 3) 迟到的成功有结局：compaction_end(result=true) 且超时标记在场时补发
 *    compactDoneAfterTimeout 系统消息（RPC 已 reject，正常 toast 链不会再走）。
 */

const { COMPACT_WAIT_TIMEOUT, classifyCompactError } = loadTsCommonJs("src/shared/compactFeedback.ts");
const agentManager = readFileSync("src/main/pi/AgentManager.ts", "utf8");
const composer = readFileSync("src/renderer/src/hooks/useSessionComposerController.ts", "utf8");
const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");
const mainCopy = readFileSync("src/shared/i18n/mainProcessCopy.ts", "utf8");

test("classifyCompactError: COMPACT_WAIT_TIMEOUT 标记归 timeout 而非 failed", () => {
	assert.equal(classifyCompactError(COMPACT_WAIT_TIMEOUT), "timeout");
	// 标记前后拼噪声（IPC 包装/其他文案）也不能归错类
	assert.equal(classifyCompactError(`Error invoking remote method: ${COMPACT_WAIT_TIMEOUT}`), "timeout");
});

test("classifyCompactError: pi 超时原文不经主进程标记时仍是 failed（主进程负责打标记）", () => {
	// 契约：渲染层只认主进程的稳定标记，不猜 pi 原文——超时文本里的 ms 值随配置变，
	// 靠正则匹配原文会让 600s/900s 等不同配置各自为政。主进程必须在 catch 里转换。
	assert.equal(classifyCompactError("RPC command timed out after 600000ms: compact"), "failed");
});

test("AgentManager.compact: 等待上限吃 rpcTimeout 设置，不再写死 120s", () => {
	assert.match(agentManager, /createCompactRpcRequest\(trimmedPrompt\),\s*this\.rpcTimeoutMs\)/);
	// compact 的请求行不得再出现写死的 120_000（其他 export/fork 等命令不在此约束内）
	const compactBlock = agentManager.slice(agentManager.indexOf("async compact(agentId"), agentManager.indexOf("private resolveCompactCancelMessage"));
	assert.doesNotMatch(compactBlock, /request\([^)]*,\s*120_000\)/);
});

test("AgentManager.compact: 超时分支保留 compactingAgents 并抛稳定标记", () => {
	// 超时识别：进程活着 + RPC 超时原文
	assert.match(agentManager, /const waitTimedOut = processAlive && \/RPC command timed out \[\^:\]\*: compact\/\.test\(errorMsg\)/);
	// 超时分支：add 超时标记集合 + 抛 COMPACT_WAIT_TIMEOUT，中间不得 delete compactingAgents
	const timeoutBranch = agentManager.slice(agentManager.indexOf("} else if (waitTimedOut) {"), agentManager.indexOf("} else if (cancelSource) {"));
	assert.ok(timeoutBranch.length > 0, "超时分支必须存在且排在 cancelSource 分支之前");
	assert.match(timeoutBranch, /this\.compactTimedOutAgents\.add\(agentId\)/);
	assert.match(timeoutBranch, /throw new Error\(COMPACT_WAIT_TIMEOUT\)/);
	assert.doesNotMatch(timeoutBranch, /this\.compactingAgents\.delete\(agentId\)/);
	// 非超时路径（reattach/cancel/普通错误）仍要清 compactingAgents：catch 统一 delete
	// 已移入 else（waitTimedOut=false）块，失败时不能漏清卡死按钮
	const catchBlock = agentManager.slice(agentManager.indexOf('void this.appLogger?.error("agent", "Compact failed"'), agentManager.indexOf("} else if (waitTimedOut) {"));
	assert.match(catchBlock, /this\.compactingAgents\.delete\(agentId\)/);
});

test("AgentManager: compaction_end 统一收尾 compactingAgents（含超时挂起）并补发超时结局", () => {
	const endBlock = agentManager.slice(agentManager.indexOf('typed.type === "compaction_end"'), agentManager.indexOf('void this.appLogger?.info("agent", "Compaction ended"'));
	// 超时挂起的 isCompacting 在事件到达时收尾
	assert.match(endBlock, /this\.compactingAgents\.delete\(agentId\)/);
	// 后台最终成功 + 曾超时 → 补发 compactDoneAfterTimeout（RPC 已 reject，toast 链不会再走）
	assert.match(endBlock, /const compactTimedOut = this\.compactTimedOutAgents\.delete\(agentId\)/);
	assert.match(endBlock, /typed\.result === true && compactTimedOut && runtime/);
	assert.match(endBlock, /diagnostic\.compactDoneAfterTimeout/);
});

test("compactTimedOutAgents 集合声明（与 compactingAgents 同域）", () => {
	assert.match(agentManager, /private readonly compactTimedOutAgents = new Set<string>\(\)/);
});

test("composer: timeout kind 映射 compactWaitTimeout 且长停留", () => {
	assert.match(composer, /case "timeout":/);
	assert.match(composer, /app\.compactWaitTimeout/);
	// 用户需要看清「没失败、稍后有结局」：与接管/取消同级 10s
	const durationLine = composer.match(/const durationMs = [^\n]+/)?.[0] ?? "";
	assert.match(durationLine, /kind === "timeout" \? 10_?000/);
});

test("i18n: app.compactWaitTimeout 与 diagnostic.compactDoneAfterTimeout 中英同步", () => {
	assert.match(zh, /"app\.compactWaitTimeout":\s*"等待超时，压缩仍在后台进行[^"]*"/);
	assert.match(en, /"app\.compactWaitTimeout":\s*"Wait timed out[^"]*"/);
	assert.match(mainCopy, /"diagnostic\.compactDoneAfterTimeout":\s*"后台压缩完成[^"]*"/);
	assert.match(mainCopy, /"diagnostic\.compactDoneAfterTimeout":\s*"Background compaction finished[^"]*"/);
});
