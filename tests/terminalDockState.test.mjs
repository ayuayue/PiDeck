import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function compile(filePath, imports = {}) {
	const output = ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
			jsx: ts.JsxEmit.ReactJSX,
		},
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(output, {
		module,
		exports: module.exports,
		require: (id) => imports[id] ?? {},
	});
	return module.exports;
}

function loadTerminalDockStateModule() {
	return compile("src/renderer/src/terminalDockState.ts");
}

function assertMotion(state, expected) {
	assert.equal(state.mounted, expected.mounted);
	assert.equal(state.closing, expected.closing);
	assert.equal(state.agentId, expected.agentId);
}

function loadDockMotion() {
	return compile("src/renderer/src/components/session/SessionRuntimeDock.tsx", {
		react: {},
		"react/jsx-runtime": { jsx: () => null },
		"../terminal/TerminalDock": {},
	});
}

test("remembers collapsed terminal dock state for each agent", () => {
	const { setTerminalDockCollapsed } = loadTerminalDockStateModule();
	const current = {
		agentA: { open: true, collapsed: false },
		agentB: { open: true, collapsed: false },
	};
	const next = setTerminalDockCollapsed(current, "agentA", true);
	assert.equal(next.agentA.collapsed, true);
	assert.equal(next.agentA.open, true);
	assert.equal(next.agentB.collapsed, false);
});

test("preserves collapsed state when toggling terminal open state", () => {
	const { setTerminalDockOpen } = loadTerminalDockStateModule();
	const closed = setTerminalDockOpen({ agentA: { open: true, collapsed: true } }, "agentA", false);
	const reopened = setTerminalDockOpen(closed, "agentA", true);
	assert.equal(closed.agentA.open, false);
	assert.equal(reopened.agentA.collapsed, true);
});

test("prunes agent and project keys against their own live sets", () => {
	const { pruneTerminalDockState, terminalOwnerKey } = loadTerminalDockStateModule();
	const agentA = terminalOwnerKey({ kind: "agent", id: "agentA" });
	const agentB = terminalOwnerKey({ kind: "agent", id: "agentB" });
	const projectP = terminalOwnerKey({ kind: "project", id: "projP" });
	const current = {
		[agentA]: { open: true, collapsed: true },
		[agentB]: { open: true, collapsed: false },
		[projectP]: { open: true, collapsed: false },
	};

	// 关键回归：不能用 agent 集合误删 project 键
	const next = pruneTerminalDockState(current, new Set(["agentB"]), new Set(["projP"]));

	assert.equal(next[agentA], undefined);
	assert.equal(next[agentB].open, true);
	assert.equal(next[projectP].open, true);
});

test("streaming prune preserves canonical agent state without allocating a new state object", () => {
	const { pruneTerminalDockState, terminalOwnerKey } = loadTerminalDockStateModule();
	const agentId = "streaming-agent";
	const ownerKey = terminalOwnerKey({ kind: "agent", id: agentId });
	const current = { [ownerKey]: { open: true, collapsed: false } };

	// 流式 runtime-state 更新会反复触发 prune；存活 agent 的终端不能被清掉，
	// 且不应创建新对象触发额外 React 更新。
	const next = pruneTerminalDockState(current, new Set([agentId]), new Set());
	assert.strictEqual(next, current);
	assert.equal(next[ownerKey].open, true);

	// 兼容已运行实例：旧 hook 曾把 agentId 直接当 key 写入；流式 prune 时应迁移，
	// 不能把当前已打开的终端直接删掉。
	const legacy = { [agentId]: { open: true, collapsed: false } };
	const migrated = pruneTerminalDockState(legacy, new Set([agentId]), new Set());
	assert.notStrictEqual(migrated, legacy);
	assert.equal(migrated[agentId], undefined);
	assert.equal(migrated[ownerKey].open, true);

	// 如果热更新期间两种 key 同时存在，已写入的新 canonical 状态优先。
	const duplicate = {
		[agentId]: { open: false, collapsed: true },
		[ownerKey]: { open: true, collapsed: false },
	};
	const normalized = pruneTerminalDockState(duplicate, new Set([agentId]), new Set());
	assert.equal(normalized[agentId], undefined);
	assert.equal(normalized[ownerKey].open, true);
	assert.equal(normalized[ownerKey].collapsed, false);
});

