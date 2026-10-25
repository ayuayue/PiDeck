/**
 * build-announcements.js 转换脚本单测。
 * 守护：front matter 拆分/解析、字段校验（必填/级别/日期/id 空白）、id 全局唯一、
 * 排序（publishedAt 倒序 + 同时间 id 稳定）、序列化格式（2 空格 + 尾换行，与
 * 现有 announcements.json 手写格式一致）、端到端目录 → feed 生成。
 * 全部走临时目录，不触碰仓库真实 announcements-md/ 与 announcements.json。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const build = require("../scripts/build-announcements.js");

/** 构造一份合法 md 源（可按需覆盖字段与正文）。 */
function makeMd(overrides = {}, body = "正文内容") {
	const lines = ["---", `id: ${overrides.id ?? "2026-09-07-sample"}`, `title: ${overrides.title ?? "示例公告"}`, `level: ${overrides.level ?? "info"}`, `publishedAt: ${overrides.publishedAt ?? "2026-09-07T00:00:00+08:00"}`, `effectiveUntil: ${overrides.effectiveUntil ?? "2026-10-07T00:00:00+08:00"}`];
	if (overrides.minVersion !== undefined) lines.push(`minVersion: ${overrides.minVersion}`);
	if (overrides.category !== undefined) lines.push(`category: ${overrides.category}`);
	if (overrides.extraField !== undefined) lines.push(`${overrides.extraField}: ${overrides.extraValue ?? "x"}`);
	lines.push("---", "", body);
	return lines.join("\n");
}

/** 建临时目录，写入若干 md 文件，返回目录路径（测试结束自动清理）。 */
function tmpDirWith(files) {
	const dir = mkdtempSync(join(tmpdir(), "announcement-md-"));
	for (const [name, content] of Object.entries(files)) {
		writeFileSync(join(dir, name), content);
	}
	return dir;
}

const cleanupDirs = [];
function track(dir) {
	cleanupDirs.push(dir);
	return dir;
}

test("splitFrontMatter：正常拆分 front matter 与正文", () => {
	const md = "---\nid: a\n---\n正文\n第二行\n";
	const { front, body, error } = build.splitFrontMatter(md);
	assert.equal(error, null);
	assert.equal(front, "id: a");
	assert.equal(body, "正文\n第二行\n");
});

test("splitFrontMatter：缺起始行 / 缺结束行均报错", () => {
	assert.match(build.splitFrontMatter("id: a\n---\n正文").error, /起始行/);
	assert.match(build.splitFrontMatter("---\nid: a\n正文").error, /结束行/);
});

test("splitFrontMatter：CRLF 行尾与正文中的横线不误伤", () => {
	const md = "---\r\nid: a\r\n---\r\n---\r\n正文里的分隔线\r\n";
	const { front, body, error } = build.splitFrontMatter(md);
	assert.equal(error, null);
	assert.equal(front, "id: a");
	assert.equal(body, "---\n正文里的分隔线\n");
});

test("parseFrontMatter：引号包裹、注释行、空行、值内含冒号", () => {
	const { fields, errors } = build.parseFrontMatter(
		[
			'id: "2026-09-07-a"', // 双引号
			"title: 公告：功能上线", // 值里的中文冒号
			"# 这是注释",
			"",
			"publishedAt: 2026-09-07T08:00:00+08:00", // 值里的英文冒号
			"minVersion: '0.7.4-beta'", // 单引号
		].join("\n"),
	);
	assert.deepEqual(errors, []);
	assert.equal(fields.id, "2026-09-07-a");
	assert.equal(fields.title, "公告：功能上线");
	assert.equal(fields.publishedAt, "2026-09-07T08:00:00+08:00");
	assert.equal(fields.minVersion, "0.7.4-beta");
});

test("parseFrontMatter：无法解析的行报错（key: value 格式）", () => {
	const { errors } = build.parseFrontMatter("id: a\n这行没有冒号\n");
	assert.equal(errors.length, 1);
	assert.match(errors[0], /第 2 行/);
});

