/**
 * build-announcements.js —— 公告维护脚本（md → announcements.json）。
 *
 * 维护入口：announcements-md/*.md（每个公告一个文件，front matter + markdown 正文）。
 * 脚本负责：解析 front matter → 字段校验 → 排序 → 生成仓库根 announcements.json
 * （保持与 AnnouncementService 读取的 schema 完全一致，字段透传不做转换）。
 *
 * 用法：
 *   node scripts/build-announcements.js            # 校验并生成 announcements.json
 *   node scripts/build-announcements.js --check    # 只校验 + 断言 json 与 md 同步（CI 用）
 *
 * md 文件格式（front matter 为轻量 key: value，支持 # 注释行与引号包裹的值）：
 *   ---
 *   id: 2026-09-07-announcements-live   # 稳定唯一 id（发布后不可变更）
 *   title: 公告功能上线
 *   level: info                         # info | warn | critical
 *   category: notice                    # 可选通知/指南，缺省 notice（见下）
 *   publishedAt: 2026-09-07T00:00:00+08:00
 *   effectiveUntil: 2026-10-07T00:00:00+08:00
 *   minVersion: 0.7.4-beta              # 可选：仅向低于该版本的客户端展示
 *   ---
 *   正文（markdown，客户端详情视图经 sanitize 渲染；首尾空行会被剔除）
 *
 * category 说明（生命周期 × 打扰策略，与 shared/types/announcement.ts 对齐）：
 * - flash —— 临时通知（时点性）：系统维护/活动截止/一次性提示，读完即移除，TTL 建议短；
 * - notice —— 公告（正式广播）：版本发布/行为变更等，已读折叠进「已读归档」，TTL 建议数周~数月；
 * - guide —— 指南（常驻参考）：新手教程/功能说明，长期显示、不打扰；
 * - 缺省 = notice（兼容历史 md 文件）。
 */

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const MD_DIR = path.join(ROOT, "announcements-md");
const OUT_FILE = path.join(ROOT, "announcements.json");

/** 合法级别（与 shared/types/announcement.ts 的 AnnouncementLevel 对齐）。 */
const LEVELS = ["info", "warn", "critical"];
/** 合法类别（与 shared/types/announcement.ts 的 AnnouncementCategory 对齐；缺省 notice）。 */
const CATEGORIES = ["flash", "notice", "guide"];
/** 必填字段（缺失/为空即报错，不允许生成半成品公告）。 */
const REQUIRED_FIELDS = ["id", "title", "level", "publishedAt", "effectiveUntil"];
/** 可选字段（透传；给了必须是非空字符串）。 */
const OPTIONAL_FIELDS = ["minVersion", "category"];

/**
 * 拆分 front matter 与正文：首行必须为 `---`，第二个 `---` 行之前的行是元数据。
 * @returns {{ front: string, body: string, error: string | null }}
 */
function splitFrontMatter(source) {
	const lines = source.split(/\r?\n/);
	if (!lines[0].trim().startsWith("---")) {
		return { front: "", body: "", error: "缺少 front matter 起始行（文件首行必须是 ---）" };
	}
	let end = -1;
	for (let i = 1; i < lines.length; i++) {
		// 结束标记必须是整行 ---，避免误伤正文里的分隔线
		if (lines[i].trim() === "---") {
			end = i;
			break;
		}
	}
	if (end === -1) {
		return { front: "", body: "", error: "front matter 缺少结束行 ---" };
	}
	return {
		front: lines.slice(1, end).join("\n"),
		body: lines.slice(end + 1).join("\n"),
		error: null,
	};
}

/**
 * 解析 front matter 文本为字段表（轻量实现，不引入 yaml 依赖）。
 * 规则：key: value（只切第一个冒号，value 内的冒号原样保留，如发布时间）；
 * 整行 `#` 开头为注释；值可被单/双引号包裹（包裹符会被剥掉，内部不做转义）。
 */
