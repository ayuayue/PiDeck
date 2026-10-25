/**
 * pi-deck-subagents 桥接扩展 —— 快照累积器纯函数测试。
 *
 * 覆盖：created/started/completed/failed/steered 状态迁移、
 * 幂等性、未知事件忽略、字段缺失降级。
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ts = require("typescript");

function loadBridgeModule() {
	const source = readFileSync(join(__dirname, "..", "resources", "extensions", "pi-deck-subagents.ts"), "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const sandbox = { exports: {} };
	const fn = new Function("exports", outputText);
	fn(sandbox.exports);
	return sandbox.exports;
}

test("reduceSnapshot: created adds queued agent", () => {
	const { reduceSnapshot } = loadBridgeModule();
	const { state, changed } = reduceSnapshot(new Map(), "subagents:created", { id: "agent-1", type: "Explore", description: "Find auth files" });
	assert.equal(changed, true);
	assert.equal(state.size, 1);
	const agent = state.get("agent-1");
	assert.equal(agent?.id, "agent-1");
	assert.equal(agent?.type, "Explore");
	assert.equal(agent?.status, "queued");
});

test("reduceSnapshot: started transitions queued → running", () => {
	const { reduceSnapshot } = loadBridgeModule();
	let state = new Map();
	let r = reduceSnapshot(state, "subagents:created", { id: "a1", type: "code", description: "d" });
	state = r.state;
	r = reduceSnapshot(state, "subagents:started", { id: "a1" });
	assert.equal(r.changed, true);
	assert.equal(r.state.get("a1")?.status, "running");
});

test("reduceSnapshot: completed transitions running → completed + carries toolUses/tokens", () => {
	const { reduceSnapshot } = loadBridgeModule();
	let state = new Map();
	let r = reduceSnapshot(state, "subagents:created", { id: "a1", type: "c", description: "d" });
	state = r.state;
	r = reduceSnapshot(state, "subagents:started", { id: "a1" });
	state = r.state;
	r = reduceSnapshot(state, "subagents:completed", {
		id: "a1",
		type: "c",
		description: "d",
		toolUses: 5,
		tokens: 300,
	});
	assert.equal(r.changed, true);
	const agent = r.state.get("a1");
	assert.equal(agent?.status, "completed");
	assert.equal(agent?.toolUses, 5);
	assert.equal(agent?.tokens, 300);
});

test("reduceSnapshot: failed transitions running → error", () => {
	const { reduceSnapshot } = loadBridgeModule();
	let state = new Map();
	let r = reduceSnapshot(state, "subagents:created", { id: "a1", type: "x", description: "d" });
	state = r.state;
	r = reduceSnapshot(state, "subagents:started", { id: "a1" });
	state = r.state;
	r = reduceSnapshot(state, "subagents:failed", { id: "a1" });
	assert.equal(r.changed, true);
	assert.equal(r.state.get("a1")?.status, "error");
});

test("reduceSnapshot: created is idempotent", () => {
	const { reduceSnapshot } = loadBridgeModule();
	let state = new Map();
	let r = reduceSnapshot(state, "subagents:created", { id: "a1", type: "e", description: "d" });
	assert.equal(r.changed, true);
	r = reduceSnapshot(r.state, "subagents:created", { id: "a1", type: "e", description: "d" });
	assert.equal(r.changed, false);
});

test("reduceSnapshot: terminal is idempotent", () => {
	const { reduceSnapshot } = loadBridgeModule();
	let state = new Map();
	let r = reduceSnapshot(state, "subagents:created", { id: "a1", type: "t", description: "d" });
	state = r.state;
	r = reduceSnapshot(state, "subagents:started", { id: "a1" });
	state = r.state;
	r = reduceSnapshot(state, "subagents:completed", { id: "a1" });
	assert.equal(r.changed, true);
	r = reduceSnapshot(r.state, "subagents:completed", { id: "a1" });
	assert.equal(r.changed, false);
});

test("reduceSnapshot: unknown event ignored", () => {
	const { reduceSnapshot } = loadBridgeModule();
	const { state, changed } = reduceSnapshot(new Map(), "unknown:event", {});
	assert.equal(changed, false);
	assert.equal(state.size, 0);
});

test("reduceSnapshot: missing id returns unchanged", () => {
	const { reduceSnapshot } = loadBridgeModule();
	const { state, changed } = reduceSnapshot(new Map(), "subagents:created", {});
	assert.equal(changed, false);
});

test("reduceSnapshot: started without prior created upserts running entry", () => {
	const { reduceSnapshot } = loadBridgeModule();
	// 前台子代理走 spawnAndWait，插件不发 created（仅后台派发时发）；started 是运行期间
	// 唯一信号，无既有条目时必须直接 upsert，否则快照 agents 为空、面板整块不渲染。
	const { state, changed } = reduceSnapshot(new Map(), "subagents:started", {
		id: "ghost",
		type: "Explore",
		description: "find files",
	});
	assert.equal(changed, true);
	const agent = state.get("ghost");
	assert.equal(agent?.id, "ghost");
	assert.equal(agent?.status, "running");
	assert.equal(agent?.type, "Explore");
	assert.equal(agent?.description, "find files");
	assert.equal(agent?.toolUses, 0);
	assert.equal(agent?.tokens, 0);
	assert.equal(typeof agent?.startedAt, "number");
});

test("reduceSnapshot: repeated started is idempotent and keeps startedAt", () => {
	const { reduceSnapshot } = loadBridgeModule();
	const first = reduceSnapshot(new Map(), "subagents:started", { id: "fg-1", type: "Explore", description: "d" });
	assert.equal(first.changed, true);
	const startedAt = first.state.get("fg-1")?.startedAt;
	const second = reduceSnapshot(first.state, "subagents:started", { id: "fg-1", type: "Explore", description: "d" });
	assert.equal(second.changed, false);
	assert.equal(second.state.get("fg-1")?.startedAt, startedAt);
});

test("reduceSnapshot: started without id is ignored", () => {
	const { reduceSnapshot } = loadBridgeModule();
	const { state, changed } = reduceSnapshot(new Map(), "subagents:started", { type: "Explore" });
	assert.equal(changed, false);
	assert.equal(state.size, 0);
});

test("reduceSnapshot: started-only entry migrates to completed with terminal payload", () => {
	const { reduceSnapshot } = loadBridgeModule();
	const started = reduceSnapshot(new Map(), "subagents:started", { id: "fg-2", type: "Explore", description: "d" });
	assert.equal(started.changed, true);
	const startedAt = started.state.get("fg-2")?.startedAt;
	const done = reduceSnapshot(started.state, "subagents:completed", {
		id: "fg-2",
		status: "completed",
		toolUses: 5,
		// 上游 21.7.4 终态 tokens 是 {input,output,total} 对象，桥接 extractFields 用 safeNumber(d.tokens)
		// 折算 → 对象恒为 0（既有缺陷，本次不修）。夹具用真实载荷形状，锁定「对象载荷不报错、不误透传」的现状。
		tokens: { input: 100, output: 200, total: 300 },
		durationMs: 42000,
	});
	assert.equal(done.changed, true);
	const agent = done.state.get("fg-2");
	assert.equal(agent?.status, "completed");
	assert.equal(agent?.toolUses, 5);
	// 既有 tokens 形状缺陷：对象载荷被 safeNumber 折算为 0（修复另议，不在本补丁范围）
	assert.equal(agent?.tokens, 0);
	assert.equal(agent?.completedAt, startedAt + 42000);
});

test("reduceSnapshot: steered transitions to steered state", () => {
	const { reduceSnapshot } = loadBridgeModule();
	let state = new Map();
	let r = reduceSnapshot(state, "subagents:created", { id: "a1", type: "s", description: "d" });
	state = r.state;
	r = reduceSnapshot(state, "subagents:started", { id: "a1" });
	state = r.state;
	r = reduceSnapshot(state, "subagents:steered", { id: "a1" });
	assert.equal(r.changed, true);
	assert.equal(r.state.get("a1")?.status, "steered");
});

test("reduceSnapshot: field defaults when missing", () => {
	const { reduceSnapshot } = loadBridgeModule();
	const { state } = reduceSnapshot(new Map(), "subagents:created", { id: "minimal" });
	const agent = state.get("minimal");
	assert.equal(agent?.type, "");
	assert.equal(agent?.description, "");
	assert.equal(agent?.toolUses, 0);
	assert.equal(agent?.tokens, 0);
});

test("reduceSnapshot: failed event honors payload status stopped", () => {
	const { reduceSnapshot } = loadBridgeModule();
	let state = new Map();
	let r = reduceSnapshot(state, "subagents:created", { id: "a1", type: "x", description: "d" });
	state = r.state;
	r = reduceSnapshot(state, "subagents:started", { id: "a1" });
	state = r.state;
	// 插件 external stop：事件名 failed，但 payload 携带真实 status=stopped
	r = reduceSnapshot(state, "subagents:failed", { id: "a1", status: "stopped" });
	assert.equal(r.changed, true);
	assert.equal(r.state.get("a1")?.status, "stopped");
});

test("reduceSnapshot: completed event honors payload status steered", () => {
	const { reduceSnapshot } = loadBridgeModule();
	let state = new Map();
	let r = reduceSnapshot(state, "subagents:created", { id: "a1", type: "s", description: "d" });
	state = r.state;
	r = reduceSnapshot(state, "subagents:started", { id: "a1" });
	state = r.state;
	// 插件 steered 完成：事件名 completed，但 payload 携带真实 status=steered，
	// 不得被折叠成 completed（绿勾）。
	r = reduceSnapshot(state, "subagents:completed", { id: "a1", status: "steered" });
	assert.equal(r.changed, true);
	assert.equal(r.state.get("a1")?.status, "steered");
});

test("reduceSnapshot: terminal event upserts when created/started were missed", () => {
	const { reduceSnapshot } = loadBridgeModule();
	// 桥接晚加载：created/started 事件已错过，只有终态事件携带完整字段
	const { state, changed } = reduceSnapshot(new Map(), "subagents:completed", { id: "ghost", type: "Explore", description: "late", status: "completed", toolUses: 4, tokens: 200 });
	assert.equal(changed, true);
	const agent = state.get("ghost");
	assert.equal(agent?.status, "completed");
	assert.equal(agent?.type, "Explore");
	assert.equal(agent?.toolUses, 4);
	assert.equal(agent?.tokens, 200);
});
test("reduceSnapshot: completed derives completedAt from durationMs payload", () => {
	const { reduceSnapshot } = loadBridgeModule();
	let state = new Map();
	let r = reduceSnapshot(state, "subagents:created", { id: "a1", type: "c", description: "d" });
	state = r.state;
	const startedAt = state.get("a1")?.startedAt;
	r = reduceSnapshot(state, "subagents:completed", {
		id: "a1",
		type: "c",
		description: "d",
		status: "completed",
		durationMs: 42000,
	});
	const agent = r.state.get("a1");
	assert.equal(agent?.status, "completed");
	// completedAt = startedAt + 插件真实时长 durationMs（消除 created 事件传播延迟误差）
	assert.equal(agent?.completedAt, startedAt + 42000);
});

test("reduceSnapshot: completed without durationMs falls back to event arrival time", () => {
	const { reduceSnapshot } = loadBridgeModule();
	let state = new Map();
	let r = reduceSnapshot(state, "subagents:created", { id: "a1", type: "c", description: "d" });
	state = r.state;
	const before = Date.now();
	r = reduceSnapshot(state, "subagents:completed", { id: "a1" });
	const after = Date.now();
	const agent = r.state.get("a1");
	assert.ok(agent?.completedAt !== undefined);
	assert.ok(agent.completedAt >= before && agent.completedAt <= after);
});

test("reduceSnapshot: terminal upsert without durationMs sets arrival-time completedAt", () => {
	const { reduceSnapshot } = loadBridgeModule();
	const before = Date.now();
	const { state } = reduceSnapshot(new Map(), "subagents:completed", {
		id: "ghost",
		type: "Explore",
		description: "late",
		status: "completed",
	});
	const after = Date.now();
	const agent = state.get("ghost");
	assert.ok(agent?.completedAt >= before && agent.completedAt <= after);
});

test("reduceSnapshot: completed carries truncated result/error preview", () => {
	const { reduceSnapshot } = loadBridgeModule();
	let state = new Map();
	let r = reduceSnapshot(state, "subagents:created", { id: "a1", type: "c", description: "d" });
	state = r.state;
	r = reduceSnapshot(state, "subagents:started", { id: "a1" });
	state = r.state;
	const longText = "x".repeat(5000);
	r = reduceSnapshot(state, "subagents:completed", { id: "a1", status: "completed", result: longText });
	const agent = r.state.get("a1");
	assert.equal(agent?.status, "completed");
	// 面板预览截断 2000 字符，完整文本由 record 承载
	assert.equal(agent?.result?.length, 2000);
});

test("reduceSnapshot: failed carries error text to snapshot", () => {
	const { reduceSnapshot } = loadBridgeModule();
	let state = new Map();
	let r = reduceSnapshot(state, "subagents:created", { id: "a1", type: "x", description: "d" });
	state = r.state;
	r = reduceSnapshot(state, "subagents:started", { id: "a1" });
	state = r.state;
	r = reduceSnapshot(state, "subagents:failed", { id: "a1", error: "boom: tool timeout" });
	const agent = r.state.get("a1");
	assert.equal(agent?.status, "error");
	assert.equal(agent?.error, "boom: tool timeout");
});

/** mock pi API：捕获事件订阅与 appendEntry 调用，驱动扩展默认导出的完整链路。 */
function createMockPi() {
	const handlers = new Map();
	// pi.on 生命周期事件（session_start / tool_execution_* / message_end 等）
	const lifecycle = new Map();
	const appendedEntries = [];
	return {
		pi: {
			events: {
				on: (name, cb) => {
					handlers.set(name, cb);
				},
			},
			on: (name, cb) => {
				lifecycle.set(name, cb);
			},
			appendEntry: (type, data) => {
				appendedEntries.push({ type, data });
			},
		},
		handlers,
		lifecycle,
		appendedEntries,
	};
}

