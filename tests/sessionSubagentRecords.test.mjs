/**
 * SessionHistoryReader.readSubagentRecords 行为验证：
 * - 正确解析 subagents:record custom 条目
 * - status 白名单校验（非法值丢弃）
 * - 非 subagents:record 的 custom 条目不混入
 * - 损坏行忽略
 * - 排序（startedAt 降序）
 * - fork 旁支上的 record 不丢失（全量条目表扫描）
 * - 同一子代理 id 多条 record 时保留文件序最新一条
 * - start 锚点（pi-deck-subagent-start）残留时合成 stopped；被 record 覆盖时以 record 为准
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { SessionHistoryReader } = loadTsCommonJs("src/main/pi/SessionHistoryReader.ts");

const T0 = "2026-08-02T11:46:21.399Z";
test("readDerivedSubagentEntries：(size,mtime) 结果缓存——文件未变不重扫，追加后失效（2027-02 性能治理）", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-derived-cache-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const filePath = join(dir, "session.jsonl");
	const subagentCall = (id, agent) =>
		JSON.stringify({
			type: "message",
			id,
			parentId: null,
			timestamp: T0,
			message: { role: "assistant", content: [{ type: "toolCall", id: `call-${id}`, name: "subagent", arguments: { agent, task: "t" } }] },
		});
	writeSession(filePath, `${subagentCall("c1", "researcher")}\n`);
	const reader = createReader();

	const first = await reader.readDerivedSubagentEntries(filePath);
	assert.equal(first.length, 1, "前置：推导出一个 running 子代理");

	// 文件未动（size/mtime 不变）：缓存必须命中（判据契约，与 displayIndex/summaryCache
	// 同款——流式追加必然同时改变 size 与 mtime，判据足够发现变化）。
	const second = await reader.readDerivedSubagentEntries(filePath);
	assert.ok(second === first, "size/mtime 未变必须返回缓存的原数组引用（不重扫）");

	// 追加一条新派发：文件变化（size/mtime 变）→ 失效重扫，结果更新
	await new Promise((resolve) => setTimeout(resolve, 20));
	writeSession(filePath, `${subagentCall("c1", "researcher")}\n${subagentCall("c2", "coder")}\n`);
	const third = await reader.readDerivedSubagentEntries(filePath);
	assert.equal(third.length, 2, "文件追加后缓存失效，重扫得到两个子代理");
});

function createReader() {
	return new SessionHistoryReader({
		toHostPath: (sessionPath) => sessionPath,
		convertMessages: (_agentId, rawMessages, _entryIds) => rawMessages.map((m, i) => ({ id: `msg-${i}`, role: m.role, text: "" })),
		trimMessages: (messages) => messages,
		translate: () => "",
	});
}

function writeSession(filePath, contents) {
	writeFileSync(filePath, contents, "utf8");
}

const fixture =
	JSON.stringify({
		type: "session",
		id: "session-1",
		cwd: "/tmp",
		timestamp: new Date().toISOString(),
	}) +
	"\n" +
	JSON.stringify({
		type: "message",
		id: "u1",
		parentId: "session-1",
		message: { role: "user", content: [{ type: "text", text: "hello" }] },
	}) +
	"\n" +
	JSON.stringify({
		type: "message",
		id: "a1",
		parentId: "u1",
		message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
	}) +
	"\n" +
	JSON.stringify({
		type: "custom",
		customType: "subagents:record",
		id: "rec-1",
		parentId: "a1",
		data: {
			id: "agent-abc12345",
			type: "Explore",
			description: "Find auth files",
			status: "completed",
			result: "Found 3 auth files",
			startedAt: 1700000000000,
			completedAt: 1700000005000,
		},
	}) +
	"\n" +
	JSON.stringify({
		type: "custom",
		customType: "subagents:record",
		id: "rec-2",
		parentId: "rec-1",
		data: {
			id: "agent-def67890",
			type: "code",
			description: "Implement login",
			status: "running",
			startedAt: 1700000010000,
		},
	}) +
	"\n" +
	JSON.stringify({
		type: "custom",
		customType: "subagents:record",
		id: "rec-3",
		parentId: "rec-2",
		data: {
			id: "agent-ghi11111",
			type: "Explore",
			description: "Status error",
			status: "error",
			error: "timeout",
			startedAt: 1700000020000,
			completedAt: 1700000030000,
		},
	}) +
	"\n" +
	// Bad entry: invalid status
	JSON.stringify({
		type: "custom",
		customType: "subagents:record",
		id: "rec-4",
		parentId: "rec-3",
		data: {
			id: "agent-bad",
			type: "code",
			description: "bad status",
			status: "INVALID",
			startedAt: 1700000040000,
		},
	}) +
	"\n" +
	// Non-subagent custom entry (child-session) — should be ignored
	JSON.stringify({
		type: "custom",
		customType: "pi-subagents.child-session",
		id: "rec-5",
		parentId: "rec-4",
		data: { schemaVersion: 1 },
	}) +
	"\n";

test("readSubagentRecords parses valid subagents:record entries", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pid-subagent-records-"));
	const sessionPath = join(dir, "session.jsonl");
	try {
		writeSession(sessionPath, fixture);
		const reader = createReader();
		const entries = await reader.readSubagentRecords(sessionPath);

		// 3 valid entries (rec-4 excluded for bad status, rec-5 excluded for wrong customType)
		assert.equal(entries.length, 3);

		// Sorted by startedAt desc
		assert.equal(entries[0].id, "agent-ghi11111"); // 1700000020000
		assert.equal(entries[1].id, "agent-def67890"); // 1700000010000
		assert.equal(entries[2].id, "agent-abc12345"); // 1700000000000

		// Check field projection
		const completedEntry = entries[2]; // agent-abc12345
		assert.equal(completedEntry.type, "Explore");
		assert.equal(completedEntry.description, "Find auth files");
		assert.equal(completedEntry.status, "completed");
		assert.equal(completedEntry.result, "Found 3 auth files");
		assert.equal(completedEntry.startedAt, 1700000000000);
		assert.equal(completedEntry.completedAt, 1700000005000);
		assert.equal(completedEntry.source, "record");

		const runningEntry = entries[1]; // agent-def67890
		assert.equal(runningEntry.status, "running");
		assert.equal(runningEntry.result, undefined);
		assert.equal(runningEntry.completedAt, undefined);

		const errorEntry = entries[0]; // agent-ghi11111
		assert.equal(errorEntry.status, "error");
		assert.equal(errorEntry.error, "timeout");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("readSubagentRecords returns empty for session with no subagent records", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pid-subagent-empty-"));
	const sessionPath = join(dir, "session.jsonl");
	try {
		const noRecords =
			JSON.stringify({
				type: "session",
				id: "s1",
				cwd: "/tmp",
				timestamp: new Date().toISOString(),
			}) +
			"\n" +
			JSON.stringify({
				type: "message",
				id: "u1",
				parentId: "s1",
				message: { role: "user", content: [{ type: "text", text: "hi" }] },
			}) +
			"\n";
		writeSession(sessionPath, noRecords);
		const reader = createReader();
		const entries = await reader.readSubagentRecords(sessionPath);
		assert.equal(entries.length, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// fork 场景：分叉点 a1 有两个孩子（旧链 abandoned、新链 active）。
// 旧链上产生的 subagents:record 不在 activeBranch，但属于会话运行审计，必须读出。
const forkedSession =
	JSON.stringify({
		type: "session",
		id: "fs1",
		cwd: "/tmp",
		timestamp: new Date().toISOString(),
	}) +
	"\n" +
	JSON.stringify({
		type: "message",
		id: "fu1",
		parentId: "fs1",
		message: { role: "user", content: [{ type: "text", text: "run agents" }] },
	}) +
	"\n" +
	// 分叉点：assistant a1
	JSON.stringify({
		type: "message",
		id: "fa1",
		parentId: "fu1",
		message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
	}) +
	"\n" +
	// 旧链（后被 fork 抛弃）：user 消息 + 子代理完成 record
	JSON.stringify({
		type: "message",
		id: "fold-u1",
		parentId: "fa1",
		message: { role: "user", content: [{ type: "text", text: "old branch" }] },
	}) +
	"\n" +
	JSON.stringify({
		type: "custom",
		customType: "subagents:record",
		id: "frec-1",
		parentId: "fold-u1",
		data: {
			id: "agent-folded99",
			type: "general-purpose",
			description: "agent on abandoned branch",
			status: "completed",
			result: "old branch result",
			startedAt: 1700000100000,
			completedAt: 1700000110000,
		},
	}) +
	"\n" +
	// 新链（活动分支）：用户从 a1 fork 重发
	JSON.stringify({
		type: "message",
		id: "fnew-u1",
		parentId: "fa1",
		message: { role: "user", content: [{ type: "text", text: "new branch" }] },
	}) +
	"\n" +
	JSON.stringify({
		type: "custom",
		customType: "pi-deck-todo",
		id: "ftodo-1",
		parentId: "fnew-u1",
		data: { activePlan: [] },
	}) +
	"\n" +
	JSON.stringify({
		type: "custom",
		customType: "subagents:record",
		id: "frec-2",
		parentId: "ftodo-1",
		data: {
			id: "agent-active88",
			type: "code",
			description: "agent on active branch",
			status: "completed",
			startedAt: 1700000200000,
			completedAt: 1700000210000,
		},
	}) +
	"\n";

test("readSubagentRecords keeps records on abandoned fork branches", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pid-subagent-fork-"));
	const sessionPath = join(dir, "session.jsonl");
	try {
		writeSession(sessionPath, forkedSession);
		const reader = createReader();
		const entries = await reader.readSubagentRecords(sessionPath);

		// 旁支 record（agent-folded99）不在 activeBranch，但必须读出
		assert.equal(entries.length, 2);
		const ids = entries.map((e) => e.id).sort();
		assert.equal(ids.join(","), "agent-active88,agent-folded99");

		const folded = entries.find((e) => e.id === "agent-folded99");
		assert.equal(folded.status, "completed");
		assert.equal(folded.result, "old branch result");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("readSubagentRecords keeps the latest record per agent id", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pid-subagent-dedup-"));
	const sessionPath = join(dir, "session.jsonl");
	try {
		const content =
			JSON.stringify({
				type: "session",
				id: "ds1",
				cwd: "/tmp",
				timestamp: new Date().toISOString(),
			}) +
			"\n" +
			JSON.stringify({
				type: "message",
				id: "du1",
				parentId: "ds1",
				message: { role: "user", content: [{ type: "text", text: "resume agent" }] },
			}) +
			"\n" +
			// 同一 agent id 的第一条 record（resume 前的终态，文件序靠前）
			JSON.stringify({
				type: "custom",
				customType: "subagents:record",
				id: "drec-1",
				parentId: "du1",
				data: {
					id: "agent-sameid11",
					type: "code",
					description: "first run",
					status: "completed",
					result: "first result",
					startedAt: 1700000000000,
					completedAt: 1700000005000,
				},
			}) +
			"\n" +
			// 同一 agent id 的第二条 record（resume 后再完成，文件序靠后 → 应胜出）
			JSON.stringify({
				type: "custom",
				customType: "subagents:record",
				id: "drec-2",
				parentId: "drec-1",
				data: {
					id: "agent-sameid11",
					type: "code",
					description: "resumed run",
					status: "completed",
					result: "resumed result",
					startedAt: 1700000090000,
					completedAt: 1700000095000,
				},
			}) +
			"\n" +
			// 另一个独立子代理
			JSON.stringify({
				type: "custom",
				customType: "subagents:record",
				id: "drec-3",
				parentId: "drec-2",
				data: {
					id: "agent-other2222",
					type: "Explore",
					description: "other agent",
					status: "completed",
					startedAt: 1700000050000,
					completedAt: 1700000060000,
				},
			}) +
			"\n";
		writeSession(sessionPath, content);
		const reader = createReader();
		const entries = await reader.readSubagentRecords(sessionPath);

		// 同 id 去重后共 2 条
		assert.equal(entries.length, 2);
		const resumed = entries.find((e) => e.id === "agent-sameid11");
		// 文件序靠后的 record 胜出：result/startedAt 都是第二次运行
		assert.equal(resumed.description, "resumed run");
		assert.equal(resumed.result, "resumed result");
		assert.equal(resumed.startedAt, 1700000090000);
		// 排序仍按 startedAt 降序：resumed（09:00）在前，other（05:00）在后
		assert.equal(entries[0].id, "agent-sameid11");
		assert.equal(entries[1].id, "agent-other2222");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// start 锚点：created 时落盘的 pi-deck-subagent-start 条目。
// 场景 1：子代理运行中被会话重启终止 → 只剩锚点，合成 stopped（保留审计痕迹）。
// 场景 2：子代理正常完成 → 锚点被更晚的 record 覆盖，以 record 为准。
const startAnchorSession =
	JSON.stringify({
		type: "session",
		id: "ss1",
		cwd: "/tmp",
		timestamp: new Date().toISOString(),
	}) +
	"\n" +
	JSON.stringify({
		type: "message",
		id: "su1",
		parentId: "ss1",
		message: { role: "user", content: [{ type: "text", text: "spawn" }] },
	}) +
	"\n" +
	// 被 termination 杀掉的子代理：只有 start 锚点，无 record
	JSON.stringify({
		type: "custom",
		customType: "pi-deck-subagent-start",
		id: "srec-1",
		parentId: "su1",
		data: {
			id: "agent-killed77",
			type: "Explore",
			description: "killed by restart",
			startedAt: 1700000300000,
		},
	}) +
	"\n" +
	// 正常完成的子代理：start 锚点（文件序靠前）+ record（文件序靠后）
	JSON.stringify({
		type: "custom",
		customType: "pi-deck-subagent-start",
		id: "srec-2",
		parentId: "srec-1",
		data: {
			id: "agent-finished8",
			type: "code",
			description: "finished normally",
			startedAt: 1700000400000,
		},
	}) +
	"\n" +
	JSON.stringify({
		type: "custom",
		customType: "subagents:record",
		id: "srec-3",
		parentId: "srec-2",
		data: {
			id: "agent-finished8",
			type: "code",
			description: "finished normally",
			status: "completed",
			result: "done",
			startedAt: 1700000400000,
			completedAt: 1700000410000,
		},
	}) +
	"\n";

test("readSubagentRecords synthesizes stopped from residual start anchors and prefers record", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pid-subagent-start-"));
	const sessionPath = join(dir, "session.jsonl");
	try {
		writeSession(sessionPath, startAnchorSession);
		const reader = createReader();
		const entries = await reader.readSubagentRecords(sessionPath);

		assert.equal(entries.length, 2);

		// 只剩锚点的子代理：合成 stopped（无 result/error/completedAt）
		const killed = entries.find((e) => e.id === "agent-killed77");
		assert.equal(killed.status, "stopped");
		assert.equal(killed.type, "Explore");
		assert.equal(killed.description, "killed by restart");
		assert.equal(killed.startedAt, 1700000300000);
		assert.equal(killed.result, undefined);
		assert.equal(killed.completedAt, undefined);

		// 有 record 的子代理：record 覆盖锚点，状态为真实终态
		const finished = entries.find((e) => e.id === "agent-finished8");
		assert.equal(finished.status, "completed");
		assert.equal(finished.result, "done");
		assert.equal(finished.completedAt, 1700000410000);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// #300：record 由插件在完成时写，运行中的子代理只剩 start 锚点。
// 无对账信息时锚点只能保守合成 stopped——但子代理实际运行中，面板会误显
// 「已停止」。传入本代 runtime 启动时间后按 startedAt 对账：本代派发的锚点
// 合成 running（与 downgradeRunningStartedBefore 同一时间阈值、同方向）。
test("readSubagentRecords anchors spawned by the live runtime generation synthesize running (#300)", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pid-subagent-live-"));
	const sessionPath = join(dir, "session.jsonl");
	try {
		writeSession(sessionPath, startAnchorSession);
		const reader = createReader();

		// 本代 runtime 启动于锚点之前：锚点是本代派发、record 未落 → 运行中
		const live = await reader.readSubagentRecords(sessionPath, { liveRuntimeStartedAt: 1700000250000 });
		const running = live.find((e) => e.id === "agent-killed77");
		assert.equal(running.status, "running");
		assert.equal(running.completedAt, undefined);
		// 有 record 的子代理不受对账影响：record 终态优先
		assert.equal(live.find((e) => e.id === "agent-finished8").status, "completed");

		// 本代 runtime 启动于锚点之后：锚点属上一代，随进程消亡 → stopped
		const prevGen = await reader.readSubagentRecords(sessionPath, { liveRuntimeStartedAt: 1700000350000 });
		assert.equal(prevGen.find((e) => e.id === "agent-killed77").status, "stopped");

		// 锚点缺 startedAt 时无法对账：保守 stopped（不复活为 running）
		const noStartSession =
			JSON.stringify({
				type: "session",
				id: "ss2",
				cwd: "/tmp",
				timestamp: new Date().toISOString(),
			}) +
			"\n" +
			JSON.stringify({
				type: "custom",
				customType: "pi-deck-subagent-start",
				id: "srec-x",
				parentId: "ss2",
				data: { id: "agent-nostart99", type: "Explore", description: "no startedAt" },
			}) +
			"\n";
		writeSession(sessionPath, noStartSession);
		const noStart = await reader.readSubagentRecords(sessionPath, { liveRuntimeStartedAt: 1700000250000 });
		const nostart = noStart.find((e) => e.id === "agent-nostart99");
		assert.equal(nostart.status, "stopped");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
/* ------------------------------------------------------------------ */
/* readDerivedSubagentEntries：acp_delegate / subagent 工具推导          */
/* ------------------------------------------------------------------ */

