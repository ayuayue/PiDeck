/**
 * issue #397 回归：反馈弹窗的 GitHub Issue 预填链接不能超长。
 *
 * 现象：点「打开 GitHub Issue」只看到 GitHub 的 "Whoa there! Your request URL is too long."
 * ——旧实现把整份诊断报告（最多 150 条报错日志）塞进 body，中文经 encodeURIComponent
 * 一个字变 9 个字符，URL 达数万字符。
 *
 * 契约：URL 只带标题 + 简述 + 环境摘要，整条长度 ≤ GITHUB_ISSUE_URL_BUDGET；
 * 完整报告由调用方放剪贴板（正文留 HTML 注释指路）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { buildFeedbackIssueUrl, GITHUB_ISSUE_URL_BUDGET, DEFAULT_FEEDBACK_REPO } = loadTsCommonJs("src/renderer/src/features/feedback/issueUrl.ts");

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
		checks: [{ id: "pi.installed", status: "ok", detail: "1.0.0" }],
		logSummary: {
			total: 150,
			error: 5,
			warn: 3,
			todayError: 2,
			todayWarn: 1,
			recent: Array.from({ length: 150 }, (_, i) => ({ time: 1710000000000 - i * 1000, level: "error", scope: "agent", message: `spawn failed for conversation ${i} — 扩展加载超时，会话已回滚到上一个快照` })),
		},
		...overrides,
	};
}

const decodeBody = (url) => decodeURIComponent(new URL(url).searchParams.get("body") ?? "");
const decodeTitle = (url) => decodeURIComponent(new URL(url).searchParams.get("title") ?? "");

test("URL 带完整报告时仍远低于 GitHub 上限，且不再包含报错日志（#397）", () => {
	const result = buildFeedbackIssueUrl({
		title: "问题反馈：切换会话后面板变透明",
		description: "打开设置再关掉，面板变成半透明并且盖不住壁纸，切换会话后才恢复正常。",
		steps: "1. 打开设置\n2. 直接关闭",
		report: makeReport(),
	});
	assert.ok(result.url.length <= GITHUB_ISSUE_URL_BUDGET, `url 超出预算：${result.url.length}`);
	assert.ok(result.url.startsWith(`${DEFAULT_FEEDBACK_REPO}/issues/new?title=`));
	const body = decodeBody(result.url);
	// 环境摘要进 URL（排障要它），150 条报错日志不进（那走剪贴板）
	assert.match(body, /## Environment/);
	assert.match(body, /PiDeck 1\.2\.3 \(installed\)/);
	assert.doesNotMatch(body, /spawn failed for conversation/);
	// 正文留了「完整报告在剪贴板」的指路注释
	assert.match(body, /clipboard/);
	assert.equal(result.truncated, false);
});

test("超长中文描述按编码后长度截断，URL 依然不越界", () => {
	const long = "会话切换后界面错乱，面板盖住背景图。".repeat(400); // ≈7400 字中文 ≈ 6.6 万编码字符
	const result = buildFeedbackIssueUrl({ title: "问题反馈：长描述", description: long, steps: "", report: makeReport() });
	assert.ok(result.url.length <= GITHUB_ISSUE_URL_BUDGET, `url 超出预算：${result.url.length}`);
	assert.equal(result.truncated, true);
	const body = decodeBody(result.url);
	assert.match(body, /…/);
	assert.match(body, /^## Problem\n会话切换后界面错乱/);
});

test("描述与步骤按 7:3 分享预算，两者都被裁到预算内", () => {
	const result = buildFeedbackIssueUrl({
		title: "t",
		description: "现象描述".repeat(500),
		steps: "步骤".repeat(500),
		report: null,
	});
	assert.ok(result.url.length <= GITHUB_ISSUE_URL_BUDGET);
	const body = decodeBody(result.url);
	assert.match(body, /### Repro steps/);
	assert.equal(result.truncated, true);
});

test("短输入不截断，无体检报告时正文没有环境小节", () => {
	const result = buildFeedbackIssueUrl({ title: "问题反馈：崩溃", description: "打开就崩", steps: "双击图标", report: null });
	assert.equal(result.truncated, false);
	assert.ok(result.url.length < 1000);
	const body = decodeBody(result.url);
	assert.match(body, /## Problem\n打开就崩/);
	assert.match(body, /### Repro steps\n双击图标/);
	assert.doesNotMatch(body, /## Environment/);
});

test("标题单行化并限长，换行不会写坏查询串", () => {
	const result = buildFeedbackIssueUrl({ title: `问题反馈：${"很长的标题".repeat(60)}\n第二行`, description: "", steps: "", report: null });
	const title = decodeTitle(result.url);
	assert.doesNotMatch(title, /\n/);
	assert.ok(title.length <= 91, `标题过长：${title.length}`);
	assert.match(title, /^问题反馈：很长的标题/);
});

test("emoji 被截在预算边界也不会抛 URIError", () => {
	// 代理对落在截断点：直接 slice 会得到孤立代理项，encodeURIComponent 会抛错
	const result = buildFeedbackIssueUrl({ title: "t", description: `前缀${"🙂".repeat(400)}`, steps: "", report: null });
	assert.ok(result.url.length <= GITHUB_ISSUE_URL_BUDGET);
	assert.doesNotThrow(() => decodeURIComponent(result.url));
	assert.equal(decodeBody(result.url).includes("\uD800"), false);
});

test("反馈弹窗改为「先复制完整报告、再用短 URL 打开 Issue」", () => {
	const dialog = readFileSync("src/renderer/src/features/feedback/FeedbackDialog.tsx", "utf8");
	assert.match(dialog, /buildFeedbackIssueUrl\(/);
	// 回归点：URL 里绝不能再塞整份报告文本
	assert.doesNotMatch(dialog, /encodeURIComponent\(feedback\.text\)/);
	assert.doesNotMatch(dialog, /issues\/new\?title=/);
	const openIndex = dialog.indexOf("await feedback.copyMarkdown()");
	const urlIndex = dialog.indexOf("onOpenExternal(issue.url)");
	assert.ok(openIndex >= 0, "打开 Issue 前必须先复制完整报告");
	assert.ok(urlIndex > openIndex, "复制失败也不能阻断打开（复制在前、打开在后）");
});
