import { existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { app } from "electron";
import initSqlJs from "sql.js";
import { PromptManager } from "./PromptManager";
import type { WslEnvironment } from "../wsl/WslPaths";
import type {
	YaoPromptCategory,
	YaoPromptItem,
	YaoPromptListResult,
	YaoPromptDetailResult,
	PiPromptTemplateSummary,
} from "../../shared/types";

/**
 * 基于 SQLite 的 XuePrompt 提示词管理器。
 *
 * 数据来源：xueprompt.com，爬取约 4000 条中文提示词，
 * 预先通过 scripts/convert-xueprompts.mjs 转换为 SQLite（含 FTS3 全文搜索）。
 * 数据库文件打包在 resources/xueprompts.db。
 */
export class XuePromptManager {
	private readonly dbPath: string;
	private readonly promptManager: PromptManager;

	constructor(home?: string) {
		const base = app.isPackaged
			? process.resourcesPath
			: join(app.getAppPath(), "resources");
		this.dbPath = join(base, "xueprompts.db");
		this.promptManager = new PromptManager(home);
	}

	private sqlPromise: ReturnType<typeof initSqlJs> | null = null;

	/**
	 * 初始化 sql.js WASM，传入 locateFile 确保能找到 sql-wasm.wasm
	 *
	 * 打包后 sql-wasm.wasm 通过 asarUnpack 解压到
	 * app.asar.unpacked/node_modules/sql.js/dist/ 下，
	 * 不能从 asar 内加载 WASM 二进制。
	 */
	private async initSql(): Promise<import("sql.js").SqlJsStatic> {
		if (!this.sqlPromise) {
			this.sqlPromise = initSqlJs({
				locateFile: (file: string) => {
					if (app.isPackaged) {
						return join(
							process.resourcesPath,
							"app.asar.unpacked",
							"node_modules",
							"sql.js",
							"dist",
							file
						);
					}
					return join(app.getAppPath(), "node_modules", "sql.js", "dist", file);
				},
			});
		}
		return this.sqlPromise;
	}

	configureWsl(wsl: WslEnvironment | null) {
		this.promptManager.configureWsl(wsl);
	}

	/**
	 * 解压 BLOB 字段（gzip 压缩的 content/description）
	 */
	private blobToString(blob: any): string {
		if (!blob) return "";
		// sql.js 返回 BLOB 为 Uint8Array
		const buf = blob instanceof Uint8Array || ArrayBuffer.isView(blob)
			? Buffer.from(blob as Uint8Array)
			: Buffer.from(blob as number[]);
		try {
			return gunzipSync(buf).toString("utf8");
		} catch {
			// 兼容旧版未压缩数据
			return buf.toString("utf8");
		}
	}

	/**
	 * 把 SELECT slug, url, title, category, content, description 的一行映射为商店条目。
	 * 全量查询与分页/搜索查询共用同一映射，避免列顺序在两处漂移。
	 */
	private rowToYaoPromptItem(row: any[]): YaoPromptItem {
		return {
			slug: String(row[0] ?? ""),
			title: String(row[2] ?? ""),
			category: String(row[3] ?? ""),
			subcategory: "",
			tags: [],
			description: row[5] ? this.blobToString(row[5]) : "",
			path: String(row[0] ?? ""),
		};
	}

	/**
	 * 延迟初始化 sql.js（WASM 只需加载一次）
	 */
	private async getDb(): Promise<import("sql.js").Database> {
		const SQL = await this.initSql();

		if (!existsSync(this.dbPath)) {
			throw new Error(`XuePrompt 数据库不存在: ${this.dbPath}`);
		}
		const buffer = readFileSync(this.dbPath);
		return new SQL.Database(buffer);
	}

	/**
	 * 列出分类和提示词。
	 *
	 * 不传 opts 时保持向后兼容 — 返回全量分类和提示词。
	 * 传 opts 时支持分页查询：categories 始终返回全部分类，
	 * prompts 按 category/search 过滤并分页，同时返回 total 总数。
	 */
	async list(opts?: {
		category?: string;
		search?: string;
		page?: number;
		pageSize?: number;
	}): Promise<YaoPromptListResult> {
		const db = await this.getDb();
		try {
			// 始终查询全部分类（数据量小，分类栏需要）
			const catRows = db.exec(
				"SELECT slug, name, count FROM xueprompt_categories ORDER BY count DESC"
			);
			const categories: YaoPromptCategory[] = (
				catRows[0]?.values ?? []
			).map((row: any[]) => ({
				slug: String(row[0] ?? ""),
				name: String(row[1] ?? ""),
				count: Number(row[2] ?? 0),
			}));

			if (!opts) {
				// 向后兼容：全量查询
				const promptRows = db.exec(
					"SELECT slug, url, title, category, content, description FROM xueprompts ORDER BY category, title"
				);
				const prompts: YaoPromptItem[] = (promptRows[0]?.values ?? []).map((row: any[]) => this.rowToYaoPromptItem(row));
				return { categories, prompts, repoPath: this.dbPath };
			}

			// title 是明文 TEXT，可直接进 SQL；content / description 都是 gzip BLOB，
			// SQL 的 LIKE 对 BLOB 只做字节比较，中文关键词永远匹配不到（实测 description
			// LIKE 命中数恒为 0），所以带 search 时必须走应用层解压匹配。
			const conditions: string[] = [];
			const params: any[] = [];

			if (opts.category) {
				// xueprompts.category 存的是原始分类名（如 "营销/SEO提示词"），
				// opts.category 是分类的 slug（如 "营销-seo提示词"），
				// 通过子查询从 xueprompt_categories 拿到原始名再匹配。
				conditions.push("(category = ? OR category = (SELECT name FROM xueprompt_categories WHERE slug = ?))");
				params.push(opts.category, opts.category);
			}

			const page = Math.max(1, opts.page ?? 1);
			const pageSize = Math.max(1, Math.min(100, opts.pageSize ?? 20));

			const keyword = opts.search?.trim();
			if (keyword) {
				// 先按 category 粗筛（不含 text 条件），再在应用层解压匹配 title/description/content。
				// 数据量约 4000 条、全量解压约 4MB，仅搜索时触发一次，开销可接受；
				// 换来的是「正文里的词也能搜到」这个正确语义。
				const categoryClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
				const rows = db.exec(
					`SELECT slug, url, title, category, content, description FROM xueprompts ${categoryClause} ORDER BY category, title`,
					params
				);
				const needle = keyword.toLowerCase();
				const matched = (rows[0]?.values ?? []).filter((row: any[]) => {
					const title = String(row[2] ?? "");
					if (title.toLowerCase().includes(needle)) return true;
					// content / description 为 gzip BLOB，解压后按明文匹配
					if (row[5] && this.blobToString(row[5]).toLowerCase().includes(needle)) return true;
					if (row[4] && this.blobToString(row[4]).toLowerCase().includes(needle)) return true;
					return false;
				});
				const offset = (page - 1) * pageSize;
				const prompts = matched.slice(offset, offset + pageSize).map((row: any[]) => this.rowToYaoPromptItem(row));
				return { categories, prompts, repoPath: this.dbPath, total: matched.length, page, pageSize };
			}

			const whereClause = conditions.length > 0
				? `WHERE ${conditions.join(" AND ")}`
				: "";

			// 总数
			const countResult = db.exec(
				`SELECT COUNT(*) FROM xueprompts ${whereClause}`,
				params
			);
			const total = Number(countResult[0]?.values?.[0]?.[0] ?? 0);

			const offset = (page - 1) * pageSize;

			const promptRows = db.exec(
				`SELECT slug, url, title, category, content, description FROM xueprompts ${whereClause} ORDER BY category, title LIMIT ? OFFSET ?`,
				[...params, pageSize, offset]
			);
			const prompts: YaoPromptItem[] = (promptRows[0]?.values ?? []).map((row: any[]) => this.rowToYaoPromptItem(row));

			return { categories, prompts, repoPath: this.dbPath, total, page, pageSize };
		} finally {
			db.close();
		}
	}

	/**
	 * 获取单条提示词详情
	 */
	async detail(
		slug: string,
		_category: string
	): Promise<YaoPromptDetailResult | null> {
		const db = await this.getDb();
		try {
			const rows = db.exec(
				"SELECT title, content, description, url FROM xueprompts WHERE slug = ?",
				[slug]
			);
			if (!rows[0]?.values?.length) return null;

			const row = rows[0].values[0];
			const title = String(row[0] ?? "");
			const content = this.blobToString(row[1]);
			const description = this.blobToString(row[2]);
			const url = String(row[3] ?? "");

			// 拼接完整内容（含类 frontmatter 头）
			const fullContent = [
				"---",
				`title: ${title}`,
				`description: ${description}`,
				`source: xueprompt`,
				`url: ${url}`,
				"---",
				"",
				content,
			].join("\n");

			return {
				title,
				description,
				// content 字段就是可用的提示词文本
				promptContent: content,
				fullContent,
			};
		} finally {
			db.close();
		}
	}

	/**
	 * 导入到 pi 模板
	 */
	async importToPi(
		slug: string,
		category: string,
		projectPath?: string,
	): Promise<PiPromptTemplateSummary> {
		const detail = await this.detail(slug, category);
		if (!detail) throw new Error(`未找到提示词: ${slug}`);

		const name = slug
			.replace(/[^\p{L}\p{N}-]+/gu, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "")
			.toLowerCase();

		const tryCreate = async (
			tryName: string
		): Promise<PiPromptTemplateSummary> => {
			try {
				const input = {
					name: tryName,
					description: detail.description || detail.title,
				};
				return projectPath
					? await this.promptManager.createInProject(projectPath, input)
					: await this.promptManager.create(input);
			} catch {
				const match = tryName.match(/-(\d+)$/);
				const nextNum = match ? parseInt(match[1], 10) + 1 : 2;
				return tryCreate(
					tryName.replace(/-\d+$/, "") + "-" + nextNum
				);
			}
		};

		const summary = await tryCreate(name);
		const frontmatter = `---\ndescription: ${(detail.description || detail.title).replace(/[\\r\\n]+/g, " ")}\nsource: xueprompt\n---\n\n`;
		if (projectPath) {
			await this.promptManager.writeContentInProject(projectPath, summary.path, frontmatter + detail.promptContent);
		} else {
			await this.promptManager.writeContent(summary.path, frontmatter + detail.promptContent);
		}
		return summary;
	}
}
