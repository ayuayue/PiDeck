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

/**
 * 建任务 + 启动 coordinator + 排队并等待 dispatch 完成，返回常用句柄。
 *
 * 等待方式：轮询直到 prompt 真正发出（sentPrompts 非空），而不是固定 setTimeout(20)。
 * 固定等待在多测试文件并发/CI 负载高时会偶发不达标（dispatch 含 createDraft await、
 * lease 获取等异步步骤），表现为「sentPrompts.length 0 !== 1」的随机失败。
 * 轮询是确定性的：只要 dispatch 最终发生就会通过，且不会白等。
 */
async function waitFor(condition, { timeoutMs = 2_000, stepMs = 5 } = {}) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) return true;
		await new Promise((r) => setTimeout(r, stepMs));
	}
	return condition();
}

/**
 * 清理夹具目录。
 *
 * Windows 上 `rm -rf` 与「in-flight 落库的原子写（临时文件 + rename）」并发时会偶发
 * ENOTEMPTY/EPERM：目录刚被判空、又被写入一个文件。node:fs 的 maxRetries 正是为这类
 * 瞬时错误设计的线性退避重试（仅 recursive:true 时生效），不是「放宽断言」——
 * 断言仍会真实执行，只是不再被操作系统的瞬时错误拖成假失败。
 */
async function removeFixtureDir(dir) {
	await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

async function createStartedCoordinator(store, taskOverrides = {}) {
	const task = await store.createTask(
		{
			name: "Nightly Health Check",
			projectId: "p1",
			prompt: "Check repo status",
			schedule: { type: "cron", expression: "0 0 * * *" },
			budget: { timeoutMs: 60_000, maxTokens: 10_000 },
			...taskOverrides,
		},
		1_000,
	);
	const deps = createMockDeps(store);
	const coordinator = new AutomationRunCoordinator(deps);
	const run = await coordinator.enqueueRun(task, undefined, "manual", 1_050);
	await waitFor(() => deps.sentPrompts.length > 0);
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
		coordinator.observeRuntimeEvent(
			runtimeStateEvent(sessionId, {
				inputTokens: 120,
				outputTokens: 80,
				cost: 0.005,
				isTurnActive: true,
				isExecutingTool: false,
			}),
		);

		// 流式补丁（emitStreamingStatePatch 形状）：没有 isTurnActive 字段——
		// 回归点：旧实现把缺失字段当 false，会在这里误判成功并杀掉 pi 进程
		coordinator.observeRuntimeEvent(
			runtimeStateEvent(sessionId, {
				isStreaming: true,
				isExecutingTool: false,
			}),
		);

		// 工具结束边沿（emitToolRuntimeTransition 形状）：同样没有 isTurnActive
		coordinator.observeRuntimeEvent(
			runtimeStateEvent(sessionId, {
				isExecutingTool: false,
			}),
		);

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
		await removeFixtureDir(dir);
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
		coordinator.observeRuntimeEvent(
			runtimeStateEvent(sessionId, {
				inputTokens: 10,
				outputTokens: 5,
				cost: 0.001,
				isTurnActive: true,
				isExecutingTool: false,
			}),
		);
		// agent_end 带 error 时先发 isTurnActive=false 边沿——
		// 回归点：旧实现在这里就判定成功，随后的 error 快照永远来不及生效
		coordinator.observeRuntimeEvent(
			runtimeStateEvent(sessionId, {
				isTurnActive: false,
				isExecutingTool: false,
			}),
		);
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
		await removeFixtureDir(dir);
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
		coordinator.observeRuntimeEvent(
			runtimeStateEvent(sessionId, {
				isTurnActive: true,
				isExecutingTool: false,
			}),
		);

		// 此时的 idle 才是回合结束
		coordinator.observeRuntimeEvent(tabStateEvent(sessionId, "idle"));
		await new Promise((r) => setTimeout(r, 20));

		assert.equal(store.getRun(run.id).status, "succeeded");

		coordinator.dispose();
	} finally {
		await removeFixtureDir(dir);
	}
});

