import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { app } from "electron";
import initSqlJs from "sql.js";
import { PromptManager } from "./PromptManager";
import type { XueIndexService, XueIndexOverlayEntry } from "./XueIndexService";
import type { XuePromptDbStore } from "./XuePromptDbStore";
import type { WslEnvironment } from "../wsl/WslPaths";
import type { YaoPromptCategory, YaoPromptItem, YaoPromptListResult, YaoPromptDetailResult, PiPromptTemplateSummary, YaoPromptDbState } from "../../shared/types";

/** 覆盖层模板条目（官方模板热更新 md，正文为明文、无需解压）。 */
type OverlayPrompt = {
	/** frontmatter 可选的 title/description/category；缺省时回退 db 同名条目的值。 */
	title?: string;
	description?: string;
	category?: string;
	content: string;
};

/**
 * 基于 SQLite 的 XuePrompt 提示词管理器。
 *
 * 数据来源：xueprompt.com，爬取约 4000 条中文提示词，
 * 预先通过 scripts/convert-xueprompts.mjs 转换为 SQLite。
 * 检索通道（按优先级）：
 *   1. Go sidecar（XueIndexService，常驻进程内存检索，支持中文搜索）——deps 注入时启用；
 *   2. sql.js WASM（逐次全库加载，语义完全相同，作为 sidecar 缺失/失败时的兜底）。
 * db 来源（deps.dbStore 注入时）：userData 缓存（远程拉取）> 仓库 resources 副本；
 * 未注入 deps 时维持旧形态（固定 resources/xueprompts.db），保证单测零改动。
 */
export class XuePromptManager {
	private readonly dbPath: string;
	private readonly promptManager: PromptManager;
	/**
	 * 官方模板覆盖层目录提供器：热更新（PromptStoreUpdater）把远端有差异的模板写进
	 * userData 覆盖层后，查询侧实时取目录路径叠加显示，写入即见无需重启。
	 * 每次查询现取（覆盖层内容很少、读取开销可忽略），避免缓存失效时序问题。
	 */
	private readonly overlayDirProvider: () => string | null;
	/** 检索通道依赖（装配层注入；缺省走纯 sql.js 旧路径）。 */
	private readonly deps: { dbStore?: XuePromptDbStore; xueIndex?: XueIndexService };

	constructor(home?: string, overlayDirProvider: () => string | null = () => null, deps: { dbStore?: XuePromptDbStore; xueIndex?: XueIndexService } = {}) {
		const base = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "resources");
		this.dbPath = join(base, "xueprompts.db");
		this.promptManager = new PromptManager(home);
		this.overlayDirProvider = overlayDirProvider;
		this.deps = deps;
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
						return join(process.resourcesPath, "app.asar.unpacked", "node_modules", "sql.js", "dist", file);
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
	private blobToString(blob: unknown): string {
		if (!blob) return "";
		// sql.js 返回 BLOB 为 Uint8Array；两类收窄都不是 any 透传，非视图非数组的值落进空 Buffer 由 gunzip 失败兜底
		const buf = blob instanceof Uint8Array || ArrayBuffer.isView(blob) ? Buffer.from(blob as Uint8Array) : Buffer.from(Array.isArray(blob) ? (blob as number[]) : []);
		try {
			return gunzipSync(buf).toString("utf8");
		} catch {
			// 兼容旧版未压缩数据
			return buf.toString("utf8");
		}
	}

