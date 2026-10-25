import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { normalizeClockTime, normalizeThemeSchedule, resolveAppColorScheme, resolveScheduledTheme, msUntilNextThemeBoundary, DEFAULT_THEME_SCHEDULE_LIGHT_START, DEFAULT_THEME_SCHEDULE_DARK_START } = loadTsCommonJs("src/shared/themeSchedule.ts");

function at(hours, minutes, seconds = 0) {
	return new Date(2026, 7, 21, hours, minutes, seconds, 0);
}

test("normalizeClockTime accepts HH:mm and HH:mm:ss, rejects invalid", () => {
	assert.equal(normalizeClockTime("7:00", "00:00"), "07:00");
	assert.equal(normalizeClockTime("19:30:00", "00:00"), "19:30");
	assert.equal(normalizeClockTime("24:00", "07:00"), "07:00");
	assert.equal(normalizeClockTime("abc", "07:00"), "07:00");
});

test("same light and dark start resolves to dark all day", () => {
	assert.equal(resolveScheduledTheme(at(12, 0), "08:00", "08:00"), "dark");
});

test("daytime window 07:00-19:00 is light, otherwise dark", () => {
	assert.equal(resolveScheduledTheme(at(6, 59), "07:00", "19:00"), "dark");
	assert.equal(resolveScheduledTheme(at(7, 0), "07:00", "19:00"), "light");
	assert.equal(resolveScheduledTheme(at(18, 59), "07:00", "19:00"), "light");
	assert.equal(resolveScheduledTheme(at(19, 0), "07:00", "19:00"), "dark");
});

test("overnight window 22:00-06:00 covers night into morning", () => {
	assert.equal(resolveScheduledTheme(at(21, 59), "22:00", "06:00"), "dark");
	assert.equal(resolveScheduledTheme(at(22, 0), "22:00", "06:00"), "light");
	assert.equal(resolveScheduledTheme(at(23, 30), "22:00", "06:00"), "light");
	assert.equal(resolveScheduledTheme(at(5, 59), "22:00", "06:00"), "light");
	assert.equal(resolveScheduledTheme(at(6, 0), "22:00", "06:00"), "dark");
	assert.equal(resolveScheduledTheme(at(12, 0), "22:00", "06:00"), "dark");
});

test("resolveAppColorScheme keeps explicit light/dark and uses schedule/system", () => {
	assert.equal(resolveAppColorScheme({ theme: "light", systemPrefersDark: true }), "light");
	assert.equal(resolveAppColorScheme({ theme: "dark", systemPrefersDark: false }), "dark");
	assert.equal(resolveAppColorScheme({ theme: "system", systemPrefersDark: true }), "dark");
	assert.equal(resolveAppColorScheme({ theme: "system", systemPrefersDark: false }), "light");
	assert.equal(
		resolveAppColorScheme({
			theme: "schedule",
			themeScheduleLightStart: "07:00",
			themeScheduleDarkStart: "19:00",
			now: at(10, 0),
		}),
		"light",
	);
	assert.equal(
		resolveAppColorScheme({
			theme: "schedule",
			now: at(22, 0),
		}),
		"dark",
	);
});

test("msUntilNextThemeBoundary sleeps until the next start, not zero at the boundary second", () => {
	const delay = msUntilNextThemeBoundary(at(7, 0, 1), "07:00", "19:00");
	assert.ok(delay > 1_000);
	assert.ok(delay <= 12 * 60 * 60 * 1000);
	const atBoundary = msUntilNextThemeBoundary(at(7, 0, 0), "07:00", "19:00");
	assert.equal(atBoundary, 12 * 60 * 60 * 1000);
});

test("normalizeThemeSchedule fills defaults", () => {
	const schedule = normalizeThemeSchedule({});
	assert.equal(schedule.lightStart, "07:00");
	assert.equal(schedule.darkStart, "19:00");
	assert.equal(schedule.lightStart, DEFAULT_THEME_SCHEDULE_LIGHT_START);
	assert.equal(schedule.darkStart, DEFAULT_THEME_SCHEDULE_DARK_START);
});

test("appearance settings expose follow-time mode and schedule fields", () => {
	const appearance = readFileSync("src/renderer/src/components/app/settings/AppearanceTab.tsx", "utf8");
	const settingsType = readFileSync("src/shared/types/settings.ts", "utf8");
	assert.match(appearance, /value: "schedule"/);
	assert.match(appearance, /themeScheduleLightStart/);
	assert.match(appearance, /themeScheduleDarkStart/);
	assert.match(settingsType, /"schedule"/);
	assert.match(settingsType, /themeScheduleLightStart/);
});
