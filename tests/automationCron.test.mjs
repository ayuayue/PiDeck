import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { parseAutomationCron, matchesAutomationCron, nextAutomationCronOccurrence, missedAutomationCronOccurrences, previewAutomationCron } = loadTsCommonJs("src/main/automation/automationCron.ts");

function local(year, month, day, hour, minute) {
	return new Date(year, month - 1, day, hour, minute, 0, 0);
}

test("automation cron parses lists, ranges, steps and Sunday alias", () => {
	const cron = parseAutomationCron("*/15 9-17 * * 1-5,7");
	assert.equal(cron.minute.values.has(45), true);
	assert.equal(cron.hour.values.has(18), false);
	assert.equal(cron.dayOfWeek.values.has(0), true);
	assert.equal(cron.dayOfWeek.values.has(6), false);
});

test("automation cron rejects malformed or out-of-range fields", () => {
	assert.throws(() => parseAutomationCron("0 9 * *"), /exactly 5 fields/);
	assert.throws(() => parseAutomationCron("60 9 * * *"), /between 0 and 59/);
	assert.throws(() => parseAutomationCron("0 9 20-10 * *"), /ascending/);
	assert.throws(() => parseAutomationCron("0 9 JAN * *"), /numeric/);
});

test("day-of-month and day-of-week use standard OR semantics", () => {
	const cron = parseAutomationCron("0 9 15 * 1");
	assert.equal(matchesAutomationCron(cron, local(2026, 6, 15, 9, 0)), true);
	assert.equal(matchesAutomationCron(cron, local(2026, 6, 22, 9, 0)), true);
	assert.equal(matchesAutomationCron(cron, local(2026, 6, 16, 9, 0)), false);
});

test("next occurrence is strictly after the supplied instant in local time", () => {
	assert.equal(nextAutomationCronOccurrence("30 8 * * 1-5", local(2026, 6, 19, 8, 30))?.getTime(), local(2026, 6, 22, 8, 30).getTime());
});

test("catch-up discovery returns latest occurrence first and can be bounded", () => {
	const missed = missedAutomationCronOccurrences("0 * * * *", local(2026, 6, 20, 8, 0), local(2026, 6, 20, 12, 15), 2);
	assert.deepEqual(JSON.parse(JSON.stringify(missed.map((value) => value.getTime()))), [local(2026, 6, 20, 12, 0).getTime(), local(2026, 6, 20, 11, 0).getTime()]);
});

test("preview returns consecutive local-time occurrences", () => {
	assert.deepEqual(JSON.parse(JSON.stringify(previewAutomationCron("0 7 * * *", local(2026, 6, 20, 7, 0), 3).map((value) => value.getTime()))), [local(2026, 6, 21, 7, 0).getTime(), local(2026, 6, 22, 7, 0).getTime(), local(2026, 6, 23, 7, 0).getTime()]);
});
