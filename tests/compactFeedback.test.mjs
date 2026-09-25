import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 手动压缩统一策略：可用态、按钮态、错误分类。
 * 圆环按钮 / /compact / 主进程重复压缩共用同一套规则。
 */

const { COMPACT_CANCELLED_BY_OWNER, COMPACT_CANCELLED_BY_USER_ABORT, COMPACT_HOOK_REJECT_MAX_MS, COMPACT_OBSERVATION_MAX_AGE_MS, COMPACT_ROUTED_TO_OWNER, COMPACT_USER_ABORT_WINDOW_MS, compactOwnerReason, compactRoutedCommand, compactUiState, resolveCompactUsagePercent, classifyCompactError } =
	loadTsCommonJs("src/shared/compactFeedback.ts");

test("compactUiState is ready whenever usage data exists, regardless of occupancy", () => {
	// loadTsCommonJs 在 vm 里跑，对象原型跨 realm，不能 deepEqual 整个对象
	const fields = (percent, compacting) => {
		const state = compactUiState(percent, compacting);
		return `${state.ready}:${state.compacting}:${state.urgency}`;
	};
	// 无占用数据（会话未运行/尚未上报）：未就绪，禁用
	assert.equal(fields(undefined, false), "false:false:idle");
	assert.equal(fields(null, false), "false:false:idle");
	// 数据可用即随时可压缩（不再有 30% 门槛），0% 占用也可点
	assert.equal(fields(0, false), "true:false:idle");
	assert.equal(fields(12, false), "true:false:idle");
	assert.equal(fields(45, false), "true:false:idle");
	// urgency 色阶保留：≥70 黄 / ≥90 红（仅视觉提示）
	assert.equal(fields(70, false), "true:false:warn");
	assert.equal(fields(90, false), "true:false:danger");
	assert.equal(fields(90, true), "true:true:danger");
	// 压缩中：有数据时 ready 保持 true，禁用由 compacting 态负责
	assert.equal(fields(90, true), "true:true:danger");
	// 压缩中 + 无数据：同样未就绪（ready false，且 compacting 也禁用）
	assert.equal(fields(undefined, true), "false:true:idle");
});

test("resolveCompactUsagePercent matches ring occupancy, including zero-percent token fallback", () => {
	assert.equal(resolveCompactUsagePercent(undefined), null);
	assert.equal(resolveCompactUsagePercent({}), null);
	assert.equal(resolveCompactUsagePercent({ contextPercent: 45.3 }), 45.3);
	// 不封顶：pi 按 tokens/window 直接计算，缓存超窗等场景可 >100%（CLI footer 同口径）
	assert.equal(resolveCompactUsagePercent({ contextPercent: 112 }), 112);
	assert.equal(resolveCompactUsagePercent({ contextPercent: 0, contextTokens: 0, contextWindow: 1000 }), 0);
	const recomputed = resolveCompactUsagePercent({
		contextPercent: 0,
		contextTokens: 408,
		contextWindow: 1_000_000,
	});
	assert.ok(recomputed != null && Math.abs(recomputed - 0.0408) < 1e-9);
	// 圆环会显示 ~40%，斜杠 /compact 必须同样不拦截
	const drifted = resolveCompactUsagePercent({
		contextPercent: 0,
		contextTokens: 40_000,
		contextWindow: 100_000,
	});
	assert.equal(drifted, 40);
});

test("no client-side low-usage skip: any reported occupancy reaches the RPC", () => {
	// 不再有 shouldSkipCompactForLowUsage：低占用也由 pi 自行判定
	const feedback = readFileSync("src/shared/compactFeedback.ts", "utf8");
	assert.doesNotMatch(feedback, /COMPACT_READY_PERCENT/);
	assert.doesNotMatch(feedback, /shouldSkipCompactForLowUsage/);
});

test("classifyCompactError maps pi/DSH strings to one notice kind", () => {
	assert.equal(classifyCompactError("nothing to compact"), "nothingToDo");
	assert.equal(classifyCompactError("Already compacted"), "nothingToDo");
	assert.equal(classifyCompactError("session too small to compact"), "tooSmall");
	assert.equal(classifyCompactError("too small"), "tooSmall");
	assert.equal(classifyCompactError("already compacting"), "inProgress");
	assert.equal(classifyCompactError("compaction in progress"), "inProgress");
	assert.equal(classifyCompactError("boom"), "failed");
	assert.equal(classifyCompactError(""), "failed");
});