test("parseAnnouncementMarkdown：合法文件 → 完整条目（minVersion 透传）", () => {
	const { item, errors } = build.parseAnnouncementMarkdown(join(track(tmpDirWith({ "a.md": makeMd({ minVersion: "0.7.4-beta" }) })), "a.md"));
	assert.deepEqual(errors, []);
	assert.equal(item.id, "2026-09-07-sample");
	assert.equal(item.title, "示例公告");
	assert.equal(item.level, "info");
	// 未写 category 时缺省 notice（兼容历史 md，与 AnnouncementService 兜底一致）
	assert.equal(item.category, "notice");
	assert.equal(item.publishedAt, "2026-09-07T00:00:00+08:00");
	assert.equal(item.effectiveUntil, "2026-10-07T00:00:00+08:00");
	assert.equal(item.minVersion, "0.7.4-beta");
	assert.equal(item.body, "正文内容");
});

test("parseAnnouncementMarkdown：category=flash/guide 透传 / 非法 category 拒绝", () => {
	// 合法类别透传（flash 临时通知 / guide 指南常驻）
	for (const category of ["flash", "guide"]) {
		const file = join(track(tmpDirWith({ "a.md": makeMd({ category }) })), "a.md");
		const parsed = build.parseAnnouncementMarkdown(file);
		assert.deepEqual(parsed.errors, []);
		assert.equal(parsed.item.category, category);
	}

	// 类别必须在 flash/notice/guide 内，否则整条拒绝（防笔误类别混进 feed）
	const badFile = join(track(tmpDirWith({ "a.md": makeMd({ category: "spam" }) })), "a.md");
	const bad = build.parseAnnouncementMarkdown(badFile);
	assert.equal(bad.item, null);
	assert.match(bad.errors.join("\n"), /category/);
});

test("parseAnnouncementMarkdown：正文首尾空行被剔除", () => {
	const md = "---\nid: a\ntitle: t\nlevel: info\npublishedAt: 2026-09-07T00:00:00+08:00\neffectiveUntil: 2026-10-07T00:00:00+08:00\n---\n\n\n正文\n\n";
	const file = join(track(tmpDirWith({ "a.md": md })), "a.md");
	const { item } = build.parseAnnouncementMarkdown(file);
	assert.equal(item.body, "正文");
});

test("parseAnnouncementMarkdown：缺必填字段逐一报错", () => {
	const cases = [
		["id", /缺少必填字段 id/],
		["title", /缺少必填字段 title/],
		["level", /缺少必填字段 level/],
		["publishedAt", /缺少必填字段 publishedAt/],
		["effectiveUntil", /缺少必填字段 effectiveUntil/],
	];
	for (const [field, pattern] of cases) {
		const overrides = { [field]: "" };
		const file = join(
			track(
				tmpDirWith({
					"a.md": makeMd(overrides),
				}),
			),
			"a.md",
		);
		const { item, errors } = build.parseAnnouncementMarkdown(file);
		assert.equal(item, null, `${field} 缺失时应拒绝`);
		assert.ok(
			errors.some((e) => pattern.test(e)),
			`${field} 缺失时报错应提到字段名：${errors}`,
		);
	}
});

test("parseAnnouncementMarkdown：非法 level / 非法日期 / 空正文 / id 含空白均拒绝", () => {
	const badSources = [makeMd({ level: "loud" }), makeMd({ category: "spam" }), makeMd({ publishedAt: "不是日期" }), makeMd({ effectiveUntil: "2026-13-45" }), makeMd({ id: "2026-09-07 bad id" }), makeMd({}, "")];
	for (const md of badSources) {
		const file = join(track(tmpDirWith({ "a.md": md })), "a.md");
		const { item, errors } = build.parseAnnouncementMarkdown(file);
		assert.equal(item, null, `非法源应被拒绝：${JSON.stringify(md.split("\n")[1])}`);
		assert.ok(errors.length > 0);
	}
});

test("parseAnnouncementMarkdown：minVersion 空值拒绝", () => {
	const file = join(track(tmpDirWith({ "a.md": makeMd({ minVersion: "  " }) })), "a.md");
	const { item, errors } = build.parseAnnouncementMarkdown(file);
	assert.equal(item, null);
	assert.match(errors.join("\n"), /minVersion/);
});

test("loadAnnouncementDir：多文件汇总 + README.md/.txt 忽略 + 排序由 buildFeed 负责", () => {
	const dir = track(
		tmpDirWith({
			"01-old.md": makeMd({ id: "b", publishedAt: "2026-09-01T00:00:00+08:00" }, "旧公告"),
			"02-new.md": makeMd({ id: "a", publishedAt: "2026-09-07T00:00:00+08:00" }, "新公告"),
			"README.md": "说明文件，不是公告（脚本显式跳过 README.md）",
			"notes.txt": "忽略",
		}),
	);
	const { items, errors } = build.loadAnnouncementDir(dir);
	assert.deepEqual(errors, []);
	assert.equal(items.length, 2);
	// 目录扫描按文件名排序读入，但排序不出现在这里（buildFeed 统一处理）
	assert.deepEqual(
		items.map((i) => i.id),
		["b", "a"],
	);
});

