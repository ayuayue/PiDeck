import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function loadModule() {
	const source = readFileSync(
		"src/renderer/src/components/session/trajectory/buildTrajectory.ts",
		"utf8",
	);
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
	const file =
		specifier === "./dshToolView"
			? "src/renderer/src/components/session/trajectory/dshToolView.ts"
			: specifier === "./trajectoryOrder"
				? "src/renderer/src/components/session/trajectory/trajectoryOrder.ts"
				: undefined;
	if (!file) throw new Error(`unexpected require: ${specifier}`);
	const source = readFileSync(file, "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	});
	const sandbox = {
		exports: {},
		module: { exports: {} },
		require: (inner) => {
			if (inner === "./buildTrajectory") return { };
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
	assert.match(source, /pi-system/);
	// dsh 会话：系统提示由 harness 在请求时组装，从 host request/header 事件读取
	// （readDshSystemPrompt），不加载 pi 的 pi-system 模板——否则 dsh 轨迹错误显示
	// pi 的系统提示（2026-08 用户反馈）
	assert.match(source, /record\?\.backend === "dsh"/);
	assert.match(source, /isDshSession/);
	assert.match(source, /readDshSystemPrompt/);
	assert.match(panel, /currentSessionIdAtom/);
	assert.match(panel, /processEvents/);
});

test("first user message is the initial prompt; process events join the ledger", () => {
	const { buildTrajectory } = loadModule();
	const model = buildTrajectory(
		[
			msg({ id: "u1", role: "user", text: "first ask", timestamp: 2000 }),
			msg({ id: "u2", role: "user", text: "follow up", timestamp: 4000 }),
		],
		5000,
		{
			processEvents: [
				{ id: "s1", kind: "session", timestamp: 1000, summary: "cwd /repo", cwd: "/repo" },
				{ id: "m1", kind: "modelChange", timestamp: 2500, summary: "openai/gpt", provider: "openai", modelId: "gpt" },
			],
			systemPrompt: "You are pi.",
		},
	);
	assert.equal(model.records[0].kind, "systemPrompt");
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
	const model = buildTrajectory([
		msg({ id: "u1", role: "user", text: "go", timestamp: 1000 }),
		msg({ id: "a1", role: "assistant", text: "done", timestamp: 2000, stopReason: "stop" }),
	]);
	assert.equal(model.records.find((r) => r.kind === "assistant")?.usage, undefined);
});

test("ledger orders by seq, not array order (dsh-web layoutEntryOrder)", () => {
	const { buildTrajectory } = loadModule();
	const model = buildTrajectory([
		msg({ id: "dsh:30", role: "assistant", text: "later", timestamp: 3000, stopReason: "stop" }),
		msg({ id: "dsh:10", role: "user", text: "first", timestamp: 1000 }),
		msg({ id: "dsh:20", role: "tool", text: "read", timestamp: 2000, meta: { toolName: "read", status: "done" } }),
	]);
	assert.equal(model.records.map((r) => r.kind).join(","), "user,tool,assistant");
	assert.equal(model.records.map((r) => r.seq).join(","), "10,20,30");
});

test("retry process event stays after the user that opened the turn", () => {
	const { buildTrajectory } = loadModule();
	const model = buildTrajectory(
		[
			msg({ id: "dsh:10", role: "user", text: "go", timestamp: 2000 }),
			msg({ id: "dsh:40", role: "assistant", text: "ok", timestamp: 4000, stopReason: "stop" }),
		],
		5000,
		{
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
		},
	);
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
