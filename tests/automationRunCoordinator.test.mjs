import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { AutomationStore } = loadTsCommonJs("src/main/automation/AutomationStore.ts");
const { AutomationRunCoordinator } = loadTsCommonJs("src/main/automation/AutomationRunCoordinator.ts");

/**
 * 构造与真实事件桥一致的 agents:runtime-state 事件。
 * 注意：emitStreamingStatePatch / 工具边沿事件的 state 里「没有」isTurnActive 字段——
 * 这正是回归测试要覆盖的形状（缺失字段绝不能被当作 false 解释成「回合已结束」）。
 */
function runtimeStateEvent(sessionId, state, extra = {}) {
	return {
		sourceChannel: "agents:runtime-state",
		sessionId,
		agentId: "agent-123",
		runtimeGeneration: 1,
		payload: { agentId: "agent-123", state, ...extra },
	};
}

/**
 * 构造 agents:state 单 tab 快照事件（桥接层把 emitState 的全量 tab 列表拆成单 tab 转发）。
 * 这是终态判定（idle/error/closed）的唯一入口。
 */
function tabStateEvent(sessionId, status, extra = {}) {
	return {
		sourceChannel: "agents:state",
		sessionId,
		agentId: "agent-123",
		runtimeGeneration: 1,
		payload: { id: "agent-123", status, ...extra },
	};
}

