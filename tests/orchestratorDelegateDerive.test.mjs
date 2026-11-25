/**
 * 编排插件适配（#598）：
 * - 裸 `delegate`（及名字带 delegate 的编排工具）派发 → running 子代理条目
 * - `custom_message` 的 `orchestrator-run-result` 按 runId 归并终态 / 摘要 / 子会话文件
 * - 体积约束：results[].messages 从不进投影（单条实测约 381 KB）
 * - 状态归一：done/cancelled/pending 等词表映射到 PiDeck 七态
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { deriveDelegateEntries, deriveToolSubagentEntries, isSubagentDerivationInput } = loadTsCommonJs("src/main/pi/derivedSubagents.ts");
const { parseOrchestratorRunResult, normalizeOrchestratorStatus, isOrchestratorResultEntry } = loadTsCommonJs("src/main/pi/orchestratorRunResult.ts");

let seq = 0;
const entryId = () => `e${(seq += 1)}`;

function delegateCall({ toolCallId, name = "delegate", args, timestamp = "2026-01-01T00:00:00.000Z" }) {
	return { type: "message", id: entryId(), timestamp, message: { role: "assistant", content: [{ type: "toolCall", id: toolCallId, name, arguments: args }] } };
}

function delegateResult({ toolCallId, toolName = "delegate", text, isError = false, timestamp = "2026-01-01T00:00:01.000Z" }) {
	return { type: "message", id: entryId(), timestamp, message: { role: "toolResult", toolCallId, toolName, isError, content: [{ type: "text", text }] } };
}

function orchestratorResult(payload, { customType = "orchestrator-run-result", timestamp = "2026-01-01T00:01:00.000Z" } = {}) {
	return { type: "custom_message", id: entryId(), timestamp, customType, display: true, content: JSON.stringify(payload) };
}

test("裸 delegate 派发推导出 running 条目，runId 记入反查表后由编排结果收尾", () => {
	const entries = deriveDelegateEntries([delegateCall({ toolCallId: "call_1", args: { agent: "Explore", task: "找一下限流实现", runId: "run_abc" } }), orchestratorResult({ runId: "run_abc", action: "done", tasks: [{ agent: "Explore", status: "done", durationMs: 4200, turns: 6 }] })]);
	assert.equal(entries.length, 1);
	const entry = entries[0];
	assert.equal(entry.id, "call_1");
	assert.equal(entry.type, "Explore");
	assert.equal(entry.description, "找一下限流实现");
	assert.equal(entry.status, "completed");
	assert.equal(entry.via, "delegate-tool");
	assert.equal(entry.toolUses, 1);
	// 摘要正文：计数 + 每任务一行，不含原文
	assert.match(entry.result, /1 task/);
	assert.match(entry.result, /Explore · completed · 4\.2s · 6 turns/);
	assert.equal(entry.completedAt, Date.parse("2026-01-01T00:01:00.000Z"));
});

test("名字里带 delegate 的其它编排工具同样识别（不靠白名单）", () => {
	const entries = deriveDelegateEntries([
		delegateCall({
			toolCallId: "call_2",
			name: "team_delegate",
			args: {
				tasks: [
					{ agent: "Plan", task: "拆任务" },
					{ agent: "Explore", task: "读代码" },
				],
			},
		}),
	]);
	assert.equal(entries.length, 1);
	assert.equal(entries[0].type, "Plan");
	assert.equal(entries[0].toolUses, 2);
	assert.equal(entries[0].description, "拆任务, 读代码");
});

test("非委托工具不推导：subagent 白名单工具与无委托字段的 delegate 名都不算", () => {
	const entries = deriveDelegateEntries([
		// 白名单工具由各自的专用链负责，这里不得重复造条目
		delegateCall({ toolCallId: "call_3", name: "acp_delegate", args: { agent: "Explore", task: "x" } }),
		delegateCall({ toolCallId: "call_4", name: "subagent", args: { agent: "Explore", task: "x" } }),
		// 名字像但没有 agent/tasks/runId：可能是 delegate_help 之类的普通工具
		delegateCall({ toolCallId: "call_5", name: "delegate_help", args: { topic: "usage" } }),
		delegateCall({ toolCallId: "call_6", name: "read", args: { path: "a.ts" } }),
	]);
	assert.equal(entries.length, 0);
});

test("失败 / 取消的编排结果映射到 error / stopped", () => {
	const failed = deriveDelegateEntries([delegateCall({ toolCallId: "c1", args: { agent: "Explore", runId: "r1" } }), orchestratorResult({ runId: "r1", action: "failed", tasks: [{ agent: "Explore", status: "failed", summary: "boom" }] })]);
	assert.equal(failed[0].status, "error");
	assert.match(failed[0].result, /boom/);

	const cancelled = deriveDelegateEntries([delegateCall({ toolCallId: "c2", args: { agent: "Explore", runId: "r2" } }), orchestratorResult({ runId: "r2", action: "cancelled" })]);
	assert.equal(cancelled[0].status, "stopped");
});

test("没有 runId 的插件：只有单一未完成条目时才归并（多路并行不猜）", () => {
	const single = deriveDelegateEntries([delegateCall({ toolCallId: "only", args: { agent: "Explore" } }), orchestratorResult({ runId: "r-unknown", action: "done" })]);
	assert.equal(single[0].status, "completed");

	const parallel = deriveDelegateEntries([delegateCall({ toolCallId: "a", args: { agent: "Explore" } }), delegateCall({ toolCallId: "b", args: { agent: "Plan" } }), orchestratorResult({ runId: "r-unknown", action: "done" })]);
	assert.deepEqual([...parallel.map((entry) => entry.status)], ["running", "running"]);
});

test("任务自带 sessionFile 时回填 childSessionPath（渲染层据此打开子会话）", () => {
	const entries = deriveDelegateEntries([delegateCall({ toolCallId: "c1", args: { agent: "Explore", runId: "r1" } }), orchestratorResult({ runId: "r1", action: "done", tasks: [{ agent: "Explore", status: "done", sessionFile: "C:\\sessions\\child.jsonl" }] })]);
	assert.equal(entries[0].childSessionPath, "C:\\sessions\\child.jsonl");
	// 相对路径/占位符不当作可打开的子会话
	const relative = deriveDelegateEntries([delegateCall({ toolCallId: "c2", args: { agent: "Explore", runId: "r2" } }), orchestratorResult({ runId: "r2", action: "done", tasks: [{ agent: "Explore", status: "done", sessionFile: "sessions/child.jsonl" }] })]);
	assert.equal(relative[0].childSessionPath, undefined);
});

test("体积约束：381 KB 的 results[].messages 不进投影，摘要保持精简", () => {
	// 造一条与用户实测同量级的载荷：每个任务带 120 KB 消息正文
	const bulk = `${"x".repeat(200_000)}`;
	const payload = {
		runId: "run_big",
		action: "done",
		tasks: [
			{ agent: "Explore", status: "done", durationMs: 1000, turns: 3, sessionFile: "/home/u/.pi/agent/sessions/child1.jsonl" },
			{ agent: "Plan", status: "done", durationMs: 2000, turns: 4, sessionFile: "/home/u/.pi/agent/sessions/child2.jsonl" },
		],
		results: [
			{
				agent: "Explore",
				messages: [
					{ role: "user", content: bulk },
					{ role: "assistant", content: bulk },
				],
			},
			{ agent: "Plan", messages: [{ role: "assistant", content: bulk }] },
		],
	};
	const raw = JSON.stringify(payload);
	assert.ok(raw.length > 600_000, `载荷应达到实测量级，实际 ${raw.length}`);
	const update = parseOrchestratorRunResult(orchestratorResult(payload));
	assert.ok(update);
	assert.ok(update.summary.length <= 2000, `摘要必须限长，实际 ${update.summary.length}`);
	assert.ok(!update.summary.includes("xxxxxxxxxx"), "摘要不得包含消息正文");
	// 任务摘要只保留标量：不复制 messages
	assert.equal(update.tasks.length, 2);
	assert.deepEqual(Object.keys(update.tasks[0]).sort(), ["agent", "durationMs", "sessionFile", "status", "turns"]);

	const entries = deriveDelegateEntries([delegateCall({ toolCallId: "c-big", args: { agent: "Explore", runId: "run_big" } }), orchestratorResult(payload)]);
	// 投影后的条目（会一路进 IPC/渲染层）必须远小于原始载荷
	const entrySize = JSON.stringify(entries[0]).length;
	assert.ok(entrySize < 4000, `推导条目应保持精简，实际 ${entrySize}`);
	assert.ok(!JSON.stringify(entries[0]).includes("xxxxxxxxxx"));
});

test("状态词归一：done/cancelled/pending/error 等外部词表映射到 PiDeck 七态", () => {
	const cases = [
		["done", "completed"],
		["completed", "completed"],
		["failed", "error"],
		["error", "error"],
		["cancelled", "stopped"],
		["canceled", "stopped"],
		["aborted", "stopped"],
		["running", "running"],
		["started", "running"],
		["pending", "queued"],
		["queued", "queued"],
		["done!", undefined],
	];
	for (const [input, expected] of cases) {
		assert.equal(normalizeOrchestratorStatus(input), expected, `${input} → ${expected}`);
	}
	assert.equal(normalizeOrchestratorStatus(undefined), undefined);
});

test("解析容错：非编排条目 / 缺 runId / content 是纯文本时都不抛错", () => {
	assert.equal(parseOrchestratorRunResult({ type: "message", message: {} }), undefined);
	assert.equal(parseOrchestratorRunResult(orchestratorResult({ action: "done" })), undefined, "缺 runId 无法归并");
	// content 不是 JSON 时退回结构化字段；两者都没有就放弃
	assert.equal(isOrchestratorResultEntry({ customType: "orchestrator-run-result" }), true);
	assert.equal(isOrchestratorResultEntry({ customType: "subagent-notify" }), false);
	const plainText = { type: "custom_message", customType: "orchestrator-run-result", content: "delegated to Explore" };
	assert.equal(parseOrchestratorRunResult(plainText), undefined);
	// data 形态（插件把载荷放 data 里）也能解析
	const nested = parseOrchestratorRunResult({ type: "custom_message", customType: "orchestrator-run-result", data: { runId: "r9", action: "done", tasks: [{ agent: "Explore", status: "done" }] } });
	assert.equal(nested.runId, "r9");
	assert.equal(nested.status, "completed");
});

test("编排结果条目被增量扫描预检接纳（否则整条链读不到）", () => {
	assert.equal(isSubagentDerivationInput(orchestratorResult({ runId: "r1", action: "done" })), true);
	assert.equal(isSubagentDerivationInput({ type: "custom_message", customType: "subagent-notify", content: "x" }), false);
	// 三条链合并后：acp / subagent 工具 / 裸 delegate 互不重复
	const entries = deriveToolSubagentEntries([delegateCall({ toolCallId: "c1", args: { agent: "Explore", runId: "r1" } }), orchestratorResult({ runId: "r1", action: "done" })]);
	assert.equal(entries.length, 1);
	assert.equal(entries[0].via, "delegate-tool");
});
