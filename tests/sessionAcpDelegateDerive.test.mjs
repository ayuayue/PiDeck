/**
 * acp_delegate（billion-context-pi）子代理条目推导行为验证：
 * - 派发 toolCall → running 条目（id=toolCallId、via 标记、幂等）
 * - [acp_delegate completed] 系统通知 → completed + completedAt
 * - [acp_delegate FAILED ⚠️] 通知 → error + Output ~~~ 块错误摘录
 * - acp_delegate_cancel toolCall（runId 反查）→ stopped
 * - 无法关联回派发的通知/取消被忽略（fail-soft）
 * - mergeSubagentSources：record 权威；裸 stopped record（锚点壳）让位给推导终态
 * - downgradeStaleRunning：仅 toolcall 来源的 running/queued 降级
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { deriveAcpDelegateEntries, mergeSubagentSources, downgradeStaleRunning } = loadTsCommonJs("src/main/pi/derivedSubagents.ts");

let seq = 0;
function entryId() {
	seq += 1;
	return `e${seq}`;
}

/** assistant 消息里的工具调用条目（真实 JSONL 形态：content[].type === "toolCall"）。 */
function toolCallEntry({ toolCallId, name = "acp_delegate", args, timestamp }) {
	return {
		type: "message",
		id: entryId(),
		parentId: null,
		timestamp,
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: toolCallId, name, arguments: args }],
		},
	};
}

function toolResultEntry({ toolCallId, toolName = "acp_delegate", text, timestamp }) {
	return {
		type: "message",
		id: entryId(),
		parentId: null,
		timestamp,
		message: {
			role: "toolResult",
			toolCallId,
			toolName,
			content: [{ type: "text", text }],
		},
	};
}

function userEntry({ text, timestamp }) {
	return {
		type: "message",
		id: entryId(),
		parentId: null,
		timestamp,
		message: { role: "user", content: [{ type: "text", text }] },
	};
}

const DISPATCH = "acp_delegate_111";
const RUN_ID = "del_abc123";
const T0 = "2026-08-30T13:39:40.253Z";
const T1 = "2026-08-30T13:40:11.728Z";

function dispatchFixture() {
	return [
		toolCallEntry({
			toolCallId: DISPATCH,
			args: { agent: "worker", task: "Generate a markdown file", cwd: "/tmp" },
			timestamp: T0,
		}),
		toolResultEntry({
			toolCallId: DISPATCH,
			text: `Delegated to **worker** (runId \`${RUN_ID}\`).\nTask: Generate a markdown file\nRunning in the background at \`/tmp\`.`,
			timestamp: T0,
		}),
	];
}

test("derive: 派发 toolCall 推导 running 条目（id=toolCallId、via、source）", () => {
	const entries = deriveAcpDelegateEntries(dispatchFixture());
	assert.equal(entries.length, 1);
	// 逐字段断言：loadTsCommonJs 的 VM realm 与本文件原型不同，整对象 deepEqual 不可用
	const entry = entries[0];
	assert.equal(entry.id, DISPATCH);
	assert.equal(entry.type, "worker");
	assert.equal(entry.description, "Generate a markdown file");
	assert.equal(entry.status, "running");
	assert.equal(entry.startedAt, Date.parse(T0));
	assert.equal(entry.source, "toolcall");
	assert.equal(entry.via, "acp-delegate");
});

test("derive: completed 系统通知 → completed + completedAt", () => {
	const entries = deriveAcpDelegateEntries([
		...dispatchFixture(),
		userEntry({
			timestamp: T1,
			text: `[acp_delegate completed] **worker** (runId \`${RUN_ID}\`, exit 0) No delegates are currently running.\n\nTask: Generate a markdown file\n\nFull result: \`C:/tmp/${RUN_ID}.out\``,
		}),
	]);
	assert.equal(entries[0].status, "completed");
	assert.equal(entries[0].completedAt, Date.parse(T1));
	assert.equal(entries[0].error, undefined);
});

test("derive: FAILED 通知 → error + Output ~~~ 块错误摘录", () => {
	const entries = deriveAcpDelegateEntries([
		...dispatchFixture(),
		userEntry({
			timestamp: T1,
			text: `[acp_delegate FAILED ⚠️] **worker** (runId \`${RUN_ID}\`, exit ?) No delegates are currently running. This delegate did NOT complete its task.\n\nTask: Generate a markdown file\n\n(result could not be persisted to a file)\n\nOutput:\n~~~\nspawn error: Error: spawn node.exe ENOENT\n~~~`,
		}),
	]);
	assert.equal(entries[0].status, "error");
	assert.equal(entries[0].completedAt, Date.parse(T1));
	assert.ok(entries[0].error?.includes("spawn node.exe ENOENT"));
});

test("derive: cancel toolCall 按 runId 反查 → stopped", () => {
	const entries = deriveAcpDelegateEntries([
		...dispatchFixture(),
		toolCallEntry({
			toolCallId: "acp_delegate_cancel_x1",
			name: "acp_delegate_cancel",
			args: { runId: RUN_ID },
			timestamp: T1,
		}),
	]);
	assert.equal(entries[0].status, "stopped");
	assert.equal(entries[0].completedAt, Date.parse(T1));
});

test("derive: 无法关联回派发的通知被忽略（无派发确认文本时）", () => {
	const entries = deriveAcpDelegateEntries([
		toolCallEntry({ toolCallId: DISPATCH, args: { agent: "worker", task: "T" }, timestamp: T0 }),
		// 派发确认缺失 → runId 映射不存在 → 通知无处可挂
		userEntry({ timestamp: T1, text: `[acp_delegate completed] **worker** (runId \`${RUN_ID}\`, exit 0)` }),
	]);
	assert.equal(entries.length, 1);
	assert.equal(entries[0].status, "running");
});

