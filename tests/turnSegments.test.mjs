import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { buildTurnDisplay, hasFoldableContent } from "../src/renderer/src/components/session/timeline/buildTurnDisplay.ts";
import { buildProcessSummary } from "../src/renderer/src/components/session/timeline/segmentSummary.ts";

/**
 * 一轮回答（agent-run）扁平展示序列测试。
 *
 * 背景：旧 buildTurnSegments 把「不连续的思考/工具」拆成多个 process 折叠段，
 * 一轮回答出现多个「执行过程」汇总。buildTurnDisplay 改为扁平展示序列：
 * - process-entry（思考/工具）原位穿插，由 run 级折叠开关统一控制；
 * - interim-answer（非最后一条 assistant 文本）；
 * - final-answer（最后一条 assistant 文本，常驻）。
 * 严格按 run.items 原始时序输出，不允许重排。
 */

let seq = 0;
function assistantMessage(text, thinking, stopReason) {
	seq += 1;
	return {
		id: `a-${seq}`,
		agentId: "agent",
		role: "assistant",
		text,
		timestamp: seq,
		...(thinking ? { thinking } : {}),
		...(stopReason ? { stopReason } : {}),
	};
}

function toolMessage() {
	seq += 1;
	return {
		id: `t-${seq}`,
		agentId: "agent",
		role: "tool",
		text: "✓ read",
		timestamp: seq,
		meta: { toolName: "read", status: "done" },
	};
}

function thinkingGroup(text) {
	const message = assistantMessage("", text);
	return {
		kind: "thinking-group",
		id: `tg-${message.id}`,
		messages: [message],
		text,
		startedAt: message.timestamp,
		endedAt: message.timestamp,
	};
}

function toolGroup() {
	const message = toolMessage();
	return { kind: "tool-group", id: `tg-${message.id}`, messages: [message] };
}

function runOf(items) {
	return {
		kind: "agent-run",
		id: "run-1",
		items,
		startedAt: 1,
		endedAt: 999,
	};
}

/** 提取序列概要：[类型:内容]，便于断言顺序 */
function outline(items) {
	return items.map((item) => {
		if (item.kind === "process-entry") {
			const entry = item.entry;
			if (entry.kind === "thinking-entry") return `think:${entry.group.text}`;
			if (entry.kind === "retry-entry") return `retry:${entry.message.meta?.i18nKey}`;
			if (entry.kind === "error-entry") return `error:${entry.message.meta?.i18nKey}`;
			return "tool";
		}
		if (item.kind === "interim-answer") return `interim:${item.message.text}`;
		return `final:${item.message.text}`;
	});
}

test("流式中间态：扁平序列严格按真实时序，不重排", () => {
	// 真实时序：思考T1 → 回答段1 → 工具 → 思考T2（还在进行，run 未结束）
	const run = runOf([{ kind: "message", message: assistantMessage("段1", "T1") }, toolGroup(), thinkingGroup("T2")]);
	const items = buildTurnDisplay(run, { showThinking: true });
	assert.deepEqual(outline(items), ["think:T1", "interim:段1", "tool", "think:T2"]);
	// 段1 后随工具/思考条目（run 未收尾）→ 中间回复，不得提升为 final-answer
	assert.equal(items[1].kind, "interim-answer");
});

test("中断的 run（回答后还有工具调用）：回答是工具前的阶段性文本，不收尾不提升", () => {
	const run = runOf([{ kind: "message", message: assistantMessage("段1") }, toolGroup()]);
	const items = buildTurnDisplay(run, { showThinking: true });
	assert.deepEqual(outline(items), ["interim:段1", "tool"]);
	// 段1 后随工具条目 → 中间回复，不能常驻折叠栏外
	assert.equal(items[0].kind, "interim-answer");
});

test("steer 打断场景：中间回复（正文+工具）永不提升为最终回答", () => {
	// 真实 steer 场景：模型先输出阶段性文本（如「两个问题：…」）再调工具，
	// 用户消息打断后该 run 以工具条目收尾——文本只是工具调用前的说明。
	const run = runOf([{ kind: "message", message: assistantMessage("两个问题：缓存逻辑有设计缺陷…", "T1") }, toolGroup()]);
	const items = buildTurnDisplay(run, { showThinking: true });
	assert.deepEqual(outline(items), ["think:T1", "interim:两个问题：缓存逻辑有设计缺陷…", "tool"]);
	assert.equal(
		items.some((item) => item.kind === "final-answer"),
		false,
	);
});

test("run 收尾条目是 assistant 才提升：工具执行后的总结照常常驻", () => {
	// 正常完成轮：工具先跑完，最后一条 assistant 是收尾条目 → 最终回答
	const run = runOf([toolGroup(), { kind: "message", message: assistantMessage("总结", "T2") }]);
	const items = buildTurnDisplay(run, { showThinking: true });
	assert.deepEqual(outline(items), ["tool", "think:T2", "final:总结"]);
	assert.equal(items[2].kind, "final-answer");
});

