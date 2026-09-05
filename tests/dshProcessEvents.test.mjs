import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

/**
 * DSH 轨迹过程事件收集器单测：mux 事件流 → SessionProcessEvent
 * （modelChange/permission/plan/goal/compaction），与 pi 会话文件过程事件同语义。
 */

function transpile(filePath) {
	return ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText;
}

function loadModule() {
	const sandbox = { exports: {} };
	vm.runInNewContext(
		transpile("src/main/dsh/dshProcessEvents.ts"),
		sandbox,
		{ filename: "dshProcessEvents.ts" },
	);
	return sandbox.exports;
}

const {
	collectDshProcessEvent,
	pushDshProcessEvent,
	estimateContextTokens,
	parseContextPressureProjection,
	parseContextBreakdownProjection,
	parseTokenUsageProjection,
	parseSessionStatsProjection,
	deriveDshSessionStats,
	deriveSessionStatsFallback,
	cacheHitPercentOf,
	DSH_PROCESS_EVENTS_LIMIT,
} = loadModule();

function event(type, data = {}, seq = 1, time = 1_000_000) {
	return { type, data, seq, time };
}

test("request/context yields a modelChange process record", () => {
	const record = collectDshProcessEvent([], event("request/context", { provider: "deepseek", model: "deepseek-chat" }, 5, 1234));
	assert.ok(record);
	assert.equal(record.kind, "modelChange");
	assert.equal(record.provider, "deepseek");
	assert.equal(record.modelId, "deepseek-chat");
	assert.equal(record.timestamp, 1234);
});

test("repeated request/context with the same model is idempotent", () => {
	const first = collectDshProcessEvent([], event("request/context", { provider: "deepseek", model: "deepseek-chat" }, 5, 1000));
	assert.ok(first);
	const second = collectDshProcessEvent([first], event("request/context", { provider: "deepseek", model: "deepseek-chat" }, 9, 2000));
	assert.equal(second, undefined);
});

test("model switch after the same model does record a new event", () => {
	const first = collectDshProcessEvent([], event("request/context", { provider: "deepseek", model: "deepseek-chat" }, 5, 1000));
	const second = collectDshProcessEvent([first], event("request/context", { provider: "deepseek", model: "deepseek-reasoner" }, 9, 2000));
	assert.ok(second);
	assert.equal(second.kind, "modelChange");
	assert.equal(second.modelId, "deepseek-reasoner");
});

test("permission/preset maps to a custom(permission) record", () => {
	const record = collectDshProcessEvent([], event("permission/preset", { preset: "workspace-write" }, 3, 1500));
	assert.ok(record);
	assert.equal(record.kind, "custom");
	assert.equal(record.customType, "permission");
	assert.equal(record.summary, "permission workspace-write");
});

test("plan/mode maps to a custom(plan) record with on/off summary", () => {
	const on = collectDshProcessEvent([], event("plan/mode", { active: true }, 4, 1600));
	assert.equal(on?.customType, "plan");
	assert.equal(on?.summary, "plan on");
	const off = collectDshProcessEvent([], event("plan/mode", { active: false }, 5, 1700));
	assert.equal(off?.summary, "plan off");
});

test("goal/change maps to a custom(goal) record; clear gets a dedicated summary", () => {
	const created = collectDshProcessEvent([], event("goal/change", { operation: "create", goal: { id: "g1", revision: 1, objective: "fix the build" } }, 6, 1800));
	assert.equal(created?.customType, "goal");
	assert.match(created?.summary ?? "", /fix the build/);
	const cleared = collectDshProcessEvent([], event("goal/change", { operation: "clear" }, 7, 1900));
	assert.equal(cleared?.summary, "goal cleared");
});

test("user/message starting with /compact yields a compaction record", () => {
	const record = collectDshProcessEvent([], event("user/message", { content: [{ type: "text", text: "/compact 保留架构" }] }, 8, 2000));
	assert.ok(record);
	assert.equal(record.kind, "compaction");
	assert.equal(record.summary, "compact: 保留架构");
});

