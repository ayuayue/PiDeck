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