test("AutomationRunCoordinator marks failed when runtime closes before finishing", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pideck-coord-closed-"));
	const storePath = join(dir, "automation.json");
	try {
		const store = new AutomationStore(storePath);
		await store.load(1_000);
		const { coordinator, run, sessionId } = await createStartedCoordinator(store);

		coordinator.observeRuntimeEvent(
			runtimeStateEvent(sessionId, {
				isTurnActive: true,
				isExecutingTool: false,
			}),
		);
		// pi 进程中途退出：立即判失败，避免 run 空挂到 timeoutMs
		coordinator.observeRuntimeEvent(tabStateEvent(sessionId, "closed"));
		await new Promise((r) => setTimeout(r, 20));

		const closedRun = store.getRun(run.id);
		assert.equal(closedRun.status, "failed");
		assert.match(closedRun.error, /exited/);

		coordinator.dispose();
	} finally {
		await removeFixtureDir(dir);
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
		coordinator.observeRuntimeEvent(
			runtimeStateEvent(sessionId, {
				inputTokens: 300,
				outputTokens: 200,
				cost: 0.02,
				isTurnActive: true,
				isExecutingTool: false,
			}),
		);

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
		await removeFixtureDir(dir);
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
		coordinator.observeRuntimeEvent(
			runtimeStateEvent(sessionId, {
				inputTokens: 350,
				outputTokens: 250,
				cost: 0.01,
				isTurnActive: true,
				isExecutingTool: false,
			}),
		);

		await new Promise((r) => setTimeout(r, 20));

		assert.equal(deps.abortedTargets.length, 1);
		assert.equal(deps.abortedTargets[0].sessionId, sessionId);

		const budgetRun = store.getRun(run.id);
		assert.equal(budgetRun.status, "budget-exhausted");
		assert.equal(budgetRun.budgetReason, "tokens");
		assert.match(budgetRun.error, /token budget/);

		coordinator.dispose();
	} finally {
		await removeFixtureDir(dir);
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
		await removeFixtureDir(dir);
	}
});

/**
 * 回归：定时任务必须把用户配置的 prompt 真正送进 pi。
 *
 * 曾现 bug：dispatch 时 agentMessage 被硬编码成「[Automation: 名称] + 请自主完成」，
 * 而 AgentManager.sendPrompt 里 agentMessage 非空会**整体替换** message —— 于是
 * task.prompt 被整个丢掉，AI 只看到任务名和一句系统话术，只能反问用户「要做什么」。
 * （用户可见症状：任务叫「时间」、提示词「输出当前时间」，但 AI 回「我看不到具体任务」。）
 *
 * 契约：agentMessage 必须包含 task.prompt 原文；message 仍保留用户可见原文。
 */
test("dispatch carries the task prompt into agentMessage (not just the automation banner)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pideck-coord-prompt-"));
	const storePath = join(dir, "automation.json");
	try {
		const store = new AutomationStore(storePath);
		await store.load(1_000);
		const { deps, coordinator } = await createStartedCoordinator(store, {
			name: "时间",
			prompt: "输出当前时间",
			schedule: { type: "cron", expression: "*/1 * * * *" },
		});

		assert.equal(deps.sentPrompts.length, 1);
		const sent = deps.sentPrompts[0];
		// message 是用户可见原文（会话气泡）
		assert.equal(sent.message, "输出当前时间");
		// 关键：prompt 必须出现在实际发给 pi 的载荷里，否则 AI 收不到指令
		assert.ok(sent.agentMessage.includes("输出当前时间"), `agentMessage 必须包含 prompt 原文，实际为: ${JSON.stringify(sent.agentMessage)}`);
		// 宿主上下文（任务名与自主完成约定）仍要保留
		assert.ok(sent.agentMessage.includes("时间"));
		assert.match(sent.agentMessage, /autonomously/);

		coordinator.dispose();
	} finally {
		await removeFixtureDir(dir);
	}
});

/**
 * 工作模式回归：定时任务可以配置普通/计划/目标，dispatch 时把模式标记带进 agentMessage。
 *
 * 契约：
 * - 普通模式（含旧任务未设置 mode）不得出现任何隐藏标记，行为与改动前逐字节一致；
 * - 计划/目标模式必须复用 composer 的标记常量（__PI_DECK_PLAN_MODE__ / __PI_DECK_GOAL_MODE__），
 *   否则 pi 内置扩展识别不到，任务会退化成普通模式静默跑错；
 * - 无论哪种模式，任务提示词原文与宿主指令都必须保留（上一个 bug 的回归防线）。
 */
