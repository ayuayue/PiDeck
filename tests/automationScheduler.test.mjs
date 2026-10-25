import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { AutomationStore } = loadTsCommonJs("src/main/automation/AutomationStore.ts");
const { AutomationScheduler } = loadTsCommonJs("src/main/automation/AutomationScheduler.ts");

test("AutomationScheduler discovers due tasks, advances lastScheduledAt, and skips overlapping runs", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pideck-sched-test-"));
	const storePath = join(dir, "automation.json");
	try {
		const store = new AutomationStore(storePath);
		await store.load(1_000);

		// Baseline: 2026-03-30 08:59:00 local time
		const baselineTime = new Date(2026, 2, 30, 8, 59, 0).getTime();

		const task = await store.createTask(
			{
				name: "Morning Check",
				projectId: "p1",
				prompt: "Check morning status",
				schedule: { type: "cron", expression: "0 9 * * *" }, // At 09:00 daily
			},
			baselineTime,
		);

		const triggered = [];
		const scheduler = new AutomationScheduler(store);
		scheduler.setTriggerHandler(async (t, scheduledFor, trigger) => {
			triggered.push({ taskId: t.id, scheduledFor, trigger });
		});

		// Tick at 08:59:30 -> Not due yet
		await scheduler.tick(new Date(2026, 2, 30, 8, 59, 30).getTime());
		assert.equal(triggered.length, 0);

		// Tick at 09:00:05 -> Due!
		const runTime = new Date(2026, 2, 30, 9, 0, 5).getTime();
		await scheduler.tick(runTime);

		assert.equal(triggered.length, 1);
		assert.equal(triggered[0].taskId, task.id);
		assert.equal(triggered[0].trigger, "schedule");
		assert.equal(triggered[0].scheduledFor, new Date(2026, 2, 30, 9, 0, 0).getTime());

		// Next tick at 09:00:10 -> Already scheduled for 09:00, shouldn't trigger again
		await scheduler.tick(new Date(2026, 2, 30, 9, 0, 10).getTime());
		assert.equal(triggered.length, 1);

		// Now simulate that the run is still in-progress when the next day 09:00 arrives
		// Create an active running run for this task
		await store.createRun(
			{
				task,
				trigger: "schedule",
				scheduledFor: new Date(2026, 2, 31, 9, 0, 0).getTime(),
				status: "running",
			},
			runTime,
		);

		// Tick at next day 09:00:02
		const nextDayTime = new Date(2026, 2, 31, 9, 0, 2).getTime();
		await scheduler.tick(nextDayTime);

		// The handler should NOT have been called again because the run is still active
		assert.equal(triggered.length, 1);

		// Instead, a skipped run record should have been persisted to record the overlap
		const runs = store.listRuns();
		const skippedRun = runs.find((r) => r.status === "skipped");
		assert.ok(skippedRun, "Expected a skipped run record for overlapping execution");
		assert.equal(skippedRun.skippedReason, "task-already-running");
		assert.equal(skippedRun.scheduledFor, new Date(2026, 2, 31, 9, 0, 0).getTime());
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("AutomationScheduler performs latest-only catch-up when waking up after downtime", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pideck-sched-catchup-"));
	const storePath = join(dir, "automation.json");
	try {
		const store = new AutomationStore(storePath);
		await store.load(1_000);

		// App went offline on Monday at 08:00
		const offlineTime = new Date(2026, 2, 30, 8, 0, 0).getTime();

		const task = await store.createTask(
			{
				name: "Hourly Task",
				projectId: "p1",
				prompt: "Check hourly",
				schedule: { type: "cron", expression: "0 * * * *" }, // every hour
			},
			offlineTime,
		);

		const triggered = [];
		const scheduler = new AutomationScheduler(store);
		scheduler.setTriggerHandler(async (t, scheduledFor, trigger) => {
			triggered.push({ taskId: t.id, scheduledFor, trigger });
		});

		// App re-opens at 12:15 on the same day (missed 09:00, 10:00, 11:00, 12:00)
		const restartTime = new Date(2026, 2, 30, 12, 15, 0).getTime();
		await scheduler.tick(restartTime);

		// By policy (latest-only catch-up), it triggers the latest occurrence (12:00)
		assert.equal(triggered.length, 1);
		assert.equal(triggered[0].trigger, "catch-up");
		assert.equal(triggered[0].scheduledFor, new Date(2026, 2, 30, 12, 0, 0).getTime());

		// Verify task.lastScheduledAt was advanced to 12:00
		const updatedTask = store.getTask(task.id);
		assert.equal(updatedTask.lastScheduledAt, new Date(2026, 2, 30, 12, 0, 0).getTime());
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
