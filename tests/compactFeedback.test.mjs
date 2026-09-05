import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 手动压缩统一策略：门槛、按钮态、错误分类。
 * 圆环按钮 / /compact / 主进程重复压缩共用同一套规则。
 */

const {
	COMPACT_READY_PERCENT,
	compactUiState,
	resolveCompactUsagePercent,
	shouldSkipCompactForLowUsage,
	classifyCompactError,
} = loadTsCommonJs("src/shared/compactFeedback.ts");

test("COMPACT_READY_PERCENT is 30 (legacy compact-chip threshold)", () => {
	assert.equal(COMPACT_READY_PERCENT, 30);
});

test("compactUiState disables below threshold and while compacting", () => {
	// loadTsCommonJs 在 vm 里跑，对象原型跨 realm，不能 deepEqual 整个对象
	const fields = (percent, compacting) => {
		const state = compactUiState(percent, compacting);
		return `${state.ready}:${state.compacting}:${state.urgency}`;
	};
	assert.equal(fields(12, false), "false:false:idle");
	assert.equal(fields(29.9, false), "false:false:idle");
	assert.equal(fields(30, false), "true:false:idle");
	assert.equal(fields(45, false), "true:false:idle");
	assert.equal(fields(70, false), "true:false:warn");
	assert.equal(fields(90, true), "true:true:danger");
	assert.equal(fields(undefined, false), "false:false:idle");
});

test("resolveCompactUsagePercent matches ring occupancy, including zero-percent token fallback", () => {
	assert.equal(resolveCompactUsagePercent(undefined), null);
	assert.equal(resolveCompactUsagePercent({}), null);
	assert.equal(resolveCompactUsagePercent({ contextPercent: 45.3 }), 45.3);
	// 不封顶：pi 按 tokens/window 直接计算，缓存超窗等场景可 >100%（CLI footer 同口径）
	assert.equal(resolveCompactUsagePercent({ contextPercent: 112 }), 112);
	assert.equal(
		resolveCompactUsagePercent({ contextPercent: 0, contextTokens: 0, contextWindow: 1000 }),
		0,
	);
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
	assert.equal(shouldSkipCompactForLowUsage(drifted, false), false);
});

test("shouldSkipCompactForLowUsage only skips idle low-usage clicks", () => {
	assert.equal(shouldSkipCompactForLowUsage(12, false), true);
	assert.equal(shouldSkipCompactForLowUsage(30, false), false);
	assert.equal(shouldSkipCompactForLowUsage(45, false), false);
	// 压缩中不走客户端跳过：交给 inProgress 提示
	assert.equal(shouldSkipCompactForLowUsage(12, true), false);
	// 无占用数据时不拦截（草稿刚启动 / 尚未上报），让 RPC 决定
	assert.equal(shouldSkipCompactForLowUsage(undefined, false), false);
	assert.equal(shouldSkipCompactForLowUsage(null, false), false);
});

test("classifyCompactError maps pi/DSH strings to one notice kind", () => {
	assert.equal(classifyCompactError("nothing to compact"), "nothingToDo");
	assert.equal(classifyCompactError("Already compacted"), "nothingToDo");
	assert.equal(classifyCompactError("session too small to compact"), "tooSmall");
	assert.equal(classifyCompactError("too small"), "tooSmall");
	assert.equal(classifyCompactError("already compacting"), "inProgress");
	assert.equal(classifyCompactError("compaction in progress"), "inProgress");
	assert.equal(classifyCompactError("Compaction cancelled"), "silent");
	assert.equal(classifyCompactError("cancelled"), "silent");
	assert.equal(classifyCompactError("boom"), "failed");
	assert.equal(classifyCompactError(""), "failed");
});

test("meter compact button uses shared ui state and e2e testid", () => {
	const meter = readFileSync("src/renderer/src/components/session/SessionContextMeter.tsx", "utf8");
	assert.match(meter, /from "\.\.\/\.\.\/\.\.\/\.\.\/shared\/compactFeedback"/);
	assert.match(meter, /resolveCompactUsagePercent\(state\)/);
	assert.match(meter, /compactUiState\(percent, compacting\)/);
	assert.match(meter, /data-testid="session-context-compact"/);
	assert.match(meter, /sessionContext\.compactNotReady/);
	assert.match(meter, /sessionContext\.compactNotReadyHint/);
	assert.match(meter, /compactDisabled = compactUi\.compacting \|\| !compactUi\.ready/);
});

test("composer compact path skips low usage, toasts done, and maps inProgress", () => {
	const composer = readFileSync(
		"src/renderer/src/hooks/useSessionComposerController.ts",
		"utf8",
	);
	assert.match(composer, /function compactNotice/);
	assert.match(composer, /classifyCompactError/);
	assert.match(composer, /shouldSkipCompactForLowUsage/);
	assert.match(composer, /resolveCompactUsagePercent\(live\?\.state\)/);
	assert.match(composer, /app\.compactDone/);
	assert.match(composer, /app\.compactInProgress/);
	assert.match(composer, /app\.compactSessionTooSmall/);
	assert.match(composer, /const runManualCompact = useCallback/);
	assert.match(composer, /await runManualCompact\(target, prompt\)/);
	assert.equal(
		(composer.match(/friendlyCompactError\(error\)/g) || []).length,
		1,
		"error mapping lives in the shared runManualCompact helper",
	);
});

test("pi and dsh compact throw already compacting instead of returning success", () => {
	const pi = readFileSync("src/main/pi/AgentManager.ts", "utf8");
	assert.match(pi, /throw new Error\("already compacting"\)/);
	assert.doesNotMatch(
		pi,
		/Compact skipped: already compacting[\s\S]{0,120}return this\.getRuntimeState\(agentId\)/,
	);
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
		assert.match(locale, /"sessionContext\.compactNotReady":/);
		assert.match(locale, /"sessionContext\.compactNotReadyHint":/);
	}
});
