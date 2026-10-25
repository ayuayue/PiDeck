/**
 * 诊断报告的三种输出形态：reportFormat.ts 纯函数。
 *
 * 断言 markdown / card / prompt 都包含关键诊断字段，且格式间内容差异符合预期——
 * 报告是发给用户/支持者的，漏字段或格式错误会直接降低排障效率。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { formatMarkdown, formatCard, formatAiPrompt, summarizeChecks } = loadTsCommonJs("src/renderer/src/features/feedback/reportFormat.ts");

function makeReport(overrides = {}) {
	return {
		generatedAt: 1710000000000,
		environment: {
			appVersion: "1.2.3",
			platform: "win32",
			arch: "x64",
			osVersion: "10.0.22631",
			locale: "zh-CN",
			timezone: "Asia/Shanghai",
			electronVersion: "38.0.0",
			chromeVersion: "130.0.0",
			nodeVersion: "22.0.0",
			installMode: "installed",
			userDataDir: "~/AppData/Roaming/PiDeck",
			logsDir: "~/AppData/Roaming/PiDeck/logs",
			appRssBytes: 500 * 1024 * 1024,
			appHeapUsedBytes: 200 * 1024 * 1024,
			systemTotalMemoryBytes: 16 * 1024 * 1024 * 1024,
			systemFreeMemoryBytes: 8 * 1024 * 1024 * 1024,
			dataDirFreeBytes: 100 * 1024 * 1024 * 1024,
			flags: {
				wslEnabled: false,
				wslDistro: "",
				piProxyEnabled: false,
				desktopProxyEnabled: false,
				piProxyConfigured: false,
				chromiumSandbox: true,
				developerDiagnostics: false,
				webServiceEnabled: true,
				customPiPathConfigured: false,
			},
			pi: { installed: true, version: "1.0.0", searchedDirs: [] },
		},
		checks: [
			{ id: "pi.installed", status: "ok", detail: "1.0.0" },
			{ id: "disk.space", status: "error", detail: "100 MB" },
		],
		logSummary: {
			total: 100,
			error: 5,
			warn: 3,
			todayError: 2,
			todayWarn: 1,
			recent: [
				{ time: 1710000000000, level: "error", scope: "agent", message: "spawn failed" },
				{ time: 1709990000000, level: "warn", scope: "git", message: "slow" },
			],
		},
		logFiles: [],
		...overrides,
	};
}

const CONTEXT = {
	description: "会话起不来",
	steps: "1. 打开应用\n2. 点会话",
	projectName: "my-proj",
};

test("formatMarkdown includes description, checks, environment and logs", () => {
	const out = formatMarkdown(makeReport(), CONTEXT);
	assert.ok(out.includes("会话起不来"), "should include description");
	assert.ok(out.includes("1. 打开应用"), "should include repro steps");
	assert.ok(out.includes("PiDeck 1.2.3"), "should include app version");
	assert.ok(out.includes("disk.space"), "should include check id");
	assert.ok(out.includes("spawn failed"), "should include recent log");
	assert.ok(out.startsWith("# PiDeck Diagnostic Report"), "should start with title");
});

test("formatMarkdown surfaces today's error/warn counts and collection totals", () => {
	const out = formatMarkdown(makeReport(), CONTEXT);
	assert.match(out, /today 2 errors \/ 1 warns/, "should show today's counts");
	assert.match(out, /errors 5 · warns 3/, "should show 7-day totals");
	assert.match(out, /2 shown of 2 collected/, "should report shown/collected");
});

test("formatMarkdown notes truncation when collected logs exceed the display limit", () => {
	const many = Array.from({ length: 200 }, (_, index) => ({
		time: 1710000000000 - index,
		level: index % 2 ? "warn" : "error",
		scope: "agent",
		message: `line ${index}`,
	}));
	const out = formatMarkdown(makeReport({ logSummary: { total: 300, error: 100, warn: 100, todayError: 5, todayWarn: 5, recent: many } }), CONTEXT);
	assert.match(out, /150 shown of 200 collected/, "should cap shown count at 150");
	assert.match(out, /共 200 条/, "should append truncation note");
});

test("formatCard is compact and contains problem + environment", () => {
	const out = formatCard(makeReport(), CONTEXT);
	assert.ok(out.includes("会话起不来"), "should include problem");
	assert.ok(out.includes("PiDeck 1.2.3"), "should include version");
	assert.ok(out.includes("errors") || out.includes("error"), "should mention errors");
});

test("formatAiPrompt sets up a support-engineer role", () => {
	const out = formatAiPrompt(makeReport(), CONTEXT);
	assert.ok(out.includes("技术支持工程师"), "should set role");
	assert.ok(out.includes("复现步骤"), "should include repro steps");
	assert.ok(out.includes("最可能的根因"), "should request root-cause analysis");
	assert.ok(out.includes("验证"), "should request verification steps");
	assert.ok(out.includes("日志统计"), "should include a log stats section");
	assert.ok(out.includes("today 2 errors / 1 warns"), "should include today counts");
});

test("formatAiPrompt embeds project context when provided", () => {
	const projectContext = {
		projectId: "proj-1",
		projectName: "PiDeck",
		agentsMd: "## 架构规则\n- 禁止 any\n- 用 Jotai\n",
		agentsMdTruncated: false,
		skills: ["pideck-doctor", "git-helper"],
	};
	const out = formatAiPrompt(makeReport(), CONTEXT, projectContext);
	assert.ok(out.includes("## 项目上下文（PiDeck）"), "should include project context section");
	assert.ok(out.includes("项目地址（源码仓库）：https://github.com/ayuayue/PiDeck"), "should point at the GitHub repo (local source is usually absent)");
	assert.ok(out.includes("- 禁止 any"), "should embed AGENTS.md content");
	assert.ok(out.includes("pideck-doctor"), "should list project skills");
	assert.ok(out.includes("/skill:pideck-doctor"), "should hint at the diagnostic skill");
});

test("formatAiPrompt marks truncated AGENTS.md and omits empty project context", () => {
	const truncated = {
		projectId: "proj-1",
		projectName: "PiDeck",
		agentsMd: "# rules",
		agentsMdTruncated: true,
		skills: [],
	};
	const out = formatAiPrompt(makeReport(), CONTEXT, truncated);
	assert.ok(out.includes("已截断"), "should mark truncation");
	assert.ok(!out.includes("项目级可用技能"), "should skip empty skills list");
	const withoutContext = formatAiPrompt(makeReport(), CONTEXT);
	assert.ok(!withoutContext.includes("## 项目上下文"), "no context → no section");
});

test("summarizeChecks counts statuses and computes score", () => {
	const summary = summarizeChecks([
		{ id: "a", status: "ok", detail: "" },
		{ id: "b", status: "warn", detail: "" },
		{ id: "c", status: "error", detail: "" },
	]);
	assert.equal(summary.ok, 1);
	assert.equal(summary.warn, 1);
	assert.equal(summary.error, 1);
	// (ok 1 + warn*0.5 0.5) / evaluated 3 = 0.5 -> 50
	assert.equal(summary.score, 50);
});

test("summarizeChecks ignores skipped for score", () => {
	const summary = summarizeChecks([
		{ id: "a", status: "ok", detail: "" },
		{ id: "b", status: "skipped", detail: "" },
	]);
	assert.equal(summary.score, 100);
	assert.equal(summary.skipped, 1);
});
