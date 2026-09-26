import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * 语音设置「改动即自动保存」的契约守卫。
 *
 * 回归背景：这个分区过去只有手动「保存」，而它嵌在通用设置里、切换标签即卸载，
 * 用户改完一堆选项切走就静默丢失（2026-09 用户反馈）。这里用源码断言把
 * 「每一项改动都必须经过 patch → 落盘」钉住，而不是靠肉眼检查 JSX。
 */
const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/renderer/src/components/app/settings/VoiceTranscriptionSettingsSection.tsx"), "utf8");

test("patch() 是唯一配置改动入口，并且每次都排一次自动保存", () => {
	const patchBody = /const patch = \(next: Partial<VoiceTranscriptionPublicConfig>\) => \{[\s\S]{0,240}?\n\t\};/.exec(source);
	assert.ok(patchBody, "patch() 定义仍在，且保持单一带花括号的形式");
	assert.match(patchBody[0], /setConfig\(\(current\)/);
	assert.match(patchBody[0], /scheduleAutoSave\(\)/);
	// 配置字段不得绕过 patch 直接写 state（那样就又回到「改了不保存」）
	for (const field of ["enabled", "engine", "inputDeviceId", "localModelId", "cliPath", "language", "baseUrl", "model", "cloudProvider", "cloudResourceId"]) {
		assert.match(source, new RegExp(`patch\\(\\{ ${field}:`), `${field} 应通过 patch 改动`);
	}
});

test("自动保存有防抖、有卸载 flush，且不会让整页控件瞬间禁用", () => {
	assert.match(source, /const AUTO_SAVE_DELAY_MS = \d+;/);
	assert.match(source, /setTimeout\(\(\) => \{[\s\S]{0,160}?void persist\(configRef\.current\)[\s\S]{0,40}?\}, AUTO_SAVE_DELAY_MS\)/);
	// 卸载时把还在防抖里的最后一次改动立刻写盘
	assert.match(source, /\(\) => \(\) => \{[\s\S]{0,260}?clearTimeout\(autoSaveTimer\.current\)[\s\S]{0,200}?void persist\(configRef\.current\)/);
	// saving 只属于显式保存：自动保存若置 saving，下拉框会在每次改动后瞬间 disabled
	const persistStart = source.indexOf("const persist = useCallback");
	const persistEnd = source.indexOf("const scheduleAutoSave", persistStart);
	assert.ok(persistStart > 0 && persistEnd > persistStart, "persist() 定义仍在，且排在 scheduleAutoSave 之前");
	const persistBody = source.slice(persistStart, persistEnd);
	assert.doesNotMatch(persistBody, /setSaving\(/);
	// 迟到的响应不得覆盖用户已经改下去的新值
	assert.match(persistBody, /configRef\.current === next/);
});

test("密钥不随按键落盘，失焦才提交（三家各一个输入框）", () => {
	// 回归：半截 key 跟着每次按键写盘，比「没保存」更难排查——用户在别家服务上试过一次的
	// 长串会先被截断存进来。豆包有两个密钥框，判据必须逐家点名，漏一家就静默不保存。
	for (const field of ["apiKey", "volcAppId", "volcAccessToken"]) {
		assert.match(source, new RegExp(`if \\(${field}\\.trim\\(\\)\\) void persist\\(configRef\\.current, \\{ ${field} \\}\\)`), `${field} 必须失焦才提交`);
		assert.doesNotMatch(source, new RegExp(`onChange=\\{\\(event\\) => \\{[^}]*persist\\(configRef\\.current, \\{ ${field}`), `${field} 不得随按键落盘`);
	}
});
