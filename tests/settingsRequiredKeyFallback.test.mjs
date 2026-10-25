import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * AppSettings 必填键兜底守卫（稳定性约束 4「向后兼容」的可判定化）：
 * 加载路径是 { ...defaultSettings, ...parsed } —— 旧 settings.json 缺任何键时，
 * 必填键必须有 defaultSettings 兜底，或在 load 的归一化块里显式赋值；
 * 否则升级后该键 = undefined，UI/主进程静默漂移（AGENTS 明令禁止的一类回归）。
 * 可选键（?:）按设计允许缺省，消费侧自行 ?? 兜底。
 */
const TYPES = readFileSync("src/shared/types/settings.ts", "utf8");
const STORE = readFileSync("src/main/settings/SettingsStore.ts", "utf8");

/** 按花括号深度提取字面量/类型体，剥掉注释后再计数，避免嵌套截断（正则法在这里裁过跟头）。 */
function extractBody(source, marker) {
	const start = source.indexOf(marker);
	assert.ok(start >= 0, `marker not found: ${marker}`);
	const open = source.indexOf("{", start);
	let depth = 0;
	for (let i = open; i < source.length; i++) {
		if (source[i] === "{") depth++;
		else if (source[i] === "}") {
			depth--;
			if (depth === 0) return source.slice(open + 1, i);
		}
	}
	throw new Error(`unbalanced braces after marker: ${marker}`);
}

function stripComments(text) {
	return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function topLevelKeys(body) {
	// biome tab 缩进：顶层键恰好一个 tab；嵌套块（内联对象/函数体）至少两个
	return [...body.matchAll(/^\t([A-Za-z_][A-Za-z0-9_]*)(\?)?:/gm)].map((m) => ({ name: m[1], optional: Boolean(m[2]) }));
}

test("AppSettings 每个必填键都有 defaultSettings 兜底或 load 归一化显式赋值", () => {
	const typeKeys = topLevelKeys(stripComments(extractBody(TYPES, "export type AppSettings = {")));
	const defaultKeys = new Set(topLevelKeys(stripComments(extractBody(STORE, "const defaultSettings: AppSettings = {"))).map((k) => k.name));
	// load 路径里的显式归一：this.settings.x = ... 与 this.settings.x ??= ...（惰性生成）
	const normalized = new Set([...STORE.matchAll(/this\.settings\.([A-Za-z_][A-Za-z0-9_]*)\s*(?:\?\?=|=[^=])/g)].map((m) => m[1]));
	assert.ok(typeKeys.length > 150, `fixture sanity: AppSettings should have many keys, got ${typeKeys.length}`);
	assert.ok(defaultKeys.size > 100, `fixture sanity: defaultSettings should be substantial, got ${defaultKeys.size}`);
	const uncovered = typeKeys.filter((k) => !k.optional && !defaultKeys.has(k.name) && !normalized.has(k.name)).map((k) => k.name);
	assert.deepEqual(uncovered, [], `必填键既无默认值也无 load 归一化——旧 settings.json 升级后将为 undefined：\n${uncovered.join("\n")}`);
});

test("AppSettings 必填键的缺失会在此测试红灯（自检：人为删除一个默认键的模拟）", () => {
	const typeKeys = topLevelKeys(stripComments(extractBody(TYPES, "export type AppSettings = {")));
	// 抽一个真实必填键验证守卫逻辑本身能抓到缺失（不修改生产文件，只在内存里模拟）
	const probe = typeKeys.find((k) => !k.optional);
	assert.ok(probe, "fixture sanity: AppSettings must have required keys");
	const simulatedDefaults = new Set(["terminalTheme"]);
	const uncovered = typeKeys.filter((k) => !k.optional && !simulatedDefaults.has(k.name) && !new Set().has(k.name)).map((k) => k.name);
	assert.ok(uncovered.includes(probe.name), "guard logic must flag a required key missing from defaults");
});
