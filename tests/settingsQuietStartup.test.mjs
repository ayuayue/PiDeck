import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * pi 1.0 起 quietStartup 是 boolean | "header" 三态。
 * 旧实现用布尔开关（checked={data.quietStartup === true} + onChange 写 checked），
 * 用户设了 "header" 后一碰开关就被覆盖成 true/false——设置数据静默丢失。
 */
test('SettingsTab 用三态下拉表达 quietStartup，不再用布尔开关覆盖 "header"', () => {
	const tab = readFileSync("src/renderer/src/config/SettingsTab.tsx", "utf8");
	const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
	const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");
	// 三态选项与按值写回（true / "header" / false），不再是 quietStartup: checked
	assert.match(tab, /QUIET_STARTUP_OPTIONS/);
	assert.match(tab, /quietStartup: v === "true" \? true : v === "header" \? "header" : false/);
	assert.doesNotMatch(tab, /quietStartup: checked/);
	// 两个 locale 的三个选项文案齐全
	for (const key of ["config.general.quietStartup.off", "config.general.quietStartup.true", "config.general.quietStartup.header"]) {
		assert.ok(zh.includes('"' + key + '"'), "zh-CN missing " + key);
		assert.ok(en.includes('"' + key + '"'), "en-US missing " + key);
	}
});