test("plain user messages are not process events", () => {
	const record = collectDshProcessEvent([], event("user/message", { content: [{ type: "text", text: "hello" }] }, 8, 2000));
	assert.equal(record, undefined);
});

test("unknown event types are ignored", () => {
	const record = collectDshProcessEvent([], event("something/else", {}, 9, 2100));
	assert.equal(record, undefined);
});

test("llm/retry yields a retry process record with seq and delay", () => {
	const record = collectDshProcessEvent([], event("llm/retry", {
		retry: 2,
		maxRetries: 5,
		delayMs: 1200,
		provider: "deepseek",
		failure: { code: "OVERLOADED", message: "provider overloaded" },
	}, 42, 2500));
	assert.ok(record);
	assert.equal(record.kind, "retry");
	assert.equal(record.seq, 42);
	assert.equal(record.retry, 2);
	assert.equal(record.maxRetries, 5);
	assert.equal(record.retryDelayMs, 1200);
	assert.equal(record.provider, "deepseek");
	assert.match(record.summary, /retry 2\/5/);
	assert.match(record.summary, /provider overloaded/);
});

test("llm/retry AUTH failure does not leak credential text", () => {
	const record = collectDshProcessEvent([], event("llm/retry", {
		retry: 1,
		delayMs: 0,
		failure: { code: "AUTH", message: "sk-secret-key is invalid" },
	}, 7, 1100));
	assert.equal(record?.kind, "retry");
	assert.equal(record?.detail, "API key is invalid");
	assert.doesNotMatch(record?.summary ?? "", /sk-secret/);
});

test("pushDshProcessEvent appends and caps at the limit", () => {
	let events = [];
	for (let i = 0; i < DSH_PROCESS_EVENTS_LIMIT + 5; i += 1) {
		events = pushDshProcessEvent(events, {
			id: `e${i}`,
			kind: "custom",
			timestamp: i,
			summary: `s${i}`,
			customType: "plan",
		});
	}
	assert.equal(events.length, DSH_PROCESS_EVENTS_LIMIT);
	assert.equal(events[0].id, "e5");
	assert.equal(events[events.length - 1].id, `e${DSH_PROCESS_EVENTS_LIMIT + 4}`);
});

test("pushDshProcessEvent ignores undefined records", () => {
	const events = pushDshProcessEvent([{ id: "a", kind: "custom", timestamp: 1, summary: "a" }], undefined);
	assert.equal(events.length, 1);
});

test("parseContextPressureProjection reads host projection values", () => {
	const parsed = parseContextPressureProjection({
		contextPressure: { pressureTokens: 1200, projectedTokens: 1500, contextWindow: 64_000 },
	});
	// vm 沙箱对象与 node assert 的深比较原型不同：按字段断言
	assert.equal(parsed.pressureTokens, 1200);
	assert.equal(parsed.projectedTokens, 1500);
	assert.equal(parsed.contextWindow, 64_000);
});

test("parseContextPressureProjection returns undefined for empty or foreign values", () => {
	assert.equal(parseContextPressureProjection({}), undefined);
	assert.equal(parseContextPressureProjection({ contextPressure: {} }), undefined);
	assert.equal(parseContextPressureProjection({ contextPressure: { pressureTokens: "nope" } }), undefined);
	assert.equal(parseContextPressureProjection(undefined), undefined);
});