test("cancelled compaction is never silent and carries its source", () => {
	// pi 原文两头同形（扩展钩子拒绝 / abort 打断），归到中性的 cancelled
	assert.equal(classifyCompactError("Compaction cancelled"), "cancelled");
	assert.equal(classifyCompactError("cancelled"), "cancelled");
	// 主进程判明来源后抛稳定标记，渲染层据此给出可操作文案
	assert.equal(classifyCompactError(COMPACT_CANCELLED_BY_OWNER), "cancelledByOwner");
	assert.equal(classifyCompactError(`Error invoking remote method 'x': Error: ${COMPACT_CANCELLED_BY_OWNER}`), "cancelledByOwner");
	assert.equal(classifyCompactError(COMPACT_CANCELLED_BY_USER_ABORT), "interrupted");
	// 任何分类都必须有文案：静默会让「压缩被扩展接管」变成「点了没反应」
	const kinds = ["done", "nothingToDo", "tooSmall", "inProgress", "failed", "cancelled", "cancelledByOwner", "interrupted"];
	for (const raw of ["Compaction cancelled", COMPACT_CANCELLED_BY_OWNER, COMPACT_CANCELLED_BY_USER_ABORT]) {
		assert.ok(kinds.includes(classifyCompactError(raw)));
	}
});

test("hook-reject threshold is short enough to separate hook cancel from real compaction", () => {
	// 扩展钩子在生成摘要前 return，几乎无耗时；真实压缩（含 LLM 调用）必然秒级起步
	assert.ok(COMPACT_HOOK_REJECT_MAX_MS <= 3000);
	assert.ok(COMPACT_USER_ABORT_WINDOW_MS >= 1000);
	assert.ok(COMPACT_OBSERVATION_MAX_AGE_MS >= COMPACT_USER_ABORT_WINDOW_MS);
});

test("owner takeover is classified as routed / owned-with-reason, never silent", () => {
	// 接管者有自己的入口：主进程已改写动作，渲染层要按「已改用 X」提示
	assert.equal(classifyCompactError(`${COMPACT_ROUTED_TO_OWNER}: /ctx-wrapup`), "routedToOwner");
	assert.equal(compactRoutedCommand(`${COMPACT_ROUTED_TO_OWNER}: /ctx-wrapup`), "/ctx-wrapup");
	// 接管者没有可用入口：标记后带原因，提示要说清为什么压不了
	const blocked = `${COMPACT_CANCELLED_BY_OWNER}: Magic Context 接管了上下文窗口，但没有配置 historian 模型`;
	assert.equal(classifyCompactError(blocked), "cancelledByOwner");
	assert.equal(compactOwnerReason(blocked), "Magic Context 接管了上下文窗口，但没有配置 historian 模型");
	// 改写类不能被 cancel 规则抢走（文案里同样含 extension / cancelled 等词）
	assert.equal(classifyCompactError("compaction routed to extension command: /ctx-wrapup"), "routedToOwner");
});

