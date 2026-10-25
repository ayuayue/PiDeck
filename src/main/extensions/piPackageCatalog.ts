/**
 * pi.dev 扩展商店（Package Catalog）数据源。
 *
 * pi.dev 无公开 JSON API（`/api/packages` 返回 501），但 `/packages` 目录页是 SSR HTML，
 * 每页 50 张卡片，卡片 `<article data-package-card="true">` 内嵌机器可读的 data-* 属性，
 * 支持 `?page=&name=&type=&sort=` 服务端过滤。本模块只做「fetch + 解析 + 内存缓存」，
 * 不依赖 electron，解析纯函数可单测；目录结构变动时只需改 parse 部分。
 */

import type { PiPackageCatalog, PiPackageCatalogItem, PiPackageCatalogQuery } from "../../shared/types";

const CATALOG_URL = "https://pi.dev/packages";
/** 缓存有效期：目录数据变化不频繁，10 分钟内复用上次结果，避免每次切页都打官网。 */
const CATALOG_TTL_MS = 10 * 60_000;
/** 单次请求超时：官网 SSR 渲染较慢，15s 是合理上限（超过即视为网络异常）。 */
const FETCH_TIMEOUT_MS = 15_000;
/** 防御性上限：目录页结构异常时最多解析 200 张卡片，防止无限内存占用。 */
const MAX_PAGE_CARDS = 200;
/** 目录页已知的每页条数（官网分页固定 50；解析失败时作为兜底值）。 */
const DEFAULT_PAGE_SIZE = 50;

export type CatalogSort = "downloads" | "recent";

type CatalogFetcher = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

/** 按查询参数缓存：同参数 10 分钟内不重复请求官网。 */
const cache = new Map<string, { atMs: number; catalog: PiPackageCatalog }>();

/** 测试钩子：清空内存缓存。 */
export function resetPiPackageCatalogCache(): void {
	cache.clear();
}

/** 解码 HTML 实体（&#xNN; / &#NN; / 命名实体），卡片属性与正文里常见。 */
function decodeHtmlEntities(text: string): string {
	return text
		.replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&");
}

/** 去掉 HTML 标签，只留纯文本。 */
function stripTags(html: string): string {
	return html.replace(/<[^>]*>/g, "");
}

/** 取某标签内指定属性值（已解码）；未命中返回 undefined。 */
function tagAttribute(tag: string, name: string): string | undefined {
	const match = tag.match(new RegExp(`${name}="([^"]*)"`));
	return match?.[1] !== undefined ? decodeHtmlEntities(match[1]) : undefined;
}

/** 非负有限数字解析：目录的 downloads/date 属性都是数字字符串，异常值返回 undefined。 */
function finiteNonNegative(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * 从目录页 HTML 解析包列表。
 * 逐卡片切块（下一个 article 开头即本卡片结束），正则提取正文里的描述/作者/链接；
 * 卡片结构缺失时跳过该卡片而非整体失败——目录页个别卡片变动不应拖垮整页。
 */
export function parsePackageCatalogHtml(html: string): PiPackageCatalogItem[] {
	const items: PiPackageCatalogItem[] = [];
	const cardTags = [...html.matchAll(/<article[^>]*data-package-card="true"[^>]*>/g)];
	for (let index = 0; index < cardTags.length && items.length < MAX_PAGE_CARDS; index += 1) {
		const card = cardTags[index]!;
		const tag = card[0];
		const bodyStart = (card.index ?? 0) + tag.length;
		const bodyEnd = index + 1 < cardTags.length ? (cardTags[index + 1]!.index ?? html.length) : html.length;
		const body = html.slice(bodyStart, bodyEnd);

		const name = tagAttribute(tag, "data-package-name");
		if (!name) continue;

		const descriptionMatch = body.match(/<p class="packages-desc">([\s\S]*?)<\/p>/);
		const authorMatch = body.match(/<div class="packages-meta"><span>([\s\S]*?)<\/span>/);
		const npmMatch = body.match(/href="(https:\/\/www\.npmjs\.com\/package\/[^"]+)"/);
		const githubMatch = body.match(/href="(https:\/\/github\.com\/[^"]+)"/);
		const pageMatch = body.match(/class="packages-name"><a href="([^"]+)"/);

		const author = authorMatch ? decodeHtmlEntities(stripTags(authorMatch[1] ?? "")).trim() : "";
		const downloadsPerMonth = finiteNonNegative(tagAttribute(tag, "data-package-downloads"));
		const publishedAt = finiteNonNegative(tagAttribute(tag, "data-package-date"));
		let pageUrl = `${CATALOG_URL}/${name}`;
		if (pageMatch?.[1]) {
			try {
				pageUrl = new URL(decodeHtmlEntities(pageMatch[1]), "https://pi.dev").toString();
			} catch {
				/* 详情链接解析失败时用构造的兜底 URL */
			}
		}

		items.push({
			name,
			description: descriptionMatch ? decodeHtmlEntities(stripTags(descriptionMatch[1] ?? "")).trim() : "",
			...(author ? { author } : {}),
			types: (tagAttribute(tag, "data-package-types") ?? "").split(/\s+/).filter(Boolean),
			...(downloadsPerMonth !== undefined ? { downloadsPerMonth } : {}),
			...(publishedAt !== undefined && publishedAt > 0 ? { publishedAt } : {}),
			...(npmMatch ? { npmUrl: decodeHtmlEntities(npmMatch[1] ?? "") } : {}),
			...(githubMatch ? { githubUrl: decodeHtmlEntities(githubMatch[1] ?? "") } : {}),
			searchText: tagAttribute(tag, "data-package-search") ?? "",
			installSource: `npm:${name}`,
			pageUrl,
		});
	}
	return items;
}