	/** 覆盖层模板条目（官方模板热更新 md，正文为明文、无需解压）。 */
	private overlayPromptOf(raw: string): OverlayPrompt {
		const frontmatter = this.parseOverlayFrontmatter(raw);
		// 与 scripts/add-builtin-prompts.mjs 的 stripFrontmatter 同一规则：只取正文，含 frontmatter 时去掉
		const content = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
		return { ...frontmatter, content };
	}
	/**
	 * 读取官方模板覆盖层（PromptStoreUpdater 热更新落盘目录）。
	 * 每次查询实时读：覆盖层只有几个 md 文件、开销可忽略，且避免「更新/还原后缓存不过期」的时序问题。
	 * 返回 slug → 条目 的映射；无覆盖层时返回空 Map（走纯 db 路径，零回归）。
	 */
	private readOverlayPrompts(): Map<string, OverlayPrompt> {
		const dir = this.overlayDirProvider();
		if (!dir || !existsSync(dir)) return new Map();
		const result = new Map<string, OverlayPrompt>();
		for (const name of readdirSync(dir)) {
			if (!name.endsWith(".md")) continue;
			try {
				const raw = readFileSync(join(dir, name), "utf8");
				const frontmatter = this.parseOverlayFrontmatter(raw);
				// 与 scripts/add-builtin-prompts.mjs 的 stripFrontmatter 同一规则：只取正文，含 frontmatter 时去掉
				const content = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
				result.set(name.slice(0, -3), { ...frontmatter, content });
			} catch {
				// 单个文件解析失败不影响其它模板（校验由更新器写盘前完成，这里只是兜底）
			}
		}
		return result;
	}

