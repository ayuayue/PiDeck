/**
 * scripts/check-release-consistency.mjs 纯函数单测：
 * 版本头解析 / 条目计数 / 徽章反解 / collectIssues 规则矩阵。
 * 全部用 fixture 文本断言，不依赖仓库当前状态（发版期真实文件天天变）。
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { collectIssues, countChangelogEntries, parseChangelogHead, parseLatestVersionLine, parseVersionBadge } from "../scripts/check-release-consistency.mjs";

test("parseChangelogHead 兼容 Unreleased 与定稿日期两种格式", () => {
	assert.deepEqual(parseChangelogHead("## v0.8.0 (Unreleased)\n- **A**"), { version: "v0.8.0", dateLabel: "Unreleased" });
	assert.deepEqual(parseChangelogHead("## v0.8.0-beta.1 - 2026-10-01\n- **A**"), { version: "v0.8.0-beta.1", dateLabel: "2026-10-01" });
	assert.equal(parseChangelogHead("# v0.8.0\n## 其他"), null);
	assert.equal(parseChangelogHead(null), null);
});

test("countChangelogEntries 只数最新小节的 `- **` 条目", () => {
	const text = ["## v0.9.0 (Unreleased)", "- **feat a**", "  - 子项", "- **feat b**", "", "## v0.8.9 - 2026-09-30", "- **旧条目**"].join("\n");
	assert.equal(countChangelogEntries(text), 2);
	assert.equal(countChangelogEntries("没有版本头"), 0);
});

test("parseVersionBadge 反解 shields 的 -- 转义并剥掉颜色后缀", () => {
	assert.equal(parseVersionBadge('![v](https://img.shields.io/badge/version-0.8.0-blue) "v"'), "0.8.0");
	assert.equal(parseVersionBadge("https://img.shields.io/badge/version-0.8.0--beta.1-blueviolet"), "0.8.0-beta.1");
	assert.equal(parseVersionBadge("没有徽章"), null);
});

test("parseLatestVersionLine 兼容中英文行", () => {
	assert.equal(parseLatestVersionLine("> 最新版本 v0.8.0"), "0.8.0");
	assert.equal(parseLatestVersionLine("**Latest: v0.8.0**"), "0.8.0");
	assert.equal(parseLatestVersionLine("什么都没有"), null);
});

/** 基线 fixture：四份文件全部对齐 v0.8.0，无失败无提醒。 */
function alignedFixture() {
	const changelog = "## v0.8.0 - 2026-10-06\n- **a**\n- **b**\n";
	const readme = "> 最新版本 v0.8.0\n![v](https://img.shields.io/badge/version-0.8.0-blue)\n";
	return { pkgVersion: "0.8.0", lockVersion: "0.8.0", lockRootVersion: "0.8.0", changelogEn: changelog, changelogZh: changelog, readmeZh: readme, readmeEn: readme };
}

test("collectIssues：基线对齐时零失败零提醒", () => {
	const { failures, warnings } = collectIssues(alignedFixture());
	assert.deepEqual(failures, []);
	assert.deepEqual(warnings, []);
});

test("collectIssues：lock 版本漂移与 CHANGELOG 版本头不一致各记一条失败", () => {
	const fixture = alignedFixture();
	fixture.lockVersion = "0.7.9";
	fixture.changelogZh = fixture.changelogZh.replace("v0.8.0", "v0.7.9");
	const { failures } = collectIssues(fixture);
	assert.equal(failures.length, 2);
	assert.match(failures[0], /package-lock\.json 根版本/);
	assert.match(failures[1], /CHANGELOG\.zh-CN\.md 最新版本/);
});

test("collectIssues：中英条目数不一致是失败；Unreleased 只是提醒", () => {
	const fixture = alignedFixture();
	fixture.changelogEn = "## v0.8.0 (Unreleased)\n- **only one**\n";
	const { failures, warnings } = collectIssues(fixture);
	assert.equal(failures.length, 1);
	assert.match(failures[0], /中英条目数不一致/);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /Unreleased/);
});

test("collectIssues：徽章/最新版本行缺失是提醒，版本不匹配是失败", () => {
	const noBadge = alignedFixture();
	noBadge.readmeZh = "没有徽章也没有版本行\n";
	let result = collectIssues(noBadge);
	assert.deepEqual(result.failures, []);
	assert.equal(result.warnings.length, 2);

	const wrongBadge = alignedFixture();
	wrongBadge.readmeEn = wrongBadge.readmeEn.replace("version-0.8.0-blue", "version-0.7.0-blue").replace("v0.8.0", "v0.7.0");
	result = collectIssues(wrongBadge);
	assert.equal(result.failures.length, 2);
	assert.match(result.failures[0], /徽章版本/);
	assert.match(result.failures[1], /最新版本行/);
});