test("derive: 非 acp 工具与重复派发不产生重复/无关条目", () => {
	const entries = deriveAcpDelegateEntries([
		...dispatchFixture(),
		toolCallEntry({ toolCallId: "bash_1", name: "bash", args: { command: "ls" }, timestamp: T0 }),
		// 同 id 重放（fork 重放场景）幂等
		toolCallEntry({ toolCallId: DISPATCH, args: { agent: "worker", task: "T" }, timestamp: T0 }),
	]);
	assert.equal(entries.length, 1);
	assert.equal(entries[0].description, "Generate a markdown file");
});

test("derive: 损坏条目被跳过", () => {
	const entries = deriveAcpDelegateEntries([null, "junk", { type: "message" }, toolCallEntry({ toolCallId: DISPATCH, args: { agent: "worker", task: "T" }, timestamp: T0 })]);
	assert.equal(entries.length, 1);
});

test("merge: record 权威，推导条目只补缺；按 startedAt 降序", () => {
	const records = [
		{
			id: "pi-sub-1",
			type: "Explore",
			description: "d",
			status: "completed",
			source: "record",
		},
	];
	const derived = [
		{ id: "pi-sub-1", type: "worker", description: "x", status: "completed", source: "toolcall", via: "acp-delegate" },
		{ id: DISPATCH, type: "worker", description: "y", status: "running", startedAt: 100, source: "toolcall", via: "acp-delegate" },
	];
	const merged = mergeSubagentSources(records, derived);
	assert.equal(merged.length, 2);
	assert.equal(merged[0].id, DISPATCH); // startedAt 100 靠前
	assert.equal(merged[1].id, "pi-sub-1");
	assert.equal(merged[1].type, "Explore"); // record 原样保留
});

test("merge: 裸 stopped record（锚点壳，无 result/error）让位给推导终态", () => {
	// 场景：桥接只写了 start 锚点（读取侧合成 stopped 壳），会话文件里终态通知
	// 携带真实结局 —— 推导条目更准确，应覆盖。
	const records = [
		{
			id: DISPATCH,
			type: "worker",
			description: "Generate",
			status: "stopped",
			source: "record",
		},
	];
	const derived = [
		{
			id: DISPATCH,
			type: "worker",
			description: "Generate",
			status: "completed",
			startedAt: Date.parse(T0),
			completedAt: Date.parse(T1),
			source: "toolcall",
			via: "acp-delegate",
		},
	];
	const merged = mergeSubagentSources(records, derived);
	assert.equal(merged.length, 1);
	assert.equal(merged[0].status, "completed");
});

test("merge: record 携带 result/error 时不被推导覆盖", () => {
	const records = [
		{
			id: DISPATCH,
			type: "worker",
			description: "Generate",
			status: "stopped",
			result: "real result text",
			source: "record",
		},
	];
	const derived = [
		{
			id: DISPATCH,
			type: "worker",
			description: "Generate",
			status: "completed",
			startedAt: Date.parse(T0),
			completedAt: Date.parse(T1),
			source: "toolcall",
			via: "acp-delegate",
		},
	];
	const merged = mergeSubagentSources(records, derived);
	assert.equal(merged[0].status, "stopped");
	assert.equal(merged[0].result, "real result text");
});

test("downgrade: 全部来源的 running/queued 降级为 stopped（含 record 残留）", () => {
	const entries = [
		{ id: "a", type: "worker", description: "", status: "running", source: "toolcall", via: "acp-delegate" },
		{ id: "b", type: "worker", description: "", status: "queued", source: "toolcall", via: "acp-delegate" },
		{ id: "c", type: "Explore", description: "", status: "running", source: "record" },
		{ id: "d", type: "worker", description: "", status: "completed", source: "toolcall", via: "acp-delegate" },
	];
	const downgraded = downgradeStaleRunning(entries);
	assert.equal(downgraded[0].status, "stopped");
	assert.equal(downgraded[1].status, "stopped");
	// record 源不再豁免：无活 runtime 时不存在「插件自己在管」的子代理，
	// 残留 running 若不降级会在历史视图里永久亮着「运行中」（用户实测）
	assert.equal(downgraded[2].status, "stopped");
	// 终态不动
	assert.equal(downgraded[3].status, "completed");
});

test("downgrade: 无可降级条目时返回原数组", () => {
	const entries = [{ id: "a", type: "w", description: "", status: "completed", source: "toolcall", via: "acp-delegate" }];
	assert.equal(downgradeStaleRunning(entries), entries);
});

test("merge: record 缺描述时用推导条目补齐（异步链终态 record 不带 task 文本）", () => {
	// 场景：pi-subagents 异步 run 的终态由桥接扩展落 subagents:record（事件 payload
	// 里没有 task），任务文本只有派发 args.task（推导条目）能提供。record 仍是终态
	// 权威，只回填空描述——否则面板行会丢掉任务文案。
	const records = [{ id: "async-run-1", type: "worker", description: "", status: "completed", startedAt: 1000, completedAt: 2000, source: "record" }];
	const derived = [{ id: "async-run-1", type: "worker", description: "目标：迁移 vm 沙箱", status: "running", startedAt: 1000, source: "toolcall", via: "pi-subagents-tool" }];
	const merged = mergeSubagentSources(records, derived);
	assert.equal(merged.length, 1);
	assert.equal(merged[0].status, "completed");
	assert.equal(merged[0].source, "record");
	assert.equal(merged[0].description, "目标：迁移 vm 沙箱");
	// record 自带描述时不被推导覆盖
	const withText = mergeSubagentSources([{ ...records[0], description: "record 文本" }], derived);
	assert.equal(withText[0].description, "record 文本");
});