test("bridge extension: subagents:created persists pi-deck-subagent-start anchor", () => {
	const { default: bridge } = loadBridgeModule();
	const { pi, handlers, appendedEntries } = createMockPi();
	bridge(pi);

	// created 事件 → 快照入库 + start 锚点落盘（审计痕迹，防运行中被重启终止后消失）
	handlers.get("subagents:created")({ id: "agent-anchor1", type: "Explore", description: "find files" });

	assert.equal(appendedEntries.length, 1);
	assert.equal(appendedEntries[0].type, "pi-deck-subagent-start");
	assert.equal(appendedEntries[0].data.id, "agent-anchor1");
	assert.equal(appendedEntries[0].data.type, "Explore");
	assert.equal(appendedEntries[0].data.description, "find files");
	assert.equal(typeof appendedEntries[0].data.startedAt, "number");

	// 幂等 created（重复事件）不重复落盘
	handlers.get("subagents:created")({ id: "agent-anchor1", type: "Explore", description: "find files" });
	assert.equal(appendedEntries.length, 1);

	// 无 id 的 created 事件不落盘
	handlers.get("subagents:created")({ type: "code", description: "no id" });
	assert.equal(appendedEntries.length, 1);

	// 终态事件不写锚点（record 由插件侧负责）
	handlers.get("subagents:completed")({ id: "agent-anchor1", status: "completed", result: "ok" });
	assert.equal(appendedEntries.length, 1);
});

