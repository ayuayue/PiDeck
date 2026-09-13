/**
 * AnnouncementService —— 无服务器公告拉取服务（纯 Node，无 electron 依赖，可被 node --test 直接加载）。
 *
 * 职责：
 * - 多源 fallback 拉取 announcements.json（AtomGit → raw，见 shared/announcementSources.ts）；
 * - 解析 + schema 校验（渲染层与缓存只接受校验后的干净数据）；
 * - TTL 过滤（effectiveUntil）+ 版本门控（minVersion，仅向旧版本客户端展示）；
 * - userData 缓存（原子写 tmp+rename，损坏忽略走空态）；
 * - 定时拉取（2h，用户指定）+ 启动延迟抖动（防集中打源）；refresh("manual") 供手动刷新；
 * - 快照推送回调（index.ts 接 webContents.send 给渲染层）。
 *
 * 设计对齐 PiAiCatalogUpdater：依赖注入（fetchImpl/now/random/log），主服务不 import electron。
 * 静默失败：公告是附属功能，任何失败都不向调用方抛出，只记 log 并保留现状。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ANNOUNCEMENT_SOURCES, unwrapAtomgitContents } from "../../shared/announcementSources";
import type {
	AnnouncementItem,
	AnnouncementLevel,
	AnnouncementSnapshot,
	AnnouncementState,
} from "../../shared/types/announcement";
import { compareSemver } from "../../shared/types/dshRuntimeManifest";

/** 定时拉取间隔：2 小时（用户指定）。 */
export const ANNOUNCEMENT_REFRESH_INTERVAL_MS = 2 * 60 * 60 * 1000;
/** 启动后首次拉取延迟基数：2 分钟。 */
export const ANNOUNCEMENT_STARTUP_DELAY_MS = 2 * 60 * 1000;
/** 启动首拉随机抖动上限（ms）：错开大量客户端同时启动的拉取峰值。 */
export const ANNOUNCEMENT_STARTUP_JITTER_MS = 60 * 1000;
/** 单次请求超时（ms）。 */
export const ANNOUNCEMENT_TIMEOUT_MS = 10_000;
/** 响应大小上限：公告是小文件，超过即视为异常响应直接换源。 */
export const ANNOUNCEMENT_MAX_BYTES = 256 * 1024;
/** 缓存文件名（userData 下）。 */
export const ANNOUNCEMENT_CACHE_FILE = "announcements-cache.json";
/** 已读 id 集合上限：公告是滚动窗口，200 足够且防历史堆积。 */
const READ_IDS_LIMIT = 200;

/** 服务依赖（全部注入，便于单测）。 */
export type AnnouncementServiceOptions = {
	/** userData 目录（缓存落盘位置）。 */
	userDataDir: string;
	/** 当前 app 版本（minVersion 门控比较用），如 "0.6.6"。 */
	appVersion: string;
	/** 网络实现（单测注入 stub）；默认 globalThis.fetch。 */
	fetchImpl?: typeof fetch;
	/** 时间源（单测注入模拟时间推移）；默认 Date.now。 */
	now?: () => number;
	/** 随机源（单测注入固定值）；默认 Math.random。 */
	random?: () => number;
	/** 日志回调（主进程接 appLogger；测试注入收集器）。 */
	log?: (domain: string, message: string, details?: Record<string, unknown>) => void;
	/** 快照推送回调：主进程接 webContents.send；测试注入收集器。 */
	onSnapshot?: (state: AnnouncementState) => void;
};

/** 缓存文件结构。items 存校验后的全量公告（未做 TTL 过滤——过滤延迟到读取，时间推移后过期条目自动消失）。 */
type AnnouncementCacheFile = {
	cacheVersion: 1;
	/** 最近一次成功拉取时间戳（ms）。 */
	fetchedAt: number | null;
	items: AnnouncementItem[];
	readIds: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value);
}

/** 合法公告级别；未知值丢弃条目（坏数据不猜测映射、不进客户端）。 */
const ANNOUNCEMENT_LEVELS: readonly AnnouncementLevel[] = ["info", "warn", "critical"];

