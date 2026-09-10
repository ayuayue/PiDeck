/**
 * 校验商店数据库 resources/xueprompts.db 的数据完整性。
 *
 *   node scripts/check-xueprompts.mjs
 *
 * 背景（2026-09-10）：用户反馈「商店看不到新加的提示词」。排查发现两个独立问题：
 *   1. 运行时搜索用 SQL LIKE 匹配 gzip BLOB 字段，中文关键词恒匹配不到（已修 XuePromptManager）；
 *   2. 打包产物里的 resources/xueprompts.db 是数据更新前的旧副本，用户升级后仍看不到新内容。
 *
 * 本脚本负责盯住第 2 类问题：
 *   - db 必须存在，且能解出「编程提示词」分类；
 *   - 内置模板（docs/pi-prompt-templates/*.md 对应的 slug）必须全部落在 db 里；
 *   - 分类表的 count 必须与 xueprompts 实际分组数一致（防增量写入后忘记重算）。
 *
 * 退出码非 0 即视为失败，供打包流水线在 electron-builder 之前挡住过期数据。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import initSqlJs from "sql.js";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = join(scriptDir, "..");
const dbPath = join(root, "resources", "xueprompts.db");
const templateDir = join(root, "docs", "pi-prompt-templates");

/** 与 scripts/add-builtin-prompts.mjs 保持一致：test 文件名落库为 test-cases。 */
const SLUG_OVERRIDES = { test: "test-cases" };
const BUILTIN_CATEGORY = "编程提示词";

const failures = [];

if (!existsSync(dbPath)) {
	failures.push(`数据库不存在: ${dbPath}`);
} else {
	const SQL = await initSqlJs();
	const db = new SQL.Database(readFileSync(dbPath));

	/** gzip BLOB → 明文；旧数据未压缩时原样返回。 */
	const blobText = (blob) => {
		if (!blob) return "";
		const buf = Buffer.from(blob);
		try {
			return gunzipSync(buf).toString("utf8");
		} catch {
			return buf.toString("utf8");
		}
	};

	try {
		// 1) 分类表 count 与实际分组一致
		const catRows = db.exec("SELECT slug, name, count FROM xueprompt_categories");
		if (!catRows[0]?.values?.length) {
			failures.push("xueprompt_categories 为空");
		} else {
			const actualByCat = new Map();
			const grouped = db.exec("SELECT category, COUNT(*) FROM xueprompts GROUP BY category");
			for (const [category, count] of grouped[0]?.values ?? []) {
				actualByCat.set(String(category), Number(count));
			}
			for (const [slug, name, count] of catRows[0].values) {
				const actual = actualByCat.get(String(name)) ?? 0;
				if (Number(count) !== actual) {
					failures.push(`分类 count 不一致: ${slug} 声明 ${count}，实际 ${actual}`);
				}
			}
		}

		// 2) 内置模板必须全部落库，且正文可解压
		if (existsSync(templateDir)) {
			const files = readdirSync(templateDir).filter((f) => f.endsWith(".md") && f !== "README.md");
			for (const file of files) {
				const templateName = file.replace(/\.md$/, "");
				const slug = SLUG_OVERRIDES[templateName] ?? templateName;
				const row = db.exec(
					"SELECT slug, category, content FROM xueprompts WHERE slug = ?",
					[slug]
				);
				if (!row[0]?.values?.length) {
					failures.push(`内置模板缺失: ${slug}（来自 ${file}，期望分类 ${BUILTIN_CATEGORY}）`);
					continue;
				}
				const [, category, content] = row[0].values[0];
				if (String(category) !== BUILTIN_CATEGORY) {
					failures.push(`内置模板分类错误: ${slug} 属于 ${category}，期望 ${BUILTIN_CATEGORY}`);
				}
				if (!blobText(content).trim()) {
					failures.push(`内置模板正文解压为空: ${slug}`);
				}
			}
		}
	} catch (err) {
		failures.push(`查询数据库失败: ${err instanceof Error ? err.message : String(err)}`);
	} finally {
		db.close();
	}
}

if (failures.length > 0) {
	console.error("✗ xueprompts.db 校验未通过：");
	for (const item of failures) console.error(`  - ${item}`);
	console.error("\n修复：跑 `node scripts/add-builtin-prompts.mjs` 重新写入内置模板，再重新打包。");
	process.exit(1);
}

console.log("✓ xueprompts.db 校验通过：分类计数一致，内置模板齐全。");