test("dispatch applies the task working mode marker and always keeps the prompt", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pideck-coord-mode-"));
	const storePath = join(dir, "automation.json");
	try {
		const store = new AutomationStore(storePath);
		await store.load(1_000);

		// 普通模式：不应出现任何模式标记
		const { deps: normalDeps, coordinator: normalCoordinator } = await createStartedCoordinator(store, {
			name: "普通任务",
			prompt: "检查仓库状态",
		});
		const normalSent = normalDeps.sentPrompts[0];
		assert.equal(normalSent.message, "检查仓库状态");
		assert.doesNotMatch(normalSent.agentMessage, /__PI_DECK_/);
		assert.ok(normalSent.agentMessage.includes("检查仓库状态"));
		normalCoordinator.dispose();

		// 计划模式：带计划标记，且提示词与指令都在
		const { deps: planDeps, coordinator: planCoordinator } = await createStartedCoordinator(store, {
			name: "计划任务",
			prompt: "重构订单模块",
			mode: "plan",
		});
		const planSent = planDeps.sentPrompts[0];
		assert.equal(planSent.message, "重构订单模块");
		assert.ok(planSent.agentMessage.includes("__PI_DECK_PLAN_MODE__"), `plan 模式必须带计划标记，实际为: ${JSON.stringify(planSent.agentMessage)}`);
		assert.ok(planSent.agentMessage.includes("重构订单模块"));
		assert.match(planSent.agentMessage, /autonomously/);
		planCoordinator.dispose();

		// 目标模式：带目标标记
		const { deps: goalDeps, coordinator: goalCoordinator } = await createStartedCoordinator(store, {
			name: "目标任务",
			prompt: "把这个功能做到测试全绿",
			mode: "goal",
		});
		const goalSent = goalDeps.sentPrompts[0];
		assert.equal(goalSent.message, "把这个功能做到测试全绿");
		assert.ok(goalSent.agentMessage.includes("__PI_DECK_GOAL_MODE__"), `goal 模式必须带目标标记，实际为: ${JSON.stringify(goalSent.agentMessage)}`);
		assert.ok(goalSent.agentMessage.includes("把这个功能做到测试全绿"));
		goalCoordinator.dispose();
	} finally {
		await removeFixtureDir(dir);
	}
});

/**
 * DSH 后端 dispatch：DSH 任务与 pi 任务共享 send 链路，但载荷不同。
 *
 * 契约：DshAgentManager.sendPrompt 显式拒绝 agentMessage
 * （session.sendDshUnsupportedPayload），且宿主指令/模式标记都是 pi 侧扩展——
 * DSH 任务只能发任务提示词原文，不得携带 agentMessage 键。
 */
test("DSH dispatch sends the raw prompt without agentMessage (no pi-only host instruction)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pideck-coord-dsh-dispatch-"));
	const storePath = join(dir, "automation.json");
	try {
		const store = new AutomationStore(storePath);
		await store.load(1_000);
		const { deps, coordinator } = await createStartedCoordinator(store, {
			name: "DSH 日报",
			prompt: "生成今日开发日报",
			backend: "dsh",
		});

		assert.equal(deps.sentPrompts.length, 1);
		const sent = deps.sentPrompts[0];
		// message 保持用户可见原文（会话气泡）
		assert.equal(sent.message, "生成今日开发日报");
		// 关键：DSH 不允许 agentMessage，整体载荷就是提示词原文
		assert.ok(!("agentMessage" in sent), `DSH 任务不得携带 agentMessage，实际为: ${JSON.stringify(sent)}`);

		coordinator.dispose();
	} finally {
		await removeFixtureDir(dir);
	}
});

/**
 * DSH 回合完成判定回归：DSH 没有 pi 的 isTurnActive/工具边沿，纯对话回合里
 * dispatch 后唯一能证明「回合开始过」的是 agents:state 的 running 快照。
 *
 * 契约：
 * - 收到 running 快照前残留的 idle 快照不得判成功（与 pi 侧同一守卫）；
 * - 收到 running 快照后 idle 即成功，即使全程没有 runtime-state 的 isTurnActive；
 * - DSH runtime-state 只有 idle/running 两值，绝不携带 error/closed 之外的终态。
 */