function parseFrontMatter(text) {
	const fields = {};
	const errors = [];
	text.split(/\r?\n/).forEach((raw, idx) => {
		const trimmed = raw.trim();
		if (!trimmed || trimmed.startsWith("#")) return; // 空行与注释行跳过
		const colon = trimmed.indexOf(":");
		if (colon <= 0) {
			errors.push(`front matter 第 ${idx + 1} 行无法解析（应为 key: value）：${trimmed}`);
			return;
		}
		const key = trimmed.slice(0, colon).trim();
		let value = trimmed.slice(colon + 1).trim();
		// 去包裹引号（单/双引号）；值内含引号不做转义处理，建议避免
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		fields[key] = value;
	});
	return { fields, errors };
}

/**
 * 校验字段合法性，返回错误列表（空 = 通过）。
 * 边界：id 不允许含空白（渲染层用作去重 key，含空白会破坏稳定性）；
 * 日期必须可被 Date.parse 解析（ISO 8601 实践，时区号必须有，词典序即时间序）。
 */
function validateItem(fields, body) {
	const errors = [];
	for (const key of REQUIRED_FIELDS) {
		const value = fields[key];
		if (value === undefined || value.trim() === "") {
			errors.push(`缺少必填字段 ${key}`);
			continue; // 缺字段不重复报后续格式错误
		}
		if (key === "id" && /\s/.test(value)) {
			errors.push(`id 不允许包含空白字符：${JSON.stringify(value)}`);
		}
		if ((key === "publishedAt" || key === "effectiveUntil") && Number.isNaN(Date.parse(value))) {
			errors.push(`${key} 不是合法日期（应为 ISO 8601，如 2026-09-07T00:00:00+08:00）：${value}`);
		}
	}
	if (fields.level !== undefined && !LEVELS.includes(fields.level)) {
		errors.push(`level 必须是 ${LEVELS.join(" / ")} 之一，当前：${fields.level}`);
	}
	if (fields.category !== undefined && !CATEGORIES.includes(fields.category)) {
		errors.push(`category 必须是 ${CATEGORIES.join(" / ")} 之一，当前：${fields.category}`);
	}
	for (const key of OPTIONAL_FIELDS) {
		if (fields[key] !== undefined && fields[key].trim() === "") {
			errors.push(`可选字段 ${key} 给了空值（不需要则整行删除）`);
		}
	}
	if (!body.trim()) {
		errors.push("正文不能为空（front matter 之后需要 markdown 正文）");
	}
	return errors;
}

/**
 * 解析单个 md 文件为公告条目。
 * @returns {{ item: object | null, errors: string[] }} item 的字段与
 *   shared/types/announcement.ts 的 AnnouncementItem 一致；errors 已带文件名前缀。
 */
function parseAnnouncementMarkdown(filePath) {
	const fileName = path.basename(filePath);
	const source = fs.readFileSync(filePath, "utf8");
	const { front, body, error } = splitFrontMatter(source);
	if (error) return { item: null, errors: [`${fileName}: ${error}`] };

	const { fields, errors: fmErrors } = parseFrontMatter(front);
	if (fmErrors.length > 0) {
		return { item: null, errors: fmErrors.map((e) => `${fileName}: ${e}`) };
	}

	const errors = validateItem(fields, body.trim());
	if (errors.length > 0) {
		return { item: null, errors: errors.map((e) => `${fileName}: ${e}`) };
	}

	// 只透传已知字段：新字段必须先在共享类型与服务端 schema 明确后才允许出现，
	// 避免 md 里的笔误字段静默混进 feed
	const item = {
		id: fields.id,
		title: fields.title,
		body: body.trim(),
		level: fields.level,
		// 类别缺省 notice：旧 md 文件/历史 feed 无此字段，统一按正式广播处理（兼容历史）
		category: fields.category ?? "notice",
		publishedAt: fields.publishedAt,
		effectiveUntil: fields.effectiveUntil,
	};
	if (fields.minVersion !== undefined) item.minVersion = fields.minVersion;
	return { item, errors: [] };
}