	/** 解析覆盖层 md 的 frontmatter（key: value 形式），非法行忽略。 */
	private parseOverlayFrontmatter(raw: string): { title?: string; description?: string; category?: string } {
		const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
		if (!match) return {};
		const result: { title?: string; description?: string; category?: string } = {};
		for (const line of match[1].split(/\r?\n/)) {
			const index = line.indexOf(":");
			if (index === -1) continue;
			const key = line.slice(0, index).trim();
			const value = line
				.slice(index + 1)
				.trim()
				.replace(/^['"]|['"]$/g, "");
			if (key === "title" || key === "description" || key === "category") {
				(result as Record<string, string>)[key] = value;
			}
		}
		return result;
	}

	/**
	 * 把 SELECT slug, url, title, category, content, description 的一行映射为商店条目。
	 * 全量查询与分页/搜索查询共用同一映射，避免列顺序在两处漂移。
	 */
	private rowToYaoPromptItem(row: unknown[]): YaoPromptItem {
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
	/**
	 * 已打开的 sql.js 库实例缓存（2027-02 性能审计）。
	 *
	 * 原先每次 list()/detail() 都 readFileSync 整个 db（实测 4.34MB）+ 全量重建
	 * sql.js 库（约 5-6ms），用完即 close。商店每次翻页、换分类、点预览都付一遍，
	 * 且全在主进程同步路径上。库文件是不可变快照（远程下载/缓存替换走整文件替换），
	 * 用 (size, mtimeMs) 判据复用实例：文件被换掉时自动重建并释放旧实例。
	 * 只做 exec 只读查询，复用实例无状态污染风险（sql.js 单线程同步执行）。
	 */
	private dbCache: { key: string; db: import("sql.js").Database } | null = null;

	/** 释放缓存的库实例（文件变化重建时 / 测试隔离用）。 */
	releaseDbCache(): void {
		const cached = this.dbCache;
		this.dbCache = null;
		if (!cached) return;
		try {
			cached.db.close();
		} catch {
			// 已关闭/内部状态异常：忽略，缓存已置空
		}
	}

	private async getDb(dbPath: string = this.dbPath): Promise<import("sql.js").Database> {
		const SQL = await this.initSql();

		if (!existsSync(dbPath)) {
			throw new Error(`XuePrompt 数据库不存在: ${dbPath}`);
		}
		const info = statSync(dbPath);
		const key = `${dbPath}|${info.size}|${info.mtimeMs}`;
		if (this.dbCache?.key === key) return this.dbCache.db;
		this.releaseDbCache();
		const buffer = readFileSync(dbPath);
		const db = new SQL.Database(buffer);
		this.dbCache = { key, db };
		return db;
	}

	/**
	 * 解析当前可用 db：注入 dbStore 时走远程缓存链（惰性 ensureReady，含 TTL 节流），
	 * 返回 null 表示无可用 db（远程拉取中/失败），调用方返回空态结果让渲染层显示进度/重试。
	 */
	private async resolveDb(): Promise<{ path: string | null; state: YaoPromptDbState }> {
		const dbStore = this.deps.dbStore;
		if (!dbStore) {
			return { path: this.dbPath, state: "ready" };
		}
		const state = await dbStore.ensureReady();
		if (state.state === "ready") return { path: state.path, state: "ready" };
		return { path: null, state: state.state };
	}

	/** 空态结果（db 未就绪）：渲染层按 dbState 显示下载进度/重试。 */
	private emptyListResult(state: YaoPromptDbState): YaoPromptListResult {
		return { categories: [], prompts: [], repoPath: "", dbState: state };
	}

	/** 把覆盖层 Map 转成 sidecar 协议条目（无覆盖层时传空数组，Go 侧走纯 db 路径）。 */
	private overlayEntriesOf(overlay: Map<string, OverlayPrompt>): XueIndexOverlayEntry[] {
		return Array.from(overlay, ([slug, op]) => ({ slug, title: op.title, description: op.description, category: op.category, content: op.content }));
	}

	/**
	 * 列出分类和提示词。
	 *
	 * 不传 opts 时保持向后兼容 — 返回全量分类和提示词。
	 * 传 opts 时支持分页查询：categories 始终返回全部分类，
	 * prompts 按 category/search 过滤并分页，同时返回 total 总数。
	 */
	async list(opts?: { category?: string; search?: string; page?: number; pageSize?: number; categoriesOnly?: boolean }): Promise<YaoPromptListResult> {
		const { path: dbPath, state } = await this.resolveDb();
		if (!dbPath) return this.emptyListResult(state);

		// ── 分类快路径（2027-02 性能审计）──
		// 商店首次打开只为渲染分类 chip 调 list()（无参），原先走「无参 = 全量」：
		// 主进程要把 4012 行连 description BLOB 全取回、逐条 gunzip 描述，再经 IPC
		// 传一份 ≈0.9MB 的 JSON 给渲染层，而渲染层拿到后只留 categories。
		// 这里直接只查分类表 + overlay 分类，条目一律不取。
		if (opts?.categoriesOnly) {
			return this.listCategoriesOnly(dbPath);
		}

		// ── 通道 1：Go sidecar（常驻内存检索，支持中文搜索；失败自动降级）──
		// 覆盖层只读一次（2027-02 性能治理）：原先 sidecar 分支与 sql.js 合并分支各读一遍
		// （readdirSync + 逐 md readFileSync）。写盘后下一次请求自然重读，不引入缓存。
		const overlay = this.readOverlayPrompts();
		const xueIndex = this.deps.xueIndex;
		if (xueIndex) {
			const overlayEntries = this.overlayEntriesOf(overlay);
			const result = await xueIndex.list(dbPath, { category: opts?.category, search: opts?.search, page: opts?.page, pageSize: opts?.pageSize, overlay: overlayEntries });
			if (result.ok) {
				return { ...result.value, repoPath: dbPath, dbState: "ready" };
			}
			// 降级不报错：sidecar 缺失（贡献者未构建）/超时都静默走 sql.js，商店始终可用
		}

		// ── 通道 2：sql.js 兑底（语义与 Go 完全一致，见 native/xue-index/store.go 对齐注释）──
		const db = await this.getDb(dbPath);
		try {
			// 始终查询全部分类（数据量小，分类栏需要）
			const catRows = db.exec("SELECT slug, name, count FROM xueprompt_categories ORDER BY count DESC");
			const categories: YaoPromptCategory[] = (catRows[0]?.values ?? []).map((row) => ({
				slug: String(row[0] ?? ""),
				name: String(row[1] ?? ""),
				count: Number(row[2] ?? 0),
			}));

			if (overlay.size === 0) {
				return this.listFromDbOnly(db, categories, dbPath, opts);
			}

			// ── 有官方模板覆盖层：db 全量取回后与 overlay 合并，再统一排序/分页/搜索 ──
			// 原因：overlay 条目可能覆盖、新增、改分类，SQL 的 LIMIT/OFFSET 会因条目插入而错位，
			// 全量合并后用同一套应用层逻辑处理才能保证 total 与页码准确。
			const conditions: string[] = [];
			const params: string[] = [];
			if (opts?.category) {
				conditions.push("(category = ? OR category = (SELECT name FROM xueprompt_categories WHERE slug = ?))");
				params.push(opts.category, opts.category);
			}
			const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
			// 轻量投影（2027-02 性能审计）：覆盖层非空时原实现无条件下「全表 + content/description
			// 两列 BLOB」（实测 4012 行 ≈94ms 取回 + 49ms 逐条 gunzip≈150ms 同步 CPU/次），
			// 而纯浏览（带分页、无搜索词）只需要展示当前页的描述。此时代码先只取
			// slug/url/title/category 做合并/过滤/排序/切片，再只为当前页条目回填描述。
			// 有关键词（搜索要匹配正文与描述）或调用方要全量形态时仍取全列。
			const keywordForQuery = opts?.search?.trim();
			const lightProjection = Boolean(opts) && !keywordForQuery;
			const columns = lightProjection ? "slug, url, title, category" : "slug, url, title, category, content, description";
			const rows = db.exec(`SELECT ${columns} FROM xueprompts ${whereClause} ORDER BY category, title`, params);

			// slug → 条目 合并表：overlay 优先（title/category 缺省时回退 db 同名值，
			// 保证商店表格显示仍是友好中文标题而非文件名）
			const bySlug = new Map<string, { item: YaoPromptItem; rawContent?: unknown; rawDesc?: unknown; overlayContent?: string }>();
			for (const row of rows[0]?.values ?? []) {
				const slug = String(row[0] ?? "");
				bySlug.set(slug, {
					item: this.rowToYaoPromptItem(row),
					rawContent: row[4],
					rawDesc: row[5],
				});
			}
			for (const [slug, op] of overlay) {
				const base = bySlug.get(slug);
				bySlug.set(slug, {
					item: {
						slug,
						title: op.title ?? base?.item.title ?? slug,
						category: op.category ?? base?.item.category ?? "编程提示词",
						subcategory: "",
						tags: [],
						description: op.description ?? (base ? this.blobToString(base.rawDesc!) : ""),
						path: slug,
					},
					overlayContent: op.content,
				});
			}

			// category 过滤：overlay 条目用「分类名或 slug」宽容匹配
			const categoryName = opts?.category ? (categories.find((c) => c.slug === opts.category)?.name ?? opts.category) : null;
			let all = Array.from(bySlug.values());
			if (categoryName) {
				all = all.filter((e) => e.item.category === categoryName || e.item.category === opts!.category);
			}

			// 搜索：应用层明文匹配（overlay 内容本来就是明文；db 的 BLOB 解压后匹配）
			const keyword = opts?.search?.trim().toLowerCase();
			if (keyword) {
				all = all.filter((e) => {
					const { item } = e;
					if (item.title.toLowerCase().includes(keyword)) return true;
					if (item.description.toLowerCase().includes(keyword)) return true;
					if (e.overlayContent?.toLowerCase().includes(keyword)) return true;
					if (e.rawContent && this.blobToString(e.rawContent).toLowerCase().includes(keyword)) return true;
					return false;
				});
			}

			// 与 SQL 一致的排序（category, title 按 Unicode 码点）
			all.sort((a, b) => {
				const c = a.item.category < b.item.category ? -1 : a.item.category > b.item.category ? 1 : 0;
				if (c !== 0) return c;
				return a.item.title < b.item.title ? -1 : a.item.title > b.item.title ? 1 : 0;
			});

			// 分类栏：db 分类 + overlay 新增分类，count 按合并后可见条数重算
			const mergedCategories = this.mergeCategories(
				categories,
				all.map((e) => e.item.category),
			);

			if (!opts) {
				return { categories: mergedCategories, prompts: all.map((e) => e.item), repoPath: dbPath, dbState: "ready" };
			}

			const page = Math.max(1, opts.page ?? 1);
			const pageSize = Math.max(1, Math.min(100, opts.pageSize ?? 20));
			const offset = (page - 1) * pageSize;
			const prompts = all.slice(offset, offset + pageSize).map((e) => e.item);
			// 轻量投影时描述还没取：只为当前页里「非覆盖层」的条目一次回填（≤pageSize 行）
			if (lightProjection) this.backfillDescriptions(db, prompts);
			return { categories: mergedCategories, prompts, repoPath: dbPath, dbState: "ready", total: all.length, page, pageSize };
		} finally {
			// 库实例由 getDb 的 (size,mtime) 缓存托管，不在这里关闭（2027-02 性能治理）
		}
	}

	/**
	 * 无覆盖层时的原 db 查询路径（保持历史行为与性能，分页走 SQL LIMIT/OFFSET）。
	 */
	private async listFromDbOnly(db: import("sql.js").Database, categories: YaoPromptCategory[], dbPath: string, opts?: { category?: string; search?: string; page?: number; pageSize?: number }): Promise<YaoPromptListResult> {
		if (!opts) {
			// 向后兼容：全量查询
			const promptRows = db.exec("SELECT slug, url, title, category, content, description FROM xueprompts ORDER BY category, title");
			const prompts: YaoPromptItem[] = (promptRows[0]?.values ?? []).map((row: unknown[]) => this.rowToYaoPromptItem(row));
			return { categories, prompts, repoPath: dbPath, dbState: "ready" };
		}

		// title 是明文 TEXT，可直接进 SQL；content / description 都是 gzip BLOB，
		// SQL 的 LIKE 对 BLOB 只做字节比较，中文关键词永远匹配不到（实测 description
		// LIKE 命中数恒为 0），所以带 search 时必须走应用层解压匹配。
		const conditions: string[] = [];
		const params: string[] = [];

		if (opts.category) {
			conditions.push("(category = ? OR category = (SELECT name FROM xueprompt_categories WHERE slug = ?))");
			params.push(opts.category, opts.category);
		}

		const page = Math.max(1, opts.page ?? 1);
		const pageSize = Math.max(1, Math.min(100, opts.pageSize ?? 20));

		const keyword = opts.search?.trim();
		if (keyword) {
			const categoryClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
			const rows = db.exec(`SELECT slug, url, title, category, content, description FROM xueprompts ${categoryClause} ORDER BY category, title`, params);
			const needle = keyword.toLowerCase();
			const matched = (rows[0]?.values ?? []).filter((row: unknown[]) => {
				const title = String(row[2] ?? "");
				if (title.toLowerCase().includes(needle)) return true;
				if (row[5] && this.blobToString(row[5]).toLowerCase().includes(needle)) return true;
				if (row[4] && this.blobToString(row[4]).toLowerCase().includes(needle)) return true;
				return false;
			});
			const offset = (page - 1) * pageSize;
			const prompts = matched.slice(offset, offset + pageSize).map((row: unknown[]) => this.rowToYaoPromptItem(row));
			return { categories, prompts, repoPath: dbPath, dbState: "ready", total: matched.length, page, pageSize };
		}

		const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

		const countResult = db.exec(`SELECT COUNT(*) FROM xueprompts ${whereClause}`, params);
		const total = Number(countResult[0]?.values?.[0]?.[0] ?? 0);

		const offset = (page - 1) * pageSize;

		const promptRows = db.exec(`SELECT slug, url, title, category, content, description FROM xueprompts ${whereClause} ORDER BY category, title LIMIT ? OFFSET ?`, [...params, pageSize, offset]);
		const prompts: YaoPromptItem[] = (promptRows[0]?.values ?? []).map((row: unknown[]) => this.rowToYaoPromptItem(row));

		return { categories, prompts, repoPath: dbPath, dbState: "ready", total, page, pageSize };
	}

	/**
	 * 为当前页条目回填描述（2027-02 性能审计配套）。
	 *
	 * 轻量投影只取 slug/url/title/category，描述（gzip BLOB）留到切片后再按需解码：
	 * 一页最多 20-100 行，用一条 IN 查询取回，替代原先「全表 4012 行 BLOB + 逐条 gunzip」。
	 * 覆盖层条目自带明文描述，不查库。
	 */
	private backfillDescriptions(db: import("sql.js").Database, prompts: YaoPromptItem[]): void {
		// 判据是「描述仍为空」而不是「不在覆盖层」：覆盖层 md 常常只有正文、没有 description
		// frontmatter，此时语义上要回退库内描述（与重路径 base.rawDesc 回退一致）。
		const wanted = prompts.filter((item) => item.description === "").map((item) => item.slug);
		if (wanted.length === 0) return;
		const placeholders = wanted.map(() => "?").join(",");
		const rows = db.exec(`SELECT slug, description FROM xueprompts WHERE slug IN (${placeholders})`, wanted);
		const descriptionBySlug = new Map<string, string>();
		for (const row of rows[0]?.values ?? []) {
			descriptionBySlug.set(String(row[0] ?? ""), row[1] ? this.blobToString(row[1]) : "");
		}
		for (const item of prompts) {
			const description = descriptionBySlug.get(item.slug);
			if (description !== undefined) item.description = description;
		}
	}

	/**
	 * 只取分类栏（2027-02 性能审计）。
	 *
	 * 商店首次打开只需要 categories：这里只跑两条轻查询（分类表 + 按分类聚合计数），
	 * 不取 content/description 两列 BLOB，因此不需要逐条 gunzip；overlay 引入的新分类
	 * 用覆盖层自身条目补齐，与合并分支 mergeCategories 的重算口径一致。
	 */
	private async listCategoriesOnly(dbPath: string): Promise<YaoPromptListResult> {
		const db = await this.getDb(dbPath);
		const catRows = db.exec("SELECT slug, name, count FROM xueprompt_categories ORDER BY count DESC");
		const categories: YaoPromptCategory[] = (catRows[0]?.values ?? []).map((row) => ({
			slug: String(row[0] ?? ""),
			name: String(row[1] ?? ""),
			count: Number(row[2] ?? 0),
		}));
		const overlay = this.readOverlayPrompts();
		if (overlay.size === 0) {
			return { categories, prompts: [], repoPath: dbPath, dbState: "ready" };
		}
		// 按分类名聚合（只读 category 列，不碰 BLOB）：覆盖层条目可能改分类/新增分类
		const grouped = db.exec("SELECT category, COUNT(*) FROM xueprompts GROUP BY category");
		const visibleCategories: string[] = [];
		for (const row of grouped[0]?.values ?? []) {
			const name = String(row[0] ?? "");
			const count = Number(row[1] ?? 0);
			for (let index = 0; index < count; index += 1) visibleCategories.push(name);
		}
		for (const entry of overlay.values()) {
			// 覆盖层条目可能改分类/新增分类：分类名直接进可见集合，交给 mergeCategories 统一重算
			if (entry.category) visibleCategories.push(entry.category);
		}
		return { categories: this.mergeCategories(categories, visibleCategories), prompts: [], repoPath: dbPath, dbState: "ready" };
	}

	/**
	 * 合并分类栏：保留 db 全部分类，叠加覆盖层引入的新分类；
	 * count 用覆盖层可见分类重算（覆盖不改变条数，新增分类才计入）。
	 */
	private mergeCategories(dbCategories: YaoPromptCategory[], visibleCategories: string[]): YaoPromptCategory[] {
		const countBy = new Map<string, number>();
		for (const name of visibleCategories) {
			countBy.set(name, (countBy.get(name) ?? 0) + 1);
		}
		const result: YaoPromptCategory[] = dbCategories.map((c) => ({
			...c,
			count: countBy.get(c.name) ?? c.count,
		}));
		// 覆盖层引入的全新分类：slug 规则与 scripts/convert-xueprompts.mjs 保持一致
		const existing = new Set(dbCategories.map((c) => c.name));
		for (const [name, count] of countBy) {
			if (existing.has(name)) continue;
			const slug = name
				.replace(/[^\w\u4e00-\u9fff]/g, "-")
				.replace(/-+/g, "-")
				.replace(/^-|-$/g, "")
				.toLowerCase();
			result.push({ slug, name, count });
		}
		result.sort((a, b) => b.count - a.count);
		return result;
	}

	/**
	 * 获取单条提示词详情（覆盖层模板优先：官方模板热更新后，商店详情立即显示新正文）
	 */
	async detail(slug: string, category: string): Promise<YaoPromptDetailResult | null> {
		const { path: dbPath } = await this.resolveDb();
		// 详情由列表进入：列表有数据即 db 已就绪；db 不可用（极小概率窗口，如换库重启间隙）直接未命中
		if (!dbPath) return null;
		const overlay = this.readOverlayPrompts().get(slug);
		if (overlay) {
			// overlay 命中：正文用覆盖层，标题/描述缺省时回退 db 同名条目（保持商店观感一致）。
			// 优先 Go 通道取回退字段，不可用再 sql.js，两路字段同构
			const xueIndex = this.deps.xueIndex;
			if (xueIndex) {
				const doc = await xueIndex.get(dbPath, slug);
				if (doc.ok) {
					return this.overlayDetailOf(overlay, doc.value ? { title: doc.value.title, url: doc.value.url, description: doc.value.description } : null, slug);
				}
			}
			const db = await this.getDb(dbPath);
			try {
				const rows = db.exec("SELECT title, description, url FROM xueprompts WHERE slug = ?", [slug]);
				const dbRow = rows[0]?.values?.[0];
				return this.overlayDetailOf(overlay, dbRow ? { title: String(dbRow[0] ?? ""), description: this.blobToString(dbRow[1]), url: String(dbRow[2] ?? "") } : null, slug);
			} finally {
				// 库实例由 getDb 缓存托管（同上），不在这里关闭
			}
		}

		const xueIndex = this.deps.xueIndex;
		if (xueIndex) {
			const doc = await xueIndex.get(dbPath, slug);
			if (doc.ok) {
				if (!doc.value) return null;
				const { title, description, content, url } = doc.value;
				const fullContent = ["---", `title: ${title}`, `description: ${description}`, `source: xueprompt`, `url: ${url}`, "---", "", content].join("\n");
				return { title, description, promptContent: content, fullContent };
			}
		}

		const db = await this.getDb(dbPath);
		try {
			const rows = db.exec("SELECT title, content, description, url FROM xueprompts WHERE slug = ?", [slug]);
			if (!rows[0]?.values?.length) return null;

			const row = rows[0].values[0];
			const title = String(row[0] ?? "");
			const content = this.blobToString(row[1]);
			const description = this.blobToString(row[2]);
			const url = String(row[3] ?? "");

			// 拼接完整内容（含类 frontmatter 头）
			const fullContent = ["---", `title: ${title}`, `description: ${description}`, `source: xueprompt`, `url: ${url}`, "---", "", content].join("\n");

			return {
				title,
				description,
				// content 字段就是可用的提示词文本
				promptContent: content,
				fullContent,
			};
		} finally {
			// 库实例由 getDb 的 (size,mtime) 缓存托管，不在这里关闭（2027-02 性能治理）
		}
	}

	/** overlay 命中时的详情组装（db 回退字段由调用方提供，Go/sql.js 两通道同构）。 */
	private overlayDetailOf(overlay: OverlayPrompt, dbDoc: { title: string; description: string; url: string } | null, slug: string): YaoPromptDetailResult {
		// 回退链：overlay 显式 title > db 同名 title > slug 文件名（原实现 db 无同名时得空串，回 slug 更可读且两通道一致）
		const title = overlay.title ?? (dbDoc?.title || slug);
		const description = overlay.description ?? (dbDoc?.description || "");
		const fullContent = ["---", `title: ${title}`, `description: ${description}`, `source: xueprompt-overlay`, `url: ${dbDoc?.url ?? ""}`, "---", "", overlay.content].join("\n");
		return { title, description, promptContent: overlay.content, fullContent };
	}

	/**
	 * 导入到 pi 模板
	 */
	async importToPi(slug: string, category: string, projectPath?: string): Promise<PiPromptTemplateSummary> {
		const detail = await this.detail(slug, category);
		if (!detail) throw new Error(`未找到提示词: ${slug}`);

		const name = slug
			.replace(/[^\p{L}\p{N}-]+/gu, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "")
			.toLowerCase();

		const tryCreate = async (tryName: string): Promise<PiPromptTemplateSummary> => {
			try {
				const input = {
					name: tryName,
					description: detail.description || detail.title,
				};
				return projectPath ? await this.promptManager.createInProject(projectPath, input) : await this.promptManager.create(input);
			} catch {
				const match = tryName.match(/-(\d+)$/);
				const nextNum = match ? parseInt(match[1], 10) + 1 : 2;
				return tryCreate(tryName.replace(/-\d+$/, "") + "-" + nextNum);
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
