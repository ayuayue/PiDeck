import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { AutomationStore } = loadTsCommonJs("src/main/automation/AutomationStore.ts");

function jsonClone(value) {
	return JSON.parse(JSON.stringify(value));
}

test("AutomationStore lifecycle: CRUD, recovery of interrupted runs, and snapshot", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pideck-automation-store-"));
	const storePath = join(dir, "automation.json");
	try {
		const store = new AutomationStore(storePath);
		const initialSnapshot = await store.load(1_000);
		assert.equal(initialSnapshot.tasks.length, 0);
		assert.equal(initialSnapshot.runs.length, 0);

		const task = await store.createTask(
			{
				name: "Nightly Audit",
				projectId: "project-1",
				prompt: "Run project tests",
				schedule: { type: "cron", expression: "0 2 * * *" },
			},
			1_000,
		);

		assert.equal(task.name, "Nightly Audit");
		assert.equal(task.enabled, true);

		const run = await store.createRun(
			{
				task,
				trigger: "schedule",
				scheduledFor: 1_200,
				status: "running",
			},
			1_200,
		);

		assert.equal(run.status, "running");

		// Simulate process restart while run is running
		const reloadedStore = new AutomationStore(storePath);
		const snapshotAfterRestart = await reloadedStore.load(2_000);
		assert.equal(snapshotAfterRestart.tasks.length, 1);
		assert.equal(snapshotAfterRestart.runs.length, 1);
		assert.equal(snapshotAfterRestart.runs[0].status, "interrupted");
		assert.match(snapshotAfterRestart.runs[0].error, /stopped before/);

		// Update task
		const updated = await reloadedStore.updateTask(
			task.id,
			{
				name: "Nightly Audit Updated",
				enabled: false,
			},
			2_500,
		);
		assert.equal(updated.name, "Nightly Audit Updated");
		assert.equal(updated.enabled, false);

		// Delete task
		const deleted = await reloadedStore.deleteTask(task.id);
		assert.equal(deleted, true);
		assert.equal(reloadedStore.listTasks().length, 0);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("AutomationStore normalizes the working mode and keeps legacy tasks compatible", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pideck-automation-mode-"));
	const storePath = join(dir, "automation.json");
	try {
		const store = new AutomationStore(storePath);
		await store.load(1_000);

		const base = {
			projectId: "project-1",
			prompt: "noop",
			schedule: { type: "cron", expression: "0 2 * * *" },
		};

		// 普通模式是缺省语义：不落盘 mode 键，避免 automation.json 里堆冗余 "normal"
		const normal = await store.createTask({ ...base, name: "Normal" }, 1_000);
		assert.equal(normal.mode, undefined);
		const goal = await store.createTask({ ...base, name: "Goal", mode: "goal" }, 1_100);
		assert.equal(goal.mode, "goal");
		const plan = await store.createTask({ ...base, name: "Plan", mode: "plan" }, 1_200);
		assert.equal(plan.mode, "plan");

		// 编辑器「恢复默认」会把 mode 显式传成 normal：必须清掉该键，而不是留旧值
		const reset = await store.updateTask(goal.id, { mode: "normal" }, 1_300);
		assert.equal(reset.mode, undefined);

		const persistedText = await readFile(storePath, "utf8");
		assert.ok(!persistedText.includes('"mode": "normal"'));
		assert.ok(persistedText.includes('"mode": "plan"'));

		// 手工编辑 automation.json 注入非法模式（imagegen 不是定时任务合法档位）必须降级为未设置，
		// 否则 dispatch 时会产出 pi 无法识别的隐藏标记，任务静默跑错。
		const raw = JSON.parse(persistedText);
		raw.tasks = raw.tasks.map((task) => (task.name === "Plan" ? { ...task, mode: "imagegen" } : task));
		await writeFile(storePath, JSON.stringify(raw), "utf8");
		const reloaded = new AutomationStore(storePath);
		await reloaded.load(2_000);
		assert.equal(reloaded.listTasks().find((task) => task.name === "Plan").mode, undefined);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("AutomationStore deleteRuns skips in-progress runs and clearTerminalRuns keeps queued work", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pideck-automation-history-"));
	const storePath = join(dir, "automation.json");
	try {
		const store = new AutomationStore(storePath);
		await store.load(1_000);
		const task = await store.createTask(
			{
				name: "History Cleaner",
				projectId: "project-1",
				prompt: "noop",
				schedule: { type: "cron", expression: "0 2 * * *" },
			},
			1_000,
		);

		const succeeded = await store.createRun({ task, trigger: "schedule", status: "succeeded" }, 1_100);
		const failed = await store.createRun({ task, trigger: "schedule", status: "failed", error: "boom" }, 1_200);
		const running = await store.createRun({ task, trigger: "schedule", status: "running" }, 1_300);

		// 批量删除只作用于已结束记录；点名进行中的 run 也必须跳过（否则看板丢任务无法中止）。
		const deleted = await store.deleteRuns([succeeded.id, running.id, "ghost-id"]);
		assert.equal(deleted, 1);
		const afterBatch = store.listRuns();
		assert.equal(
			afterBatch.some((run) => run.id === succeeded.id),
			false,
		);
		assert.equal(
			afterBatch.some((run) => run.id === running.id),
			true,
		);

		// 清空历史保留进行中的任务。
		const cleared = await store.clearTerminalRuns();
		assert.equal(cleared, 1); // 只有 failed 那条已结束
		assert.equal(
			store.listRuns().some((run) => run.id === running.id),
			true,
		);

		// 进行中的 run 结束后即可被清空；空数组/无匹配 ID 幂等返回 0。
		await store.updateRun(running.id, { status: "aborted" });
		assert.equal(await store.deleteRuns([]), 0);
		assert.equal(await store.clearTerminalRuns(), 1);
		assert.equal(store.listRuns().length, 0);

		// 删除结果落盘：重载后历史仍为空。
		const reloaded = new AutomationStore(storePath);
		const snapshot = await reloaded.load(2_000);
		assert.equal(snapshot.runs.length, 0);
		assert.equal(snapshot.tasks.length, 1);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("AutomationStore budget：编辑器留空(null)=不限，重启不伪造默认；外部不带预算仍给默认保护", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pideck-automation-budget-"));
	const storePath = join(dir, "automation.json");
	try {
		const store = new AutomationStore(storePath);
		await store.load(1_000);

		// 编辑器留空会显式传 null（IPC 丢 undefined 键，null 才能表达「不限」）
		const unlimited = await store.createTask(
			{
				name: "Unlimited Budget",
				projectId: "project-1",
				prompt: "noop",
				schedule: { type: "cron", expression: "0 2 * * *" },
				budget: { timeoutMs: null, maxTokens: null, maxCostUsd: null, maxSteps: null },
			},
			1_000,
		);
		assert.equal(unlimited.budget.timeoutMs, undefined);
		assert.equal(unlimited.budget.maxTokens, undefined);
		assert.equal(unlimited.budget.maxCostUsd, undefined);
		assert.equal(unlimited.budget.maxSteps, undefined);

		// 只改一个字段为 null 不影响其他已设字段（按键合并语义）
		const resetTokens = await store.updateTask(
			unlimited.id,
			{
				budget: { maxTokens: null },
			},
			1_100,
		);
		assert.equal(resetTokens.budget.maxTokens, undefined);

		// 重启后「不限」必须保持：读盘缺键不能再被 DEFAULT 兜底伪造回 30min/200K。
		// 这是本测试守卫的核心回归——旧实现读盘走输入层 normalizeBudget，会把缺失
		// 键填成默认值，用户保存的「留空不限」隔一次重启就悄悄变回默认。
		const persisted = await readFile(storePath, "utf8");
		assert.ok(!persisted.includes('"timeoutMs"'), "不限任务的预算不应落盘 timeoutMs 键");
		const reloaded = new AutomationStore(storePath);
		await reloaded.load(2_000);
		const afterReload = reloaded.listTasks().find((task) => task.name === "Unlimited Budget");
		assert.equal(afterReload.budget.timeoutMs, undefined);
		assert.equal(afterReload.budget.maxTokens, undefined);

		// 外部调用方不传 budget：仍落默认保护（30min 等），不能因缺省语义变成裸奔
		const defaulted = await store.createTask(
			{
				name: "Default Budget",
				projectId: "project-1",
				prompt: "noop",
				schedule: { type: "cron", expression: "0 2 * * *" },
			},
			1_200,
		);
		assert.equal(defaulted.budget.timeoutMs, 30 * 60_000);

		// 数值仍钳制到合法区间（最小 10s / 最大 7 天）
		const clamped = await store.createTask(
			{
				name: "Clamped Budget",
				projectId: "project-1",
				prompt: "noop",
				schedule: { type: "cron", expression: "0 2 * * *" },
				budget: { timeoutMs: 5_000, maxSteps: 10_000_000 },
			},
			1_300,
		);
		assert.equal(clamped.budget.timeoutMs, 10_000);
		assert.equal(clamped.budget.maxSteps, 100_000);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
