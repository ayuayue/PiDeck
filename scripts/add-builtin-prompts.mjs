/**
 * 将 PiDeck 曾内置的 prompt 模板写入商店数据库（xueprompts.db）。
 *
 * 背景：这批模板曾写死在 PromptManager.ts 的 BUILTIN_TEMPLATES（builtin://），
 * 2026-09-07 提交 02dc7953 整体移除；还原版 md 位于 docs/pi-prompt-templates/。
 * 本脚本把它们作为商店提示词插入，随应用分发，用户可在「提示词精选」页导入为 pi 模板。
 *
 * 用法: node scripts/add-builtin-prompts.mjs
 * 输入: docs/pi-prompt-templates/*.md（跳过 README.md）
 * 输出: resources/xueprompts.db（原地更新，可重复执行：INSERT OR REPLACE + 分类 count 重算）
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import initSqlJs from "sql.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SRC_DIR = join(ROOT, "docs", "pi-prompt-templates");
const DB_PATH = join(ROOT, "resources", "xueprompts.db");

/** 归入的商店分类（已存在的分类名，避免新建分类） */
const CATEGORY = "编程提示词";

/**
 * slug 覆盖映射：文件名 → 商店 slug。
 * 仅 test 需要改名：商店已有 slug='test' 的记录（xueprompt.com「测试提示词」），
 * 不能覆盖（用户可能已导入过）；test-cases 导入 pi 后命令为 /test-cases。
 */
const SLUG_OVERRIDES = { test: "test-cases" };

/** 商店展示标题（沿用现有「功能（分类）」命名风格） */
const TITLES = {
	fix: "修复 Bug 提示词（编程）",
	review: "代码审查提示词（编程）",
	test: "编写测试用例提示词（编程）",
	refactor: "代码重构提示词（编程）",
	doc: "代码文档注释提示词（编程）",
	explain: "代码解释提示词（编程）",
	commit: "生成提交信息提示词（编程）",
	"commit-own": "只提交自己改动提示词（编程）",
	"commit-split": "按功能拆分提交提示词（编程）",
	"pi-system": "查看 pi 系统提示词（编程）",
	"skill-discipline": "技能执行纪律提示词（编程）",
	"enhance-prompt": "提示词增强（编程）",
	"enhance-prompt-deep": "提示词深度增强（编程）",
};

/**
 * 中文描述，逐字取自 src/renderer/src/composerBehavior.ts 的
 * BUILTIN_PROMPT_DESC_CN（原 builtin:// 模板在 UI 上的官方中文描述），
 * 导入 pi 模板时会作为 frontmatter description。
 */
const DESCRIPTIONS = {
	review: "审查暂存的 Git 更改，检查 bug、安全问题和逻辑错误",
	test: "为函数或组件编写全面的测试用例",
	fix: "调试并修复问题，包含根因分析",
	refactor: "重构代码以提升可读性和可维护性",
	doc: "添加或改进文档和注释",
	explain: "用简洁的语言解释代码或架构",
	commit: "根据暂存更改生成约定式提交信息",
	"commit-own": "只提交自己修改的文件和代码（跳过无关改动）",
	"commit-split": "提交所有改动，按功能拆分为多个 commit",
	"pi-system": "查看 pi 的默认系统提示词（身份、工具、行为准则）",
	"skill-discipline": "技能执行纪律：何时及如何触发 agent 技能的规则",
	"enhance-prompt": "将需求草稿改写为更清晰、更具体、更可执行的提示词（保留原有意图，语言一致，不超过 800 字）",
	"enhance-prompt-deep": "将开放型需求实质性扩展为丰富、具体、可执行的提示词（代码/路径等精确内容原样保留，无长度限制）",
};

/** 剥离 markdown frontmatter（--- 包裹的元数据），只留正文；与渲染层 stripFrontmatter 同一规则 */
function stripFrontmatter(raw) {
	return raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

async function main() {
	if (!existsSync(DB_PATH)) {
		console.error(`数据库不存在: ${DB_PATH}`);
		process.exit(1);
	}

	const files = readdirSync(SRC_DIR)
		.filter((f) => f.endsWith(".md") && f !== "README.md")
		.sort();
	if (!files.length) {
		console.error(`模板目录为空: ${SRC_DIR}`);
		process.exit(1);
	}

	const SQL = await initSqlJs();
	const db = new SQL.Database(readFileSync(DB_PATH));

	db.run("BEGIN TRANSACTION");
	const insertStmt = db.prepare(
		`INSERT OR REPLACE INTO xueprompts (slug, url, title, category, content, description)
     VALUES (?, ?, ?, ?, ?, ?)`,
	);

	for (const file of files) {
		const templateName = file.replace(/\.md$/, "");
		const slug = SLUG_OVERRIDES[templateName] ?? templateName;
		const body = stripFrontmatter(readFileSync(join(SRC_DIR, file), "utf8"));
		// 与 compact-xueprompts.mjs 一致：content/description gzip 后存 BLOB
		insertStmt.run([slug, "", TITLES[templateName] ?? templateName, CATEGORY, gzipSync(body, { level: 9 }), gzipSync(DESCRIPTIONS[templateName] ?? templateName, { level: 9 })]);
		console.log(`已写入: ${slug} <- ${file} (${body.length} 字符正文)`);
	}
	insertStmt.free();

	// 分类 count 全量重算（不依赖本脚本的增量，保证可重复执行）
	db.run(
		`UPDATE xueprompt_categories SET count = (
       SELECT COUNT(*) FROM xueprompts WHERE xueprompts.category = xueprompt_categories.name
     )`,
	);
	db.run("COMMIT");

	const data = db.export();
	writeFileSync(DB_PATH, Buffer.from(data));
	db.close();

	console.log(`\n已更新: ${DB_PATH} (${(data.length / 1024).toFixed(1)} KB)`);
	console.log("提示: 商店分类 count 已重算，无需再跑 compact-xueprompts.mjs");
}

main().catch((err) => {
	console.error("写入失败:", err);
	process.exit(1);
});