test("提升稳定性：收尾判定随 run 结构变化，不会提升后又反复", () => {
	// [M1]：M1 收尾 → 提升
	const run1 = runOf([{ kind: "message", message: assistantMessage("段1") }]);
	assert.equal(buildTurnDisplay(run1, { showThinking: true })[0].kind, "final-answer");
	// [M1, T1]：M1 后随工具 → 不提升
	const run2 = runOf([{ kind: "message", message: assistantMessage("段1") }, toolGroup()]);
	assert.equal(buildTurnDisplay(run2, { showThinking: true })[0].kind, "interim-answer");
	// [M1, T1, M2]：M2 收尾 → 提升；M1 始终是中间回复
	const run3 = runOf([{ kind: "message", message: assistantMessage("段1") }, toolGroup(), { kind: "message", message: assistantMessage("段2") }]);
	const items3 = buildTurnDisplay(run3, { showThinking: true });
	assert.equal(items3[0].kind, "interim-answer");
	assert.equal(items3[2].kind, "final-answer");
});

test("多段回答：中间回答与最终回答正确区分，各自思考插入到文本之前", () => {
	// 真实时序：T1 → 段1 → 工具 → T2 → 段2
	const run = runOf([{ kind: "message", message: assistantMessage("段1", "T1") }, toolGroup(), { kind: "message", message: assistantMessage("段2", "T2") }]);
	const items = buildTurnDisplay(run, { showThinking: true });
	assert.deepEqual(outline(items), ["think:T1", "interim:段1", "tool", "think:T2", "final:段2"]);
	// 段1 不是最后一条 assistant → interim；段2 是最后一条 → final
	assert.equal(items[1].kind, "interim-answer");
	assert.equal(items[4].kind, "final-answer");
});

test("相邻多段回答（中间无工具）：各自思考保持「思考→回答」时序", () => {
	const run = runOf([
		{ kind: "message", message: assistantMessage("段1", "T1") },
		{ kind: "message", message: assistantMessage("段2", "T2") },
	]);
	const items = buildTurnDisplay(run, { showThinking: true });
	assert.deepEqual(outline(items), ["think:T1", "interim:段1", "think:T2", "final:段2"]);
});

test("流式中（isComplete=false）：所有 assistant 都归中间回答，不提前常驻", () => {
	// 真实流式场景：run 尚未结束（agent 忙碌），当前最后一条 assistant
	// 不能判定为最终回答——否则会常驻在折叠栏外（用户反馈的 bug）。
	const run = runOf([{ kind: "message", message: assistantMessage("段1", "T1") }, toolGroup(), { kind: "message", message: assistantMessage("段2", "T2") }]);
	const items = buildTurnDisplay(run, { showThinking: true, isComplete: false });
	assert.deepEqual(outline(items), ["think:T1", "interim:段1", "tool", "think:T2", "interim:段2"]);
	// 即使最后一条也不得标记为 final-answer（流式中无法判断）
	assert.equal(items[4].kind, "interim-answer");
});

test("完整轮次：最终回答的思考插到其前，顺序保持", () => {
	const run = runOf([thinkingGroup("T1"), toolGroup(), { kind: "message", message: assistantMessage("回答", "T2") }]);
	const items = buildTurnDisplay(run, { showThinking: true });
	assert.deepEqual(outline(items), ["think:T1", "tool", "think:T2", "final:回答"]);
});

test("showThinking 关闭时不展开消息自带思考，但已有 thinking-group 仍保留", () => {
	const run = runOf([thinkingGroup("T1"), { kind: "message", message: assistantMessage("段1", "T2") }]);
	const items = buildTurnDisplay(run, { showThinking: false });
	assert.deepEqual(outline(items), ["think:T1", "final:段1"]);
});

test("无 assistant 消息的 run：全部归入过程步骤", () => {
	const run = runOf([thinkingGroup("T1"), toolGroup()]);
	const items = buildTurnDisplay(run, { showThinking: true });
	assert.deepEqual(outline(items), ["think:T1", "tool"]);
});

test("过程步骤使用稳定 id（流式重渲染不重置展开状态）", () => {
	const message = assistantMessage("段1", "T1");
	const run = runOf([{ kind: "message", message }]);
	const first = buildTurnDisplay(run, { showThinking: true });
	const second = buildTurnDisplay(run, { showThinking: true });
	const firstThinking = first[0];
	const secondThinking = second[0];
	assert.equal(firstThinking.kind, "process-entry");
	assert.equal(secondThinking.kind, "process-entry");
	assert.equal(firstThinking.entry.id, secondThinking.entry.id);
});

/* ── groupToolMessages：连续 assistant 消息不再合并（多段回答原位平铺，issue #130） ── */