test("DSH run succeeds via agents:state running then idle without isTurnActive", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pideck-coord-dsh-turn-"));
	const storePath = join(dir, "automation.json");
	try {
		const store = new AutomationStore(storePath);
		await store.load(1_000);
		const { deps, coordinator, run, sessionId } = await createStartedCoordinator(store, {
			name: "DSH 巡检",
			prompt: "检查服务健康",
			backend: "dsh",
		});

		// dispatch 后、任何事件前的 idle 快照（模拟触发前残留快照）不得判成功
		coordinator.observeRuntimeEvent(tabStateEvent(sessionId, "idle"));
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(store.getRun(run.id).status, "running");

		// DSH 回合开始：applyControl turn/start → 状态切 running 并必发 agents:state
		coordinator.observeRuntimeEvent(tabStateEvent(sessionId, "running"));
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(store.getRun(run.id).status, "running");

		// 回合结束：DSH runtime-state 无 isTurnActive（状态里根本没有这个字段）
		coordinator.observeRuntimeEvent(runtimeStateEvent(sessionId, { status: "idle" }));
		coordinator.observeRuntimeEvent(tabStateEvent(sessionId, "idle"));
		await new Promise((r) => setTimeout(r, 20));

		const finished = await waitFor(() => {
			const status = store.getRun(run.id).status;
			return status === "succeeded" || status === "failed";
		});
		assert.ok(finished, "DSH 回合在 running→idle 后必须收尾");
		assert.equal(store.getRun(run.id).status, "succeeded");

		coordinator.dispose();
	} finally {
		await removeFixtureDir(dir);
	}
});

test("AutomationRunCoordinator 预算全留空（不限）不误杀：run 正常走到 succeeded", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pideck-coord-unlimited-"));
	const storePath = join(dir, "automation.json");
	try {
		const store = new AutomationStore(storePath);
		await store.load(1_000);

		// 编辑器留空形态：四字段显式 null → store 归一化为「不限」（无 timeoutMs 键）
		const { deps, coordinator, run, sessionId } = await createStartedCoordinator(store, {
			budget: { timeoutMs: null, maxTokens: null, maxCostUsd: null, maxSteps: null },
		});
		assert.equal(store.listTasks()[0].budget.timeoutMs, undefined);

		// 回归守卫：若 timeout watch 被错误地以 setTimeout(fn, undefined) 挂上（0ms 立即触发），
		// run 会在 dispatch 后瞬间被判 timed-out；正常路径应不受影响走到 succeeded。
		coordinator.observeRuntimeEvent(
			runtimeStateEvent(sessionId, {
				inputTokens: 10,
				outputTokens: 5,
				cost: 0.001,
				isTurnActive: true,
				isExecutingTool: false,
			}),
		);
		await new Promise((r) => setTimeout(r, 30));
		assert.notEqual(store.getRun(run.id).status, "timed-out");

		deps.setRuntimeState({ inputTokens: 10, outputTokens: 5, cost: 0.001 });
		coordinator.observeRuntimeEvent(tabStateEvent(sessionId, "idle"));
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(store.getRun(run.id).status, "succeeded");

		coordinator.dispose();
	} finally {
		await removeFixtureDir(dir);
	}
});

test("each automation run creates a fresh session while retaining task linkage", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pideck-coord-fresh-session-"));
	const storePath = join(dir, "automation.json");
	try {
		const store = new AutomationStore(storePath);
		await store.load(1_000);
		const { task, deps, coordinator, run, sessionId } = await createStartedCoordinator(store);

		coordinator.observeRuntimeEvent(
			runtimeStateEvent(sessionId, {
				isTurnActive: true,
				isExecutingTool: false,
			}),
		);
		coordinator.observeRuntimeEvent(tabStateEvent(sessionId, "idle"));
		assert.equal(await waitFor(() => store.getRun(run.id)?.status === "succeeded"), true, "the first run should settle before starting the next occurrence");

		const secondRun = await coordinator.runNow(task.id, 2_000);
		assert.equal(
			await waitFor(() => {
				const persisted = store.getRun(secondRun.id);
				return deps.createdSessions.length === 2 && Boolean(persisted?.sessionId);
			}),
			true,
			"a second occurrence should receive its own session",
		);

		const secondSessionId = deps.createdSessions[1].id;
		const persistedSecondRun = store.getRun(secondRun.id);
		assert.notEqual(secondSessionId, sessionId);
		assert.equal(persistedSecondRun.taskId, task.id);
		assert.equal(persistedSecondRun.projectId, task.projectId);
		assert.equal(persistedSecondRun.sessionId, secondSessionId);

		// 第二个 run 此时还在飞行中。必须等它真的进入 running（= send 已返回、
		// tracker.target 已绑定）再收尾，两个理由：
		//   1. observeRuntimeEvent 按 tracker.target.sessionId 匹配；target 未绑定时
		//      发终态事件会直接落空，run 永远不 settle；
		//   2. executeRun 在终态之后还会继续 updateRun 写 automation.json，若此时 finally
		//      已删掉临时目录，就会产生 ENOENT 的 unhandledRejection（文件级偶发失败）。
		assert.equal(await waitFor(() => store.getRun(secondRun.id)?.status === "running"), true, "the second occurrence should reach running before terminal events are sent");
		coordinator.observeRuntimeEvent(
			runtimeStateEvent(secondSessionId, {
				isTurnActive: true,
				isExecutingTool: false,
			}),
		);
		coordinator.observeRuntimeEvent(tabStateEvent(secondSessionId, "idle"));
		assert.equal(await waitFor(() => store.getRun(secondRun.id)?.status === "succeeded"), true, "the second run should settle before the fixture directory is removed");

		coordinator.dispose();
	} finally {
		await removeFixtureDir(dir);
	}
});
// ── dispose 回归：退出路径上在飞 run 不得继续落库 ──

