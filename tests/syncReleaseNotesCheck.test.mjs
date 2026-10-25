/**
 * scripts/sync-release-notes.js 的 --check 支撑函数单测：
 * computeReadmeUpdate（README 亮点区块定位/同步判定）与 computeDocsSiteUpdate
 * （插入/同版本替换/v0.6.6 去重）。全部走临时文件/内容注入，不碰真实 README 与 docs-site，
 * 也不依赖仓库当前同步状态。
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { computeDocsSiteUpdate, computeReadmeUpdate } from "../scripts/sync-release-notes.js";

/** 造一份带亮点区块的 README 形状（与真实 README 的区块边界规则一致）。 */
function readmeFixture(block) {
	return ["# PiDeck", "", "> **v0.8.0 亮点**", ...(block ?? ["> - ✨ 新功能 A", "> - 🐛 修复 B"]), "> ", "> [查看完整更新日志](CHANGELOG.zh-CN.md)", "", "---", "", "## 安装", ""].join("\n");
}

const newBlock = ["> **v0.9.0 亮点**", "> - ✨ 新功能 C", "> ", "> [查看完整更新日志](CHANGELOG.zh-CN.md)"].join("\n");

test("computeReadmeUpdate：区块滞后时 changed=true，内容按新区块替换", () => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-notes-"));
	try {
		const file = join(dir, "README.md");
		writeFileSync(file, readmeFixture(), "utf8");
		const result = computeReadmeUpdate(file, newBlock);
		assert.equal(result.ok, true);
		assert.equal(result.changed, true);
		assert.match(result.newContent, /v0\.9\.0 亮点/);
		assert.match(result.newContent, /新功能 C/);
		assert.ok(!result.newContent.includes("新功能 A"));
		// 写回后再次计算应收敛为 changed=false（幂等，--check 依赖这一点）
		writeFileSync(file, result.newContent, "utf8");
		assert.equal(computeReadmeUpdate(file, newBlock).changed, false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("computeReadmeUpdate：找不到亮点区块时 ok=false（--check 判红）", () => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-notes-"));
	try {
		const file = join(dir, "README.md");
		writeFileSync(file, "# PiDeck\n\n没有区块\n", "utf8");
		const result = computeReadmeUpdate(file, newBlock);
		assert.equal(result.ok, false);
		assert.equal(result.changed, false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

function docsData(version, feats = ["功能 A"], imps = ["改进 B"]) {
	return { version, date: "2026-10-06", majorFeatures: feats, improvements: imps };
}

test("computeDocsSiteUpdate：新版本插入到最上方", () => {
	const content = ["## v0.8.0", "发布时间：2026-10-01", "- 🚀 **旧**", "", "## v0.7.9", "发布时间：2026-09-20", ""].join("\n");
	const result = computeDocsSiteUpdate(docsData("v0.9.0"), content);
	assert.equal(result.ok, true);
	assert.equal(result.changed, true);
	const lines = result.newContent.split("\n");
	assert.equal(lines[0], "## v0.9.0");
	assert.ok(lines.indexOf("## v0.8.0") > 0);
	assert.match(result.newContent, /- 🚀 \*\*功能 A\*\*/);
	assert.match(result.newContent, /- ✨ \*\*改进 B\*\*/);
});

test("computeDocsSiteUpdate：同版本重跑走替换不重复插入；已同步时 changed=false", () => {
	const content = ["## v0.8.0", "发布时间：2026-10-01", "- 🚀 **旧文案**", "", "## v0.7.9", ""].join("\n");
	const once = computeDocsSiteUpdate(docsData("v0.8.0", ["新文案"]), content);
	assert.equal(once.changed, true);
	// 旧段落被整体替换，不再出现两份 v0.8.0 头
	assert.equal(once.newContent.split("^## v0\\.8\\.0$").length, 1);
	assert.ok(!once.newContent.includes("旧文案"));
	assert.equal((once.newContent.match(/^## v0\.8\.0$/gm) ?? []).length, 1);
	// 用替换后的内容重算 → 幂等收敛
	assert.equal(computeDocsSiteUpdate(docsData("v0.8.0", ["新文案"]), once.newContent).changed, false);
});

test("computeDocsSiteUpdate：同版本仅发布日期变化时替换原段，且能收敛掉已存在的同版本重复段", () => {
	// 2026-10-13 发版实测事故：当期版本日期从 10-12 改成 10-13 后重跑同步，
	// 按整行（含日期）比对会认不出既有段落，于是 docs-site 出现两份 v0.9.0。
	const content = ["## v0.9.0 (2026-10-12)", "发布时间：2026-10-12", "- 🚀 **旧**", "", "## v0.8.0 (2026-10-07)", "", "## v0.6.6", "历史段", ""].join("\n");
	const result = computeDocsSiteUpdate(docsData("v0.9.0 (2026-10-13)"), content);
	assert.equal(result.changed, true);
	assert.equal((result.newContent.match(/^## v0\.9\.0/gm) ?? []).length, 1);
	assert.match(result.newContent, /^## v0\.9\.0 \(2026-10-13\)$/m);
	assert.ok(!result.newContent.includes("2026-10-12"));
	assert.ok(result.newContent.includes("## v0.6.6"));
	// 已存在新旧两份时，重跑自愈为单份（不能只替换第一份而留下旧日期段）
	const duplicated = ["## v0.9.0 (2026-10-13)", "发布时间：2026-10-13", "- 🚀 **新**", "", "## v0.9.0 (2026-10-12)", "发布时间：2026-10-12", "- 🚀 **旧**", "", "## v0.8.0", ""].join("\n");
	const healed = computeDocsSiteUpdate(docsData("v0.9.0 (2026-10-13)"), duplicated);
	assert.equal((healed.newContent.match(/^## v0\.9\.0/gm) ?? []).length, 1);
	assert.ok(!healed.newContent.includes("旧"));
});

test("computeDocsSiteUpdate：v0.6.6 历史重复只保留第一份，且绝不误删唯一版本段", () => {
	const dup = ["## v0.8.0", "", "## v0.6.6", "旧 66 第一份", "", "## v0.6.6-beta.1", "旧 66 第二份", "", "## v0.6.5", ""].join("\n");
	const deduped = computeDocsSiteUpdate(docsData("v0.8.0"), dup);
	assert.ok(!deduped.newContent.includes("旧 66 第二份"));
	assert.ok(deduped.newContent.includes("旧 66 第一份"));
	// 唯一一份 v0.6.6 时不得被清空（2026-08-15 误删事故的回归锚）
	const single = ["## v0.8.0", "", "## v0.6.6", "唯一历史段", "", "## v0.6.5", ""].join("\n");
	const kept = computeDocsSiteUpdate(docsData("v0.8.0"), single);
	assert.ok(kept.newContent.includes("唯一历史段"));
});

test("computeDocsSiteUpdate：找不到任何版本头时 ok=false", () => {
	const result = computeDocsSiteUpdate(docsData("v0.9.0"), "# 没有版本段的文件\n");
	assert.equal(result.ok, false);
});
