/**
 * TokenDance 公开报价 → 模型折扣/免费徽章（模型选择器展示用）。
 *
 * 为什么单独一个端点：网关 /gateway/v1/models（见 tokendanceCatalog.ts）只返回
 * id/name/context_length，没有任何价格字段；折扣信息只在站点 SPA 自用的
 * /portal/api/models/all（TOKENDANCE_PRICING_URL）里，形状为
 * `{ models: [{ slug, pricing: { items: [...], reference: [...] } }] }`：
 * - items：现价（rate 为「元/百万 token」，plans 可能按区间分档，首档即基价）；
 * - reference：参考价（站点价格页上划掉的原价），实测 115 个模型里 48 个带；
 * - time_pricing：deepseek 系列的分时定价，以 items/base_items 为基准价，这里按基准算折扣。
 * slug 与网关模型 id 完全一致（实测 115/115 对齐），所以徽章按 id 直接挂。
 *
 * 失败一律 fail-open：拿不到价格表就返回空表，模型列表保持原样（徽章是装饰信息，
 * 不能因为报价端点挂了就影响选模型）。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { TOKENDANCE_PRICING_URL, type TokendancePriceTagMap } from "../../shared/tokendance";
import type { ModelPriceTag } from "../../shared/types";

/** 价格表缓存有效期：报价变动不频繁，6h 与模型目录缓存对齐。 */
export const TOKENDANCE_PRICING_TTL_MS = 6 * 60 * 60 * 1000;
/** 拉取超时：与目录一致用 10s。 */
const FETCH_TIMEOUT_MS = 10_000;
/**
 * 折扣口径优先取输入 token 单价：同一模型各项计费倍率实测一致（115 个模型全部一致），
 * 真出现不一致时用输入价更接近用户对「这个模型几折」的直觉。
 */
const PREFERRED_ITEM_ID = "openai:chat-completions:input_tokens";

/** 磁盘缓存结构：at = 拉取时刻（epoch ms），tags = 已规格化的徽章表。 */
export type TokendancePricingCache = {
	at: number;
	tags: TokendancePriceTagMap;
};

/** 读取结果：fromCache 区分「本次实时拉取」与「用已缓存表」。 */
export type TokendancePricingResult = TokendancePricingCache & { fromCache: boolean };

export type TokendancePricingStoreDeps = {
	/** 缓存文件绝对路径（主进程用 userData/tokendance-pricing.json；测试注入临时文件） */
	getCachePath: () => string;
	log: (message: string, detail?: Record<string, unknown>) => void;
	/** 拉取函数（默认 electron net.fetch；测试注入 stub，避免真实网络） */
	fetchFn?: (url: string) => Promise<{ ok: boolean; status?: number; json(): Promise<unknown> }>;
	/** 时钟（测试注入固定时间，验证 TTL） */
	now?: () => number;
};