/**
 * 扫描目录下所有 .md 文件并按发布规则汇总（id 全局唯一）为公告列表。
 * @returns {{ items: object[], errors: string[] }} items 未排序（排序交给 buildFeed）。
 */
function loadAnnouncementDir(dir) {
	if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
		return { items: [], errors: [`公告目录不存在：${dir}（首次使用请先创建并放入 .md 文件）`] };
	}
	const errors = [];
	const items = [];
	const seenIds = new Set();
	for (const fileName of fs.readdirSync(dir).sort()) {
		// README.md 是目录说明文件（介绍如何写公告），不是公告本体，显式跳过
		if (!fileName.endsWith(".md") || fileName === "README.md") continue;
		const { item, errors: fileErrors } = parseAnnouncementMarkdown(path.join(dir, fileName));
		errors.push(...fileErrors);
		if (!item) continue;
		if (seenIds.has(item.id)) {
			errors.push(`id 重复：${item.id}（发行规则要求稳定唯一，请改名其中一个文件）`);
			continue;
		}
		seenIds.add(item.id);
		items.push(item);
	}
	if (items.length === 0 && errors.length === 0) {
		errors.push(`目录下没有 .md 文件：${dir}`);
	}
	return { items, errors };
}

/**
 * 生成 feed：按发布时间倒序（新公告在前），同时间按 id 字典序保证输出稳定。
 * 结构必须与 shared/types/announcement.ts 的 AnnouncementFeed（version: 1）一致。
 */
function buildFeed(items) {
	const sorted = [...items].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	return { version: 1, announcements: sorted };
}

/** 序列化：2 空格缩进 + 尾换行（与现有 announcements.json 手写格式保持一致）。 */
function serializeFeed(feed) {
	return JSON.stringify(feed, null, 2) + "\n";
}

function main() {
	const checkOnly = process.argv.includes("--check");
	const { items, errors } = loadAnnouncementDir(MD_DIR);
	if (errors.length > 0) {
		for (const e of errors) console.error(`✗ ${e}`);
		console.error("公告生成中止：请先修正上面的错误。");
		process.exit(1);
	}
	const serialized = serializeFeed(buildFeed(items));

	if (checkOnly) {
		// CI 断言模式：json 必须与 md 源逐字节一致（含缩进/尾换行），防止手工改 json 漂移
		const existing = fs.existsSync(OUT_FILE) ? fs.readFileSync(OUT_FILE, "utf8") : null;
		if (existing !== serialized) {
			console.error(`✗ ${OUT_FILE} 与 announcements-md/ 不一致，请运行 node scripts/build-announcements.js 重新生成。`);
			process.exit(1);
		}
		console.log(`✓ ${items.length} 条公告，${OUT_FILE} 与 md 源一致。`);
		return;
	}

	fs.writeFileSync(OUT_FILE, serialized);
	console.log(`✓ 已生成 ${OUT_FILE}（${items.length} 条公告，来源 announcements-md/*.md）。`);
	console.log("发布提示：把 announcements-md/ 与 announcements.json 一起 commit 到 main 分支即可生效。");
}

module.exports = {
	splitFrontMatter,
	parseFrontMatter,
	parseAnnouncementMarkdown,
	loadAnnouncementDir,
	buildFeed,
	serializeFeed,
	buildFeedJson(sourceDir = MD_DIR, outFile = OUT_FILE) {
		// 便捷入口：main 与测试共用（sourceDir 可注入临时目录，outFile 可注入临时输出）
		const { items, errors } = loadAnnouncementDir(sourceDir);
		if (errors.length > 0) return { ok: false, errors };
		const feed = buildFeed(items);
		return { ok: true, feed, serialized: serializeFeed(feed) };
	},
	MD_DIR,
	OUT_FILE,
};

if (require.main === module) main();