test("bridge extension: appendEntry throw does not break snapshot flow", () => {
	const { default: bridge } = loadBridgeModule();
	const handlers = new Map();
	const pi = {
		events: {
			on: (name, cb) => {
				handlers.set(name, cb);
			},
		},
		on: () => {},
		appendEntry: () => {
			throw new Error("session closed");
		},
	};
	bridge(pi);

	// 持久化失败仅损失审计锚点：事件处理不抛错，后续事件继续工作
	handlers.get("subagents:created")({ id: "agent-throw1", type: "code", description: "d" });
	let threw = false;
	try {
		handlers.get("subagents:started")({ id: "agent-throw1" });
	} catch {
		threw = true;
	}
	assert.equal(threw, false);
});

/* ------------------------------------------------------------------ */
/* acp_delegate（billion-context-pi）桥接                               */
/* ------------------------------------------------------------------ */

const ACP_DISPATCH = "acp_delegate_111";
const ACP_RUN_ID = "del_abc123";

function acpDispatchEndEvent() {
	return {
		type: "tool_execution_end",
		toolCallId: ACP_DISPATCH,
		toolName: "acp_delegate",
		result: { content: [{ type: "text", text: `Delegated to **worker** (runId \`${ACP_RUN_ID}\`).\nRunning in the background.` }] },
		isError: false,
	};
}