/** 合法公告类别；旧 feed/缓存缺省按 notice（正式广播）兼容处理。
 * flash=时点信息（读完即焚）/ notice=正式广播（读后归档）/ guide=常驻指南（静默）。 */
const ANNOUNCEMENT_CATEGORIES = ["flash", "notice", "guide"] as const;

/**
 * 校验单条公告：字段类型/边界校验，非法条目整体丢弃（不修复、不填默认值——
 * 源由维护者 commit，数据出错应该被发现，而不是被静默修正后展示）。
 */
export function parseAnnouncementItem(value: unknown): AnnouncementItem | null {
	if (!isRecord(value)) return null;
	const { id, title, body, level, publishedAt, effectiveUntil } = value;
	if (typeof id !== "string" || id.length === 0 || id.length > 128) return null;
	if (typeof title !== "string" || title.length === 0 || title.length > 200) return null;
	if (typeof body !== "string" || body.length > 5000) return null;
	if (typeof level !== "string" || !ANNOUNCEMENT_LEVELS.includes(level as AnnouncementLevel)) return null;
	if (typeof publishedAt !== "string" || Number.isNaN(Date.parse(publishedAt))) return null;
	if (typeof effectiveUntil !== "string" || Number.isNaN(Date.parse(effectiveUntil))) return null;
	// minVersion 可选；给了就必须是字符串（比较交给 compareSemver 的容错解析）
	if (value.minVersion !== undefined && typeof value.minVersion !== "string") return null;
	// category 可选；合法值透传，未知/缺失按 notice 兜底（旧版本 feed 与缓存没有该字段）
	const category =
		typeof value.category === "string" &&
		(ANNOUNCEMENT_CATEGORIES as readonly string[]).includes(value.category)
			? (value.category as AnnouncementItem["category"])
			: "notice";
	return {
		id,
		title,
		body,
		level: level as AnnouncementLevel,
		category,
		publishedAt,
		effectiveUntil,
		minVersion: value.minVersion as string | undefined,
	};
}

/**
 * 校验整个 feed：version 必须是 1（保留演进空间，未来换 schema 时旧客户端整体拒绝）；
 * 条目逐条校验后按 publishedAt 倒序（新公告在前）。结构不合法返回 null（视为源失败换源）。
 */
export function parseAnnouncementFeed(text: string): AnnouncementItem[] | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.announcements)) return null;
	const items: AnnouncementItem[] = [];
	for (const entry of parsed.announcements) {
		const item = parseAnnouncementItem(entry);
		if (item) items.push(item);
	}
	items.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
	return items;
}

/**
 * 版本门控：minVersion 缺省 = 所有版本可见；有值时仅当 appVersion < minVersion 展示
 * （「引导升级」语义：升级到 minVersion 后公告自动消失）。版本解析异常按可见兜底
 * （宁可多展示，不吞正常公告）。
 */
export function shouldShowForVersion(item: AnnouncementItem, appVersion: string): boolean {
	if (!item.minVersion) return true;
	try {
		return compareSemver(appVersion, item.minVersion) < 0;
	} catch {
		return true;
	}
}

/**
 * TTL + 版本门控过滤：过期（effectiveUntil <= now）条目丢弃——拉取模式必须可过期，
 * 否则旧公告永久滞留客户端；过期时间解析失败按立即过期（坏数据宁可少展示）。
 */
export function filterEffectiveItems(
	items: AnnouncementItem[],
	now: number,
	appVersion: string,
): AnnouncementItem[] {
	return items.filter((item) => {
		const until = Date.parse(item.effectiveUntil);
		if (Number.isNaN(until) || until <= now) return false;
		return shouldShowForVersion(item, appVersion);
	});
}

export class AnnouncementService {
	private readonly fetchImpl: typeof fetch;
	private readonly now: () => number;
	private readonly random: () => number;
	private readonly log: (domain: string, message: string, details?: Record<string, unknown>) => void;
	private readonly onSnapshot: (state: AnnouncementState) => void;
	private readonly cachePath: string;

	/** 校验后的全量公告（未过滤 TTL），缓存落盘用；内存态唯一事实来源。 */
	private rawItems: AnnouncementItem[] = [];
	/** 对渲染层可见的状态（TTL/版本过滤后）。 */
	private state: AnnouncementState = { items: [], fetchedAt: null, source: "cache", readIds: [] };
	private refreshTimer: ReturnType<typeof setTimeout> | null = null;
	private refreshing = false;

