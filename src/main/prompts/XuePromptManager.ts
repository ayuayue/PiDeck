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
	 */
	private async initSql(): Promise<import("sql.js").SqlJsStatic> {
		if (!this.sqlPromise) {
			this.sqlPromise = initSqlJs({
				locateFile: (file: string) => {
					if (app.isPackaged) {
						return join(process.resourcesPath, file);
					}
					return join(app.getAppPath(), "node_modules", "sql.js", "dist", file);
				},
			});
		}
		return this.sqlPromise;
	}

	configureWsl(distro: string | null, user?: string) {
		this.promptManager.configureWsl(distro, user);
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
	 * 列出所有分类和提示词
	 */
	async list(): Promise<YaoPromptListResult> {
		const db = await this.getDb();
		try {
			// 查询分类
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

			// 查询所有提示词
			const promptRows = db.exec(
				"SELECT slug, url, title, category, content, description FROM xueprompts ORDER BY category, title"
			);
			const prompts: YaoPromptItem[] = (
				promptRows[0]?.values ?? []
			).map((row: any[]) => ({
				slug: String(row[0] ?? ""),
				title: String(row[2] ?? ""),
				category: String(row[3] ?? ""),
				// xueprompt 数据没有 subcategory/tags 字段，返回空值
				subcategory: "",
				tags: [],
				description: row[5] ? this.blobToString(row[5]) : "",
				// SQLite 模式下 path 无意义，用 slug 填充兼容类型
				path: String(row[0] ?? ""),
			}));

			return { categories, prompts, repoPath: this.dbPath };
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
