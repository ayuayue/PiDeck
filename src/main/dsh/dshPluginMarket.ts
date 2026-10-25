/**
 * DSH 插件市场搜索：官方目录 API + npm search 双源合并。
 *
 * 官方目录（api.dsh-plugin.org/plugins.<lang>.json，与 dsh-plugin-hub 市场插件同一数据源）
 * 返回短键数组（s/n/vr/c/t/d/r…，见市场插件 src/client/logic/normalize.ts）。其中只有
 * `r.npmPackage` 条目可经 npm 安装（纯 GitHub 仓库条目 PiDeck 装不了，跳过）。
 * npm search 补充官方目录未收录的包（尊重 .npmrc registry）。
 * 单源失败不阻断：收集 warnings 返回给 UI 展示。
 */
import type { DshPluginMarketEntry, DshPluginMarketSearchResult } from "../../shared/types";

/** 官方目录 URL（zh 目录与市场插件 UI 默认语言一致；en 变体仅描述文本不同）。 */
const MARKET_CATALOG_URL = "https://api.dsh-plugin.org/plugins.zh.json";

/** 目录请求超时：市场不可达时快速降级到 npm 单源。 */
const MARKET_FETCH_TIMEOUT_MS = 10_000;

/** 目录内存缓存时长：同一会话内反复打开搜索不重复打远程。 */
const MARKET_CACHE_TTL_MS = 10 * 60 * 1000;

/** 合并后的结果上限（双源全量返回会刷屏；市场/npm 各自已有排序权重）。 */
const MAX_SEARCH_RESULTS = 30;

/** npm search 每次请求的条数上限（npm 默认 20，显式声明避免依赖默认值）。 */
const NPM_SEARCH_LIMIT = 20;

/** 关键词里的控制字符（换行等；包名/关键词语义都不需要）。 */
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

let marketCache: { at: number; entries: DshPluginMarketEntry[] } | undefined;

/** 测试用：清空目录内存缓存（生产无调用方；fake fetch 场景防缓存串测）。 */
export function clearMarketCatalogCache(): void {
	marketCache = undefined;
}

/** fetch 的最小注入面（测试替身用；生产传 globalThis.fetch）。 */
export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** 市场条目名按官方命名惯例判 UI-only：*-client-ui-* / client-ui/* / *-client-ui。 */
export function marketEntryLooksUiOnly(name: string, category: string | undefined, topics: readonly string[]): boolean {
	if (/(?:^|[-/])client-ui(?:[-/]|$)/i.test(name)) return true;
	const haystack = [category ?? "", ...topics].join(" ").toLowerCase();
	return /\bui\b|界面/.test(haystack);
}

/** 收窄「带 message 的对象」给错误文本兜底。 */
function describeError(error: unknown): string {
	if (typeof error === "object" && error !== null && typeof Reflect.get(error, "message") === "string") return String(Reflect.get(error, "message"));
	return String(error);
}

/** 短键条目 → 市场条目；无 npm 包名（纯 repo 收录）返回 undefined（PiDeck 无法 npm 安装）。 */
function normalizeMarketEntry(raw: Record<string, unknown>): DshPluginMarketEntry | undefined {
	const slug = raw.s;
	if (typeof slug !== "string" || !slug) return undefined;
	const source = raw.r;
	let npmPackage: string | undefined;
	if (typeof source === "string") {
		npmPackage = undefined;
	} else if (typeof source === "object" && source !== null) {
		const value = Reflect.get(source, "npmPackage");
		npmPackage = typeof value === "string" && value ? value : undefined;
	}
	const name = npmPackage ?? slug;
	const version = typeof raw.vr === "string" ? raw.vr : undefined;
	const description = typeof raw.d === "string" ? raw.d : undefined;
	const category = typeof raw.c === "string" ? raw.c : undefined;
	const topics = Array.isArray(raw.t) ? raw.t.filter((topic): topic is string => typeof topic === "string") : [];
	return {
		name,
		version,
		description,
		uiOnly: marketEntryLooksUiOnly(name, category, topics),
		source: "market",
	};
}

/** 解析目录 JSON（数组；容错非数组形态返回空）。 */
function parseCatalogPayload(payload: unknown): DshPluginMarketEntry[] {
	if (!Array.isArray(payload)) return [];
	const entries: DshPluginMarketEntry[] = [];
	for (const item of payload) {
		if (typeof item !== "object" || item === null) continue;
		const entry = normalizeMarketEntry(item as Record<string, unknown>);
		if (entry !== undefined) entries.push(entry);
	}
	return entries;
}