	constructor(private readonly options: AnnouncementServiceOptions) {
		this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
		this.now = options.now ?? Date.now;
		this.random = options.random ?? Math.random;
		this.log = options.log ?? (() => {});
		this.onSnapshot = options.onSnapshot ?? (() => {});
		this.cachePath = join(options.userDataDir, ANNOUNCEMENT_CACHE_FILE);
	}

	/** 当前快照（渲染层 list 直接返回；不触发网络请求）。 */
	getState(): AnnouncementState {
		return this.state;
	}

	/**
	 * 启动：加载缓存（有则立即推送，重启后公告立即可见）→ 延迟抖动首拉 →
	 * 链式 setTimeout 维持 2h 周期。清理由 index.ts 登记 QuitCleanupRegistry → stop()，
	 * 服务自身不感知装配层。
	 */
	start(): void {
		this.loadCache();
		const startupDelay =
			ANNOUNCEMENT_STARTUP_DELAY_MS + Math.floor(this.random() * ANNOUNCEMENT_STARTUP_JITTER_MS);
		const scheduleNext = (): void => {
			// 用链式 setTimeout 而非 setInterval：拉取耗时超过 interval 时不会堆叠并发请求
			this.refreshTimer = setTimeout(() => {
				void this.refresh("timer").finally(scheduleNext);
			}, ANNOUNCEMENT_REFRESH_INTERVAL_MS);
			this.refreshTimer.unref?.();
		};
		this.refreshTimer = setTimeout(() => {
			void this.refresh("timer").finally(scheduleNext);
		}, startupDelay);
		this.refreshTimer.unref?.();
	}

	/** 停止：清定时器（退出清理调用；幂等，重复调用安全）。 */
	stop(): void {
		if (this.refreshTimer !== null) {
			clearTimeout(this.refreshTimer);
			this.refreshTimer = null;
		}
	}

	/**
	 * 拉取并更新状态：按源列表顺序尝试，任一源返回合法 feed 即采纳；全部失败时
	 * 保留现状（缓存或空态），不覆盖。成功后写缓存并推送快照。
	 * trigger 仅用于日志区分（timer/manual）。
	 */
	async refresh(trigger: "timer" | "manual" = "manual"): Promise<AnnouncementState> {
		// 防重入：周期拉取与手动刷新可能并发，第二个调用直接返回当前态
		if (this.refreshing) return this.state;
		this.refreshing = true;
		try {
			const items = await this.fetchFromAnySource();
			this.rawItems = items;
			this.state = {
				items: filterEffectiveItems(items, this.now(), this.options.appVersion),
				fetchedAt: this.now(),
				source: "remote",
				readIds: this.state.readIds,
			};
			this.persistCache();
			this.log("announcement", "announcement refreshed", { count: items.length, trigger });
			this.emit();
			return this.state;
		} catch (error) {
			// 全源失败：保留现状（缓存/空态），下次周期再试
			this.log("announcement", "announcement refresh failed", {
				trigger,
				error: error instanceof Error ? error.message : String(error),
			});
			return this.state;
		} finally {
			this.refreshing = false;
		}
	}

	/** 从源列表按序拉取；全部失败抛最后一个错误（refresh 统一 catch 归类）。 */
	private async fetchFromAnySource(): Promise<AnnouncementItem[]> {
		let lastError: unknown;
		for (const source of ANNOUNCEMENT_SOURCES) {
			try {
				let text = await this.downloadText(source.url);
				if (source.kind === "atomgit-contents") {
					// AtomGit v5 contents 返回 base64 包裹；解包失败（结构异常/被劫持）
					// 与 feed 解析失败同等对待——fallback 到下一源
					const unwrapped = unwrapAtomgitContents(text);
					if (unwrapped == null) throw new Error("invalid atomgit contents envelope");
					text = unwrapped;
				}
				const items = parseAnnouncementFeed(text);
				// 返回了合法 JSON 但结构不对（schema 演进/被劫持成别的文件）：换下一个源
				if (!items) throw new Error("invalid announcement feed");
				return items;
			} catch (error) {
				lastError = error;
			}
		}
		throw lastError ?? new Error("no announcement sources");
	}

