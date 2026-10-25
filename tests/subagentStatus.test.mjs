/**
 * subagentStatus 纯函数测试：失败探测 / 图标种类 / 文案后缀 / 终态判定。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { detectSubagentFailure, subagentIconKind, subagentStatusLabelSuffix, isFailureSubagentStatus, isTerminalSubagentStatus } = loadTsCommonJs("src/renderer/src/components/session/subagentStatus.ts");

test("detectSubagentFailure: extracts error from Agent result text", () => {
	const text = "Agent: abc\nType: Explore | Status: error | Tool uses: 3\n\nError: timeout";
	assert.equal(detectSubagentFailure(text), "error");
});

test("detectSubagentFailure: extracts stopped and aborted", () => {
	assert.equal(detectSubagentFailure("Type: code | Status: stopped | 1s"), "stopped");
	assert.equal(detectSubagentFailure("Type: code | Status: aborted | 1s"), "aborted");
});

test("detectSubagentFailure: non-failure statuses return undefined", () => {
	assert.equal(detectSubagentFailure("Type: Explore | Status: completed | 1s"), undefined);
	assert.equal(detectSubagentFailure("Type: Explore | Status: running | 1s"), undefined);
	assert.equal(detectSubagentFailure("Type: Explore | Status: steered | 1s"), undefined);
});

test("detectSubagentFailure: empty / unrelated text returns undefined", () => {
	assert.equal(detectSubagentFailure(""), undefined);
	assert.equal(detectSubagentFailure("no status line here"), undefined);
});

test("subagentIconKind: maps statuses to display kinds", () => {
	assert.equal(subagentIconKind("completed"), "completed");
	assert.equal(subagentIconKind("running"), "active");
	assert.equal(subagentIconKind("queued"), "active");
	assert.equal(subagentIconKind("error"), "error");
	assert.equal(subagentIconKind("stopped"), "stopped");
	assert.equal(subagentIconKind("aborted"), "aborted");
	assert.equal(subagentIconKind("steered"), "steered");
	assert.equal(subagentIconKind("weird"), "neutral");
});

test("subagentStatusLabelSuffix: maps statuses to i18n suffixes", () => {
	assert.equal(subagentStatusLabelSuffix("completed"), "completed");
	assert.equal(subagentStatusLabelSuffix("running"), "running");
	assert.equal(subagentStatusLabelSuffix("queued"), "queued");
	assert.equal(subagentStatusLabelSuffix("error"), "error");
	assert.equal(subagentStatusLabelSuffix("stopped"), "stopped");
	assert.equal(subagentStatusLabelSuffix("aborted"), "aborted");
	assert.equal(subagentStatusLabelSuffix("steered"), "steered");
	assert.equal(subagentStatusLabelSuffix("weird"), "unknown");
});

test("isFailureSubagentStatus: failure-class terminal detection", () => {
	assert.equal(isFailureSubagentStatus("error"), true);
	assert.equal(isFailureSubagentStatus("stopped"), true);
	assert.equal(isFailureSubagentStatus("aborted"), true);
	assert.equal(isFailureSubagentStatus("completed"), false);
	assert.equal(isFailureSubagentStatus("steered"), false);
	assert.equal(isFailureSubagentStatus("running"), false);
});

test("isTerminalSubagentStatus: all terminal states covered", () => {
	for (const s of ["completed", "error", "stopped", "aborted", "steered"]) {
		assert.equal(isTerminalSubagentStatus(s), true, s);
	}
	for (const s of ["running", "queued", "unknown"]) {
		assert.equal(isTerminalSubagentStatus(s), false, s);
	}
});