test("reduceAcpToolEvent: start(acp_delegate) → running 条目（via 标记、幂等）", () => {
	const { reduceAcpToolEvent } = loadBridgeModule();
	const start = { type: "tool_execution_start", toolCallId: ACP_DISPATCH, toolName: "acp_delegate", args: { agent: "worker", task: "Generate md" } };
	const first = reduceAcpToolEvent(new Map(), new Map(), "tool_execution_start", start, 1000);
	assert.equal(first.changed, true);
	assert.equal(first.state.get(ACP_DISPATCH).status, "running");
	assert.equal(first.state.get(ACP_DISPATCH).via, "acp-delegate");
	assert.equal(first.state.get(ACP_DISPATCH).description, "Generate md");

	// 同 toolCallId 幂等
	const again = reduceAcpToolEvent(first.state, first.runIds, "tool_execution_start", start, 2000);
	assert.equal(again.changed, false);
	assert.equal(again.state.get(ACP_DISPATCH).startedAt, 1000);
});

test("reduceAcpToolEvent: end 从结果文本提取 runId（派发 ≠ 终态）", () => {
	const { reduceAcpToolEvent } = loadBridgeModule();
	const started = reduceAcpToolEvent(new Map(), new Map(), "tool_execution_start", { type: "tool_execution_start", toolCallId: ACP_DISPATCH, toolName: "acp_delegate", args: { agent: "worker" } }, 1000);
	const ended = reduceAcpToolEvent(started.state, started.runIds, "tool_execution_end", acpDispatchEndEvent(), 1100);
	assert.equal(ended.changed, false); // 状态不变，widget 不重推
	assert.equal(ended.runIds.get(ACP_RUN_ID), ACP_DISPATCH);
	assert.equal(ended.state.get(ACP_DISPATCH).status, "running");
});

test("reduceAcpToolEvent: 取消按 runId 反查 → stopped", () => {
	const { reduceAcpToolEvent } = loadBridgeModule();
	const started = reduceAcpToolEvent(new Map(), new Map(), "tool_execution_start", { type: "tool_execution_start", toolCallId: ACP_DISPATCH, toolName: "acp_delegate", args: { agent: "worker" } }, 1000);
	const dispatched = reduceAcpToolEvent(started.state, started.runIds, "tool_execution_end", acpDispatchEndEvent(), 1100);
	const cancelled = reduceAcpToolEvent(dispatched.state, dispatched.runIds, "tool_execution_start", { type: "tool_execution_start", toolCallId: "acp_delegate_cancel_x", toolName: "acp_delegate_cancel", args: { runId: ACP_RUN_ID } }, 1200);
	assert.equal(cancelled.changed, true);
	assert.equal(cancelled.state.get(ACP_DISPATCH).status, "stopped");
	assert.equal(cancelled.state.get(ACP_DISPATCH).completedAt, 1200);
});

test("reduceAcpToolEvent: 非 acp 工具事件被忽略", () => {
	const { reduceAcpToolEvent } = loadBridgeModule();
	const result = reduceAcpToolEvent(new Map(), new Map(), "tool_execution_start", { type: "tool_execution_start", toolCallId: "bash_1", toolName: "bash", args: { command: "ls" } }, 1000);
	assert.equal(result.changed, false);
	assert.equal(result.state.size, 0);
});

