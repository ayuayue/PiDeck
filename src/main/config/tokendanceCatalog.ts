/**
 * TokenDance（词元跳动）内置模型目录：live fetch + userData 缓存。
 *
 * 设计要点：
 * - TokenDance /gateway/v1/models 是**公开免鉴权**的 OpenAI 风格模型列表（实测 200），
 *   所以未配置 Key 也能拉取展示；缓存落在 PiDeck userData（独立于 pi 配置文件，
 *   参考 imagegen.json 先例，不写 ~/.pi/agent）。
 * - 缓存带 TTL（默认 6h），拉取失败时回退旧缓存（断网仍可展示已发现目录）。
 * - 合并规则是纯函数：模型列表已含 tokendance 组（用户已把目录写入 pi models.json
 *   或 pi catalog 自带）时不重复注入，保持「PiDeck 展示 = pi 运行时」不分裂。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AvailableModel } from "../../shared/types";
// 端点/供应商名等常量收敛到 shared 层，主进程与渲染层共用一套值（防归因漂移）。
import { TOKENDANCE_BASE_URL, TOKENDANCE_PROVIDER } from "../../shared/tokendance";

// 兼容导出：既有调用方（systemIpc/main/index/tests）仍按原名 import。
export { TOKENDANCE_BASE_URL, TOKENDANCE_PROVIDER };
/** 目录缓存有效期：模型目录变化不频繁，6 小时足够；超过后下次读取重新拉取。 */
export const TOKENDANCE_CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
/** 拉取超时：与 ConfigManager 模型探测一致用 10s，避免网络差时拖住列表加载。 */
const FETCH_TIMEOUT_MS = 10_000;

/** 磁盘缓存结构：at = 拉取时刻（epoch ms），models = 已规格化的模型列表。 */
export type TokendanceCatalogCache = {
	at: number;
	models: AvailableModel[];
};

/** 目录读取结果：fromCache 区分「实时拉取」与「读缓存」，渲染层据此显示数据时效。 */
export type TokendanceCatalogResult = {
	models: AvailableModel[];
	fromCache: boolean;
	at: number;
};

/**
 * 解析 TokenDance /gateway/v1/models 响应体（OpenAI /v1/models 形状：
 * { data: [{ id, name?, context_length?, ... }] }）。
 * 输入不可信（网络响应）：字段缺失/类型不符的条目直接丢弃，绝不 throw。
 */
export function parseTokenDanceCatalog(data: unknown): AvailableModel[] {
	if (!data || typeof data !== "object") return [];
	const list = (data as { data?: unknown }).data;
	if (!Array.isArray(list)) return [];
	const models: AvailableModel[] = [];
	for (const raw of list) {
		if (!raw || typeof raw !== "object") continue;
		const entry = raw as { id?: unknown; name?: unknown; context_length?: unknown };
		if (typeof entry.id !== "string" || entry.id.length === 0) continue;
		models.push({
			id: entry.id,
			provider: TOKENDANCE_PROVIDER,
			name: typeof entry.name === "string" && entry.name.length > 0 ? entry.name : undefined,
			contextWindow:
				typeof entry.context_length === "number" && Number.isFinite(entry.context_length)
					? entry.context_length
					: undefined,
		});
	}
	return models;
}

export type TokendanceCatalogStoreDeps = {
	/** 缓存文件绝对路径（主进程用 userData/tokendance-models.json；测试注入临时文件） */
	getCachePath: () => string;
	log: (message: string, detail?: Record<string, unknown>) => void;
	/** 拉取函数（默认 net.fetch；测试注入 stub，避免真实网络） */
	fetchFn?: (url: string) => Promise<{ ok: boolean; status?: number; json(): Promise<unknown> }>;
	/** 时钟（测试注入固定时间，验证 TTL） */
	now?: () => number;
};

/** TokenDance 模型目录 store：live fetch + userData 缓存 + 失败回退旧缓存。 */
export class TokendanceCatalogStore {
	private fetchFn: NonNullable<TokendanceCatalogStoreDeps["fetchFn"]>;
	private now: NonNullable<TokendanceCatalogStoreDeps["now"]>;

	constructor(private readonly deps: TokendanceCatalogStoreDeps) {
		// 默认走 electron net.fetch：走 Chromium 网络栈（defaultSession 代理生效），
		// 与 ConfigManager 的 provider 探测同一网络路径，避免 Node fetch 不读系统代理。
		// 默认走 electron net.fetch：走 Chromium 网络栈（defaultSession 代理生效），
		// 与 ConfigManager 的 provider 探测同一网络路径，避免 Node fetch 不读系统代理。
		// Response 结构上满足最小接口（ok/status/json），无需强转。
		this.fetchFn =
			deps.fetchFn ??
			((url) =>
				import("electron").then(({ net }) =>
					net.fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }),
				));
		this.now = deps.now ?? Date.now;
	}

	/**
	 * 取模型目录：缓存新鲜（未过期）直接读缓存；过期/force 重新拉取；
	 * 拉取失败回退旧缓存（有则用，无则返回 null，调用方按“无目录”处理）。
	 */
	async getModels(force = false): Promise<TokendanceCatalogResult | null> {
		const cached = await this.readCache();
		if (!force && cached && this.now() - cached.at < TOKENDANCE_CATALOG_TTL_MS) {
			return { models: cached.models, fromCache: true, at: cached.at };
		}
		try {
			const models = await this.fetchAndCache();
			return { models, fromCache: false, at: this.now() };
		} catch (error) {
			// 拉取失败（网络/超时/解析异常）：有旧缓存就降级用，避免目录直接消失；
			// 无缓存则返回 null，让模型列表保持 pi 目录原样（不注入）。
			const message = error instanceof Error ? error.message : String(error);
			this.deps.log("tokendance catalog fetch failed", { error: message });
			if (cached) return { models: cached.models, fromCache: true, at: cached.at };
			return null;
		}
	}

	/** 强制刷新并落盘新缓存；失败 throw（调用方（IPC）负责降级返回）。 */
	async refresh(): Promise<TokendanceCatalogResult> {
		const models = await this.fetchAndCache();
		return { models, fromCache: false, at: this.now() };
	}

	private async fetchAndCache(): Promise<AvailableModel[]> {
		const response = await this.fetchFn(`${TOKENDANCE_BASE_URL}/models`);
		if (!response.ok) {
			throw new Error(`TokenDance models HTTP ${response.status}`);
		}
		const body: unknown = await response.json();
		const models = parseTokenDanceCatalog(body);
		// 空列表视为异常（端点错了/协议变了），走回退路径，不缓存空目录
		if (models.length === 0) {
			throw new Error("TokenDance models empty list");
		}
		await this.writeCache({ at: this.now(), models });
		return models;
	}

	private async readCache(): Promise<TokendanceCatalogCache | null> {
		try {
			const raw = await readFile(this.deps.getCachePath(), "utf8");
			const parsed = JSON.parse(raw) as unknown;
			if (!parsed || typeof parsed !== "object") return null;
			const cache = parsed as Partial<TokendanceCatalogCache>;
			if (typeof cache.at !== "number" || !Array.isArray(cache.models)) return null;
			return { at: cache.at, models: cache.models.filter((m) => m && m.provider === TOKENDANCE_PROVIDER) };
		} catch {
			return null; // 文件不存在/损坏统一按无缓存处理
		}
	}

	private async writeCache(cache: TokendanceCatalogCache): Promise<void> {
		const filePath = this.deps.getCachePath();
		await mkdir(dirname(filePath), { recursive: true });
		await writeFile(filePath, JSON.stringify(cache, null, 2), "utf8");
	}
}