function loadAppUtils() {
	const source = readFileSync("src/renderer/src/components/app/AppUtils.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	});
	const sandbox = {
		exports: {},
		location: { href: "file:///Users/test/app" },
		require: (id) => {
			if (id === "../session/composer/chips") return { formatFilePathRef: (p) => p };
			if (id === "../session/timelineFailureNotice") {
				// 重试状态消息判定：与生产实现同口径（diagnostic.retry* i18nKey 集合）
				const RETRY_KEYS = new Set(["diagnostic.retryScheduled", "diagnostic.retryScheduledAfterDelay", "diagnostic.retrySucceeded", "diagnostic.retryFailed"]);
				return { isRetryStatusMessage: (message) => RETRY_KEYS.has(message?.meta?.i18nKey) };
			}
			return {};
		},
	};
	vm.runInNewContext(outputText, sandbox, { filename: "AppUtils.ts" });
	return sandbox.exports;
}

test("groupToolMessages 不合并连续 assistant 消息：多段回答各自独立、顺序保持", () => {
	const { groupToolMessages } = loadAppUtils();
	const user = { id: "u1", agentId: "a", role: "user", text: "问题", timestamp: 1 };
	const a1 = { id: "a1", agentId: "a", role: "assistant", text: "段1", thinking: "T1", timestamp: 2 };
	const a2 = { id: "a2", agentId: "a", role: "assistant", text: "段2", thinking: "T2", timestamp: 3 };
	const rendered = groupToolMessages([user, a1, a2]);
	const run = rendered.find((item) => item.kind === "agent-run");
	assert.ok(run, "should produce one agent-run");
	const texts = run.items.filter((item) => item.kind === "message").map((item) => item.message.text);
	// vm 沙箱跨 realm 的数组与 Node 侧 Array 原型不同，deepEqual 会误判，统一走 JSON 比较
	assert.equal(JSON.stringify(texts), JSON.stringify(["段1", "段2"]));
	// 合并会把 T1/T2 串接到同一条消息上导致思考上移；不合并时各自保留在各自消息里
	assert.equal(run.items[0].message.thinking, "T1");
	assert.equal(run.items[1].message.thinking, "T2");
});

test("groupToolMessages 忙碌中 error 诊断不打断 agent-run：回答保持一轮，诊断卡落在用户消息之后", () => {
	const { groupToolMessages } = loadAppUtils();
	const user = { id: "u2", agentId: "a", role: "user", text: "继续", timestamp: 4 };
	const err = {
		id: "e1",
		agentId: "a",
		role: "error",
		text: "扩展执行错误。",
		timestamp: 5,
		meta: { i18nKey: "diagnostic.extensionError", debugDetails: "todo: boom" },
	};
	const a1 = { id: "a1", agentId: "a", role: "assistant", text: "段1", timestamp: 6 };
	const a2 = { id: "a2", agentId: "a", role: "assistant", text: "段2", timestamp: 7 };
	// 扩展报错可能在回答流式途中到达：旧实现（无 agentBusy）把 error 当用户消息处理，
	// flush 当前 run → 一段回答被拆成两个 agent-run、错误卡夹在中间（用户反馈
	// 「错误提示跑上上个消息卡片上去了」）。agentBusy=true 时诊断卡独立落盘、不拆 run。
	const rendered = groupToolMessages([user, err, a1, a2], { agentBusy: true });
	// 独立条目顺序：用户消息 → error 诊断卡 → 合并后的回答 run
	assert.equal(rendered[0].kind, "message");
	assert.equal(rendered[0].message.role, "user");
	assert.equal(rendered[1].kind, "message");
	assert.equal(rendered[1].message.role, "error");
	const runs = rendered.filter((item) => item.kind === "agent-run");
	assert.equal(runs.length, 1, "忙碌中 error 诊断不得把一段回答拆成两个 run");
	const texts = runs[0].items.filter((item) => item.kind === "message").map((item) => item.message.text);
	assert.equal(JSON.stringify(texts), JSON.stringify(["段1", "段2"]));
});

test("groupToolMessages 空闲态 error 诊断仍排在完成 run 之后（不回归旧位置语义）", () => {
	const { groupToolMessages } = loadAppUtils();
	const user = { id: "u1", agentId: "a", role: "user", text: "问题", timestamp: 1 };
	const a1 = { id: "a1", agentId: "a", role: "assistant", text: "回答", timestamp: 2 };
	const err = {
		id: "e1",
		agentId: "a",
		role: "error",
		text: "扩展执行错误。",
		timestamp: 5,
		meta: { i18nKey: "diagnostic.extensionError", debugDetails: "todo: boom" },
	};
	// agent 已空闲（agentBusy=false）：error 到达时 run 已结束，
	// 诊断卡应 flush 当前 run 后排在回答之后，而不是插在问答之间。
	const rendered = groupToolMessages([user, a1, err], { agentBusy: false });
	assert.equal(rendered[0].kind, "message");
	assert.equal(rendered[0].message.role, "user");
	assert.equal(rendered[1].kind, "agent-run");
	assert.equal(rendered[2].kind, "message");
	assert.equal(rendered[2].message.role, "error");
	// 缺省（未传 agentBusy）保持旧行为：与空闲态一致
	const renderedDefault = groupToolMessages([user, a1, err]);
	assert.equal(renderedDefault[0].kind, "message");
	assert.equal(renderedDefault[1].kind, "agent-run");
	assert.equal(renderedDefault[2].kind, "message");
	assert.equal(renderedDefault[2].message.role, "error");
});

/* ── ask_question 等待时长推导（2026-09 用户反馈「ask 时时间还在计时」）──
 * 主进程已在 ask_question 工具结束时把用户等待从 durationMs 扣除（AgentManager
 * settleAskWait / upsertToolMessage），渲染层在分组时反推每轮等待量：
 *   等待 = (工具结束消息时间戳 - meta.startedAt) - meta.durationMs
 * 供 TurnRow 从轮时长减去（effectiveStart = startedAt + askWaitMs）；
 * 运行中的 ask（meta.status === "running"）标记 askPending，尾部耗时冻结。 */

function askToolMessage({ status, startedAt, durationMs, timestamp }) {
	const meta = { toolName: "ask_question", status, startedAt, toolCallId: `ask-${seq}` };
	if (durationMs !== undefined) meta.durationMs = durationMs;
	return { id: `ask-${seq}`, agentId: "a", role: "tool", text: "✓ ask_question", timestamp, meta };
}

test("groupToolMessages 反推 ask_question 等待：completed 时按三字段差值累计", () => {
	const { groupToolMessages } = loadAppUtils();
	const user = { id: "u1", agentId: "a", role: "user", text: "问题", timestamp: 1 };
	const ask = askToolMessage({ status: "done", startedAt: 1000, durationMs: 2000, timestamp: 12000 });
	const a1 = { id: "a1", agentId: "a", role: "assistant", text: "回答", timestamp: 13000 };
	const rendered = groupToolMessages([user, ask, a1]);
	const run = rendered.find((item) => item.kind === "agent-run");
	// 等待 = 12000 - 1000(开始) - 2000(实际处理) = 9000ms
	assert.equal(run.askWaitMs, 9000);
	assert.equal(run.askPending, false);
});

test("groupToolMessages 运行中 ask_question 标记 askPending 并冻结在提问时刻", () => {
	const { groupToolMessages } = loadAppUtils();
	const user = { id: "u1", agentId: "a", role: "user", text: "问题", timestamp: 1 };
	const ask = askToolMessage({ status: "running", startedAt: 5000, timestamp: 5000 });
	const rendered = groupToolMessages([user, ask]);
	const run = rendered.find((item) => item.kind === "agent-run");
	assert.equal(run.askPending, true);
	assert.equal(run.askPendingAt, 5000);
	// 运行中无 durationMs：不参与等待累计
	assert.equal(run.askWaitMs, 0);
});

test("groupToolMessages DSH 整轮多步 toolUse 中间回复保持单 run（stopReason 拆碎回合回归）", () => {
	// 回归（2026-09-17）：DSH 投影器曾把每条 assistant/message 都标 stopReason="stop"，
	// 而 DSH 一次 turn 的每步模型响应各落一条 assistant/message（中间步骤也带 tool-call），
	// 导致同一 turn 的每条中间短文本被拆成独立 agent-run（头像+时间戳+「执行过程」chip 重复）。
	// 投影器改为带 tool-call 标 toolUse 后：单 turn 内多条 toolUse 中间回复 + 末尾一条
	// stop 最终回复应合并为一个 run；真实用户消息到来时才开启下一 run。
	const { groupToolMessages } = loadAppUtils();
	const user = { id: "u1", agentId: "a", role: "user", text: "修 issue", timestamp: 1 };
	const mk = (id, text, stopReason, ts) => ({ id, agentId: "a", role: "assistant", text, stopReason, timestamp: ts });
	const messages = [
		user,
		mk("a1", "我先看下代码", "toolUse", 2),
		{ id: "t1", agentId: "a", role: "tool", text: "✓ read", timestamp: 3, meta: { toolName: "read", status: "done" } },
		mk("a2", "找到了问题", "toolUse", 4),
		{ id: "t2", agentId: "a", role: "tool", text: "✓ edit", timestamp: 5, meta: { toolName: "edit", status: "done" } },
		mk("a3", "修好了，总结如下", "stop", 6),
	];
	const rendered = groupToolMessages(messages);
	const runs = rendered.filter((item) => item.kind === "agent-run");
	assert.equal(runs.length, 1, "同一 turn 的 toolUse 中间回复 + stop 收尾应为一个 run");
	const texts = runs[0].items.filter((item) => item.kind === "message").map((item) => item.message.text);
	assert.equal(JSON.stringify(texts), JSON.stringify(["我先看下代码", "找到了问题", "修好了，总结如下"]));
});

test("groupToolMessages 非 ask 工具不计入等待；已结算等待不影响新一轮 run", () => {
	const { groupToolMessages } = loadAppUtils();
	const user = { id: "u1", agentId: "a", role: "user", text: "问题", timestamp: 1 };
	const read = {
		id: "r1",
		agentId: "a",
		role: "tool",
		text: "✓ read",
		timestamp: 10,
		meta: { toolName: "read", status: "done", startedAt: 5, durationMs: 5 },
	};
	const a1 = { id: "a1", agentId: "a", role: "assistant", text: "回答", timestamp: 20 };
	const run = groupToolMessages([user, read, a1]).find((item) => item.kind === "agent-run");
	assert.equal(run.askWaitMs, 0);
	assert.equal(run.askPending, false);
});

/* ── stopReason 协议信号判定（2026-08 升级）──
 * pi RPC message_end 携带 provider 归一化 stopReason：
 * stop=最终回复 / toolUse=中间回复（工具调用回合）/ pending=message_start 占位。
 * 渲染层优先用协议信号（message_end 即确定、永不反复），无字段时回退启发式。 */

test("stopReason=stop：steer 排队后模型回应，stop 消息提升、此前 toolUse 中间回复不提升", () => {
	// 真实 steer 场景（抓取验证）：中间回复(toolUse) → 工具 → 用户 steer → stop 回应
	const run = runOf([{ kind: "message", message: assistantMessage("中间回复", undefined, "toolUse") }, toolGroup(), { kind: "message", message: assistantMessage("最终总结", undefined, "stop") }]);
	const items = buildTurnDisplay(run, { showThinking: true });
	assert.deepEqual(outline(items), ["interim:中间回复", "tool", "final:最终总结"]);
	assert.equal(items[0].kind, "interim-answer");
	assert.equal(items[2].kind, "final-answer");
});

test("stopReason=toolUse：即使它是 run 最后一条 assistant，也永不提升为最终回答", () => {
	// 关键新行为：协议信号优先于「最后一条 + 收尾条目」启发式。
	// 纯工具回合（空文本）与带文本中间回复的 stopReason 都是 toolUse。
	const runWithText = runOf([{ kind: "message", message: assistantMessage("我查一下", undefined, "toolUse") }]);
	const items = buildTurnDisplay(runWithText, { showThinking: true });
	assert.equal(items[0].kind, "interim-answer");

	// 空文本纯工具回合：同样不提升（旧启发式会把空骨架提升为空 final）
	const runEmpty = runOf([{ kind: "message", message: assistantMessage("", undefined, "toolUse") }]);
	const itemsEmpty = buildTurnDisplay(runEmpty, { showThinking: true });
	assert.equal(itemsEmpty[0].kind, "interim-answer");
});

test("stopReason=aborted/error/length：一律中间回答，不常驻", () => {
	// pending 是骨架占位残留：单独用例验证回退行为（收尾可提升、后随工具不提升）。
	for (const reason of ["aborted", "error", "length"]) {
		const run = runOf([{ kind: "message", message: assistantMessage("被打断的文本", undefined, reason) }]);
		const items = buildTurnDisplay(run, { showThinking: true });
		assert.equal(items[0].kind, "interim-answer", `stopReason=${reason} 不应提升为 final-answer`);
	}
});

test("stopReason 缺失（旧数据）：回退「最后一条 assistant 且收尾」启发式", () => {
	// 无字段消息保持旧行为：收尾提升、后随工具不提升
	const runTail = runOf([{ kind: "message", message: assistantMessage("旧总结") }]);
	assert.equal(buildTurnDisplay(runTail, { showThinking: true })[0].kind, "final-answer");
	const runMid = runOf([{ kind: "message", message: assistantMessage("旧中间回复") }, toolGroup()]);
	assert.equal(buildTurnDisplay(runMid, { showThinking: true })[0].kind, "interim-answer");
});

test("流式中（isComplete=false）：stopReason=stop 的消息也暂不提升（run 未结束不可定论）", () => {
	// 流式中 run 未收尾：即使某条消息 stopReason=stop（如工具回合的临时结束），
	// 也不能提前常驻——最终回答资格必须等 run 结束确认。
	const run = runOf([
		{ kind: "message", message: assistantMessage("中间回复", undefined, "toolUse") },
		{ kind: "message", message: assistantMessage("暂时结尾", undefined, "stop") },
	]);
	const items = buildTurnDisplay(run, { isComplete: false, showThinking: true });
	assert.equal(items[0].kind, "interim-answer");
	assert.equal(items[1].kind, "interim-answer");
});

test("stopReason=pending 残留（message_end 缺字段的降级路径）：视为无字段，回退启发式", () => {
	// 主进程骨架不持久化 pending 后，历史旧数据仍可能带 pending（旧版本 pi 落盘）；
	// 渲染层把 pending 当无字段处理：收尾消息可提升、后随工具不提升。
	const runTail = runOf([{ kind: "message", message: assistantMessage("旧总结", undefined, "pending") }]);
	assert.equal(buildTurnDisplay(runTail, { showThinking: true })[0].kind, "final-answer");
	const runMid = runOf([{ kind: "message", message: assistantMessage("旧中间回复", undefined, "pending") }, toolGroup()]);
	assert.equal(buildTurnDisplay(runMid, { showThinking: true })[0].kind, "interim-answer");
});

test("stopReason=stop 但非最后一条 assistant：不提升（位置守卫，防御异常数据）", () => {
	// 异常数据防御：stop 消息后仍有条目时按中间回复处理，保证每 run 至多一个 final-answer。
	const runMid = runOf([{ kind: "message", message: assistantMessage("不该提升", undefined, "stop") }, toolGroup()]);
	const items = buildTurnDisplay(runMid, { showThinking: true });
	assert.equal(items[0].kind, "interim-answer");

	// 多个 stop：只有最后一条 assistant 提升（不变量：每 run 至多一个 final）
	const runDouble = runOf([
		{ kind: "message", message: assistantMessage("段1", undefined, "stop") },
		{ kind: "message", message: assistantMessage("段2", undefined, "stop") },
	]);
	const itemsDouble = buildTurnDisplay(runDouble, { showThinking: true });
	assert.equal(itemsDouble[0].kind, "interim-answer");
	assert.equal(itemsDouble[1].kind, "final-answer");
});

test("空文本中间回复（error 占位/live 挂载点）不计入折叠汇总", () => {
	// 真实场景（用户反馈截图）：连续 error 空消息 + 1 段有文本中间回复 + 工具 + 最终回答。
	// 修复前 5 条 error 空消息被计成「5段中间回复」，实际只有 1 段。
	const run = runOf([
		{ kind: "message", message: assistantMessage("", undefined, "error") },
		{ kind: "message", message: assistantMessage("", undefined, "error") },
		{ kind: "message", message: assistantMessage("好问题，先核实数据能力再答。", undefined, "toolUse") },
		toolGroup(),
		{ kind: "message", message: assistantMessage("核实完毕", undefined, "stop") },
	]);
	const items = buildTurnDisplay(run, { showThinking: true });
	const summary = buildProcessSummary(items);
	assert.equal(summary.interimCount, 1, "空文本骨架不应计入中间回复数");
	assert.equal(summary.toolCount, 1);
	assert.equal(summary.thinkingCount, 0);
	assert.equal(hasFoldableContent(items), true);
});

test("全空 run（连续 error 空消息）：无可折叠内容，不渲染汇总按钮", () => {
	const run = runOf([
		{ kind: "message", message: assistantMessage("", undefined, "error") },
		{ kind: "message", message: assistantMessage("", undefined, "error") },
	]);
	const items = buildTurnDisplay(run, { showThinking: true });
	assert.equal(hasFoldableContent(items), false);
	assert.equal(buildProcessSummary(items).interimCount, 0);
});

/* ── 无触发消息的回合边界：后台子代理唤醒父回合（用户反馈「输出被折叠、后面的变成最后」） ── */

/** run 结构摘要：每个 agent-run 列出其 assistant 文本，system 卡片单列。 */
function outlineRuns(rendered) {
	return [...rendered].map((item) => {
		if (item.kind !== "agent-run") return `card:${item.message.meta?.type ?? item.message.role}`;
		const texts = [...item.items].filter((sub) => sub.kind === "message").map((sub) => `${sub.message.role}:${sub.message.text ?? ""}`);
		return `run[${texts.join("|")}]`;
	});
}

test("上一轮 stop 收尾后又来 assistant：拆成两个 run，上一轮回答不退化为中间回答", () => {
	const { groupToolMessages } = loadAppUtils();
	// 场景：父回合已结束（a1 带 stopReason="stop"），后台子代理完成唤醒父会话，
	// 新回合的 assistant（a2）到来。pi 的唤醒消息是 role="custom"，旧实现整条丢弃，
	// 于是两个回合并进同一个 run：a1 变成「中间回答」被折叠、a2 成为最终回答（错位）。
	const user = { id: "u1", agentId: "a", role: "user", text: "问题", timestamp: 1 };
	const a1 = { id: "a1", agentId: "a", role: "assistant", text: "上一轮回答", timestamp: 2, stopReason: "stop" };
	const a2 = { id: "a2", agentId: "a", role: "assistant", text: "唤醒后的回答", timestamp: 3, stopReason: "stop" };
	const rendered = groupToolMessages([user, a1, a2]);
	assert.equal(JSON.stringify(outlineRuns(rendered)), JSON.stringify(["card:user", "run[assistant:上一轮回答]", "run[assistant:唤醒后的回答]"]));
});

test("唤醒回合以工具开头（assistant 尚未到来）也先断开上一轮", () => {
	const { groupToolMessages } = loadAppUtils();
	const user = { id: "u1", agentId: "a", role: "user", text: "问题", timestamp: 1 };
	const a1 = { id: "a1", agentId: "a", role: "assistant", text: "上一轮回答", timestamp: 2, stopReason: "stop" };
	// 新回合先执行工具：工具不能留在上一轮的折叠区里
	const tool = { id: "t1", agentId: "a", role: "tool", text: "✓ read", timestamp: 3, meta: { toolName: "read", status: "done" } };
	const a2 = { id: "a2", agentId: "a", role: "assistant", text: "新回合回答", timestamp: 4, stopReason: "stop" };
	const rendered = groupToolMessages([user, a1, tool, a2]);
	assert.equal(JSON.stringify(outlineRuns(rendered)), JSON.stringify(["card:user", "run[assistant:上一轮回答]", "run[assistant:新回合回答]"]));
});

test("未收尾的 run 不拆：中间 assistant（toolUse）后跟工具不算回合边界", () => {
	const { groupToolMessages } = loadAppUtils();
	const user = { id: "u1", agentId: "a", role: "user", text: "问题", timestamp: 1 };
	const a1 = { id: "a1", agentId: "a", role: "assistant", text: "先查一下", timestamp: 2, stopReason: "toolUse" };
	const tool = { id: "t1", agentId: "a", role: "tool", text: "✓ read", timestamp: 3, meta: { toolName: "read", status: "done" } };
	const a2 = { id: "a2", agentId: "a", role: "assistant", text: "查完了", timestamp: 4, stopReason: "stop" };
	const rendered = groupToolMessages([user, a1, tool, a2]);
	assert.equal(JSON.stringify(outlineRuns(rendered)), JSON.stringify(["card:user", "run[assistant:先查一下|assistant:查完了]"]));
});

test("customMessage 卡片落在两轮之间，并断开当前 run", () => {
	const { groupToolMessages } = loadAppUtils();
	const user = { id: "u1", agentId: "a", role: "user", text: "问题", timestamp: 1 };
	const a1 = { id: "a1", agentId: "a", role: "assistant", text: "上一轮回答", timestamp: 2, stopReason: "stop" };
	const card = {
		id: "cm1",
		agentId: "a",
		role: "system",
		text: "Background task completed: **delegate**",
		timestamp: 3,
		meta: { type: "customMessage", customType: "subagent-notify" },
	};
	const a2 = { id: "a2", agentId: "a", role: "assistant", text: "唤醒后的回答", timestamp: 4, stopReason: "stop" };
	const rendered = groupToolMessages([user, a1, card, a2]);
	assert.equal(JSON.stringify(outlineRuns(rendered)), JSON.stringify(["card:user", "run[assistant:上一轮回答]", "card:customMessage", "run[assistant:唤醒后的回答]"]));
});

test("askQuestion 卡片仍不打断 run（自定义通知卡的边界规则不误伤既有语义）", () => {
	const { groupToolMessages } = loadAppUtils();
	const ask = {
		id: "q1",
		agentId: "a",
		role: "system",
		text: "请选择",
		timestamp: 2,
		meta: { type: "askQuestion" },
	};
	const a1 = { id: "a1", agentId: "a", role: "assistant", text: "问题一", timestamp: 3, stopReason: "toolUse" };
	const a2 = { id: "a2", agentId: "a", role: "assistant", text: "问题二", timestamp: 4, stopReason: "toolUse" };
	const rendered = groupToolMessages([{ id: "u1", agentId: "a", role: "user", text: "问题", timestamp: 1 }, ask, a1, a2]);
	// 卡片原位落盘、run 保持完整（两张 assistant 属同一轮）——既有语义不变。
	assert.equal(JSON.stringify(outlineRuns(rendered)), JSON.stringify(["card:user", "card:askQuestion", "run[assistant:问题一|assistant:问题二]"]));
});

test("重试状态消息收进当前 run 过程序列：不拆 run、紧跟触发它的工具/思考", () => {
	const { groupToolMessages } = loadAppUtils();
	// 场景（用户截图 m00001）：请求失败 → pi 调度自动重试 → 重试成功后继续回答。
	// 旧实现把重试状态消息（role=system, meta.i18nKey=diagnostic.retry*）当独立卡片
	// 插在工具调用与后续回答之间（割裂/错序根因）；现在收进 run 内作为过程条目。
	const user = { id: "u1", agentId: "a", role: "user", text: "问题", timestamp: 1 };
	const a1 = { id: "a1", agentId: "a", role: "assistant", text: "阶段回复", timestamp: 2, stopReason: "toolUse" };
	const retryRunning = { id: "r1", agentId: "a", role: "system", text: "正在自动重试 1/8，5 秒后重试", timestamp: 3, meta: { i18nKey: "diagnostic.retryScheduledAfterDelay", status: "running", attempt: 1, maxAttempts: 8 } };
	const retryOk = { id: "r2", agentId: "a", role: "system", text: "自动重试成功，共重试 1 次", timestamp: 4, meta: { i18nKey: "diagnostic.retrySucceeded", status: "success", attempt: 1 } };
	const a2 = { id: "a2", agentId: "a", role: "assistant", text: "最终回答", timestamp: 5, stopReason: "stop" };
	const rendered = groupToolMessages([user, a1, retryRunning, retryOk, a2]);
	assert.equal(JSON.stringify(outlineRuns(rendered)), JSON.stringify(["card:user", "run[assistant:阶段回复|assistant:最终回答]"]), "重试消息不得拆 run/独立成卡");
	const run = rendered.find((item) => item.kind === "agent-run");
	const retries = run.items.filter((item) => item.kind === "retry-group");
	// 两条重试状态都按原始时序保留在 run 内（同 id upsert 的收敛卡与运行卡各占一条）
	assert.equal(retries.length, 2);
	assert.equal(retries[0].id, "r1");
	assert.equal(retries[1].id, "r2");
	// 时序：retry 行位于 assistant 消息之间（紧跟阶段回复之后）
	const kinds = run.items.map((item) => item.kind);
	assert.equal(JSON.stringify(kinds), JSON.stringify(["message", "retry-group", "retry-group", "message"]));
});

test("重试状态消息在 run 未开始时保持独立条目：不凭空造空 run", () => {
	const { groupToolMessages } = loadAppUtils();
	// 场景：首轮请求立即失败（无任何工具/思考/回答），重试卡无所属 run，保持独立卡片。
	const retryRunning = { id: "r1", agentId: "a", role: "system", text: "正在自动重试 1/8", timestamp: 2, meta: { i18nKey: "diagnostic.retryScheduled", status: "running" } };
	const a1 = { id: "a1", agentId: "a", role: "assistant", text: "恢复后的回答", timestamp: 3, stopReason: "stop" };
	const rendered = groupToolMessages([retryRunning, a1]);
	// 重试卡独立落盘在 run 之前；assistant 正常成 run（不把重试卡卷进去）
	assert.equal(rendered[0].kind, "message");
	assert.equal(rendered[0].message.meta.i18nKey, "diagnostic.retryScheduled");
	const run = rendered[1];
	assert.equal(run.kind, "agent-run");
	assert.equal(run.items.length, 1);
	assert.equal(run.items[0].kind, "message");
});

test("非重试 system 消息仍走旧路径：askQuestion/customMessage 边界不受影响", () => {
	const { groupToolMessages } = loadAppUtils();
	const ask = { id: "q1", agentId: "a", role: "system", text: "请选择", timestamp: 2, meta: { type: "askQuestion" } };
	const a1 = { id: "a1", agentId: "a", role: "assistant", text: "回答", timestamp: 3, stopReason: "stop" };
	const rendered = groupToolMessages([{ id: "u1", agentId: "a", role: "user", text: "问题", timestamp: 1 }, ask, a1]);
	assert.equal(JSON.stringify(outlineRuns(rendered)), JSON.stringify(["card:user", "card:askQuestion", "run[assistant:回答]"]));
});

test("buildTurnDisplay：retry-group 映射为 retry-entry 过程行，时序原位保持", () => {
	const retryMsg = { id: "r1", agentId: "a", role: "system", text: "正在自动重试 1/8，5 秒后重试", timestamp: 3, meta: { i18nKey: "diagnostic.retryScheduledAfterDelay", status: "running" } };
	const failedMsg = { id: "r2", agentId: "a", role: "system", text: "自动重试失败，已重试 8/8 次", timestamp: 4, meta: { i18nKey: "diagnostic.retryFailed", status: "error" } };
	const run = runOf([toolGroup(), { kind: "retry-group", id: retryMsg.id, message: retryMsg }, { kind: "retry-group", id: failedMsg.id, message: failedMsg }]);
	const items = buildTurnDisplay(run, { showThinking: true });
	assert.deepEqual(outline(items), ["tool", "retry:diagnostic.retryScheduledAfterDelay", "retry:diagnostic.retryFailed"]);
	// 重试行是可折叠内容（参与 run 级折叠开关与汇总按钮）
	assert.equal(hasFoldableContent(items), true);
	// 汇总统计：工具 1 + 重试 2（思考 0、中间回复 0、错误 0）
	assert.deepEqual(buildProcessSummary(items), { toolCount: 1, thinkingCount: 0, interimCount: 0, retryCount: 2, errorCount: 0 });
});

test("buildTurnDisplay：error-group 映射为 error-entry 过程行，时序原位保持，计入 errorCount", () => {
	// 429 错误诊断（diagnostic.requestFailed*）与重试行同构：折叠进工具调用，可点开详情。
	// 场景：工具 → 请求失败诊断 → 最终回答。
	const errMsg = { id: "e1", agentId: "a", role: "error", text: "请求失败", timestamp: 3, meta: { i18nKey: "diagnostic.requestFailed", errorMessage: "429 Too Many Requests" } };
	const run = runOf([toolGroup(), { kind: "error-group", id: errMsg.id, message: errMsg }, { kind: "message", message: assistantMessage("最终回答", undefined, "stop") }]);
	const items = buildTurnDisplay(run, { showThinking: true });
	assert.deepEqual(outline(items), ["tool", "error:diagnostic.requestFailed", "final:最终回答"]);
	// 错误行是可折叠内容（参与 run 级折叠开关与汇总按钮）
	assert.equal(hasFoldableContent(items), true);
	// 汇总统计：工具 1 + 错误 1，其余为 0
	assert.deepEqual(buildProcessSummary(items), { toolCount: 1, thinkingCount: 0, interimCount: 0, retryCount: 0, errorCount: 1 });
});

test("buildTurnDisplay：仅重试行的 run 也有折叠内容；summary retryCount 驱动汇总按钮", () => {
	const retryMsg = { id: "r1", agentId: "a", role: "system", text: "自动重试成功，共重试 1 次", timestamp: 3, meta: { i18nKey: "diagnostic.retrySucceeded", status: "success" } };
	const run = runOf([{ kind: "retry-group", id: retryMsg.id, message: retryMsg }]);
	const items = buildTurnDisplay(run, { showThinking: true });
	assert.deepEqual(outline(items), ["retry:diagnostic.retrySucceeded"]);
	assert.equal(hasFoldableContent(items), true);
	const summary = buildProcessSummary(items);
	assert.equal(summary.retryCount, 1);
	assert.equal((summary.toolCount | summary.thinkingCount | summary.interimCount) === 0 && summary.retryCount > 0, true, "仅重试行也应显示汇总（避免重试痕迹被折叠头吞掉）");
});

test("重试行时序：retry 到来时未成组的工具先 flush，重试行严格晚于前面的工具", () => {
	const { groupToolMessages } = loadAppUtils();
	// 场景：assistant(toolUse) → tool 事件已到但尚未 flush（currentTools 暂存中）→ retry 状态
	// 旧 flushThinking-only 写法会把 retry 推进 run、工具之后才 flushTools 成组 → 顺序颠倒。
	const user = { id: "u1", agentId: "a", role: "user", text: "问题", timestamp: 1 };
	const tool = { id: "t1", agentId: "a", role: "tool", text: "✓ read", timestamp: 2, meta: { toolName: "read", status: "done" } };
	const retry = { id: "r1", agentId: "a", role: "system", text: "正在自动重试 1/8", timestamp: 3, meta: { i18nKey: "diagnostic.retryScheduled", status: "running" } };
	const rendered = groupToolMessages([user, tool, retry]);
	const run = rendered.find((item) => item.kind === "agent-run");
	assert.ok(run, "tool + retry 应组成同一 run");
	const kinds = run.items.map((item) => item.kind);
	assert.equal(JSON.stringify(kinds), JSON.stringify(["tool-group", "retry-group"]), "重试行必须晚于它之前的工具组");
});
