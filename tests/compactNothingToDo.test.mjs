import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * #113 3.2-7：compact nothing-to-do 友好文案链路。
 * 1) AgentManager 必须把 RPC success:false 抛出（不能只 warn）
 * 2) 渲染层优先读 debugDetails 映射 nothing-to-do / too-small
 * 3) /compact 与 chip 共用同一映射
 */

const agentManager = readFileSync("src/main/pi/AgentManager.ts", "utf8");
const composer = readFileSync("src/renderer/src/hooks/useSessionComposerController.ts", "utf8");
const mockPi = readFileSync("e2e/mock-pi.cjs", "utf8");

test("AgentManager.compact throws when RPC returns success:false", () => {
	// 失败路径：读 response.error 后 throw，而不是只记 warn 后当成功
	assert.match(agentManager, /if \(!response\.success\)/);
	assert.match(agentManager, /throw new Error\(rpcError\)/);
	// 不得再出现「只 warn 不抛」的旧注释语义
	assert.doesNotMatch(agentManager, /session might still be written[\s\S]{0,80}this\.compactingAgents\.delete\(agentId\);\s*\/\/ 压缩成功/);
});

test("composer maps compact errors via debugDetails-first friendly helper", () => {
	assert.match(composer, /function friendlyCompactError/);
	assert.match(composer, /debugDetails/);
	assert.match(composer, /classifyCompactError/);
	assert.match(composer, /app\.compactNothingToDo/);
	assert.match(composer, /app\.compactSessionTooSmall/);
	assert.match(composer, /app\.compactInProgress/);
	// 压缩被取消：不再静默。2026-08 的静默是「取消响应可能延迟到正常对话后返回，
	// 表现为没点压缩却弹提示」；现在主进程会判明来源（扩展接管 / 自己打断），
	// 文案本身就是「压缩已取消/被扩展接管」，延迟到达也不误导，且「点压缩没反应」
	// 这类真实故障才有出口（2026-09 billion-context 取消 pi 压缩的排查）。
	assert.doesNotMatch(composer, /case "silent":/);
	assert.match(composer, /app\.compactCancelledByOwner/);
	assert.match(composer, /app\.compactCancelled/);
	assert.match(composer, /if \(notice\) showNotice\(notice\.text, notice\.durationMs\)/);
	// 圆环按钮与 /compact 共用 runManualCompact：错误映射只出现一次
	assert.match(composer, /const notice = friendlyCompactError\(error\)/);
	assert.equal((composer.match(/friendlyCompactError\(error\)/g) || []).length, 1);
});

test("mock pi supports NOTHING compact failure path", () => {
	assert.match(mockPi, /function respondFail/);
	assert.match(mockPi, /NOTHING/);
	assert.match(mockPi, /nothing to compact/);
});

test("compaction_end 后主动检查 idle，避免状态卡在 running", () => {
	// pi 压缩结束不保证发 agent_settled：不主动检查会永远 stuck 在 running，
	// 渲染层表现：最后回复耗时继续走（LiveDuration）、加载动画常驻、
	// 思考/工具折叠保持展开（2026-08 用户反馈）。
	assert.match(agentManager, /typed\.type === "compaction_end"/);
	assert.match(agentManager, /markIdleIfPiReportsNoWork\(agentId\)[\s\S]{0,200}Compaction ended/);
	// idle 检查必须延迟到 pi 压缩收尾之后（文件写入/状态刷新）
	assert.match(agentManager, /setTimeout\(\(\) => \{\s*\n\s*void this\.markIdleIfPiReportsNoWork\(agentId\);\s*\n\s*\}, 300\)/);
});