test("reduceAcpNotification: completed/FAILED 通知迁到终态并携带错误摘录", () => {
	const { reduceAcpToolEvent, reduceAcpNotification } = loadBridgeModule();
	const started = reduceAcpToolEvent(new Map(), new Map(), "tool_execution_start", { type: "tool_execution_start", toolCallId: ACP_DISPATCH, toolName: "acp_delegate", args: { agent: "worker" } }, 1000);
	const dispatched = reduceAcpToolEvent(started.state, started.runIds, "tool_execution_end", acpDispatchEndEvent(), 1100);

	const completed = reduceAcpNotification(dispatched.state, dispatched.runIds, `[acp_delegate completed] **worker** (runId \`${ACP_RUN_ID}\`, exit 0) No delegates are currently running.`, 2000);
	assert.equal(completed.changed, true);
	assert.equal(completed.state.get(ACP_DISPATCH).status, "completed");
	assert.equal(completed.state.get(ACP_DISPATCH).completedAt, 2000);

	// FAILED 通知：错误摘录从 Output ~~~ 块提取
	const failed = reduceAcpNotification(dispatched.state, dispatched.runIds, `[acp_delegate FAILED ⚠️] **worker** (runId \`${ACP_RUN_ID}\`, exit ?) failed.\n\nOutput:\n~~~\nspawn error: ENOENT\n~~~`, 3000);
	assert.equal(failed.changed, true);
	assert.equal(failed.state.get(ACP_DISPATCH).status, "error");
	assert.ok(failed.state.get(ACP_DISPATCH).error.includes("ENOENT"));
	// 终态后再收通知不再迁移（幂等）
	const repeated = reduceAcpNotification(failed.state, dispatched.runIds, `[acp_delegate completed] **worker** (runId \`${ACP_RUN_ID}\`, exit 0)`, 4000);
	assert.equal(repeated.changed, false);

	// 未知 runId 的通知被忽略
	const orphan = reduceAcpNotification(dispatched.state, dispatched.runIds, `[acp_delegate completed] **worker** (runId \`del_unknown\`, exit 0)`, 5000);
	assert.equal(orphan.changed, false);
});

test("bridge extension: acp 委托派发落 start 锚点、终态通知落 subagents:record", () => {
	const { default: bridge } = loadBridgeModule();
	const { lifecycle, appendedEntries } = createMockPi();
	bridge(pi4acp(lifecycle, appendedEntries));

	// 派发 start → 快照 + start 锚点
	lifecycle.get("tool_execution_start")({
		type: "tool_execution_start",
		toolCallId: ACP_DISPATCH,
		toolName: "acp_delegate",
		args: { agent: "worker", task: "Generate md", cwd: "/tmp" },
	});
	const anchor = appendedEntries.find((e) => e.type === "pi-deck-subagent-start");
	assert.ok(anchor, "start 锚点应落盘");
	assert.equal(anchor.data.id, ACP_DISPATCH);
	assert.equal(anchor.data.type, "worker");

	// 派发确认（end）→ 只登记 runId，不落盘
	lifecycle.get("tool_execution_end")(acpDispatchEndEvent());
	assert.equal(appendedEntries.filter((e) => e.type === "pi-deck-subagent-start").length, 1);

	// 终态通知 → subagents:record 落盘（历史重建权威数据，via 标记）
	lifecycle.get("message_end")({
		type: "message_end",
		message: { role: "user", content: [{ type: "text", text: `[acp_delegate completed] **worker** (runId \`${ACP_RUN_ID}\`, exit 0) No delegates are currently running.` }] },
	});
	const record = appendedEntries.find((e) => e.type === "subagents:record");
	assert.ok(record, "终态 record 应落盘");
	assert.equal(record.data.id, ACP_DISPATCH);
	assert.equal(record.data.status, "completed");
	assert.equal(record.data.via, "acp-delegate");
	assert.equal(typeof record.data.completedAt, "number");
});

test("bridge extension: 非 user 消息/非 acp 通知不触发落盘", () => {
	const { default: bridge } = loadBridgeModule();
	const { lifecycle, appendedEntries } = createMockPi();
	bridge(pi4acp(lifecycle, appendedEntries));

	lifecycle.get("message_end")({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "[acp_delegate completed] fake" }] } });
	lifecycle.get("message_end")({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "普通用户消息 [acp_delegate completed] 字样但非通知" }] } });
	assert.equal(appendedEntries.length, 0);
});

/** acp 测试用 mock pi：lifecycle/appendedEntries 与 createMockPi 产物共享同一实例。 */
function pi4acp(lifecycle, appendedEntries) {
	return {
		events: { on: () => {} },
		on: (name, cb) => {
			lifecycle.set(name, cb);
		},
		appendEntry: (type, data) => {
			appendedEntries.push({ type, data });
		},
	};
}

test("bridge extension: session_shutdown 把在飞条目补成 stopped 终态", () => {
	const { default: bridge } = loadBridgeModule();
	const { pi, handlers, lifecycle, appendedEntries } = createMockPi();
	bridge(pi);

	// 一个仍在跑的（created + started）+ 一个已完成的（不该被重复写终态）
	handlers.get("subagents:created")({ id: "live1", type: "Explore", description: "d" });
	handlers.get("subagents:started")({ id: "live1" });
	handlers.get("subagents:created")({ id: "done1", type: "code", description: "d" });
	handlers.get("subagents:completed")({ id: "done1", status: "completed", result: "ok" });
	appendedEntries.length = 0;

	lifecycle.get("session_shutdown")({ type: "session_shutdown", reason: "resume" });

	// 会话关闭后旧会话文件再也等不到终态写入 → 面板永远「运行中」、时长无限增长，
	// 所以关闭时补一条 stopped（读取侧后写覆盖先写，runner 事后真完成会被覆盖）
	assert.equal(appendedEntries.length, 1);
	assert.equal(appendedEntries[0].type, "subagents:record");
	assert.equal(appendedEntries[0].data.id, "live1");
	assert.equal(appendedEntries[0].data.status, "stopped");
	assert.equal(typeof appendedEntries[0].data.completedAt, "number");
	assert.ok(appendedEntries[0].data.completedAt >= appendedEntries[0].data.startedAt);
});

