import { existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { app } from "electron";
import initSqlJs from "sql.js";
import { PromptManager } from "./PromptManager";
import type {
	YaoPromptCategory,
	YaoPromptItem,
	YaoPromptListResult,
	YaoPromptDetailResult,
	PiPromptTemplateSummary,
} from "../../shared/types";
import type { WslEnvironment } from "../wsl/WslPaths";

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

	configureWsl(environment: WslEnvironment | null) {
		this.promptManager.configureWsl(environment);
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
				const prompts: YaoPromptItem[] = (
					promptRows[0]?.values ?? []
				).map((row: any[]) => ({
					slug: String(row[0] ?? ""),
					title: String(row[2] ?? ""),
					category: String(row[3] ?? ""),
					subcategory: "",
					tags: [],
					description: row[5] ? this.blobToString(row[5]) : "",
					path: String(row[0] ?? ""),
				}));
				return { categories, prompts, repoPath: this.dbPath };
			}

			// 分页查询：构建 WHERE 条件
			const conditions: string[] = [];
			const params: any[] = [];

			if (opts.category) {
				// xueprompts.category 存的是原始分类名（如 "营销/SEO提示词"），
				// opts.category 是分类的 slug（如 "营销-seo提示词"），
				// 通过子查询从 xueprompt_categories 拿到原始名再匹配。
				conditions.push("(category = ? OR category = (SELECT name FROM xueprompt_categories WHERE slug = ?))");
				params.push(opts.category, opts.category);
			}
			if (opts.search) {
				conditions.push("(title LIKE ? OR description LIKE ?)");
				const like = `%${opts.search}%`;
				params.push(like, like);
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

			// 分页
			const page = Math.max(1, opts.page ?? 1);
			const pageSize = Math.max(1, Math.min(100, opts.pageSize ?? 20));
			const offset = (page - 1) * pageSize;

			const promptRows = db.exec(
				`SELECT slug, url, title, category, content, description FROM xueprompts ${whereClause} ORDER BY category, title LIMIT ? OFFSET ?`,
				[...params, pageSize, offset]
			);
			const prompts: YaoPromptItem[] = (
				promptRows[0]?.values ?? []
			).map((row: any[]) => ({
				slug: String(row[0] ?? ""),
				title: String(row[2] ?? ""),
				category: String(row[3] ?? ""),
				subcategory: "",
				tags: [],
				description: row[5] ? this.blobToString(row[5]) : "",
				path: String(row[0] ?? ""),
			}));

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
		category: string
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
				return await this.promptManager.create({
					name: tryName,
					description: detail.description || detail.title,
				});
			} catch {
				const match = tryName.match(/-(\d+)$/);
				const nextNum = match ? parseInt(match[1], 10) + 1 : 2;
				return tryCreate(
					tryName.replace(/-\d+$/, "") + "-" + nextNum
				);
			}
		};

		const summary = await tryCreate(name);
		const frontmatter = `---\ndescription: ${(detail.description || detail.title).replace(/\n/g, " ")}\nsource: xueprompt\n---\n\n`;
		await this.promptManager.writeContent(
			summary.path,
			frontmatter + detail.promptContent
		);
		return summary;
	}
}
