import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

/**
 * relativeTime 纯函数单测：transpile 后以 vm 加载，mock 掉 i18n 依赖，
 * 让 t(key, params) 按「刚刚」「{count}分钟」这类模板替换返回，直接断言边界分档。
 *
 * 分档是产品规则（2027-03 用户要求）：不足 1 分钟统一「刚刚」，其后分钟/小时/天/月，
 * 不再有秒级与年级档位。
 */

const I18N_TEMPLATES = {
	"session.relativeJustNow": "刚刚",
	"session.relativeMinutes": "{count}分钟",
	"session.relativeHours": "{count}小时",
	"session.relativeDays": "{count}天",
	"session.relativeMonths": "{count}个月",
};

function loadModule() {
	const output = ts.transpileModule(readFileSync("src/renderer/src/utils/relativeTime.ts", "utf8"), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
		fileName: "relativeTime.ts",
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(
		output,
		{
			module,
			exports: module.exports,
			JSON,
			Object,
			Math,
			Date,
			require: (specifier) => {
				if (specifier === "../i18n") {
					return {
						t: (key, params) => {
							const template = I18N_TEMPLATES[key] ?? key;
							return template.replace(/\{(\w+)\}/g, (_, name) => String(params?.[name] ?? ""));
						},
					};
				}
				throw new Error(`Unexpected import: ${specifier}`);
			},
		},
		{ filename: "relativeTime.ts" },
	);
	return module.exports;
}

/** 构造「now - elapsedMs」的时间戳，让用例不依赖真实时钟。 */
function tsAgo(elapsedMs) {
	return Date.now() - elapsedMs;
}

test("under a minute collapses to 刚刚 (no per-second flicker)", () => {
	const { formatRelativeTime } = loadModule();
	assert.equal(formatRelativeTime(tsAgo(0)), "刚刚");
	assert.equal(formatRelativeTime(tsAgo(59_000)), "刚刚");
});

test("minutes bucket from 60s to <1h", () => {
	const { formatRelativeTime } = loadModule();
	assert.equal(formatRelativeTime(tsAgo(60_000)), "1分钟");
	assert.equal(formatRelativeTime(tsAgo(59 * 60_000)), "59分钟");
});

test("hours bucket from 1h to <24h", () => {
	const { formatRelativeTime } = loadModule();
	assert.equal(formatRelativeTime(tsAgo(3_600_000)), "1小时");
	assert.equal(formatRelativeTime(tsAgo(23 * 3_600_000)), "23小时");
});

test("days bucket from 24h to <30d", () => {
	const { formatRelativeTime } = loadModule();
	assert.equal(formatRelativeTime(tsAgo(24 * 3_600_000)), "1天");
	assert.equal(formatRelativeTime(tsAgo(29 * 86_400_000)), "29天");
});

test("months bucket caps the scale: 30d, a year and beyond all read as months", () => {
	const { formatRelativeTime } = loadModule();
	assert.equal(formatRelativeTime(tsAgo(30 * 86_400_000)), "1个月");
	assert.equal(formatRelativeTime(tsAgo(11 * 30 * 86_400_000)), "11个月");
	assert.equal(formatRelativeTime(tsAgo(365 * 86_400_000)), "12个月");
	assert.equal(formatRelativeTime(tsAgo(3 * 365 * 86_400_000)), "36个月");
});

test("future timestamps clamp to 刚刚", () => {
	const { formatRelativeTime } = loadModule();
	assert.equal(formatRelativeTime(Date.now() + 10_000), "刚刚");
});
