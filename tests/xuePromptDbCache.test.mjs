/**
 * XuePromptManager 库实例缓存（2027-02 性能治理）。
 *
 * 契约：
 * 1. 同一 db 文件（size/mtime 未变）重复查询复用同一个 sql.js 实例——不再每次
 *    读整个 db 文件并重建库；
 * 2. 库文件被替换（size/mtime 变）后自动重建，查询结果跟着变（不返回陈旧数据）。
 *
 * 读盘次数用 fs 核心模块补丁观测：loadTsCommonJs 转译出的 CJS 每次调用都经
 * require("node:fs").readFileSync 属性访问，与测试侧 import 的是同一对象。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import initSqlJs from "sql.js";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// app.getAppPath() 决定 db 位置（非打包态 = <appPath>/resources/xueprompts.db），
// 用可变引用让每个用例指向自己的临时目录。
let appPathForTest = tmpdir();
const { XuePromptManager } = loadTsCommonJs("src/main/prompts/XuePromptManager.ts", {
	stubs: {
		electron: { app: { isPackaged: false, getAppPath: () => appPathForTest } },
		"../logging/sharedLogger": { getAppLogger: () => null },
	},
});

/** 造一个最小 xueprompts.db：分类表 + 一行提示词。 */
async function writeDb(path, title) {
	const SQL = await initSqlJs();
	const db = new SQL.Database();
	db.run("CREATE TABLE xueprompt_categories (slug TEXT, name TEXT, count INTEGER)");
	db.run("CREATE TABLE xueprompts (slug TEXT, url TEXT, title TEXT, category TEXT, content BLOB, description BLOB)");
	db.run("INSERT INTO xueprompt_categories VALUES ('writing', '写作', 1)");
	db.run("INSERT INTO xueprompts VALUES ('doc-summary', '', ?, 'writing', ?, ?)", [title, Buffer.from("内容"), Buffer.from("描述")]);
	const bytes = db.export();
	db.close();
	writeFileSync(path, Buffer.from(bytes));
}

test("同库文件重复查询复用实例（不重复读盘），文件替换后自动重建", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-xue-dbcache-"));
	const previousAppPath = appPathForTest;
	try {
		mkdirSync(join(root, "resources"), { recursive: true });
		const dbPath = join(root, "resources", "xueprompts.db");
		await writeDb(dbPath, "第一代标题");
		appPathForTest = root;
		const manager = new XuePromptManager(root);

		const first = await manager.list({ page: 1, pageSize: 10 });
		assert.equal(first.prompts.length, 1);
		assert.equal(first.prompts[0].title, "第一代标题");

		// 第二次查询与详情查询都不得再读库文件
		const realRead = fs.readFileSync;
		let dbReads = 0;
		fs.readFileSync = (target, ...rest) => {
			if (String(target) === dbPath) dbReads += 1;
			return realRead(target, ...rest);
		};
		try {
			await manager.list({ page: 1, pageSize: 10 });
			await manager.detail("doc-summary");
		} finally {
			fs.readFileSync = realRead;
		}
		assert.equal(dbReads, 0, "缓存命中时不得重新读库文件");

		// 换库（size/mtime 变）：自动重建并返回新内容
		await new Promise((resolve) => setTimeout(resolve, 20));
		await writeDb(dbPath, "第二代标题完全不同长度");
		const second = await manager.list({ page: 1, pageSize: 10 });
		assert.equal(second.prompts[0].title, "第二代标题完全不同长度", "库文件替换后必须重建实例");
	} finally {
		appPathForTest = previousAppPath;
		rmSync(root, { recursive: true, force: true });
	}
});

test("categoriesOnly：只返回分类栏，不取条目（商店首开快路径）", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-xue-catonly-"));
	const previousAppPath = appPathForTest;
	try {
		mkdirSync(join(root, "resources"), { recursive: true });
		const dbPath = join(root, "resources", "xueprompts.db");
		await writeDb(dbPath, "标题");
		appPathForTest = root;
		const manager = new XuePromptManager(root);

		const full = await manager.list({ page: 1, pageSize: 10 });
		const categoryOnly = await manager.list({ categoriesOnly: true });
		// 跨 vm realm 的数组原型不同，deepEqual 会误判：比长度即可
		assert.equal(categoryOnly.prompts.length, 0, "分类快路径不得返回条目");
		// 分类口径与带条目查询一致（同一 slug/name/count 集合）
		const signature = (categories) =>
			categories
				.map((item) => `${item.slug}|${item.name}|${item.count}`)
				.sort()
				.join(",");
		assert.equal(signature(categoryOnly.categories), signature(full.categories), "分类栏必须与全量查询一致");
		assert.equal(categoryOnly.dbState, "ready");
		assert.equal(categoryOnly.repoPath, dbPath);
	} finally {
		appPathForTest = previousAppPath;
		rmSync(root, { recursive: true, force: true });
	}
});

test("覆盖层非空 + 分页浏览：当前页描述回填正确（轻量投影不取全表 BLOB）", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-xue-light-"));
	const previousAppPath = appPathForTest;
	try {
		mkdirSync(join(root, "resources"), { recursive: true });
		mkdirSync(join(root, "overlay"), { recursive: true });
		const dbPath = join(root, "resources", "xueprompts.db");
		await writeDb(dbPath, "标题一");
		// 覆盖层存在 → 走合并分支（这是原先无条件下全表 BLOB 的分支）
		writeFileSync(join(root, "overlay", "doc-summary.md"), "---\ntitle: 覆盖标题\n---\n\n覆盖正文\n", "utf8");
		appPathForTest = root;
		const manager = new XuePromptManager(root, () => join(root, "overlay"));

		// 带分页、无搜索词 → 轻量投影路径
		const page = await manager.list({ page: 1, pageSize: 10 });
		assert.equal(page.prompts.length, 1);
		assert.equal(page.prompts[0].title, "覆盖标题", "覆盖层条目优先");
		assert.equal(page.prompts[0].description, "描述", "非覆盖层条目描述必须回填（库内原值）");
		// 覆盖层 md 没有 category frontmatter → 回退 db 行里的 category 列原值
		assert.equal(page.prompts[0].category, "writing");
		assert.ok((page.total ?? 0) >= 1);
	} finally {
		appPathForTest = previousAppPath;
		rmSync(root, { recursive: true, force: true });
	}
});