const acpSession =
	JSON.stringify({
		type: "session",
		id: "session-acp",
		cwd: "/tmp",
		timestamp: new Date().toISOString(),
	}) +
	"\n" +
	// 派发 toolCall
	JSON.stringify({
		type: "message",
		id: "m1",
		parentId: null,
		timestamp: "2026-08-30T13:39:40.253Z",
		message: {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "acp_delegate_111",
					name: "acp_delegate",
					arguments: { agent: "worker", task: "Generate a markdown file", cwd: "/tmp" },
				},
			],
		},
	}) +
	"\n" +
	// 派发确认（含 runId 关联）
	JSON.stringify({
		type: "message",
		id: "m2",
		parentId: null,
		timestamp: "2026-08-30T13:39:40.265Z",
		message: {
			role: "toolResult",
			toolCallId: "acp_delegate_111",
			toolName: "acp_delegate",
			content: [{ type: "text", text: "Delegated to **worker** (runId `del_abc123`).\nRunning in the background." }],
		},
	}) +
	"\n" +
	// 终态系统通知（role=user）
	JSON.stringify({
		type: "message",
		id: "m3",
		parentId: null,
		timestamp: "2026-08-30T13:40:11.728Z",
		message: {
			role: "user",
			content: [{ type: "text", text: "[acp_delegate completed] **worker** (runId `del_abc123`, exit 0) No delegates are currently running." }],
		},
	}) +
	"\n" +
	// 无关行（不含 acp_delegate 字样，走预检跳过路径）
	JSON.stringify({
		type: "message",
		id: "m4",
		parentId: null,
		timestamp: "2026-08-30T13:40:12.000Z",
		message: { role: "user", content: [{ type: "text", text: "继续吧" }] },
	}) +
	"\n";