	/**
	 * 单源下载：超时中止 + 大小上限。注意主进程 globalThis.fetch 走 Node undici、
	 * 不受 session 代理影响——这是有意的：公告源按「国内可达」排序（AtomGit 首选，
	 * raw 直连兜底海外/代理环境），无代理环境也可达。
	 */
	private async downloadText(url: string): Promise<string> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), ANNOUNCEMENT_TIMEOUT_MS);
		try {
			const response = await this.fetchImpl(url, {
				signal: controller.signal,
				redirect: "follow",
				headers: { "user-agent": "PiDeck-announcements" },
			});
			if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
			const buffer = await response.arrayBuffer();
			if (buffer.byteLength > ANNOUNCEMENT_MAX_BYTES) {
				throw new Error(`response too large (${buffer.byteLength} bytes) for ${url}`);
			}
			return new TextDecoder("utf-8").decode(buffer);
		} finally {
			clearTimeout(timer);
		}
	}

	/** 读缓存：损坏/版本不符整体忽略走空态（缓存是加速，不是信任源）。 */
	private loadCache(): void {
		try {
			if (!existsSync(this.cachePath)) return;
			const parsed: unknown = JSON.parse(readFileSync(this.cachePath, "utf8"));
			if (!isRecord(parsed) || parsed.cacheVersion !== 1) return;
			const rawList = Array.isArray(parsed.items) ? parsed.items : [];
			// 缓存虽出自本服务，仍逐条重校验（防手改/旧版本格式差异把脏数据带进内存）
			const raw = rawList
				.map((entry) => parseAnnouncementItem(entry))
				.filter((item): item is AnnouncementItem => item !== null);
			const readIds = Array.isArray(parsed.readIds)
				? parsed.readIds.filter((v): v is string => typeof v === "string")
				: [];
			this.rawItems = raw;
			this.state = {
				// 缓存读取时重新做 TTL/版本过滤：时间推移后过期条目自动消失，无需等下一次拉取
				items: filterEffectiveItems(raw, this.now(), this.options.appVersion),
				fetchedAt: typeof parsed.fetchedAt === "number" ? parsed.fetchedAt : null,
				source: "cache",
				readIds,
			};
			this.emit();
		} catch {
			// 缓存损坏：忽略，走空态（下次拉取成功会重写）
		}
	}

	/** 原子写缓存（tmp + rename，防半写损坏）；失败只记日志，不影响内存态。 */
	private persistCache(): void {
		try {
			mkdirSync(this.options.userDataDir, { recursive: true });
			const payload: AnnouncementCacheFile = {
				cacheVersion: 1,
				fetchedAt: this.state.fetchedAt,
				items: this.rawItems,
				readIds: this.state.readIds,
			};
			const tmp = `${this.cachePath}.tmp`;
			writeFileSync(tmp, JSON.stringify(payload), "utf8");
			renameSync(tmp, this.cachePath);
		} catch (error) {
			this.log("announcement", "announcement cache write failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/** 推送快照给渲染层（index.ts 注册 onSnapshot → webContents.send）。 */
	private emit(): void {
		this.onSnapshot(this.state);
	}

	/** 已读标记：幂等追加 id，裁剪上限后持久化 + 推送（未读数在渲染层重算）。 */
	markRead(id: string): void {
		if (typeof id !== "string" || id.length === 0 || id.length > 128) return;
		if (this.state.readIds.includes(id)) return;
		// 追加序 = 时间序，裁掉最旧（数组头部）保上限
		const readIds = [...this.state.readIds, id].slice(-READ_IDS_LIMIT);
		this.state = { ...this.state, readIds };
		this.persistCache();
		this.emit();
	}

	/** 全部已读：当前可见公告 id 全部并入已读集合，持久化 + 推送。 */
	markAllRead(): void {
		const all = new Set(this.state.readIds);
		for (const item of this.state.items) all.add(item.id);
		this.state = { ...this.state, readIds: [...all].slice(-READ_IDS_LIMIT) };
		this.persistCache();
		this.emit();
	}
}