test("terminal dock hook converts owners into canonical owner keys", () => {
	const hookSource = readFileSync("src/renderer/src/hooks/useTerminalDock.ts", "utf8");

	// 终端状态 helper 的 prune 契约只识别 agent:<id>/project:<id>；hook 必须
	// 用 terminalOwnerKey 归一 owner，不能存裸 id。project owner（引导页/未激活
	// agent/历史会话）与 agent owner 共用同一套键模型，保证不串台。
	assert.match(hookSource, /terminalOwnerKey\(activeOwner\)/);
	assert.match(hookSource, /terminalDockStateByOwner\[activeOwnerKey\]/);
	// 分屏各栏按自己的 owner key 写入状态表（per-owner setter），
	// 激活 owner 的开关仍走同一入口，键模型不变。
	assert.match(hookSource, /setTerminalDockOpen\(current, ownerKey, open\)/);
	assert.match(hookSource, /setTerminalDockCollapsed\(current, ownerKey, collapsed\)/);
	assert.match(hookSource, /setTerminalOpenByOwnerKey\(activeOwnerKey, open\)/);
	assert.match(hookSource, /setTerminalCollapsedByOwnerKey\(activeOwnerKey, collapsed\)/);
	assert.match(hookSource, /activeOwner: TerminalDockOwner \| undefined/);
	// 分屏高度是全局单份并持久化（与抽屉宽度同策略）：首帧从 localStorage 恢复
	// 上次拖拽结果，拖拽回写时落盘；不再按 owner 分桶，项目/agent 终端共享同一高度。
	assert.match(hookSource, /loadTerminalHeight\(COMPOSER_DEFAULT_TERMINAL_HEIGHT\)/);
	assert.match(hookSource, /saveTerminalHeight\(next\)/);
});