test("bridge extension: session_shutdown 无在飞条目时不落盘、落盘失败不抛错", () => {
	const { default: bridge } = loadBridgeModule();
	const { pi, handlers, lifecycle, appendedEntries } = createMockPi();
	bridge(pi);

	// 没有任何条目的干净会话：不该凭空写 record
	lifecycle.get("session_shutdown")({ type: "session_shutdown", reason: "quit" });
	assert.equal(appendedEntries.length, 0);

	// teardown 阶段 appendEntry 抛错（会话已在收尾）不能冒泡打断 pi 的会话切换
	const throwingLifecycle = new Map();
	const throwingPi = {
		events: { on: () => {} },
		on: (name, cb) => {
			throwingLifecycle.set(name, cb);
		},
		appendEntry: () => {
			throw new Error("session closed");
		},
	};
	bridge(throwingPi);
	// 需要再造一个在飞条目：走 acp 派发路径（无 ctx 也能进快照）
	throwingLifecycle.get("tool_execution_start")({
		toolCallId: "acp_delegate_9",
		toolName: "acp_delegate",
		args: { agent: "worker", task: "do it" },
	});
	let threw = false;
	try {
		throwingLifecycle.get("session_shutdown")({ type: "session_shutdown", reason: "resume" });
	} catch {
		threw = true;
	}
	assert.equal(threw, false);
});

test("bridge extension: 前台 started-only 事件经去抖推送 running 快照到 widget", async () => {
	const { default: bridge } = loadBridgeModule();
	const { pi, handlers, lifecycle, appendedEntries } = createMockPi();
	bridge(pi);

	// 事件回调没有 ctx，setWidget 走 session_start 保存的 ctx.ui 引用
	const widgetCalls = [];
	const ctx = { ui: { setWidget: (key, lines) => widgetCalls.push({ key, lines }) } };
	lifecycle.get("session_start")({ type: "session_start" }, ctx);
	handlers.get("subagents:started")({ id: "fg-widget", type: "Explore", description: "foreground task" });

	// schedulePush 去抖 200ms
	await new Promise((resolve) => setTimeout(resolve, 300));

	const last = widgetCalls.at(-1);
	assert.equal(last.key, "pi-deck-subagents");
	const snapshot = JSON.parse(last.lines[0]);
	assert.equal(snapshot.v, 1);
	const agent = snapshot.agents.find((a) => a.id === "fg-widget");
	assert.ok(agent, "运行中的前台子代理应出现在快照 agents 中（面板整块按 entries 渲染）");
	assert.equal(agent.status, "running");
	assert.equal(agent.type, "Explore");
	assert.equal(agent.description, "foreground task");
	// 决策：不给 started 补 start 锚点——读取侧会把残留锚点合成 stopped，运行期间重取 record 会误显示为已停止
	assert.equal(appendedEntries.length, 0);
});

test("bridge extension: session_shutdown 给仅 started 建立的 running 条目补 stopped record", () => {
	const { default: bridge } = loadBridgeModule();
	const { pi, handlers, lifecycle, appendedEntries } = createMockPi();
	bridge(pi);

	// 前台子代理只有 started、无 created：关闭时同样要补终态，否则旧会话文件永远停在 running
	handlers.get("subagents:started")({ id: "fg-live", type: "Explore", description: "d" });
	assert.equal(appendedEntries.length, 0);
	lifecycle.get("session_shutdown")({ type: "session_shutdown", reason: "quit" });

	assert.equal(appendedEntries.length, 1);
	assert.equal(appendedEntries[0].type, "subagents:record");
	assert.equal(appendedEntries[0].data.id, "fg-live");
	assert.equal(appendedEntries[0].data.status, "stopped");
	assert.equal(typeof appendedEntries[0].data.completedAt, "number");
});

/* ------------------------------------------------------------------ */
/* pi-subagents（nicobailon）异步链：派发回执 → 终态 record + 快照      */
/* ------------------------------------------------------------------ */

const ASYNC_DISPATCH = "call_00_async1";
const ASYNC_RUN_ID = "2824f0e6-08ff-42a5-9a30-683302ba52eb";
const ASYNC_TASK = "把 4 个仍用手写 vm 沙箱的测试迁移到统一加载器";

/** 真实回执形状：Run fan-out 头 + `Async: <agent> [<asyncId>]` 行 + detached 引导文。 */
function asyncReceiptText() {
	return `Run fan-out: 1/64 used, 63 remaining\nAsync: worker [${ASYNC_RUN_ID}]\n\nThe async run is detached and running in the background.\nYou are in an interactive session.`;
}

function asyncDispatchStart() {
	return { type: "tool_execution_start", toolCallId: ASYNC_DISPATCH, toolName: "subagent", args: { agent: "worker", task: ASYNC_TASK, async: true } };
}

function asyncDispatchEnd(text = asyncReceiptText()) {
	return { type: "tool_execution_end", toolCallId: ASYNC_DISPATCH, toolName: "subagent", result: { content: [{ type: "text", text }] }, isError: false };
}

function emptyAsyncBridge() {
	return { pending: new Map(), byRunId: new Map() };
}