test("pi compact path consults the context owner before sending the RPC", () => {
	const pi = readFileSync("src/main/pi/AgentManager.ts", "utf8");
	const owner = readFileSync("src/main/pi/compactionOwner.ts", "utf8");
	// 探测 + 改写/拒绝必须在发 compact RPC 之前
	assert.match(pi, /private async resolveSessionCompactionOwnership\(/);
	assert.match(pi, /await this\.resolveSessionCompactionOwnership\(runtime\)/);
	assert.match(pi, /private async routeCompactToOwner\(/);
	const routeIndex = pi.indexOf("await this.resolveSessionCompactionOwnership(runtime)");
	const rpcIndex = pi.indexOf("createCompactRpcRequest(trimmedPrompt)");
	assert.ok(routeIndex > 0 && rpcIndex > routeIndex, "owner probe must run before the compact RPC");
	// 会话内事实（get_commands）而不是只读磁盘
	assert.match(pi, /private async listRegisteredCommandNames\(/);
	assert.match(pi, /type: "get_commands"/);
	// 改写时用扩展命令 prompt，且用用户配置的 RPC 超时（wrapup 跑 historian 可能很久）
	assert.match(pi, /type: "prompt", message: command/);
	assert.match(pi, /this\.settingsStore\.get\(\)\.rpcTimeout/);
	// 探测失败不得阻断原生压缩
	assert.match(pi, /Compaction ownership probe failed/);
	// 判定只认用户级配置（MC 自己忽略项目级 compaction.enabled）
	assert.match(owner, /magic-context\.jsonc/);
	assert.match(owner, /MAGIC_CONTEXT_WRAPUP_COMMAND = "\/ctx-wrapup"/);
});

test("context overflow keeps a visible recovery compact action even without usage data", () => {
	const meter = readFileSync("src/renderer/src/components/session/SessionContextMeter.tsx", "utf8");
	const agentState = readFileSync("src/shared/types/agent.ts", "utf8");
	const overflow = readFileSync("src/shared/contextOverflow.ts", "utf8");
	assert.match(agentState, /contextOverflow\?: boolean/);
	assert.match(overflow, /context_length_exceeded/);
	assert.match(meter, /overflowRecovery/);
	assert.match(meter, /compactOverflow/);
	assert.match(meter, /!compactUi\.ready && !overflowRecovery/);
});

test("meter compact button uses shared ui state and e2e testid", () => {
	const meter = readFileSync("src/renderer/src/components/session/SessionContextMeter.tsx", "utf8");
	assert.match(meter, /from "\.\.\/\.\.\/\.\.\/\.\.\/shared\/compactFeedback"/);
	assert.match(meter, /resolveCompactUsagePercent\(state\)/);
	assert.match(meter, /compactUiState\(context\?\.percent, compacting\)/);
	assert.match(meter, /data-testid="session-context-compact"/);
	assert.match(meter, /sessionContext\.compactNotReady/);
	assert.match(meter, /sessionContext\.compactNotReadyHint/);
	assert.match(meter, /compactDisabled = compactUi\.compacting \|\| \(!compactUi\.ready && !overflowRecovery\)/);
});

test("composer compact path toasts done and maps inProgress", () => {
	const composer = readFileSync("src/renderer/src/hooks/useSessionComposerController.ts", "utf8");
	assert.match(composer, /function compactNotice/);
	assert.match(composer, /classifyCompactError/);
	// 客户端不再按占用拦截：低占用也发 RPC，由 pi 自行判定
	assert.doesNotMatch(composer, /shouldSkipCompactForLowUsage/);
	assert.match(composer, /app\.compactDone/);
	assert.match(composer, /app\.compactInProgress/);
	assert.match(composer, /app\.compactSessionTooSmall/);
	// 取消类必须可见：不再有 silent 分支
	assert.match(composer, /app\.compactCancelledByOwner/);
	assert.match(composer, /app\.compactInterrupted/);
	assert.doesNotMatch(composer, /case "silent"/);
	assert.match(composer, /const runManualCompact = useCallback/);
	assert.match(composer, /await runManualCompact\(target, prompt\)/);
	assert.equal((composer.match(/friendlyCompactError\(error\)/g) || []).length, 1, "error mapping lives in the shared runManualCompact helper");
});

test("pi compact failure resolves the cancel source instead of swallowing it", () => {
	const pi = readFileSync("src/main/pi/AgentManager.ts", "utf8");
	// 来源判定必须用真实证据：compaction_start→end 耗时 + 我们自己的 abort 时间
	assert.match(pi, /COMPACT_CANCELLED_BY_OWNER/);
	assert.match(pi, /COMPACT_CANCELLED_BY_USER_ABORT/);
	assert.match(pi, /private resolveCompactCancelMessage\(/);
	assert.match(pi, /private compactionCancelEvidence\(/);
	assert.match(pi, /this\.compactionStartedAt\.set\(agentId, Date\.now\(\)\)/);
	assert.match(pi, /this\.lastCompactionObservation\.set\(agentId, \{/);
	assert.match(pi, /this\.lastUserAbortAt\.set\(agentId, Date\.now\(\)\)/);
	// 观测字段要进日志，否则下次仍然只能看到「取消了」
	assert.match(pi, /"Compaction ended"[\s\S]{0,260}elapsedMs,/);
	assert.match(pi, /"Compact failed"[\s\S]{0,400}compactionCancelEvidence\(agentId\)/);
	// 判明来源时抛稳定标记（渲染层才分类得出「扩展接管」）
	assert.match(pi, /throw new Error\(cancelSource\)/);
});

test("context overflow is carried through the main and DSH runtime paths", () => {
	const pi = readFileSync("src/main/pi/AgentManager.ts", "utf8");
	const dsh = readFileSync("src/main/dsh/DshAgentManager.ts", "utf8");
	assert.match(pi, /isContextOverflowError\(errorMsg\)/);
	assert.match(pi, /contextOverflowByAgent/);
	assert.match(dsh, /isContextOverflowError\(reasonMessage\)/);
	assert.match(dsh, /contextOverflow: runtime\.contextOverflow === true/);
});

test("pi and dsh compact throw already compacting instead of returning success", () => {
	const pi = readFileSync("src/main/pi/AgentManager.ts", "utf8");
	assert.match(pi, /throw new Error\("already compacting"\)/);
	assert.doesNotMatch(pi, /Compact skipped: already compacting[\s\S]{0,120}return this\.getRuntimeState\(agentId\)/);
	const dsh = readFileSync("src/main/dsh/DshAgentManager.ts", "utf8");
	assert.match(dsh, /if \(runtime\.isCompacting\) \{\s*\n\s*throw new Error\("already compacting"\)/);
});

test("locales keep compact feedback keys in sync", () => {
	const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
	const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");
	for (const locale of [zh, en]) {
		assert.match(locale, /"app\.compactDone":/);
		assert.match(locale, /"app\.compactInProgress":/);
		assert.match(locale, /"app\.compactNothingToDo":/);
		assert.match(locale, /"app\.compactSessionTooSmall":/);
		assert.match(locale, /"app\.compactCancelled":/);
		assert.match(locale, /"app\.compactCancelledByOwner":/);
		assert.match(locale, /"app\.compactCancelledByOwnerWithReason":/);
		assert.match(locale, /"app\.compactRoutedToOwner":/);
		assert.match(locale, /"app\.compactInterrupted":/);
		assert.match(locale, /"sessionContext\.compactNotReady":/);
		assert.match(locale, /"sessionContext\.compactNotReadyHint":/);
	}
});