function createMockDeps(store) {
	const createdSessions = [];
	const sentPrompts = [];
	const abortedTargets = [];
	const stoppedTargets = [];

	// getRuntimeState 在终态收尾（completeRun）时被调用来补采最终指标；测试可随时替换
	let runtimeState = { inputTokens: 0, outputTokens: 0, cost: 0 };

	const catalog = {
		createDraft: async (opts) => {
			const session = {
				id: `session-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
				projectId: opts.projectId,
				title: opts.title,
				source: opts.source,
			};
			createdSessions.push(session);
			return session;
		},
	};

	const sessionRuntimeCoordinator = {
		send: async (payload) => {
			sentPrompts.push(payload);
			return {
				accepted: true,
				agentId: "agent-123",
				runtimeGeneration: 1,
			};
		},
		abortRuntime: async (target) => {
			abortedTargets.push(target);
		},
		stopRuntime: async (target) => {
			stoppedTargets.push(target);
		},
		getTarget: () => null,
		getRuntimeState: async (target) => ({
			ok: true,
			value: { target, value: { ...runtimeState } },
		}),
	};

	const projectStore = {
		get: (id) => ({ id, name: "Test Project", path: "/test", environment: "native" }),
	};

	return {
		store,
		catalog,
		sessionRuntimeCoordinator,
		projectStore,
		createdSessions,
		sentPrompts,
		abortedTargets,
		stoppedTargets,
		setRuntimeState(next) {
			runtimeState = next;
		},
	};
}

/** 建任务 + 启动 coordinator + 排队并等待 dispatch 完成，返回常用句柄 */
async function createStartedCoordinator(store, taskOverrides = {}) {
	const task = await store.createTask({
		name: "Nightly Health Check",
		projectId: "p1",
		prompt: "Check repo status",
		schedule: { type: "cron", expression: "0 0 * * *" },
		budget: { timeoutMs: 60_000, maxTokens: 10_000 },
		...taskOverrides,
	}, 1_000);
	const deps = createMockDeps(store);
	const coordinator = new AutomationRunCoordinator(deps);
	const run = await coordinator.enqueueRun(task, undefined, "manual", 1_050);
	await new Promise((r) => setTimeout(r, 20));
	return { task, deps, coordinator, run, sessionId: deps.createdSessions[0].id };
}

test("AutomationRunCoordinator marks success only on agents:state idle, not on streaming patches", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pideck-coord-test-"));
	const storePath = join(dir, "automation.json");
	try {
		const store = new AutomationStore(storePath);
		await store.load(1_000);
		const { deps, coordinator, run, sessionId } = await createStartedCoordinator(store);

		assert.equal(deps.sentPrompts.length, 1);
		assert.equal(deps.sentPrompts[0].message, "Check repo status");
		const runningRun = store.getRun(run.id);
		assert.ok(runningRun.status === "starting" || runningRun.status === "running");
		assert.equal(runningRun.sessionId, sessionId);

		// agent_start 边沿：完整快照带 isTurnActive=true，记账回合开始
		coordinator.observeRuntimeEvent(runtimeStateEvent(sessionId, {
			inputTokens: 120,
			outputTokens: 80,
			cost: 0.005,
			isTurnActive: true,
			isExecutingTool: false,
		}));

		// 流式补丁（emitStreamingStatePatch 形状）：没有 isTurnActive 字段——
		// 回归点：旧实现把缺失字段当 false，会在这里误判成功并杀掉 pi 进程
		coordinator.observeRuntimeEvent(runtimeStateEvent(sessionId, {
			isStreaming: true,
			isExecutingTool: false,
		}));

		// 工具结束边沿（emitToolRuntimeTransition 形状）：同样没有 isTurnActive
		coordinator.observeRuntimeEvent(runtimeStateEvent(sessionId, {
			isExecutingTool: false,
		}));

		await new Promise((r) => setTimeout(r, 20));
		// 关键断言：补丁不得触发终态
		assert.equal(store.getRun(run.id).status, "running");

		// pi agent_settled → emitState idle：唯一合法的成功终态
		deps.setRuntimeState({ inputTokens: 120, outputTokens: 80, cost: 0.005 });
		coordinator.observeRuntimeEvent(tabStateEvent(sessionId, "idle"));
		await new Promise((r) => setTimeout(r, 20));

		const finishedRun = store.getRun(run.id);
		assert.equal(finishedRun.status, "succeeded");
		// 终态指标来自 getRuntimeState 补采
		assert.equal(finishedRun.inputTokens, 120);
		assert.equal(finishedRun.outputTokens, 80);
		assert.equal(finishedRun.costUsd, 0.005);
		// 成功后应释放 runtime（停掉 pi 子进程），防止进程泄漏
		assert.equal(deps.stoppedTargets.length, 1);
		assert.equal(deps.stoppedTargets[0].sessionId, sessionId);

		coordinator.dispose();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("AutomationRunCoordinator marks failed on error even after isTurnActive=false edge", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pideck-coord-error-"));
	const storePath = join(dir, "automation.json");
	try {
		const store = new AutomationStore(storePath);
		await store.load(1_000);
		const { deps, coordinator, run, sessionId } = await createStartedCoordinator(store);

		// 回合开始
		coordinator.observeRuntimeEvent(runtimeStateEvent(sessionId, {
			inputTokens: 10,
			outputTokens: 5,
			cost: 0.001,
			isTurnActive: true,
			isExecutingTool: false,
		}));
		// agent_end 带 error 时先发 isTurnActive=false 边沿——
		// 回归点：旧实现在这里就判定成功，随后的 error 快照永远来不及生效
		coordinator.observeRuntimeEvent(runtimeStateEvent(sessionId, {
			isTurnActive: false,
			isExecutingTool: false,
		}));
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(store.getRun(run.id).status, "running");

		// 紧随其后的 error 状态才是真实终态
		coordinator.observeRuntimeEvent(tabStateEvent(sessionId, "error", { error: "Model returned 500" }));
		await new Promise((r) => setTimeout(r, 20));

		const failedRun = store.getRun(run.id);
		assert.equal(failedRun.status, "failed");
		assert.equal(failedRun.error, "Model returned 500");
		// 失败时不停 runtime，保留现场供用户打开会话排查
		assert.equal(deps.stoppedTargets.length, 0);

		coordinator.dispose();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("AutomationRunCoordinator ignores idle snapshot before the turn starts", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pideck-coord-stale-"));
	const storePath = join(dir, "automation.json");
	try {
		const store = new AutomationStore(storePath);
		await store.load(1_000);
		const { deps, coordinator, run, sessionId } = await createStartedCoordinator(store);

		// dispatch 后残留的空闲快照（attach/重启竞态）：不能误判为完成
		coordinator.observeRuntimeEvent(tabStateEvent(sessionId, "idle"));
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(store.getRun(run.id).status, "running");

		// 回合真正开始
		coordinator.observeRuntimeEvent(runtimeStateEvent(sessionId, {
			isTurnActive: true,
			isExecutingTool: false,
		}));

		// 此时的 idle 才是回合结束
		coordinator.observeRuntimeEvent(tabStateEvent(sessionId, "idle"));
		await new Promise((r) => setTimeout(r, 20));

		assert.equal(store.getRun(run.id).status, "succeeded");

		coordinator.dispose();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("AutomationRunCoordinator marks failed when runtime closes before finishing", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pideck-coord-closed-"));
	const storePath = join(dir, "automation.json");
	try {
		const store = new AutomationStore(storePath);
		await store.load(1_000);
		const { coordinator, run, sessionId } = await createStartedCoordinator(store);

		coordinator.observeRuntimeEvent(runtimeStateEvent(sessionId, {
			isTurnActive: true,
			isExecutingTool: false,
		}));
		// pi 进程中途退出：立即判失败，避免 run 空挂到 timeoutMs
		coordinator.observeRuntimeEvent(tabStateEvent(sessionId, "closed"));
		await new Promise((r) => setTimeout(r, 20));

		const closedRun = store.getRun(run.id);
		assert.equal(closedRun.status, "failed");
		assert.match(closedRun.error, /exited/);

		coordinator.dispose();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("AutomationRunCoordinator preserves token metrics when metric-less patches arrive", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pideck-coord-metrics-"));
	const storePath = join(dir, "automation.json");
	try {
		const store = new AutomationStore(storePath);
		await store.load(1_000);
		const { deps, coordinator, run, sessionId } = await createStartedCoordinator(store);

		// 等过 1s 指标节流窗口，让第一个带 token 的快照真正落库
		await new Promise((r) => setTimeout(r, 1_100));
		coordinator.observeRuntimeEvent(runtimeStateEvent(sessionId, {
			inputTokens: 300,
			outputTokens: 200,
			cost: 0.02,
			isTurnActive: true,
			isExecutingTool: false,
		}));

		// 再过一个节流窗口，发出不带 token 字段的流式补丁 + 工具步数变化——
		// 回归点：旧实现对缺失字段按 0 兜底写入，把真实 token/cost 反复清零
		await new Promise((r) => setTimeout(r, 1_100));
		coordinator.observeRuntimeEvent(runtimeStateEvent(sessionId, { isExecutingTool: true }));
		coordinator.observeRuntimeEvent(runtimeStateEvent(sessionId, { isExecutingTool: false }));
		await new Promise((r) => setTimeout(r, 20));

		const midRun = store.getRun(run.id);
		assert.equal(midRun.stepCount, 1);
		assert.equal(midRun.inputTokens, 300);
		assert.equal(midRun.outputTokens, 200);
		assert.equal(midRun.costUsd, 0.02);

		// 正常收尾：终态指标不应回退
		deps.setRuntimeState({ inputTokens: 300, outputTokens: 200, cost: 0.02 });
		coordinator.observeRuntimeEvent(tabStateEvent(sessionId, "idle"));
		await new Promise((r) => setTimeout(r, 20));

		const finishedRun = store.getRun(run.id);
		assert.equal(finishedRun.status, "succeeded");
		assert.equal(finishedRun.stepCount, 1);
		assert.equal(finishedRun.inputTokens, 300);
		assert.equal(finishedRun.outputTokens, 200);
		assert.equal(finishedRun.costUsd, 0.02);

		coordinator.dispose();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("AutomationRunCoordinator enforces token budget and aborts runtime when budget exhausted", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pideck-coord-budget-"));
	const storePath = join(dir, "automation.json");
	try {
		const store = new AutomationStore(storePath);
		await store.load(1_000);
		const { deps, coordinator, run, sessionId } = await createStartedCoordinator(store, {
			budget: { timeoutMs: 60_000, maxTokens: 500 }, // strict 500 token limit
		});

		// Emit metrics exceeding maxTokens (600 > 500)
		coordinator.observeRuntimeEvent(runtimeStateEvent(sessionId, {
			inputTokens: 350,
			outputTokens: 250,
			cost: 0.01,
			isTurnActive: true,
			isExecutingTool: false,
		}));

		await new Promise((r) => setTimeout(r, 20));

		assert.equal(deps.abortedTargets.length, 1);
		assert.equal(deps.abortedTargets[0].sessionId, sessionId);

		const budgetRun = store.getRun(run.id);
		assert.equal(budgetRun.status, "budget-exhausted");
		assert.equal(budgetRun.budgetReason, "tokens");
		assert.match(budgetRun.error, /token budget/);

		coordinator.dispose();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("AutomationRunCoordinator supports manual abortRun", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pideck-coord-abort-"));
	const storePath = join(dir, "automation.json");
	try {
		const store = new AutomationStore(storePath);
		await store.load(1_000);
		const { deps, coordinator, run } = await createStartedCoordinator(store, {
			name: "Manual Abort Task",
			prompt: "Long running inspection",
			schedule: { type: "manual" },
			budget: { timeoutMs: 120_000 },
		});

		const aborted = await coordinator.abortRun(run.id, "User requested cancellation");
		assert.equal(aborted, true);

		assert.equal(deps.abortedTargets.length, 1);
		const abortedRun = store.getRun(run.id);
		assert.equal(abortedRun.status, "aborted");
		assert.equal(abortedRun.error, "User requested cancellation");

		coordinator.dispose();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
