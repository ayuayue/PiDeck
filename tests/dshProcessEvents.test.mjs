import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * DSH 轨迹过程事件收集器单测：mux 事件流 → SessionProcessEvent
 * （modelChange/permission/plan/goal/compaction），与 pi 会话文件过程事件同语义。
 */

// dshProcessEvents.ts 依赖同目录外的 ../tokenEstimate，必须用 loadTsCommonJs
// 按源文件目录解析相对 import（手写 vm 沙箱会以 tests/ 为基准报 require is not defined）
function loadModule() {
	return loadTsCommonJs("src/main/dsh/dshProcessEvents.ts");
}

const { collectDshProcessEvent, collectDshProcessEvents, pushDshProcessEvent, estimateContextTokens, parseContextPressureProjection, parseContextBreakdownProjection, parseTokenUsageProjection, parseSessionStatsProjection, deriveDshSessionStats, deriveSessionStatsFallback, cacheHitPercentOf, DSH_PROCESS_EVENTS_LIMIT } =
	loadModule();

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
	const record = collectDshProcessEvent(
		[],
		event(
			"llm/retry",
			{
				retry: 2,
				maxRetries: 5,
				delayMs: 1200,
				provider: "deepseek",
				failure: { code: "OVERLOADED", message: "provider overloaded" },
			},
			42,
			2500,
		),
	);
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
	const record = collectDshProcessEvent(
		[],
		event(
			"llm/retry",
			{
				retry: 1,
				delayMs: 0,
				failure: { code: "AUTH", message: "sk-secret-key is invalid" },
			},
			7,
			1100,
		),
	);
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

test("pushDshProcessEvent dedupes by id (follow snapshot replay)", () => {
	// 回归：follow 泵打开时的首帧 journal 尾部 snapshot 会重放 attach 已收集的事件，
	// 同 id 再投递必须跳过——曾致轨迹列表 duplicate key
	// （process:dsh-process:permission/preset:0、process:dsh-process:request/context:13）。
	const permission = collectDshProcessEvent([], event("permission/preset", { preset: "workspace-write" }, 0, 1000));
	const modelChange = collectDshProcessEvent([], event("request/context", { provider: "tokendance", model: "glm-5.2" }, 13, 2000));
	let events = pushDshProcessEvent([], permission);
	events = pushDshProcessEvent(events, modelChange);
	// 模拟 snapshot 重放：乱序再投一遍（重放不保证与末位相邻，内容幂等挡不住）
	events = pushDshProcessEvent(events, modelChange);
	events = pushDshProcessEvent(events, permission);
	assert.equal(events.length, 2);
	// vm 跨 realm 数组不能 deepStrictEqual，逐字段断言
	assert.equal(events[0].id, "dsh-process:permission/preset:0");
	assert.equal(events[1].id, "dsh-process:request/context:13");
});

