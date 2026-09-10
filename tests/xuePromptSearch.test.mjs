import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * XuePromptManager.list 的搜索行为回归测试。
 *
 * 背景（2026-09-10 用户反馈「商店看不到提示词」）：
 * content / description 在库里都是 gzip BLOB，SQL 的 LIKE 对 BLOB 只做字节比较，
 * 中文关键词永远匹配不到。旧实现写的是 `title LIKE ? OR description LIKE ?`，
 * 实测 description 分支命中数恒为 0——等于搜索只对标题生效，正文/描述里的词全查不到。
 * 修复后改为「按 category 粗筛 + 应用层解压匹配 title/description/content」。
 *
 * 这里用真实的 resources/xueprompts.db（只读）断言真实数据上的行为，避免再用
 * 合成 fixture 掩盖 BLOB 编码差异。
 */

const testsDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(testsDir, "..");
const dbPath = join(projectRoot, "resources", "xueprompts.db");
const dbAvailable = existsSync(dbPath);

/** 以只读语义加载 XuePromptManager：stub 掉 electron 的 app 与 PromptManager 依赖。 */
function loadXuePromptManager() {
	return loadTsCommonJs("src/main/prompts/XuePromptManager.ts", {
		stubs: {
			electron: {
				app: {
					isPackaged: false,
					getAppPath: () => projectRoot,
				},
			},
			// PromptManager 只是被构造，不参与 list/detail；给一个空壳即可
			"./PromptManager": { PromptManager: class { configureWsl() {} } },
		},
	});
}

/** 解压 gzip BLOB，旧数据未压缩时原样返回（与生产 blobToString 同规则）。 */
function blobText(blob) {
	if (!blob) return "";
	const buf = Buffer.from(blob);
	try {
		return gunzipSync(buf).toString("utf8");
	} catch {
		return buf.toString("utf8");
	}
}

test("list 搜索命中 description（gzip BLOB），而非只命中 title", { skip: !dbAvailable }, async () => {
	const { XuePromptManager } = loadXuePromptManager();
	const manager = new XuePromptManager();

	// "调试并修复问题" 是内置模板 fix 的 description，不含在 title 里。
	// 旧实现（description LIKE BLOB）返回 0；修复后必须能搜到。
	const result = await manager.list({ category: "编程提示词", search: "调试并修复问题", page: 1, pageSize: 20 });
	assert.ok(result.total >= 1, `期望至少命中 1 条，实际 ${result.total}`);
	assert.ok(
		result.prompts.some((item) => item.slug === "fix"),
		`期望命中 slug=fix，实际命中 [${result.prompts.map((p) => p.slug).join(", ")}]`,
	);
});

test("list 搜索命中 content（gzip BLOB 正文）", { skip: !dbAvailable }, async () => {
	const { XuePromptManager } = loadXuePromptManager();
	const manager = new XuePromptManager();

	// 取正文：detail 按 slug 直查，不经过搜索（slug 本身不在搜索命中的字段里）
	const detail = await manager.detail("skill-discipline", "编程提示词");
	assert.ok(detail?.promptContent, "前置条件：详情应返回正文");

	// 取正文中一段 12 字的中文片段作为搜索词（跳过首尾避免边界空白）
	const body = detail.promptContent.replace(/\s+/gu, "");
	assert.ok(body.length > 24, "前置条件：正文应有足够长度");
	const probe = body.slice(8, 20);
	// 前置条件：该片段不能出现在标题里，否则测不出「搜到了正文」
	assert.ok(!detail.title.includes(probe), `前置条件：片段 "${probe}" 不应出现在标题里`);

	const result = await manager.list({ category: "编程提示词", search: probe, page: 1, pageSize: 50 });
	assert.ok(
		result.prompts.some((item) => item.slug === "skill-discipline"),
		`期望正文片段 "${probe}" 能命中 skill-discipline，实际命中 ${result.total} 条`,
	);
});

test("list 搜索大小写不敏感，且分页 total 基于过滤后集合", { skip: !dbAvailable }, async () => {
	const { XuePromptManager } = loadXuePromptManager();
	const manager = new XuePromptManager();

	const lower = await manager.list({ category: "编程提示词", search: "git", page: 1, pageSize: 5 });
	const upper = await manager.list({ category: "编程提示词", search: "GIT", page: 1, pageSize: 5 });
	assert.equal(lower.total, upper.total, "大小写不同的同一关键词应得到相同命中数");
	assert.ok(lower.total > 0, "期望 git 至少命中 1 条");

	// 第一页 pageSize=5 时最多返回 5 条，但 total 必须是完整命中数
	assert.ok(lower.prompts.length <= 5, "分页应生效");
});

test("list 不传 search 时保持 SQL 分页语义（total 为分类总数）", { skip: !dbAvailable }, async () => {
	const { XuePromptManager } = loadXuePromptManager();
	const manager = new XuePromptManager();

	const result = await manager.list({ category: "编程提示词", page: 1, pageSize: 20 });
	assert.equal(result.prompts.length, 20);
	assert.ok(result.total > 20, `「编程提示词」总数应大于单页容量，实际 ${result.total}`);

	// 分类计数与实际分组一致（防增量写入后忘记重算 count）
	const category = result.categories.find((item) => item.slug === "编程提示词");
	assert.ok(category, "分类栏应包含「编程提示词」");
	assert.equal(category.count, result.total, "分类 count 应与实际查询 total 一致");
});

test("内置模板均落在「编程提示词」分类且正文可解压", { skip: !dbAvailable }, async () => {
	const initSqlJs = (await import("sql.js")).default;
	const SQL = await initSqlJs();
	const db = new SQL.Database(new Uint8Array(readFileSync(dbPath)));
	const expected = [
		"fix", "review", "test-cases", "refactor", "doc", "explain",
		"commit", "commit-own", "commit-split", "pi-system", "skill-discipline",
	];
	try {
		for (const slug of expected) {
			const rows = db.exec("SELECT category, content FROM xueprompts WHERE slug = ?", [slug]);
			assert.ok(rows[0]?.values?.length, `内置模板缺失: ${slug}`);
			const [category, content] = rows[0].values[0];
			assert.equal(String(category), "编程提示词", `${slug} 分类错误`);
			assert.ok(blobText(content).trim().length > 0, `${slug} 正文解压为空`);
		}
	} finally {
		db.close();
	}
});