test("projection parsers accept the unwrapped mux-frame unit value", () => {
	// 回归：mux session/projection 帧的 value 是单元值本体（host onChanged 原样下发），
	// 不是 attach projections.values 的 { key: 单元值 } 包装；之前帧被静默丢弃，
	// 运行中会话的圆环永远走字符估算兜底（表现 = 「dsh-web 准、PiDeck 不准」）。
	const pressure = parseContextPressureProjection({ pressureTokens: 1200, projectedTokens: 1500, contextWindow: 64_000 });
	assert.equal(pressure.pressureTokens, 1200);
	assert.equal(pressure.projectedTokens, 1500);
	assert.equal(pressure.contextWindow, 64_000);
	const breakdown = parseContextBreakdownProjection({ systemTokens: 900, toolsTokens: 300, messageTokens: 4200 });
	assert.equal(breakdown.systemTokens, 900);
	assert.equal(breakdown.toolsTokens, 300);
	assert.equal(breakdown.messageTokens, 4200);
	const usage = parseTokenUsageProjection({ uncachedInputTokens: 1200, outputTokens: 800, cacheReadTokens: 6400, cacheWriteTokens: 100 });
	assert.equal(usage.inputTokens, 1200);
	assert.equal(usage.cacheReadTokens, 6400);
	const stats = parseSessionStatsProjection({ turns: 3, steps: 7, llmMs: 12_000, toolMs: 4_000, ttftMs: 900, ttftSteps: 3, decodeMs: 8_000, decodeTokens: 2_400 });
	assert.equal(stats.turns, 3);
	assert.equal(stats.decodeTokens, 2_400);
});

test("parseContextBreakdownProjection reads heuristic composition", () => {
	const parsed = parseContextBreakdownProjection({
		contextBreakdown: { systemTokens: 900, toolsTokens: 300, messageTokens: 4200 },
	});
	assert.equal(parsed.systemTokens, 900);
	assert.equal(parsed.toolsTokens, 300);
	assert.equal(parsed.messageTokens, 4200);
});

test("parseContextBreakdownProjection tolerates partial fields", () => {
	const parsed = parseContextBreakdownProjection({ contextBreakdown: { messageTokens: 10 } });
	assert.equal(parsed.systemTokens, 0);
	assert.equal(parsed.toolsTokens, 0);
	assert.equal(parsed.messageTokens, 10);
});

test("estimateContextTokens counts text chars / 4 across messages", () => {
	// 与 pi 的 contextMessageTokens 同规则（字符数 ÷ 4）
	assert.equal(estimateContextTokens([
		{ role: "user", text: "abcd" },
		{ role: "assistant", text: "efgh" },
	]), 2);
	assert.equal(estimateContextTokens([
		{ role: "user", text: "你好世界" },
		{ role: "tool", text: "abcd" },
	]), 2);
});

test("estimateContextTokens skips empty and missing text", () => {
	assert.equal(estimateContextTokens([
		{ role: "user", text: "" },
		{ role: "assistant" },
		{ role: "user", text: "abcdefgh" },
	]), 2);
	assert.equal(estimateContextTokens([]), 0);
	// 不足 4 字符按 0 处理（floor）
	assert.equal(estimateContextTokens([{ role: "user", text: "abc" }]), 0);
});

test("parseTokenUsageProjection maps uncachedInput to input totals", () => {
	const parsed = parseTokenUsageProjection({
		tokenUsage: { uncachedInputTokens: 1200, outputTokens: 800, cacheReadTokens: 6400, cacheWriteTokens: 100 },
	});
	assert.equal(parsed.inputTokens, 1200);
	assert.equal(parsed.outputTokens, 800);
	assert.equal(parsed.cacheReadTokens, 6400);
	assert.equal(parsed.cacheWriteTokens, 100);
});

test("parseTokenUsageProjection tolerates partial and foreign values", () => {
	const parsed = parseTokenUsageProjection({ tokenUsage: { outputTokens: 50 } });
	assert.equal(parsed.inputTokens, 0);
	assert.equal(parsed.outputTokens, 50);
	assert.equal(parseTokenUsageProjection({}), undefined);
	assert.equal(parseTokenUsageProjection({ tokenUsage: {} }), undefined);
	assert.equal(parseTokenUsageProjection(undefined), undefined);
});

