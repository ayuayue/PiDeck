import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const i18n = [readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8"), readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8")].join("\n");

const keys = [
	"usageStats.dayDetail.range.today",
	"usageStats.dayDetail.range.week",
	"usageStats.dayDetail.range.month",
	"usageStats.dayDetail.range.year",
	"usageStats.dayDetail.titleWeek",
	"usageStats.dayDetail.titleMonth",
	"usageStats.dayDetail.titleYear",
	"usageStats.dayDetail.titleRange",
	"usageStats.dayDetail.periodWord.day",
	"usageStats.dayDetail.periodWord.week",
	"usageStats.dayDetail.periodWord.month",
	"usageStats.dayDetail.periodWord.year",
	"usageStats.dayDetail.backWeek",
	"usageStats.dayDetail.backMonth",
	"usageStats.dayDetail.backYear",
	"usageStats.dayDetail.emptyWeek",
	"usageStats.dayDetail.emptyMonth",
	"usageStats.dayDetail.emptyYear",
	...Array.from({ length: 12 }, (_, i) => `usageStats.periodPicker.month.${i + 1}`),
];

test("usage stats period keys exist in both locales", () => {
	for (const key of keys) {
		assert.ok(i18n.includes(`"${key}"`), `${key} must exist in both locales`);
	}
});

const pickerSource = readFileSync("src/renderer/src/components/app/usageStats/UsagePeriodPicker.tsx", "utf8");
const modelSource = readFileSync("src/renderer/src/components/app/usageStats/usagePeriodModel.ts", "utf8");

test("UsagePeriodPicker source scans", () => {
	assert.match(pickerSource, /weekStartsOn\s*=\s*\{\s*1\s*\}/, "weekStartsOn={1} must be present");
	assert.match(pickerSource, /range_start/, "range_start modifier must be present");
	assert.match(pickerSource, /range_end/, "range_end modifier must be present");
	assert.match(pickerSource, /usageStats\.dayDetail\.range\./, "range labels must come from i18n");
	assert.match(pickerSource, /minYear/, "minYear prop must be used");
	assert.match(pickerSource, /ui-shadcn\/select/, "must import shadcn Select, not native select");
	assert.doesNotMatch(modelSource, /toISOString/, "usagePeriodModel.ts must not use toISOString");
});

const dayDetailSource = readFileSync("src/renderer/src/components/app/usageStats/UsageDayDetail.tsx", "utf8");

test("UsageDayDetail wiring scans", () => {
	assert.match(dayDetailSource, /from\s+["']\.\/usagePeriodModel["']/, "must import from usagePeriodModel");
	assert.match(dayDetailSource, /UsagePeriodPicker/, "must use UsagePeriodPicker");
	assert.match(dayDetailSource, /periodWord/, "must reference periodWord");
	assert.match(dayDetailSource, /titleRange/, "must reference titleRange");
	assert.match(dayDetailSource, /emptyWeek|emptyMonth|emptyYear/, "must reference a non-day empty key");
	assert.match(dayDetailSource, /backWeek/, "must reference backWeek");
	assert.doesNotMatch(dayDetailSource, /function\s+dayKeyOf/, "must not define local dayKeyOf");
	assert.ok(dayDetailSource.split("\n").length <= 400, "UsageDayDetail.tsx must be <= 400 lines");
});
