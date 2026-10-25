import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { hasActiveAutomationRun, compareQueuedAutomationRuns, trimAutomationRunHistory } = loadTsCommonJs("src/main/automation/automationPolicy.ts");

function run(id, taskId, status, updatedAt, queuedAt = updatedAt) {
	return {
		id,
		taskId,
		taskName: taskId,
		projectId: "project-1",
		trigger: "manual",
		status,
		queuedAt,
		updatedAt,
		inputTokens: 0,
		outputTokens: 0,
		costUsd: 0,
		stepCount: 0,
		events: [],
	};
}

test("task single-flight detects queued, starting and running runs", () => {
	assert.equal(hasActiveAutomationRun([run("1", "task", "queued", 1)], "task"), true);
	assert.equal(hasActiveAutomationRun([run("1", "task", "succeeded", 1)], "task"), false);
});

test("queue ordering prefers scheduled occurrence then queued time", () => {
	const late = { ...run("late", "a", "queued", 3, 3), scheduledFor: 20 };
	const early = { ...run("early", "b", "queued", 2, 2), scheduledFor: 10 };
	assert.deepEqual(
		[late, early].sort(compareQueuedAutomationRuns).map((item) => item.id),
		["early", "late"],
	);
});

test("history trimming never removes active runs", () => {
	const trimmed = trimAutomationRunHistory([run("active", "a", "running", 1), run("old", "b", "failed", 2), run("new", "c", "succeeded", 3)], 1);
	assert.deepEqual(JSON.parse(JSON.stringify(trimmed.map((item) => item.id))), ["new", "active"]);
});