test("readDerivedSubagentEntries derives acp_delegate entries from session file", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pid-acp-derive-"));
	const sessionPath = join(dir, "session.jsonl");
	try {
		writeSession(sessionPath, acpSession);
		const reader = createReader();
		const entries = await reader.readDerivedSubagentEntries(sessionPath);

		assert.equal(entries.length, 1);
		const entry = entries[0];
		assert.equal(entry.id, "acp_delegate_111");
		assert.equal(entry.type, "worker");
		assert.equal(entry.description, "Generate a markdown file");
		assert.equal(entry.status, "completed");
		assert.equal(entry.startedAt, Date.parse("2026-08-30T13:39:40.253Z"));
		assert.equal(entry.completedAt, Date.parse("2026-08-30T13:40:11.728Z"));
		assert.equal(entry.source, "toolcall");
		assert.equal(entry.via, "acp-delegate");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("readDerivedSubagentEntries returns empty for session without acp activity", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pid-acp-empty-"));
	const sessionPath = join(dir, "session.jsonl");
	try {
		writeSession(
			sessionPath,
			JSON.stringify({
				type: "session",
				id: "s",
				cwd: "/tmp",
				timestamp: new Date().toISOString(),
			}) +
				"\n" +
				JSON.stringify({
					type: "message",
					id: "m1",
					parentId: null,
					timestamp: new Date().toISOString(),
					message: { role: "user", content: [{ type: "text", text: "普通会话内容" }] },
				}) +
				"\n",
		);
		const reader = createReader();
		// VM realm 数组原型不同，deepEqual 不可用
		const entries = await reader.readDerivedSubagentEntries(sessionPath);
		assert.equal(entries.length, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
/* ------------------------------------------------------------------ */
/* pi-subagents 异步链（nicobailon）：桥接终态 record + 推导条目合并      */
/* ------------------------------------------------------------------ */

// 用户实测场景（2026-10-11）：异步 run 完成后面板一直显示「运行中」。根因是插件只在
// 自己的 widget 里保留终态 10s（async-job-tracker 的 completionRetentionMs），会话
// 文件里只有派发 toolCall + 回执；widget 清空后渲染层回退到推导条目的 running。
// 桥接扩展补落 subagents:record 之后，读取侧的合并结果必须是「终态 + 任务描述」。
const asyncRunId = "2824f0e6-08ff-42a5-9a30-683302ba52eb";
const asyncTask = "目标：把 4 个仍用手写 vm 沙箱的测试迁移到统一加载器";
const asyncSubagentSession =
	JSON.stringify({
		type: "session",
		id: "as1",
		cwd: "/tmp",
		timestamp: "2026-10-11T07:37:00.000Z",
	}) +
	"\n" +
	JSON.stringify({
		type: "message",
		id: "au1",
		parentId: "as1",
		timestamp: "2026-10-11T07:37:55.963Z",
		message: { role: "user", content: [{ type: "text", text: "派一个 worker" }] },
	}) +
	"\n" +
	// 异步派发 toolCall（args.task 是任务文本的唯一来源）
	JSON.stringify({
		type: "message",
		id: "am1",
		parentId: "au1",
		timestamp: "2026-10-11T07:37:55.963Z",
		message: {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call_async_1",
					name: "subagent",
					arguments: { agent: "worker", async: true, task: asyncTask },
				},
			],
		},
	}) +
	"\n" +
	// 异步回执：把推导条目重键为 asyncId（与桥接 record 同 id）
	JSON.stringify({
		type: "message",
		id: "am2",
		parentId: "am1",
		timestamp: "2026-10-11T07:37:55.995Z",
		message: {
			role: "toolResult",
			toolCallId: "call_async_1",
			toolName: "subagent",
			content: [{ type: "text", text: `Run fan-out: 1/64 used, 63 remaining\nAsync: worker [${asyncRunId}]\n\nThe async run is detached and running in the background.` }],
		},
	}) +
	"\n" +
	// 桥接扩展落盘的终态 record（事件 payload 没有 task，描述留空由读取侧回填）
	JSON.stringify({
		type: "custom",
		customType: "subagents:record",
		id: "arec-1",
		parentId: "am2",
		data: {
			id: asyncRunId,
			type: "worker",
			description: "",
			status: "completed",
			startedAt: 1791704276963,
			completedAt: 1791704545239,
		},
	}) +
	"\n";

test("record + 推导合并：异步 run 完成后读出 completed 且带任务描述", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pid-async-subagent-"));
	const sessionPath = join(dir, "session.jsonl");
	try {
		writeSession(sessionPath, asyncSubagentSession);
		const reader = createReader();
		const records = await reader.readSubagentRecords(sessionPath);
		assert.equal(records.length, 1);
		assert.equal(records[0].id, asyncRunId);
		assert.equal(records[0].status, "completed");
		assert.equal(records[0].description, "");

		const derived = await reader.readDerivedSubagentEntries(sessionPath);
		assert.equal(derived.length, 1);
		assert.equal(derived[0].id, asyncRunId);
		// 推导侧对异步派发只有「派发即运行中」（终态通知不带 runId，无法关联）
		assert.equal(derived[0].status, "running");
		assert.equal(derived[0].description, asyncTask);

		const { mergeSubagentSources } = loadTsCommonJs("src/main/pi/derivedSubagents.ts");
		const merged = mergeSubagentSources(records, derived);
		assert.equal(merged.length, 1);
		assert.equal(merged[0].status, "completed");
		assert.equal(merged[0].description, asyncTask);
		assert.equal(merged[0].completedAt, 1791704545239);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