/** rate 在响应里是字符串（"0.8"）也可能是数字，统一转成非负有限数。 */
function toRate(value: unknown): number | undefined {
	const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/** 计费项列表 → item id → 首档单价（分档区间按首档算，避免把区间上限价当基价）。 */
function readRates(list: unknown): Map<string, number> {
	const rates = new Map<string, number>();
	if (!Array.isArray(list)) return rates;
	for (const raw of list) {
		if (!raw || typeof raw !== "object") continue;
		const item = raw as { id?: unknown; plans?: unknown };
		if (typeof item.id !== "string" || item.id.length === 0) continue;
		if (!Array.isArray(item.plans) || item.plans.length === 0) continue;
		const plan = item.plans[0];
		if (!plan || typeof plan !== "object") continue;
		const rate = toRate((plan as { rate?: unknown }).rate);
		if (rate === undefined) continue;
		rates.set(item.id, rate);
	}
	return rates;
}

/**
 * 现价/参考价 → 折扣比例。只在确实更便宜时给出：
 * 无参考价（从未打折）、折扣不小于 1（涨价/原价）都返回 undefined。
 */
function resolveDiscount(current: Map<string, number>, reference: Map<string, number>): number | undefined {
	const ratios: Array<{ id: string; ratio: number }> = [];
	for (const [id, rate] of current) {
		const original = reference.get(id);
		// 单价 0 的计费项（如某些模型的缓存读写免费）不参与折扣比，否则会算出 0 折。
		if (original === undefined || original <= 0 || rate <= 0) continue;
		ratios.push({ id, ratio: rate / original });
	}
	if (ratios.length === 0) return undefined;
	const picked = ratios.find((entry) => entry.id === PREFERRED_ITEM_ID) ?? ratios.sort((left, right) => (left.id < right.id ? -1 : 1))[0];
	// 千分位精度：0.35 / 0.25 这类折扣不被浮点误差抬成 0.35000000000000003。
	const ratio = Math.round(picked.ratio * 1000) / 1000;
	return ratio > 0 && ratio < 0.999 ? ratio : undefined;
}

/**
 * 解析 /portal/api/models/all 响应体。输入不可信（网络响应）：字段缺失/类型不符的条目丢弃，绝不 throw。
 */
export function parseTokenDancePriceTags(data: unknown): TokendancePriceTagMap {
	const tags: TokendancePriceTagMap = {};
	if (!data || typeof data !== "object") return tags;
	const list = (data as { models?: unknown }).models;
	if (!Array.isArray(list)) return tags;
	for (const raw of list) {
		if (!raw || typeof raw !== "object") continue;
		const model = raw as { slug?: unknown; pricing?: unknown };
		if (typeof model.slug !== "string" || model.slug.length === 0) continue;
		if (!model.pricing || typeof model.pricing !== "object") continue;
		const pricing = model.pricing as { items?: unknown; reference?: unknown };
		const current = readRates(pricing.items);
		if (current.size === 0) continue;
		// 全部计费项单价为 0 = 免费模型（站点价格页同样标记为免费）。
		if ([...current.values()].every((rate) => rate === 0)) {
			tags[model.slug] = { free: true };
			continue;
		}
		const discount = resolveDiscount(current, readRates(pricing.reference));
		if (discount !== undefined) {
			const tag: ModelPriceTag = { discount };
			tags[model.slug] = tag;
		}
	}
	return tags;
}

/** TokenDance 价格表 store：内存 + userData 缓存 + 过期后台刷新（装饰信息不阻塞模型列表）。 */
export class TokendancePricingStore {
	private fetchFn: NonNullable<TokendancePricingStoreDeps["fetchFn"]>;
	private now: NonNullable<TokendancePricingStoreDeps["now"]>;
	private memory: TokendancePricingCache | null = null;
	private diskChecked = false;
	private inflight: Promise<TokendancePricingCache> | null = null;

	constructor(private readonly deps: TokendancePricingStoreDeps) {
		// 与目录 store 同一网络路径（Chromium net.fetch → 系统代理生效）。
		this.fetchFn = deps.fetchFn ?? ((url) => import("electron").then(({ net }) => net.fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })));
		this.now = deps.now ?? Date.now;
	}

	/**
	 * 取徽章表：缓存新鲜直接返回；有旧表（内存或磁盘）时先用旧表、后台换新；
	 * 完全没缓存才等待一次拉取，失败回空表（模型列表照常显示，只是没有徽章）。
	 */
	async getTags(force = false): Promise<TokendancePricingResult> {
		// 磁盘缓存只读一次（含“确实没有”的结果），之后的过期判断只看内存里的 at。
		if (!this.diskChecked && !this.memory) {
			this.memory = await this.readCache();
			this.diskChecked = true;
		}
		const fresh = this.memory ? this.now() - this.memory.at < TOKENDANCE_PRICING_TTL_MS : false;
		if (!force && fresh && this.memory) {
			return { ...this.memory, fromCache: true };
		}
		if (!force && this.memory) {
			// 过期旧表：后台刷新，本次仍返回旧表（选择器不该等网络）。
			void this.refresh().catch(() => {
				// 失败静默：旧表仍可用，下次读取再试。
			});
			return { ...this.memory, fromCache: true };
		}
		try {
			const pulled = await this.refresh();
			return { ...pulled, fromCache: false };
		} catch (error) {
			this.deps.log("tokendance pricing fetch failed", { error: error instanceof Error ? error.message : String(error) });
			// 拉取失败（含 force 刷新）：有旧表（内存或磁盘）就用旧表，否则空表。
			return { tags: this.memory?.tags ?? {}, at: this.memory?.at ?? 0, fromCache: true };
		}
	}

	/** 强制刷新并落盘；失败 throw（getTags 兜底，测试也可直接断言）。 */
	refresh(): Promise<TokendancePricingCache> {
		this.inflight ??= this.fetchAndCache().finally(() => {
			this.inflight = null;
		});
		return this.inflight;
	}

	private async fetchAndCache(): Promise<TokendancePricingCache> {
		const response = await this.fetchFn(TOKENDANCE_PRICING_URL);
		if (!response.ok) {
			throw new Error(`TokenDance pricing HTTP ${response.status}`);
		}
		const tags = parseTokenDancePriceTags(await response.json());
		// 空表视为异常（端点变了/协议变了），走失败回退，不覆盖旧缓存。
		if (Object.keys(tags).length === 0) {
			throw new Error("TokenDance pricing empty");
		}
		const cache: TokendancePricingCache = { at: this.now(), tags };
		await this.writeCache(cache);
		this.memory = cache;
		return cache;
	}

	private async readCache(): Promise<TokendancePricingCache | null> {
		try {
			const parsed = JSON.parse(await readFile(this.deps.getCachePath(), "utf8")) as unknown;
			if (!parsed || typeof parsed !== "object") return null;
			const cache = parsed as { at?: unknown; tags?: unknown };
			if (typeof cache.at !== "number" || !cache.tags || typeof cache.tags !== "object") return null;
			return { at: cache.at, tags: cache.tags as TokendancePriceTagMap };
		} catch {
			return null; // 文件不存在/损坏统一按无缓存处理
		}
	}

	private async writeCache(cache: TokendancePricingCache): Promise<void> {
		const filePath = this.deps.getCachePath();
		await mkdir(dirname(filePath), { recursive: true });
		await writeFile(filePath, JSON.stringify(cache, null, 2), "utf8");
	}
}
