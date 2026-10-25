import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function loadModule() {
	const source = readFileSync("src/renderer/src/components/session/trajectory/buildTrajectory.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	});
	const sandbox = { exports: {}, module: { exports: {} }, require: loadTrajectoryDep };
	sandbox.module.exports = sandbox.exports;
	vm.runInNewContext(outputText, sandbox, { filename: "buildTrajectory.ts" });
	return sandbox.exports;
}

/** buildTrajectory 依赖的 dsh 工具视图助手（独立纯模块，vm 内编译加载）。 */
function loadTrajectoryDep(specifier) {
	const file = specifier === "./dshToolView" ? "src/renderer/src/components/session/trajectory/dshToolView.ts" : specifier === "./trajectoryOrder" ? "src/renderer/src/components/session/trajectory/trajectoryOrder.ts" : undefined;
	if (!file) throw new Error(`unexpected require: ${specifier}`);
	const source = readFileSync(file, "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	});
	const sandbox = {
		exports: {},
		module: { exports: {} },
		require: (inner) => {
			if (inner === "./buildTrajectory") return {};
			throw new Error(`unexpected nested require: ${inner}`);
		},
	};
	sandbox.module.exports = sandbox.exports;
	vm.runInNewContext(outputText, sandbox, { filename: file });
	return sandbox.exports;
}

function msg(partial) {
	return {
		id: "m",
		agentId: "a",
		role: "user",
		text: "",
		timestamp: 1,
		...partial,
	};
}

test("user message opens a turn; assistant/tool/thinking belong to it", () => {
	const { buildTrajectory } = loadModule();
	const model = buildTrajectory([
		msg({ id: "u1", role: "user", text: "fix the bug", timestamp: 1000 }),
		msg({
			id: "a1",
			role: "assistant",
			text: "looking",
			thinking: "hmm",
			thinkingStartedAt: 1100,
			thinkingEndedAt: 1400,
			timestamp: 1500,
			stopReason: "toolUse",
		}),
		msg({
			id: "t1",
			role: "tool",
			text: "✓ read",
			timestamp: 1800,
			meta: {
				toolName: "read",
				toolCallId: "c1",
				startedAt: 1600,
				durationMs: 200,
				status: "done",
				detailText: "src/a.ts",
			},
		}),
	]);
	assert.equal(model.turns.length, 1);
	assert.equal(model.records.map((r) => r.kind).join(","), "user,thinking,assistant,tool");
	const tool = model.records.find((r) => r.kind === "tool");
	assert.equal(tool.startedAt, 1600);
	assert.equal(tool.durationMs, 200);
	assert.equal(tool.endedAt, 1800);
	assert.equal(tool.lane, "tools");
	assert.equal(model.records[0].lane, "input");
	assert.equal(model.records[1].lane, "model");
	assert.equal(model.records.find((r) => r.kind === "user")?.durationMs, undefined);
	assert.equal(model.records.find((r) => r.kind === "thinking")?.durationMs, 300);
	assert.equal(model.records.find((r) => r.kind === "assistant")?.durationMs, 100);
	assert.equal(model.turns[0].durationMs, 800);
});

test("history assistant without thinking span uses previous message as start", () => {
	const { buildTrajectory } = loadModule();
	const model = buildTrajectory([
		msg({ id: "u1", role: "user", text: "go", timestamp: 1000 }),
		msg({
			id: "a1",
			role: "assistant",
			text: "done",
			thinking: "plan",
			timestamp: 2500,
			stopReason: "stop",
		}),
	]);
	const thinking = model.records.find((r) => r.kind === "thinking");
	const assistant = model.records.find((r) => r.kind === "assistant");
	assert.equal(thinking?.durationMs, undefined);
	assert.equal(assistant?.startedAt, 1000);
	assert.equal(assistant?.endedAt, 2500);
	assert.equal(assistant?.durationMs, 1500);
	assert.equal(model.turns[0].durationMs, 1500);
});

test("in-flight tool does not invent duration", () => {
	const { buildTrajectory } = loadModule();
	const model = buildTrajectory(
		[
			msg({ id: "u1", role: "user", text: "go", timestamp: 10 }),
			msg({
				id: "t1",
				role: "tool",
				text: "▶ bash",
				timestamp: 20,
				meta: { toolName: "bash", startedAt: 15, status: "running" },
			}),
		],
		100,
	);
	const tool = model.records.find((r) => r.kind === "tool");
	assert.equal(tool.endedAt, undefined);
	assert.equal(tool.durationMs, undefined);
	assert.equal(model.turns[0].inFlight, true);
	assert.ok(model.domainEnd >= 100);
});

test("filterRecordsByRange keeps overlapping spans only", () => {
	const { filterRecordsByRange } = loadModule();
	const records = [
		{ id: "a", startedAt: 0, endedAt: 10 },
		{ id: "b", startedAt: 20, endedAt: 30 },
		{ id: "c", startedAt: 25, endedAt: undefined },
	];
	const hit = filterRecordsByRange(records, { start: 22, end: 28 }).map((r) => r.id);
	assert.equal(JSON.stringify(hit), JSON.stringify(["b", "c"]));
});

test("trajectory lives in the right drawer, not the session surface", () => {
	const sessionView = readFileSync("src/renderer/src/components/session/SessionView.tsx", "utf8");
	const stage = readFileSync("src/renderer/src/components/session/SessionSurfaceStage.tsx", "utf8");
	const header = readFileSync("src/renderer/src/components/session/SessionHeader.tsx", "utf8");
	const app = readFileSync("src/renderer/src/App.tsx", "utf8");
	const drawer = readFileSync("src/renderer/src/components/workspace/DrawerSurface.tsx", "utf8");
	const hook = readFileSync("src/renderer/src/hooks/useWorkspacePanels.ts", "utf8");
	assert.match(sessionView, /SessionSurfaceStage/);
	assert.doesNotMatch(sessionView, /sessionSurfaceViewByIdAtomFamily/);
	assert.doesNotMatch(stage, /SessionTrajectoryView/);
	assert.doesNotMatch(header, /session.view.trajectory/);
	assert.match(hook, /"trajectory"/);
	assert.match(app, /id: "trajectory"/);
	const rail = app.slice(app.indexOf("WorkspaceDrawerRail"));
	const trajectoryAt = rail.indexOf('id: "trajectory"');
	const browserAt = rail.indexOf('id: "browser"');
	assert.ok(trajectoryAt >= 0 && browserAt > trajectoryAt, "trajectory tab must sit before the built-in browser");
	assert.match(drawer, /SessionTrajectoryPanel/);
	assert.match(drawer, /drawer === "trajectory"/);
});

test("trajectory source concatenates runtime history prefix with the live window", () => {
	const source = readFileSync("src/renderer/src/hooks/useSessionTrajectorySource.ts", "utf8");
	const panel = readFileSync("src/renderer/src/components/session/trajectory/SessionTrajectoryPanel.tsx", "utf8");
	assert.match(source, /sessionMessageCacheBySessionIdAtomFamily/);
	assert.match(source, /\[\.\.\.cachedEntry\.history\.messages, \.\.\.cachedEntry\.messages\]/);
	assert.match(source, /prependSessionHistoryPageAtom/);
	assert.match(source, /readProcessEvents/);
	// 系统提示词走 processEvents 快照链路（pi 会话文件重放 / dsh system.message），
	// 不再单独读「最近一次请求头」或退回 pi-system 模板——那两条路只能看到最新提示，
	// 看不到会话开头的初始提示词与中途变更（2026-10 轨迹补齐）。
	assert.doesNotMatch(source, /pi-system/);
	assert.doesNotMatch(source, /readDshSystemPrompt/);
	assert.match(source, /record\?\.backend === "dsh"/);
	assert.match(source, /isDshSession/);
	assert.match(panel, /currentSessionIdAtom/);
	assert.match(panel, /processEvents/);
});

test("first user message is the initial prompt; process events join the ledger", () => {
	const { buildTrajectory } = loadModule();
	const model = buildTrajectory([msg({ id: "u1", role: "user", text: "first ask", timestamp: 2000 }), msg({ id: "u2", role: "user", text: "follow up", timestamp: 4000 })], 5000, {
		processEvents: [
			{ id: "s1", kind: "session", timestamp: 1000, summary: "cwd /repo", cwd: "/repo" },
			{ id: "m1", kind: "modelChange", timestamp: 2500, summary: "openai/gpt", provider: "openai", modelId: "gpt" },
			{
				id: "p1",
				kind: "systemPrompt",
				timestamp: 500,
				summary: "initial · 11 chars · 1 tools",
				detail: "You are pi.",
				prompt: { kind: "initial", text: "You are pi.", tools: ["bash"] },
			},
		],
	});
	assert.equal(model.records[0].kind, "systemPrompt");
	assert.equal(model.records[0].promptKind, "initial");
	assert.equal(model.records[0].prompt?.text, "You are pi.");
	assert.equal(model.records.find((r) => r.id === "u1")?.isInitialPrompt, true);
	assert.equal(model.records.find((r) => r.id === "u2")?.isInitialPrompt, undefined);
	assert.ok(model.records.some((r) => r.processKind === "session"));
	assert.ok(model.records.some((r) => r.processKind === "modelChange"));
	assert.equal(model.records.find((r) => r.kind === "systemPrompt")?.durationMs, undefined);
	assert.equal(model.records.find((r) => r.processKind === "session")?.durationMs, undefined);
});

test("assistant message usage lands on the trajectory record (DSH adapter report)", () => {
	const { buildTrajectory } = loadModule();
	const model = buildTrajectory([
		msg({ id: "u1", role: "user", text: "go", timestamp: 1000 }),
		msg({
			id: "a1",
			role: "assistant",
			text: "done",
			timestamp: 2000,
			stopReason: "stop",
			meta: {
				usage: { inputTokens: 120, outputTokens: 45, cacheReadTokens: 300, cacheWriteTokens: 12 },
			},
		}),
	]);
	const assistant = model.records.find((r) => r.kind === "assistant");
	assert.equal(assistant?.usage?.inputTokens, 120);
	assert.equal(assistant?.usage?.outputTokens, 45);
	assert.equal(assistant?.usage?.cacheReadTokens, 300);
	assert.equal(assistant?.usage?.cacheWriteTokens, 12);
});

test("assistant message without usage leaves record.usage undefined (pi path)", () => {
	const { buildTrajectory } = loadModule();
	const model = buildTrajectory([msg({ id: "u1", role: "user", text: "go", timestamp: 1000 }), msg({ id: "a1", role: "assistant", text: "done", timestamp: 2000, stopReason: "stop" })]);
	assert.equal(model.records.find((r) => r.kind === "assistant")?.usage, undefined);
});

test("ledger orders by seq, not array order (dsh-web layoutEntryOrder)", () => {
	const { buildTrajectory } = loadModule();
	const model = buildTrajectory([msg({ id: "dsh:30", role: "assistant", text: "later", timestamp: 3000, stopReason: "stop" }), msg({ id: "dsh:10", role: "user", text: "first", timestamp: 1000 }), msg({ id: "dsh:20", role: "tool", text: "read", timestamp: 2000, meta: { toolName: "read", status: "done" } })]);
	assert.equal(model.records.map((r) => r.kind).join(","), "user,tool,assistant");
	assert.equal(model.records.map((r) => r.seq).join(","), "10,20,30");
});

test("retry process event stays after the user that opened the turn", () => {
	const { buildTrajectory } = loadModule();
	const model = buildTrajectory([msg({ id: "dsh:10", role: "user", text: "go", timestamp: 2000 }), msg({ id: "dsh:40", role: "assistant", text: "ok", timestamp: 4000, stopReason: "stop" })], 5000, {
		processEvents: [
			{
				id: "retry-1",
				kind: "retry",
				timestamp: 2500,
				seq: 25,
				summary: "retry 1/3: overloaded",
				retry: 1,
				maxRetries: 3,
				retryDelayMs: 800,
			},
		],
	});
	assert.equal(model.records.map((r) => r.kind).join(","), "user,process,assistant");
	const retry = model.records.find((r) => r.processKind === "retry");
	assert.equal(retry?.retry, 1);
	assert.equal(retry?.maxRetries, 3);
	assert.equal(retry?.retryDelayMs, 800);
	assert.equal(retry?.turnIndex, 0);
});

test("tool records split inputDetail and outputDetail for the inspector copy blocks", () => {
	const { buildTrajectory } = loadModule();
	const model = buildTrajectory([
		msg({ id: "u1", role: "user", text: "run", timestamp: 1000 }),
		msg({
			id: "t1",
			role: "tool",
			text: "bash",
			timestamp: 1800,
			meta: {
				toolName: "bash",
				startedAt: 1600,
				durationMs: 200,
				status: "done",
				view: { for: "call", view: { card: "terminal", title: "ls", cwd: "/repo" } },
				resultView: { for: "result", view: { card: "terminal", output: "a.txt", exitCode: 0 } },
			},
		}),
	]);
	const tool = model.records.find((r) => r.kind === "tool");
	assert.match(tool?.inputDetail ?? "", /\$ ls/);
	assert.match(tool?.inputDetail ?? "", /cwd: \/repo/);
	assert.match(tool?.outputDetail ?? "", /a\.txt/);
	assert.match(tool?.outputDetail ?? "", /exit 0/);
});

test("inspector copy control is wired on the trajectory detail panel", () => {
	const view = readFileSync("src/renderer/src/components/session/trajectory/SessionTrajectoryView.tsx", "utf8");
	assert.match(view, /function CopyableBlock/);
	assert.match(view, /writeClipboard/);
	assert.match(view, /session\.trajectory\.field\.payload/);
	assert.match(view, /session\.trajectory\.field\.result/);
});

test("trajectory header turn count follows the unified round contract", () => {
	// 对外「N 轮」：DSH 会话用 host sessionStats（官方，与 dsh-web 一致）；pi 会话用
	// countUserTurns（发言权周期，与分页/缓存协议同口径）。账本分组仍按 user 开轮。
	const view = readFileSync("src/renderer/src/components/session/trajectory/SessionTrajectoryView.tsx", "utf8");
	assert.match(view, /countUserTurns/);
	assert.match(view, /dshSessionStats\.turns/);
	assert.doesNotMatch(view, /count: model\.turns\.length/);
	assert.doesNotMatch(view, /countDialogueTurns/);
});

test("model traces land in their user turns as point records", () => {
	const { buildTrajectory } = loadModule();
	const model = buildTrajectory([msg({ id: "u1", role: "user", text: "first", timestamp: 1000 }), msg({ id: "a1", role: "assistant", text: "ok", timestamp: 1500 }), msg({ id: "u2", role: "user", text: "second", timestamp: 3000 }), msg({ id: "a2", role: "assistant", text: "done", timestamp: 3500 })], Date.now(), {
		modelTraces: [
			// 乱序传入：内部按 time 归轮，不得依赖入参顺序
			{ traceId: "t2", agentId: "ag1", time: 3100, model: "glm-5.3", provider: "openai", messageCount: 8, toolCount: 28, payloadBytes: 61234, truncated: false },
			{ traceId: "t1", agentId: "ag1", time: 1050, model: "glm-5.3", provider: "openai", messageCount: 4, toolCount: 28, payloadBytes: 56800 },
		],
	});
	const requests = model.records.filter((r) => r.kind === "modelRequest");
	assert.equal(requests.length, 2);
	const first = requests.find((r) => r.id === "model:t1");
	const second = requests.find((r) => r.id === "model:t2");
	assert.equal(first?.turnIndex, 0);
	assert.equal(second?.turnIndex, 1);
	// 请求快照是时间点：起止同刻，不得伪造区间
	assert.equal(first?.startedAt, first?.endedAt);
	assert.equal(first?.durationMs, undefined);
	assert.equal(first?.lane, "model");
	// 摘要携带体积与计数（账本时长列改显体积）
	assert.match(second?.summary ?? "", /8 msgs/);
	assert.match(second?.summary ?? "", /28 tools/);
	assert.match(second?.summary ?? "", /59\.8 KB|1\.5 MB/);
	// 回读指针完整保留：agentId/messageCount/truncated 供检查器使用
	assert.equal(first?.modelTrace?.agentId, "ag1");
	assert.equal(second?.modelTrace?.truncated, false);
	assert.equal(first?.modelTrace?.messageCount, 4);
});

test("model trace before the first user message falls into turn 0; without messages it forms its own turn", () => {
	const { buildTrajectory } = loadModule();
	const early = buildTrajectory([msg({ id: "u1", role: "user", text: "hi", timestamp: 2000 })], Date.now(), {
		modelTraces: [{ traceId: "t0", time: 1500 }],
	});
	const earlyRecord = early.records.find((r) => r.kind === "modelRequest");
	assert.equal(earlyRecord?.turnIndex, 0);
	assert.ok(early.turns[0].records.some((r) => r.id === "model:t0"));

	const empty = buildTrajectory([], Date.now(), { modelTraces: [{ traceId: "solo", time: 5000 }] });
	assert.equal(empty.turns.length, 1);
	assert.equal(empty.records[0]?.kind, "modelRequest");
	assert.equal(empty.records[0]?.startedAt, empty.records[0]?.endedAt);
});

test("modelRequest ledger wiring: kindLabel key, size label in duration column, full-request entry", () => {
	// 展示层接线契约：kind 标签、时长列改显体积、检查器可回读完整请求体
	const view = readFileSync("src/renderer/src/components/session/trajectory/SessionTrajectoryView.tsx", "utf8");
	assert.match(view, /session\.trajectory\.kind\.modelRequest/);
	assert.match(view, /traceSizeLabel/);
	assert.match(view, /viewFullRequest/);
	assert.match(view, /ModelTraceDetail/);
});

test("prompt updates stay where they happened; only the initial prompt is hoisted", () => {
	const { buildTrajectory } = loadModule();
	const model = buildTrajectory([msg({ id: "u1", role: "user", text: "go", timestamp: 1000 }), msg({ id: "a1", role: "assistant", text: "ok", timestamp: 2000, stopReason: "stop" })], 9000, {
		processEvents: [
			{ id: "p0", kind: "systemPrompt", timestamp: 500, summary: "initial", prompt: { kind: "initial", text: "base", tools: [] } },
			{ id: "p1", kind: "systemPrompt", timestamp: 3000, summary: "update", prompt: { kind: "update", text: "base+v2", tools: ["bash"] } },
		],
	});
	const order = model.records.map((record) => (record.kind === "systemPrompt" ? `prompt:${record.promptKind}` : record.kind)).join(",");
	assert.equal(order, "prompt:initial,user,assistant,prompt:update");
	assert.equal(model.records[0].prompt?.text, "base");
	assert.equal(model.records[3].prompt?.tools.join(","), "bash");
});

test("system prompt snapshot renders in the ledger inspector, replacing the pi-system fallback", () => {
	const view = readFileSync("src/renderer/src/components/session/trajectory/SessionTrajectoryView.tsx", "utf8");
	assert.match(view, /function PromptSnapshotDetail/);
	assert.match(view, /session\.trajectory\.prompt\.fullText/);
	assert.match(view, /session\.trajectory\.prompt\.toolList/);
	assert.match(view, /record\.promptKind === "initial"/);
	assert.doesNotMatch(view, /readDshSystemPrompt|desktopApi.prompts/);
});

test("pi assistant durationMs drives the exact ledger span", () => {
	const { buildTrajectory } = loadModule();
	const model = buildTrajectory([msg({ id: "u1", role: "user", text: "go", timestamp: 1000 }), msg({ id: "a1", role: "assistant", text: "ok", timestamp: 1200, stopReason: "stop", meta: { durationMs: 4000, startedAt: 1200, usage: { inputTokens: 10, outputTokens: 20, reasoningTokens: 5 } } })]);
	const assistant = model.records.find((record) => record.kind === "assistant");
	assert.equal(assistant?.startedAt, 1200);
	assert.equal(assistant?.endedAt, 5200);
	assert.equal(assistant?.durationMs, 4000);
	assert.equal(assistant?.usage?.reasoningTokens, 5);
});