test("reduceSubagentAsyncToolEvent: start 暂存派发（type/description/startedAt），end 按回执 asyncId 存档", () => {
	const { reduceSubagentAsyncToolEvent } = loadBridgeModule();
	const started = reduceSubagentAsyncToolEvent(emptyAsyncBridge(), "tool_execution_start", asyncDispatchStart(), 1000);
	assert.equal(started.asyncId, undefined);
	const descriptor = started.state.pending.get(ASYNC_DISPATCH);
	assert.equal(descriptor.type, "worker");
	assert.equal(descriptor.description, ASYNC_TASK);
	assert.equal(descriptor.startedAt, 1000);

	const ended = reduceSubagentAsyncToolEvent(started.state, "tool_execution_end", asyncDispatchEnd(), 1100);
	assert.equal(ended.asyncId, ASYNC_RUN_ID);
	assert.equal(ended.descriptor.startedAt, 1000);
	assert.equal(ended.descriptor.description, ASYNC_TASK);
	assert.equal(ended.state.pending.size, 0);
	assert.equal(ended.state.byRunId.get(ASYNC_RUN_ID).type, "worker");
});

test("reduceSubagentAsyncToolEvent: 前台派发的最终报告（无 detached 回执）不留档", () => {
	const { reduceSubagentAsyncToolEvent } = loadBridgeModule();
	const started = reduceSubagentAsyncToolEvent(emptyAsyncBridge(), "tool_execution_start", { toolCallId: "call_fg", toolName: "subagent", args: { agent: "worker", task: "t" } }, 1000);
	const ended = reduceSubagentAsyncToolEvent(started.state, "tool_execution_end", { toolCallId: "call_fg", toolName: "subagent", result: { content: [{ type: "text", text: "worker:\n全部完成" }] } }, 1100);
	assert.equal(ended.asyncId, undefined);
	assert.equal(ended.state.pending.size, 0);
	assert.equal(ended.state.byRunId.size, 0);
});

test("reduceSubagentAsyncToolEvent: action 管理查询 / 工作流脚本 / 非 subagent 工具不登记", () => {
	const { reduceSubagentAsyncToolEvent } = loadBridgeModule();
	const action = reduceSubagentAsyncToolEvent(emptyAsyncBridge(), "tool_execution_start", { toolCallId: "c1", toolName: "subagent", args: { agent: "worker", action: "list" } }, 1000);
	assert.equal(action.state.pending.size, 0);
	const workflow = reduceSubagentAsyncToolEvent(emptyAsyncBridge(), "tool_execution_start", { toolCallId: "c2", toolName: "subagent", args: { agent: "worker", workflowScript: "..." } }, 1000);
	assert.equal(workflow.state.pending.size, 0);
	const other = reduceSubagentAsyncToolEvent(emptyAsyncBridge(), "tool_execution_start", { toolCallId: "c3", toolName: "bash", args: { command: "ls" } }, 1000);
	assert.equal(other.state.pending.size, 0);
});

test("buildSubagentAsyncTerminal: 终态映射完整（complete/failed/partial/stopped/rejected）", () => {
	const { buildSubagentAsyncTerminal } = loadBridgeModule();
	const descriptor = { type: "worker", description: ASYNC_TASK, startedAt: 1000 };
	const cases = [
		["complete", "completed"],
		["failed", "error"],
		["partial", "error"],
		["stopped", "stopped"],
		["rejected", "stopped"],
	];
	for (const [state, expected] of cases) {
		const built = buildSubagentAsyncTerminal({ runId: ASYNC_RUN_ID, state, agent: "worker" }, descriptor, 2000);
		assert.equal(built.entry.status, expected);
		assert.equal(built.record.status, expected);
		assert.equal(built.record.id, ASYNC_RUN_ID);
		assert.equal(built.record.type, "worker");
		assert.equal(built.record.description, ASYNC_TASK);
		// 有描述符时 startedAt 取派发时刻，completedAt 退化到事件到达时刻（payload 无绝对时刻）
		assert.equal(built.record.startedAt, 1000);
		assert.equal(built.record.completedAt, 2000);
	}
});

test("buildSubagentAsyncTerminal: paused / 未知状态 / 缺 id 不落终态（运行可能恢复）", () => {
	const { buildSubagentAsyncTerminal } = loadBridgeModule();
	const descriptor = { type: "worker", description: "t", startedAt: 1000 };
	assert.equal(buildSubagentAsyncTerminal({ runId: ASYNC_RUN_ID, state: "paused" }, descriptor, 2000), undefined);
	assert.equal(buildSubagentAsyncTerminal({ runId: ASYNC_RUN_ID, state: "running" }, descriptor, 2000), undefined);
	assert.equal(buildSubagentAsyncTerminal({ runId: ASYNC_RUN_ID, state: "unknown-state" }, descriptor, 2000), undefined);
	assert.equal(buildSubagentAsyncTerminal({ state: "complete" }, descriptor, 2000), undefined);
	assert.equal(buildSubagentAsyncTerminal(null, descriptor, 2000), undefined);
});

test("buildSubagentAsyncTerminal: payload 绝对时刻与 durationMs 还原完成时间", () => {
	const { buildSubagentAsyncTerminal } = loadBridgeModule();
	const descriptor = { type: "worker", description: "t", startedAt: 1000 };
	const stamped = buildSubagentAsyncTerminal({ runId: ASYNC_RUN_ID, state: "complete", timestamp: 1500 }, descriptor, 2000);
	assert.equal(stamped.record.completedAt, 1500);
	// 无描述符（桥接晚于派发加载）：startedAt/completedAt 由真实时长反推，type 降级用 payload.agent
	const measured = buildSubagentAsyncTerminal({ id: ASYNC_RUN_ID, state: "complete", agent: "reviewer", durationMs: 500 }, undefined, 2000);
	assert.equal(measured.record.id, ASYNC_RUN_ID);
	assert.equal(measured.record.type, "reviewer");
	assert.equal(measured.record.description, "");
	assert.equal(measured.record.startedAt, 1500);
	assert.equal(measured.record.completedAt, 2000);
});