function loadTerminalDockStateWithStorage(storage) {
	const output = ts.transpileModule(readFileSync("src/renderer/src/terminalDockState.ts", "utf8"), {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText;
	const module = { exports: {} };
	// terminalDockState.ts 直接引用浏览器全局 localStorage，测试用替身注入
	vm.runInNewContext(output, {
		module,
		exports: module.exports,
		require: () => ({}),
		localStorage: storage,
	});
	return module.exports;
}

function createMemoryStorage() {
	const map = new Map();
	return {
		getItem: (key) => (map.has(key) ? map.get(key) : null),
		setItem: (key, value) => map.set(key, String(value)),
	};
}

test("terminal panel resize collapses below threshold and expands with height above it", () => {
	const { applyTerminalPanelResize } = loadTerminalDockStateModule();

	// 注意：对象来自 vm 沙箱，原型与本域不同，不能用 deepEqual，逐属性断言。

	// 展开态拖到折叠条高度 → 折叠，不写高度
	let intent = applyTerminalPanelResize({ px: 20, collapsed: false, maxHeight: 500 });
	assert.equal(intent.collapsed, true);
	assert.equal(intent.height, undefined);

	// 已折叠再收到程序化 resize 到阈值下 → 无变化，调用方可跳过 setState
	intent = applyTerminalPanelResize({ px: 20, collapsed: true, maxHeight: 500 });
	assert.equal(intent.collapsed, undefined);
	assert.equal(intent.height, undefined);

	// 折叠态拖回展开 → 同时给出展开意图与新高度
	intent = applyTerminalPanelResize({ px: 300, collapsed: true, maxHeight: 500 });
	assert.equal(intent.collapsed, false);
	assert.equal(intent.height, 300);

	// 展开态普通拖拽 → 只回写高度，不动折叠态
	intent = applyTerminalPanelResize({ px: 300, collapsed: false, maxHeight: 500 });
	assert.equal(intent.collapsed, undefined);
	assert.equal(intent.height, 300);
});

test("terminal panel resize clamps height into [min, maxHeight]", () => {
	const { applyTerminalPanelResize, TERMINAL_HEIGHT_MIN } = loadTerminalDockStateModule();

	// 超过可用上限：clamp 到 maxHeight，防止终端吃掉整个工作区
	assert.equal(applyTerminalPanelResize({ px: 2000, collapsed: false, maxHeight: 400 }).height, 400);
	// 高于折叠阈值但低于最小高度：clamp 到 TERMINAL_HEIGHT_MIN
	assert.equal(applyTerminalPanelResize({ px: 50, collapsed: false, maxHeight: 500 }).height, TERMINAL_HEIGHT_MIN);
	// 小数像素四舍五入
	assert.equal(applyTerminalPanelResize({ px: 299.6, collapsed: false, maxHeight: 500 }).height, 300);
});

test("terminal height persists across reloads and rejects invalid stored values", () => {
	const storage = createMemoryStorage();
	const mod = loadTerminalDockStateWithStorage(storage);

	// 无存档时返回调用方默认值
	assert.equal(mod.loadTerminalHeight(220), 220);

	// 拖拽回写后重新加载能恢复上次大小（跨重启持久化的核心契约）
	mod.saveTerminalHeight(280);
	assert.equal(mod.loadTerminalHeight(220), 280);

	// 写入时 clamp 到最小高度，避免异常值写坏布局
	mod.saveTerminalHeight(10);
	assert.equal(Number(storage.getItem(mod.TERMINAL_HEIGHT_STORAGE_KEY)), mod.TERMINAL_HEIGHT_MIN);

	// 存档损坏 / 低于最小高度时退回默认值，不让布局卡死
	storage.setItem(mod.TERMINAL_HEIGHT_STORAGE_KEY, "not-a-number");
	assert.equal(mod.loadTerminalHeight(220), 220);
	storage.setItem(mod.TERMINAL_HEIGHT_STORAGE_KEY, "40");
	assert.equal(mod.loadTerminalHeight(220), 220);
});

test("terminal height helpers survive unavailable localStorage", () => {
	const throwing = {
		getItem: () => {
			throw new Error("unavailable");
		},
		setItem: () => {
			throw new Error("quota");
		},
	};
	const mod = loadTerminalDockStateWithStorage(throwing);

	// localStorage 不可用（隐私模式等）时不抛异常，退回默认高度
	assert.equal(mod.loadTerminalHeight(220), 220);
	assert.doesNotThrow(() => mod.saveTerminalHeight(300));
});

test("rapid reopen cancels the closing state without a second timer owner", () => {
	const { transitionSessionRuntimeDock } = loadDockMotion();
	const open = transitionSessionRuntimeDock({ mounted: false, closing: false }, { agentId: "A", open: true });
	const closing = transitionSessionRuntimeDock(open, { agentId: "A", open: false });
	const reopened = transitionSessionRuntimeDock(closing, { agentId: "A", open: true });
	assertMotion(closing, { mounted: true, closing: true, agentId: "A" });
	assertMotion(reopened, { mounted: true, closing: false, agentId: "A" });
});

test("runtime replacement mounts B directly and close completion cannot retain stale A", () => {
	const { transitionSessionRuntimeDock, finishSessionRuntimeDockClose, disposeSessionRuntimeDock } = loadDockMotion();
	const agentB = transitionSessionRuntimeDock({ mounted: true, closing: false, agentId: "A" }, { agentId: "B", open: true });
	const closed = finishSessionRuntimeDockClose(transitionSessionRuntimeDock(agentB, { agentId: undefined, open: false }));
	assertMotion(agentB, { mounted: true, closing: false, agentId: "B" });
	assertMotion(closed, { mounted: false, closing: false, agentId: undefined });
	assertMotion(disposeSessionRuntimeDock(), { mounted: false, closing: false, agentId: undefined });
});

test("pane terminal dock stays mounted when its owner differs from the active owner", () => {
	const { shouldMountPaneTerminalDock, terminalOwnerKey } = loadTerminalDockStateModule();
	const agentA = terminalOwnerKey({ kind: "agent", id: "agentA" });
	const agentB = terminalOwnerKey({ kind: "agent", id: "agentB" });
	const projectP = terminalOwnerKey({ kind: "project", id: "projP" });

	// 分屏双栏各有自己的 agent：聚焦切到 B 后，A 的终端不再消失（本次修复的核心契约）
	assert.equal(
		shouldMountPaneTerminalDock({
			ownerKey: agentA,
			activeOwnerKey: agentB,
			focused: false,
			open: true,
		}),
		true,
	);
	// 聚焦栏（owner 与激活 owner 相同）始终挂载
	assert.equal(
		shouldMountPaneTerminalDock({
			ownerKey: agentA,
			activeOwnerKey: agentA,
			focused: true,
			open: true,
		}),
		true,
	);
	// 终端没开 → 不挂载
	assert.equal(
		shouldMountPaneTerminalDock({
			ownerKey: agentA,
			activeOwnerKey: agentA,
			focused: true,
			open: false,
		}),
		false,
	);
	// owner 未解析（无 agent 也无 project）→ 不挂载
	assert.equal(
		shouldMountPaneTerminalDock({
			ownerKey: undefined,
			activeOwnerKey: agentA,
			focused: true,
			open: true,
		}),
		false,
	);
});

test("shared project owner dereplicates against the focused pane", () => {
	const { shouldMountPaneTerminalDock, terminalOwnerKey } = loadTerminalDockStateModule();
	const projectP = terminalOwnerKey({ kind: "project", id: "projP" });

	// 同一项目终端（两条历史会话都回退 project owner）：只允许聚焦栏挂载，
	// 避免同一 owner 的两个 TerminalDock 双份订阅同一 PTY。
	assert.equal(
		shouldMountPaneTerminalDock({
			ownerKey: projectP,
			activeOwnerKey: projectP,
			focused: true,
			open: true,
		}),
		true,
	);
	assert.equal(
		shouldMountPaneTerminalDock({
			ownerKey: projectP,
			activeOwnerKey: projectP,
			focused: false,
			open: true,
		}),
		false,
	);
});

test("pane terminal resolves agent target from its own runtime and project fallback", () => {
	const { resolvePaneTerminal, terminalOwnerKey } = loadTerminalDockStateModule();

	// agent runtime 可用 → agent 目标（runtimeGeneration 必须存在才算绑定句柄）
	const withAgent = resolvePaneTerminal({
		sessionId: "session-1",
		runtime: { agentId: "agentA", runtimeGeneration: 3, status: "running" },
		projectId: "projP",
		project: { id: "projP", path: "C:/work/projP", kind: undefined },
	});
	assert.equal(withAgent.owner.kind, "agent");
	assert.equal(withAgent.owner.id, "agentA");
	assert.equal(withAgent.target.kind, "agent");
	assert.equal(withAgent.target.agentId, "agentA");
	assert.equal(withAgent.target.sessionId, "session-1");
	assert.equal(withAgent.target.runtimeGeneration, 3);

	// 无 runtime（历史会话）→ project 目标，owner 落 project
	const history = resolvePaneTerminal({
		sessionId: "session-2",
		runtime: undefined,
		projectId: "projP",
		project: { id: "projP", path: "C:/work/projP" },
	});
	assert.equal(history.owner.kind, "project");
	assert.equal(terminalOwnerKey(history.owner), "project:projP");
	assert.equal(history.target.kind, "project");
	assert.equal(history.target.projectId, "projP");
	assert.equal("cwd" in history.target, false);

	// Chat 项目没有可落地的 cwd → 不提供终端
	const chat = resolvePaneTerminal({
		sessionId: "session-3",
		runtime: undefined,
		projectId: "chatP",
		project: { id: "chatP", path: "chat", kind: "chat" },
	});
	assert.equal(chat, undefined);

	// pending-* 只是渲染层占位 id，不能当作 agent owner
	const pending = resolvePaneTerminal({
		sessionId: "session-4",
		runtime: { agentId: "pending-1", runtimeGeneration: 1 },
		projectId: "projP",
		project: { id: "projP", path: "C:/work/projP" },
	});
	assert.equal(pending.owner.kind, "project");
	assert.equal(pending.target.kind, "project");

	// 既无 agent 也无 project → undefined
	assert.equal(resolvePaneTerminal({ sessionId: "session-5", runtime: undefined }), undefined);
});