test("dispose() stops an in-flight run from writing to the store", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pideck-coord-dispose-"));
	const storePath = join(dir, "automation.json");
	try {
		const store = new AutomationStore(storePath);
		await store.load(1_000);
		const task = await store.createTask(
			{
				name: "Dispose Mid-Flight",
				projectId: "p1",
				prompt: "Check repo status",
				schedule: { type: "cron", expression: "0 0 * * *" },
				budget: { timeoutMs: 60_000, maxTokens: 10_000 },
			},
			1_000,
		);

		const deps = createMockDeps(store);
		// dispatch 挂起在 await 里：run 停在 send()，精确覆盖「dispose 落在 await 中间」
		// 这个退出路径上最常见的窗口（也是临时目录被拆除后仍被写入的成因）。
		let releaseSend;
		const sendGate = new Promise((resolve) => {
			releaseSend = resolve;
		});
		const realSend = deps.sessionRuntimeCoordinator.send;
		deps.sessionRuntimeCoordinator.send = async (payload) => {
			await sendGate;
			return realSend(payload);
		};

		const coordinator = new AutomationRunCoordinator(deps);
		const run = await coordinator.enqueueRun(task, undefined, "manual", 1_050);
		assert.equal(await waitFor(() => store.getRun(run.id)?.status === "starting"), true, "the run should reach starting before dispose");

		// dispose 之后统计落库：退出时 store 目录可能已被拆除，任何写入都会变成
		// ENOENT 的 unhandledRejection（旧实现的偶发失败形态）。
		const writesAfterDispose = [];
		const realUpdateRun = store.updateRun.bind(store);
		store.updateRun = async (...args) => {
			writesAfterDispose.push(args[0]);
			return realUpdateRun(...args);
		};

		coordinator.dispose();
		releaseSend();
		await new Promise((r) => setTimeout(r, 50));

		assert.deepEqual(writesAfterDispose, [], "dispose 之后不得再落库");
		assert.equal(store.getRun(run.id).status, "starting", "in-flight run 不得被推进到 running");
	} finally {
		await removeFixtureDir(dir);
	}
});

test("dispose() blocks new work from being enqueued or dispatched", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pideck-coord-dispose-idle-"));
	const storePath = join(dir, "automation.json");
	try {
		const store = new AutomationStore(storePath);
		await store.load(1_000);
		const task = await store.createTask(
			{
				name: "After Dispose",
				projectId: "p1",
				prompt: "Check repo status",
				schedule: { type: "cron", expression: "0 0 * * *" },
				budget: { timeoutMs: 60_000, maxTokens: 10_000 },
			},
			1_000,
		);

		const deps = createMockDeps(store);
		const coordinator = new AutomationRunCoordinator(deps);
		coordinator.dispose();

		await coordinator.enqueueRun(task, undefined, "manual", 1_050);
		await new Promise((r) => setTimeout(r, 50));

		// 队列不再 drain：既不能建会话，也不能派发提示词
		assert.equal(deps.createdSessions.length, 0, "dispose 之后不得再建会话");
		assert.equal(deps.sentPrompts.length, 0, "dispose 之后不得再派发提示词");
	} finally {
		await removeFixtureDir(dir);
	}
});
