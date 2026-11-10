import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { isPlausibleChangelog, extractChangelogRange, PiChangelogService } = loadTsCommonJs("src/main/pi/PiChangelogService.ts");

// 与 pi 官方 CHANGELOG.md 同构的样本（Keep-a-Changelog：`## [x.y.z] - date` + 小节）。
const SAMPLE = `# Changelog

All notable changes to pi.

## [1.0.2] - 2026-10-04

### Fixed

- Fixed a crash on startup (#102)
- Another fix with a [link](https://example.com/docs/models.md#part)

## [1.0.1] - 2026-10-03

### Added

- Added sampling params (#9776)

## [1.0.0] - 2026-10-01

### New Features

- Big 1.0 release notes

## [0.99.0] - 2026-09-28

### Changed

- Old stuff nobody needs

## [Unreleased]

- not a version entry, must be ignored
`;

// ── isPlausibleChangelog：HTML 错误壳识别 ─────────────────────────

test("plausible: 拒绝 CDN/代理返回的 HTML 错误壳", () => {
	assert.equal(isPlausibleChangelog("<!DOCTYPE html><html><body>404</body></html>"), false);
	assert.equal(isPlausibleChangelog("<html><head></head></html>"), false);
	assert.equal(isPlausibleChangelog("  \n<!doctype html>\n<html>"), false);
});

test("plausible: 接受真实 changelog，拒绝无版本条目的 markdown", () => {
	assert.equal(isPlausibleChangelog(SAMPLE), true);
	assert.equal(isPlausibleChangelog("# Changelog\n\nnothing here"), false);
	assert.equal(isPlausibleChangelog("random text"), false);
});

// ── extractChangelogRange：版本区间抽取 ───────────────────────────

test("range: 只保留 (current, latest] 区间条目，排除当前与更老版本", () => {
	const result = extractChangelogRange(SAMPLE, "1.0.0", "1.0.2");
	assert.equal(result.versionCount, 2);
	assert.ok(result.markdown.includes("## [1.0.2]"));
	assert.ok(result.markdown.includes("## [1.0.1]"));
	assert.ok(!result.markdown.includes("## [1.0.0]"));
	assert.ok(!result.markdown.includes("## [0.99.0]"));
	assert.equal(result.truncated, false);
});

test("range: 非 semver 段落头（Unreleased）被忽略，文件头不进入正文", () => {
	const result = extractChangelogRange(SAMPLE, "0.99.0", "1.0.2");
	assert.equal(result.versionCount, 3);
	assert.ok(!result.markdown.includes("Unreleased"));
	assert.ok(!result.markdown.includes("# Changelog"));
});

test("range: currentVersion 缺失/非法时兜底取最新 3 条", () => {
	const result = extractChangelogRange(SAMPLE, undefined, "1.0.2");
	// 样本共 4 个版本条目，兕底 FALLBACK_VERSIONS=3 → 1.0.2/1.0.1/1.0.0，不含 0.99.0。
	assert.equal(result.versionCount, 3);
	assert.ok(result.markdown.includes("## [1.0.0]"));
	assert.ok(!result.markdown.includes("## [0.99.0]"));
	const garbage = extractChangelogRange(SAMPLE, "not-a-version", "1.0.2");
	assert.equal(garbage.versionCount, 3);
});

test("range: 已是最新（current == latest）返回空区间", () => {
	const result = extractChangelogRange(SAMPLE, "1.0.2", "1.0.2");
	assert.equal(result.versionCount, 0);
	assert.equal(result.markdown, "");
});

test("range: 超过版本数上限按新版本截断并标记 truncated", () => {
	const result = extractChangelogRange(SAMPLE, "0.99.0", "1.0.2", { maxVersions: 2 });
	assert.equal(result.versionCount, 2);
	assert.equal(result.truncated, true);
	assert.ok(result.markdown.includes("## [1.0.2]"));
	assert.ok(!result.markdown.includes("## [1.0.0]"));
});

test("range: 超过字符上限截在版本边界，不会半个段落", () => {
	const full = extractChangelogRange(SAMPLE, "0.99.0", "1.0.2");
	const cut = extractChangelogRange(SAMPLE, "0.99.0", "1.0.2", { maxChars: 120 });
	assert.equal(cut.truncated, true);
	assert.ok(cut.markdown.length < full.markdown.length);
	// 截断只丢完整条目：留下的每个 `## [` 都有对应的小节正文。
	assert.ok(!cut.markdown.endsWith("## [1.0.0] - 2026-10-01"));
});

// ── PiChangelogService：抓取上限（增长型门槛，回归 1.5.1 撞线）──────

/** 造一份与 pi 官方同构、总长约 totalChars 的 changelog。 */
function changelogOfSize(totalChars) {
	const head = "# Changelog\n\nAll notable changes to pi.\n\n## [1.5.1] - 2026-11-09\n\n### Fixed\n\n- ";
	const tail = "\n\n## [1.5.0] - 2026-11-02\n\n### Added\n\n- previous release\n";
	return head + "x".repeat(Math.max(0, totalChars - head.length - tail.length)) + tail;
}

/** 只回第一帧的 fetch 替身：三源重试时后续请求直接 404，不影响首源成功路径。 */
function firstHitFetch(text) {
	let calls = 0;
	return async () => {
		calls += 1;
		return calls === 1 ? new Response(text, { status: 200 }) : new Response("not found", { status: 404 });
	};
}

test("fetch: 超旧上限（1.2M 字符）的 changelog 仍被接受，不会静默降级成「在浏览器查看」", async () => {
	// 回归背景：上游 CHANGELOG.md 实测 1.5.0 = 682,079、1.5.1 = 712,870 字符，每个 minor 约 +30KB。
	// 旧上限 800k 在 1.5.1 时只剩 11% 余量，两三个版本后 → 三源全跳过 → 「更新详情」永久失效。
	// 这里用旧上限必失败的尺寸，钉住「门槛不能按当时文件大小 + 一点余量定」。
	const service = new PiChangelogService({ fetchImpl: firstHitFetch(changelogOfSize(1_200_000)) });
	const result = await service.getReleaseNotes({ latestVersion: "1.5.1", currentVersion: "1.5.0" });
	assert.equal(result.source, "jsdelivr");
	assert.equal(result.versionCount, 1);
	assert.ok(result.markdown.includes("## [1.5.1]"));
	// 正文上限（MAX_RANGE_CHARS）不算本次契约：它总是至少保留一条版本条目，
	// 所以单个超大条目会整条透传，由渲染层负责展开/折叠。
});

test("fetch: 超出上限的文件仍按异常跳过（三源全失败 → 空 payload）", async () => {
	const service = new PiChangelogService({ fetchImpl: async () => new Response(changelogOfSize(2_100_000), { status: 200 }) });
	const result = await service.getReleaseNotes({ latestVersion: "1.5.1", currentVersion: "1.5.0" });
	assert.equal(result.markdown, null);
	assert.equal(result.source, null);
});

// ── PiChangelogService：入参防御（网络路径不打，只测快速失败分支）──

test("service: latestVersion 非法直接返回空 payload（不发网络请求）", async () => {
	const service = new PiChangelogService();
	const result = await service.getReleaseNotes({ latestVersion: "abc" });
	assert.equal(result.markdown, null);
	assert.equal(result.source, null);
	assert.equal(result.versionCount, 0);
	assert.ok(result.pageUrl.includes("github.com"));
	assert.equal(result.truncated, false);
});