/**
 * 从目录页 HTML 解析分页元数据：`packages-count` 元素形如 "1-50 / 5300"。
 * 拿不到时只返回 lastPage=1，由调用方按 items 长度兜底。
 */
export function parseCatalogIndexMeta(html: string): {
	rangeStart?: number;
	rangeEnd?: number;
	total?: number;
	lastPage: number;
} {
	let lastPage = 1;
	// 翻页链接（?page=N）里最大的页码，作为 lastPage 的保守估计
	for (const match of html.matchAll(/[?&]page=(\d+)/g)) {
		const page = Number(match[1]);
		if (Number.isSafeInteger(page) && page > lastPage) lastPage = page;
	}
	const count = html.match(/class="packages-count">\s*(\d+)\s*-\s*(\d+)\s*\/\s*(\d+)/);
	if (!count) return { lastPage };
	const rangeStart = Number(count[1]);
	const rangeEnd = Number(count[2]);
	const total = Number(count[3]);
	const pageSize = rangeEnd - rangeStart + 1;
	if (Number.isSafeInteger(pageSize) && pageSize > 0 && Number.isSafeInteger(total) && total >= 0) {
		lastPage = Math.max(lastPage, Math.ceil(total / pageSize) || 1);
	}
	return { rangeStart, rangeEnd, total, lastPage };
}

/** 按查询参数拼目录页 URL（page=1、sort=downloads 为默认值，不重复携带）。 */
export function catalogPageUrl(query: PiPackageCatalogQuery): string {
	const params = new URLSearchParams();
	if (query.page && query.page > 1) params.set("page", String(query.page));
	if (query.query) params.set("name", query.query);
	if (query.type) params.set("type", query.type);
	if (query.sort && query.sort !== "downloads") params.set("sort", query.sort);
	const search = params.toString();
	return search ? `${CATALOG_URL}?${search}` : CATALOG_URL;
}

function cacheKey(query: PiPackageCatalogQuery): string {
	return `${query.page ?? 1}\t${query.query ?? ""}\t${query.type ?? ""}\t${query.sort ?? "downloads"}`;
}

/** 归一化查询参数：trim 搜索词，sort 只认 downloads/recent。 */
function normalizeQuery(query: PiPackageCatalogQuery): Required<Pick<PiPackageCatalogQuery, "page">> & Pick<PiPackageCatalogQuery, "query" | "type" | "sort"> {
	return {
		page: query.page ?? 1,
		query: (query.query ?? "").trim(),
		type: (query.type ?? "").trim(),
		sort: query.sort === "recent" ? "recent" : "downloads",
	};
}

function createTimeoutSignal(ms: number): { signal: AbortSignal; dispose: () => void } {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), ms);
	timer.unref?.();
	return {
		signal: controller.signal,
		dispose: () => clearTimeout(timer),
	};
}

function buildCatalog(items: PiPackageCatalogItem[], query: PiPackageCatalogQuery, meta: ReturnType<typeof parseCatalogIndexMeta>, generatedAt: number, fromCache: boolean): PiPackageCatalog {
	const inferredPageSize = meta.rangeEnd !== undefined && meta.rangeStart !== undefined ? meta.rangeEnd - meta.rangeStart + 1 : items.length;
	const pageSize = inferredPageSize > 0 ? inferredPageSize : DEFAULT_PAGE_SIZE;
	const total = meta.total ?? items.length;
	const lastPage = Math.max(1, query.page ?? 1, meta.lastPage, pageSize > 0 && total > 0 ? Math.ceil(total / pageSize) : 1);
	return {
		generatedAt,
		fromCache,
		items,
		page: query.page ?? 1,
		pageSize,
		total,
		lastPage,
	};
}

/**
 * 获取商店某一页数据。
 * - 同参数 10 分钟内命中缓存直接返回（fromCache=true）；
 * - 网络/解析失败且有旧缓存时回退缓存；无缓存则抛错（由 IPC 层转成用户可读文案）；
 * - 首屏（无过滤的第 1 页）解析到 0 张卡片视为目录不可用，避免把空页当正常结果缓存。
 */
export async function getPiPackageCatalog(
	args: PiPackageCatalogQuery & {
		fetchImpl?: CatalogFetcher;
		now?: () => number;
	} = {},
): Promise<PiPackageCatalog> {
	const now = args.now ?? Date.now;
	const fetchImpl: CatalogFetcher = args.fetchImpl ?? fetch;
	const query = normalizeQuery(args);
	const key = cacheKey(query);
	const hit = cache.get(key);

	if (args.refresh !== true && hit && now() - hit.atMs <= CATALOG_TTL_MS) {
		return { ...hit.catalog, fromCache: true };
	}

	const timeout = createTimeoutSignal(FETCH_TIMEOUT_MS);
	try {
		const response = await fetchImpl(catalogPageUrl(query), {
			signal: timeout.signal,
			headers: { accept: "text/html" },
		});
		if (!response.ok) {
			throw new Error(`Package catalog request failed with status ${response.status}`);
		}
		const html = await response.text();
		const items = parsePackageCatalogHtml(html);
		const unfilteredFirstPage = query.page === 1 && !query.query && !query.type;
		if (items.length === 0 && unfilteredFirstPage) {
			throw new Error("Package catalog page contained no packages");
		}
		const catalog = buildCatalog(items, query, parseCatalogIndexMeta(html), now(), false);
		cache.set(key, { atMs: now(), catalog });
		return catalog;
	} catch (error) {
		// 官网抖动时回退到旧缓存，保证商店页仍可用（旧数据可能略陈旧）
		if (hit) return { ...hit.catalog, fromCache: true };
		throw error;
	} finally {
		timeout.dispose();
	}
}