test("loadAnnouncementDir：id 重复报错", () => {
	const dir = track(
		tmpDirWith({
			"a.md": makeMd(),
			"b.md": makeMd({ title: "撞 id 的公告" }),
		}),
	);
	const { items, errors } = build.loadAnnouncementDir(dir);
	assert.equal(items.length, 1);
	assert.match(errors.join("\n"), /id 重复：2026-09-07-sample/);
});

test("loadAnnouncementDir：目录不存在 / 目录为空都报错", () => {
	const missing = build.loadAnnouncementDir(join(tmpdir(), "definitely-not-exists-xyz"));
	assert.equal(missing.items.length, 0);
	assert.match(missing.errors[0], /目录不存在/);

	const empty = track(tmpDirWith({ "a.txt": "不参与" }));
	const { items, errors } = build.loadAnnouncementDir(empty);
	assert.equal(items.length, 0);
	assert.match(errors.join("\n"), /没有 \.md 文件/);
});

test("buildFeed：publishedAt 倒序 + 同时间按 id 稳定", () => {
	const feed = build.buildFeed([
		{ id: "z", publishedAt: "2026-09-01T00:00:00+08:00" },
		{ id: "a", publishedAt: "2026-09-07T00:00:00+08:00" },
		{ id: "b", publishedAt: "2026-09-07T00:00:00+08:00" },
		{ id: "m", publishedAt: "2026-09-03T00:00:00+08:00" },
	]);
	assert.deepEqual(
		feed.announcements.map((i) => i.id),
		["a", "b", "m", "z"],
	);
	assert.equal(feed.version, 1);
});

test("serializeFeed：2 空格缩进 + 尾换行（与已有 announcements.json 格式一致）", () => {
	const serialized = build.serializeFeed({
		version: 1,
		announcements: [{ id: "a", title: "t", level: "info" }],
	});
	assert.equal(serialized, '{\n  "version": 1,\n  "announcements": [\n    {\n      "id": "a",\n      "title": "t",\n      "level": "info"\n    }\n  ]\n}\n');
});

test("端到端：临时 md 目录 → feed 生成 + 序列化回读一致", () => {
	const dir = track(
		tmpDirWith({
			"new.md": makeMd({ id: "new-1", publishedAt: "2026-09-07T00:00:00+08:00" }, "**新**公告"),
			"old.md": makeMd({ id: "old-1", publishedAt: "2026-09-01T00:00:00+08:00" }, "旧公告"),
		}),
	);
	const { ok, errors, serialized } = build.buildFeedJson(dir);
	assert.equal(ok, true, String(errors));
	const parsed = JSON.parse(serialized);
	assert.equal(parsed.version, 1);
	assert.deepEqual(
		parsed.announcements.map((i) => i.id),
		["new-1", "old-1"],
	);
	assert.equal(parsed.announcements[0].body, "**新**公告");
});

test("buildFeedJson：源有错时不产出", () => {
	const dir = track(tmpDirWith({ "bad.md": makeMd({ level: "loud" }) }));
	const { ok, errors, feed, serialized } = build.buildFeedJson(dir);
	assert.equal(ok, false);
	assert.ok(errors.length > 0);
	assert.equal(feed, undefined);
	assert.equal(serialized, undefined);
});

test("生成的 feed 保持 AnnouncementItem 精确字段（服务端 schema 只接受这些）", () => {
	const dir = track(
		tmpDirWith({
			"a.md": makeMd({ minVersion: "0.7.4-beta", extraField: "typoField" }),
		}),
	);
	// typoField 必须是前端未知名：透传层只输出已知字段，防止笔误字段混进 feed
	const { ok, errors, feed } = build.buildFeedJson(dir);
	assert.equal(ok, true, String(errors));
	const item = feed.announcements[0];
	assert.deepEqual(Object.keys(item).sort(), ["body", "category", "effectiveUntil", "id", "level", "minVersion", "publishedAt", "title"]);
});