test("parseSessionStatsProjection reads wall-clock aggregates", () => {
	const parsed = parseSessionStatsProjection({
		sessionStats: { turns: 3, steps: 7, llmMs: 12_000, toolMs: 4_000, ttftMs: 900, ttftSteps: 3, decodeMs: 8_000, decodeTokens: 2_400 },
	});
	assert.equal(parsed.turns, 3);
	assert.equal(parsed.steps, 7);
	assert.equal(parsed.llmMs, 12_000);
	assert.equal(parsed.toolMs, 4_000);
	assert.equal(parsed.ttftMs, 900);
	assert.equal(parsed.ttftSteps, 3);
	assert.equal(parsed.decodeMs, 8_000);
	assert.equal(parsed.decodeTokens, 2_400);
});

test("parseSessionStatsProjection requires turns or steps", () => {
	assert.equal(parseSessionStatsProjection({ sessionStats: { llmMs: 100 } }), undefined);
	const parsed = parseSessionStatsProjection({ sessionStats: { turns: 2 } });
	assert.equal(parsed.turns, 2);
	assert.equal(parsed.steps, 0);
	assert.equal(parseSessionStatsProjection(undefined), undefined);
});

test("deriveDshSessionStats computes averages and keeps sample-less fields undefined", () => {
	const full = deriveDshSessionStats({ turns: 3, steps: 7, llmMs: 12_000, toolMs: 4_000, ttftMs: 900, ttftSteps: 3, decodeMs: 8_000, decodeTokens: 2_400 });
	assert.equal(full.turns, 3);
	assert.equal(full.steps, 7);
	assert.equal(full.llmMs, 12_000);
	assert.equal(full.toolMs, 4_000);
	assert.equal(full.ttftAvgMs, 300);
	assert.equal(full.tokensPerSecond, 300);
	// 无样本：平均首字/生成速度保持 undefined（UI 不渲染对应行）
	const empty = deriveDshSessionStats({ turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 });
	assert.equal(empty.ttftAvgMs, undefined);
	assert.equal(empty.tokensPerSecond, undefined);
});

test("deriveSessionStatsFallback counts turns with model product, mirroring dsh-web", () => {
	assert.equal(deriveSessionStatsFallback([]), undefined);
	assert.equal(deriveSessionStatsFallback([{ role: "user" }]), undefined);
	// 未回复的连发 user：无模型产物，兜底不出数字（与完成轮口径一致）。
	assert.equal(deriveSessionStatsFallback([{ role: "user" }, { role: "user" }]), undefined);
	const one = deriveSessionStatsFallback([
		{ role: "user" },
		{ role: "assistant" },
		{ role: "tool" },
	]);
	assert.equal(one.turns, 1);
	assert.equal(one.steps, 1);
	assert.equal(one.llmMs, 0);
	const two = deriveSessionStatsFallback([
		{ role: "user" },
		{ role: "assistant" },
		{ role: "user" },
		{ role: "assistant" },
		{ role: "assistant" },
	]);
	assert.equal(two.turns, 2);
	assert.equal(two.steps, 3);
	// 纯工具执行轮（投影无 assistant 气泡但已有 tool 卡片）：算完成轮、step 保持 0。
	const toolOnly = deriveSessionStatsFallback([{ role: "user" }, { role: "tool" }]);
	assert.equal(toolOnly?.turns, 1);
	assert.equal(toolOnly?.steps, 0);
});

test("cacheHitPercentOf uses the dsh-web/pi shared formula", () => {
	assert.equal(cacheHitPercentOf({ inputTokens: 1200, outputTokens: 800, cacheReadTokens: 6400, cacheWriteTokens: 100 }), 83);
	assert.equal(cacheHitPercentOf({ inputTokens: 0, outputTokens: 10 }), undefined);
	assert.equal(cacheHitPercentOf(undefined), undefined);
});