test("buildSubagentAsyncTerminal: 失败类终态携带错误摘要（截断 2000）", () => {
	const { buildSubagentAsyncTerminal } = loadBridgeModule();
	const built = buildSubagentAsyncTerminal({ runId: ASYNC_RUN_ID, state: "failed", error: "x".repeat(5000) }, undefined, 2000);
	assert.equal(built.record.status, "error");
	assert.equal(built.record.error.length, 2000);
	// 成功终态不写 error
	const ok = buildSubagentAsyncTerminal({ runId: ASYNC_RUN_ID, state: "complete", error: "ignored" }, undefined, 2000);
	assert.equal(ok.record.error, undefined);
});

test("bridge extension: 异步派发 + 终态事件 → subagents:record 落盘并并入桥接快照", async () => {
	const { default: bridge } = loadBridgeModule();
	const { pi, handlers, lifecycle, appendedEntries } = createMockPi();
	bridge(pi);

	const widgetCalls = [];
	const ctx = { ui: { setWidget: (key, lines) => widgetCalls.push({ key, lines }) } };
	lifecycle.get("session_start")({ type: "session_start" }, ctx);

	lifecycle.get("tool_execution_start")(asyncDispatchStart());
	lifecycle.get("tool_execution_end")(asyncDispatchEnd());
	// 派发阶段不落盘（只有运行中 widget 是插件的事）
	assert.equal(appendedEntries.length, 0);

	handlers.get("subagent:async-complete")({ runId: ASYNC_RUN_ID, state: "complete", agent: "worker", durationMs: 500, timestamp: 1791704545239 });

	assert.equal(appendedEntries.length, 1);
	assert.equal(appendedEntries[0].type, "subagents:record");
	const record = appendedEntries[0].data;
	assert.equal(record.id, ASYNC_RUN_ID);
	assert.equal(record.status, "completed");
	assert.equal(record.type, "worker");
	assert.equal(record.description, ASYNC_TASK);
	assert.equal(record.completedAt, 1791704545239);

	// 实时快照：终态条目必须并入（插件的 subagent-async widget 10s 后清空，
	// 桥接快照里的终态留到会话结束，否则渲染层回退到推导条目的 running）
	await new Promise((resolve) => setTimeout(resolve, 300));
	const last = widgetCalls.at(-1);
	assert.equal(last.key, "pi-deck-subagents");
	const snapshot = JSON.parse(last.lines[0]);
	const agent = snapshot.agents.find((a) => a.id === ASYNC_RUN_ID);
	assert.ok(agent, "终态条目应出现在桥接快照中");
	assert.equal(agent.status, "completed");
	assert.equal(agent.description, ASYNC_TASK);
});

test("bridge extension: 未登记 asyncId 的完成事件忽略、重复终态不重复落盘", () => {
	const { default: bridge } = loadBridgeModule();
	const { pi, handlers, lifecycle, appendedEntries } = createMockPi();
	bridge(pi);

	// 没经过派发的 run（工作流子 run 等）：不落盘、不进快照，避免面板凭空多出无描述条目
	handlers.get("subagent:async-complete")({ runId: "workflow-child-1", state: "complete", agent: "worker" });
	assert.equal(appendedEntries.length, 0);

	lifecycle.get("tool_execution_start")(asyncDispatchStart());
	lifecycle.get("tool_execution_end")(asyncDispatchEnd());
	handlers.get("subagent:async-complete")({ runId: ASYNC_RUN_ID, state: "complete", agent: "worker" });
	assert.equal(appendedEntries.length, 1);
	// 完成事件重放（投递重试/会话恢复）：同 run 同终态不重复写
	handlers.get("subagent:async-complete")({ runId: ASYNC_RUN_ID, state: "complete", agent: "worker" });
	assert.equal(appendedEntries.length, 1);
});

test("bridge extension: 异步终态 appendEntry 抛错不影响快照与后续事件", () => {
	const { default: bridge } = loadBridgeModule();
	const { lifecycle } = createMockPi();
	const appended = [];
	const throwingPi = {
		events: { on: () => {} },
		on: (name, cb) => {
			lifecycle.set(name, cb);
		},
		appendEntry: () => {
			appended.push("threw");
			throw new Error("session closed");
		},
	};
	// events.on 需要真正订阅（throwingPi 覆盖了 createMockPi 的 handlers）
	const handlers = new Map();
	throwingPi.events = { on: (name, cb) => handlers.set(name, cb) };
	bridge(throwingPi);

	lifecycle.get("tool_execution_start")(asyncDispatchStart());
	lifecycle.get("tool_execution_end")(asyncDispatchEnd());
	let threw = false;
	try {
		handlers.get("subagent:async-complete")({ runId: ASYNC_RUN_ID, state: "complete", agent: "worker" });
	} catch {
		threw = true;
	}
	assert.equal(threw, false);
	assert.deepEqual(appended, ["threw"]);
});