test("collectDshProcessEvents replaying the same journal tail is a no-op", () => {
	const journal = [event("permission/preset", { preset: "workspace-write" }, 0, 1000), event("request/context", { provider: "tokendance", model: "glm-5.2" }, 13, 2000), event("request/context", { provider: "tokendance", model: "kimi-k2.5" }, 40, 3000)];
	const firstPass = collectDshProcessEvents([], journal);
	assert.equal(firstPass.length, 3);
	const secondPass = collectDshProcessEvents(firstPass, journal);
	// 幂等：重放后不新增任何条目
	assert.equal(secondPass.length, 3);
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

// 田分字段缺失语义见下一条「keeps absent fields undefined」回归（不再补 0）

test("parseContextBreakdownProjection keeps absent fields undefined instead of fabricating zeros", () => {
	// 回归：只有 messageTokens 的投影曾被补成 system/tools = 0，圆环渲染成「系统 0 / 工具 0」的假数据
	const parsed = parseContextBreakdownProjection({ contextBreakdown: { messageTokens: 10 } });
	assert.equal(parsed.systemTokens, undefined);
	assert.equal(parsed.toolsTokens, undefined);
	assert.equal(parsed.messageTokens, 10);
});

test("estimateContextTokens uses CJK-weighted estimation (same rule as pi)", () => {
	// 与 pi 的 contextMessageTokens 同规则：非中文 4 字符/token，中文 1.5 字/token
	assert.equal(
		estimateContextTokens([
			{ role: "user", text: "abcd" },
			{ role: "assistant", text: "efgh" },
		]),
		2,
	);
	assert.equal(
		estimateContextTokens([
			{ role: "user", text: "你好世界" },
			{ role: "tool", text: "abcd" },
		]),
		Math.ceil(4 / 1.5 + 1),
	);
});

test("estimateContextTokens skips empty and missing text", () => {
	assert.equal(estimateContextTokens([{ role: "user", text: "" }, { role: "assistant" }, { role: "user", text: "abcdefgh" }]), 2);
	assert.equal(estimateContextTokens([]), 0);
	// 估算向上取整：即使不足 4 字符也至少计 1 token，不再像 ÷4+floor 那样归零
	assert.equal(estimateContextTokens([{ role: "user", text: "abc" }]), 1);
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
	// 端到端：同一批 decodeTokens ÷（首 token 等待 + 解码）= 2400 ÷ 8.9s
	assert.equal(full.endToEndTokensPerSecond, 2_400 / 8.9);
	// 无样本：平均首字/生成速度保持 undefined（UI 显示 —）
	const empty = deriveDshSessionStats({ turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 });
	assert.equal(empty.ttftAvgMs, undefined);
	assert.equal(empty.tokensPerSecond, undefined);
	assert.equal(empty.endToEndTokensPerSecond, undefined);
	// 只有首 token、没有 usage 样本：不拿 0 tokens 除首字耗时伪造端到端速度
	const ttftOnly = deriveDshSessionStats({ turns: 1, steps: 1, llmMs: 2_000, toolMs: 0, ttftMs: 500, ttftSteps: 1, decodeMs: 0, decodeTokens: 0 });
	assert.equal(ttftOnly.tokensPerSecond, undefined);
	assert.equal(ttftOnly.endToEndTokensPerSecond, undefined);
});

test("deriveSessionStatsFallback counts turns with model product, mirroring dsh-web", () => {
	assert.equal(deriveSessionStatsFallback([]), undefined);
	assert.equal(deriveSessionStatsFallback([{ role: "user" }]), undefined);
	// 未回复的连发 user：无模型产物，兜底不出数字（与完成轮口径一致）。
	assert.equal(deriveSessionStatsFallback([{ role: "user" }, { role: "user" }]), undefined);
	const one = deriveSessionStatsFallback([{ role: "user" }, { role: "assistant" }, { role: "tool" }]);
	assert.equal(one.turns, 1);
	assert.equal(one.steps, 1);
	assert.equal(one.llmMs, 0);
	const two = deriveSessionStatsFallback([{ role: "user" }, { role: "assistant" }, { role: "user" }, { role: "assistant" }, { role: "assistant" }]);
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

test("system/message replays into an initial prompt snapshot and drops repeats", () => {
	const first = collectDshProcessEvent([], event("system/message", { message: { content: [{ type: "text", text: "persona + sections" }] } }, 2, 1000));
	assert.ok(first);
	assert.equal(first.kind, "systemPrompt");
	assert.equal(first.prompt.kind, "initial");
	assert.equal(first.prompt.text, "persona + sections");
	assert.equal(first.seq, 2);

	const repeat = collectDshProcessEvent([first], event("system/message", { message: { content: [{ type: "text", text: "persona + sections" }] } }, 12, 3000));
	assert.equal(repeat, undefined, "identical reloads must not add a ledger record");

	const update = collectDshProcessEvent([first], event("system/message", { message: { content: [{ type: "text", text: "persona + extra rules" }] } }, 20, 5000));
	assert.ok(update);
	assert.equal(update.prompt.kind, "update");
	assert.match(update.prompt.text, /extra rules/);
});

test("request/header records the tool catalog and diffs it against the previous prompt", () => {
	const initial = collectDshProcessEvent([], event("system/message", { message: { content: [{ type: "text", text: "sys" }] } }, 2, 1000));
	const header = event("request/header", { header: { config: { provider: "p", model: "m" }, tools: [{ name: "bash" }, { name: "read" }] } }, 3, 1100);
	const withTools = collectDshProcessEvent([initial], header);
	assert.ok(withTools);
	assert.equal(withTools.prompt.kind, "update");
	assert.equal(withTools.prompt.tools.join(","), "bash,read");
	assert.equal(withTools.prompt.toolsAdded.join(","), "bash,read");

	const later = collectDshProcessEvent([initial, withTools], event("request/header", { header: { config: { provider: "p", model: "m" }, tools: [{ name: "bash" }, { name: "write" }] } }, 9, 2000));
	assert.ok(later);
	assert.equal(later.prompt.tools.join(","), "bash,write");
	assert.equal(later.prompt.toolsAdded.join(","), "write");
	assert.equal(later.prompt.toolsRemoved.join(","), "read");

	const unchanged = collectDshProcessEvent([initial, withTools], event("request/header", { header: { config: { provider: "p", model: "m" }, tools: [{ name: "bash" }, { name: "read" }] } }, 10, 2100));
	assert.equal(unchanged, undefined);
});

test("token placeholder tool catalogs are not treated as tools", () => {
	const initial = collectDshProcessEvent([], event("system/message", { message: { content: [{ type: "text", text: "sys" }] } }, 2, 1000));
	assert.equal(collectDshProcessEvent([initial], event("request/header", { header: { config: { provider: "p", model: "m" }, tools: "{{tools}}" } }, 3, 1100)), undefined);
});

test("developer/message tool changes update the prompt tool set instead of adding noise", () => {
	const initial = collectDshProcessEvent([], event("system/message", { message: { content: [{ type: "text", text: "sys" }] } }, 2, 1000));
	const withTools = collectDshProcessEvent([initial], event("request/header", { header: { config: { provider: "p", model: "m" }, tools: [{ name: "bash" }, { name: "read" }] } }, 3, 1100));
	const added = collectDshProcessEvent([initial, withTools], event("developer/message", { message: { content: [{ type: "tool-addition", toolName: "edit" }] } }, 4, 1200));
	assert.ok(added);
	assert.equal(added.kind, "systemPrompt");
	assert.equal(added.prompt.tools.join(","), "bash,edit,read");
	assert.equal(added.prompt.toolsAdded.join(","), "edit");

	const text = collectDshProcessEvent([initial, withTools], event("developer/message", { message: { content: [{ type: "text", text: "workspace context injected" }] } }, 5, 1300));
	assert.equal(text.kind, "custom");
	assert.equal(text.customType, "context");
	assert.match(text.summary, /workspace context/);
});

test("compaction/summary records the summary with tokensBefore and usage; end error is kept", () => {
	const summary = collectDshProcessEvent([], event("compaction/summary", { compactionId: "c1", summary: "short recap", shadowedTokenCount: 81_000, provider: "p", model: "m", usage: { input: 100, output: 20 } }, 7, 7000));
	assert.ok(summary);
	assert.equal(summary.kind, "compaction");
	assert.equal(summary.tokensBefore, 81_000);
	assert.equal(summary.provider, "p");
	assert.equal(summary.modelId, "m");
	assert.equal(summary.summary, "short recap");
	assert.match(summary.detail, /input 100/);
	assert.match(summary.detail, /output 20/);

	assert.equal(collectDshProcessEvent([], event("compaction/end", { compactionId: "c1" }, 8, 7100)), undefined);

	const failed = collectDshProcessEvent([], event("compaction/end", { compactionId: "c1", error: { message: "provider down" } }, 9, 7200));
	assert.ok(failed);
	assert.equal(failed.kind, "compaction");
	assert.match(failed.summary, /provider down/);
});

test("prompt snapshots survive the process-event cap", () => {
	// 长会话排到 240 条以后时，初始提示词不能被裁掉——否则轨迹开头又看不到系统提示词。
	const prompt = collectDshProcessEvent([], event("system/message", { message: { content: [{ type: "text", text: "sys" }] } }, 0, 1000));
	let events = pushDshProcessEvent([], prompt);
	for (let index = 0; index < DSH_PROCESS_EVENTS_LIMIT + 20; index += 1) {
		events = pushDshProcessEvent(events, { id: `retry-${index}`, kind: "retry", timestamp: 2000 + index, seq: index + 1, summary: `retry ${index}`, retry: 1 });
	}
	assert.ok(events.length <= DSH_PROCESS_EVENTS_LIMIT + 1);
	assert.equal(events[0].kind, "systemPrompt");
	assert.equal(events[0].prompt.text, "sys");
});

// ── S1 红测基线（计划 docs/trajectory-session-consumer-plan.md §8.3）────────────
// 与 pi 同一套提示词预算：≤96,000 码元且 ≤256KiB（262,144 字节）。

const DSH_PROMPT_BYTE_LIMIT = 262_144;

test("B3: dsh 系统提示同样受字节预算约束并按字节截断", () => {
	// 90,000 × 3 = 270,000 字节 > 262,144；码元数未超 96,000。
	const record = collectDshProcessEvent([], event("system/message", { message: { content: [{ type: "text", text: "中".repeat(90_000) }] } }, 2, 1000));
	assert.ok(record, "首帧系统提示必须产出一条快照");
	assert.equal(record.prompt.truncated, true, "字符数未超限但字节超限，必须标记 truncated");
	assert.ok(Buffer.byteLength(record.prompt.text, "utf8") <= DSH_PROMPT_BYTE_LIMIT, `字节超限：${Buffer.byteLength(record.prompt.text, "utf8")}`);
});

test("B3: dsh 截断不得拆开 emoji 代理对", () => {
	const record = collectDshProcessEvent([], event("system/message", { message: { content: [{ type: "text", text: "a".repeat(95_999) + "😀" }] } }, 2, 1000));
	assert.ok(record);
	assert.equal(record.prompt.truncated, true);
	const last = record.prompt.text.charCodeAt(record.prompt.text.length - 1);
	assert.ok(!(last >= 0xd800 && last <= 0xdbff), `结尾是孤立高代理（0x${last.toString(16)}）`);
});

test("窗口未覆盖会话开头时首个提示词标为 snapshot，不冒充 initial", () => {
	const unseen = event("system/message", { message: { content: [{ type: "text", text: "window-only" }] } }, 2, 1000);
	const windowed = collectDshProcessEvent([], unseen, { fromStart: false });
	assert.ok(windowed);
	assert.equal(windowed.prompt.kind, "snapshot");
	// 未声明覆盖范围（默认）仍是会话初始装载。
	const complete = collectDshProcessEvent([], event("system/message", { message: { content: [{ type: "text", text: "from-start" }] } }, 3, 2000));
	assert.equal(complete.prompt.kind, "initial");
	// 批量入口同样要把覆盖范围传下去（历史冷读走这条）。
	const batch = collectDshProcessEvents([], [unseen], { fromStart: false });
	assert.equal(batch.filter((entry) => entry.kind === "systemPrompt").pop().prompt.kind, "snapshot");
});