/** 拉官方目录（带内存缓存与超时）；失败抛错由调用方降级。 */
async function fetchMarketCatalog(fetchImpl: FetchLike): Promise<DshPluginMarketEntry[]> {
	const cached = marketCache;
	if (cached !== undefined && Date.now() - cached.at < MARKET_CACHE_TTL_MS) return cached.entries;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), MARKET_FETCH_TIMEOUT_MS);
	try {
		const response = await fetchImpl(MARKET_CATALOG_URL, { signal: controller.signal });
		if (!response.ok) throw new Error(`market catalog HTTP ${response.status}`);
		const entries = parseCatalogPayload(await response.json());
		marketCache = { at: Date.now(), entries };
		return entries;
	} finally {
		clearTimeout(timer);
	}
}

/** npm search 关键词过滤：DSH 生态之外的结果（同名包等）不进列表。 */
const DSH_RELEVANCE_RE = /\b(?:dsh|deepseek|cordis)\b/i;

/** npm search --json（走 runNpm 子进程，尊重 .npmrc registry 与代理 env）。 */
async function npmSearch(runNpm: (args: readonly string[], options: { timeoutMs?: number }) => Promise<{ code: number | null; stdout: string; stderr: string }>, keyword: string): Promise<DshPluginMarketEntry[]> {
	const query = `${keyword} dsh`;
	const result = await runNpm(["search", "--json", `--searchlimit=${NPM_SEARCH_LIMIT}`, query], {});
	if (result.code !== 0) throw new Error(`npm search failed: ${result.stderr || result.stdout || "no output"}`);
	let payload: unknown;
	try {
		payload = JSON.parse(result.stdout);
	} catch {
		throw new Error("npm search returned invalid JSON");
	}
	if (!Array.isArray(payload)) return [];
	const entries: DshPluginMarketEntry[] = [];
	for (const item of payload) {
		if (typeof item !== "object" || item === null) continue;
		const record = item as Record<string, unknown>;
		const name = record.name;
		if (typeof name !== "string" || !name) continue;
		const description = typeof record.description === "string" ? record.description : "";
		const keywords = Array.isArray(record.keywords) ? record.keywords.filter((keyword): keyword is string => typeof keyword === "string") : [];
		if (!DSH_RELEVANCE_RE.test(name) && !DSH_RELEVANCE_RE.test(description) && !keywords.some((keyword) => DSH_RELEVANCE_RE.test(keyword))) continue;
		entries.push({
			name,
			version: typeof record.version === "string" ? record.version : undefined,
			description: description || undefined,
			uiOnly: marketEntryLooksUiOnly(name, undefined, keywords),
			source: "npm",
		});
	}
	return entries;
}

/** 关键词边界校验（IPC handler 与服务层共用；1..80 字符、无控制字符）。 */
export function validateSearchKeyword(keyword: string): { ok: true; value: string } | { ok: false; reason: string } {
	const value = keyword.trim();
	if (!value || value.length > 80) return { ok: false, reason: "search keyword must be 1-80 characters" };
	if (CONTROL_CHARS_RE.test(value)) return { ok: false, reason: "search keyword contains control characters" };
	return { ok: true, value };
}

/** 搜索条件（fetch 与 npm runner 均注入，测试禁真实网络）。 */
export type SearchDshPluginMarketInput = {
	keyword: string;
	fetchImpl: FetchLike;
	runNpm: (args: readonly string[], options: { timeoutMs?: number }) => Promise<{ code: number | null; stdout: string; stderr: string }>;
};

/**
 * 双源并行搜索，按 name 去重（官方目录优先——它是策展数据），截断到 30 条。
 * 任一源失败记 warning，双源全挂时抛最后错误。
 */
export async function searchDshPluginMarket(input: SearchDshPluginMarketInput): Promise<DshPluginMarketSearchResult> {
	const keyword = input.keyword.trim().toLowerCase();
	const warnings: string[] = [];
	const [marketSettled, npmSettled] = await Promise.allSettled([fetchMarketCatalog(input.fetchImpl), npmSearch(input.runNpm, input.keyword.trim())]);
	let marketEntries: DshPluginMarketEntry[] = [];
	if (marketSettled.status === "fulfilled") {
		marketEntries = marketSettled.value.filter((entry) => entry.name.toLowerCase().includes(keyword) || (entry.description ?? "").toLowerCase().includes(keyword));
	} else {
		warnings.push(`market: ${describeError(marketSettled.reason)}`);
	}
	let npmEntries: DshPluginMarketEntry[] = [];
	if (npmSettled.status === "fulfilled") {
		npmEntries = npmSettled.value;
	} else {
		warnings.push(`npm: ${describeError(npmSettled.reason)}`);
	}
	if (marketSettled.status === "rejected" && npmSettled.status === "rejected") {
		throw new Error(warnings.join("; "));
	}
	const seen = new Set<string>();
	const entries: DshPluginMarketEntry[] = [];
	for (const entry of [...marketEntries, ...npmEntries]) {
		if (seen.has(entry.name)) continue;
		seen.add(entry.name);
		entries.push(entry);
		if (entries.length >= MAX_SEARCH_RESULTS) break;
	}
	return { entries, warnings };
}
