/**
 * 渲染层噪音的判定 + 聚合（main 与 renderer 共用，无 Electron/window 依赖）。
 *
 * 背景（issue #376）：Chromium 的良性通知（典型是 ResizeObserver loop）会同时命中两条管道——
 *   A. renderer 的 `window.onerror` / `unhandledrejection`（src/renderer/src/main.tsx → rendererLog IPC）
 *   B. main 的 `webContents.on("console-message")`（src/main/index.ts、src/main/pet/PetWindow.ts）
 * 0.9.x 两条管道都逐条落盘：同一事件写两遍，单日 500+ 行「ResizeObserver loop」把
 * EnvironmentDoctor 的「最近 7 天报错」统计灌满，真正的失败信号（MODULE_NOT_FOUND 等）被淹没。
 *
 * 统一口径（三条管道共用这一份）：
 * - 良性（见 `classifyRendererNoise`）：只有 renderer 自己的全局处理器写日志，main 的 console
 *   镜像直接跳过 → 同一事件只落一条；按时间窗口折叠成「×N 条」的 info，不进 error/warn 统计。
 * - 非良性：首条即时按原级别落盘（真实报错不能被延迟），窗口内重复折叠成一条降档汇总
 *   （error→warn、warn→info）→ `logs.errors` 只反映「首次发生次数」，不再被循环报错灌满。
 * - 持续刷屏时聚合窗口指数增长（30s → … → 1h 封顶），避免长时间循环把日志重新堆满。
 *
 * 修改判定或聚合规则必须同步 tests/rendererNoisePolicy.test.mjs。
 */
import type { AppLogLevel } from "./types/app";

/** 良性类别的稳定 key：既是日志区分维度，也是聚合键。 */
export type RendererNoiseKind = "resize-observer-loop";

/** 判定结果：是否良性 + 良性时的类别。 */
export type RendererNoiseVerdict = {
	benign: boolean;
	kind: RendererNoiseKind | null;
};

/** 良性类别的落盘与聚合属性。 */
export type RendererNoiseKindMeta = {
	kind: RendererNoiseKind;
	/** 聚合日志的消息串（每窗口一条，明细按 count 折叠）。 */
	message: string;
	/** 落盘级别：一律 info——良性噪音不进健康体检的 error/warn 统计。 */
	level: AppLogLevel;
	/** 首个聚合窗口（毫秒）；持续刷屏时按 RENDERER_NOISE_WINDOW_GROWTH 增长。 */
	windowMs: number;
};

/** 良性类别登记表：新增良性噪音在此一处登记（判定与属性不放两地）。 */
export const RENDERER_NOISE_KINDS: Record<RendererNoiseKind, RendererNoiseKindMeta> = {
	"resize-observer-loop": {
		kind: "resize-observer-loop",
		message: "Renderer benign ResizeObserver loop notifications",
		level: "info",
		windowMs: 30_000,
	},
};

/** 非良性（真实报错/告警）的默认聚合窗口。 */
export const RENDERER_NOISE_WINDOW_MS = 30_000;
/** 每结算一次，下一窗口的放大倍数（持续刷屏时降低写盘频率）。 */
export const RENDERER_NOISE_WINDOW_GROWTH = 2;
/** 聚合窗口上限：再怎么持续刷屏，同键同文案最多每小时一条汇总。 */
export const RENDERER_NOISE_WINDOW_MAX_MS = 3_600_000;

/**
 * 判断一条渲染层消息是否良性（可折叠、不参与错误统计）。
 *
 * ResizeObserver loop 是 Chromium 的良性通知：同一帧内 RO 回调又触发一次 resize，
 * 平台不提供堆栈（lineno/colno 为 0），既无法修复也不表示功能失败；
 * Streamdown 动画 + 可拖拽面板组合下每秒可达数十条。
 */
export function classifyRendererNoise(message: unknown): RendererNoiseVerdict {
	if (typeof message === "string" && message.includes("ResizeObserver loop")) {
		return { benign: true, kind: "resize-observer-loop" };
	}
	return { benign: false, kind: null };
}

/** 重复汇总的行级别：降一档，让 `logs.errors` 只统计首次发生。 */
export function toRendererNoiseSummaryLevel(level: AppLogLevel): AppLogLevel {
	if (level === "error") return "warn";
	if (level === "warn") return "info";
	return level;
}

/** 一次写盘结算。 */
export type RendererNoiseFlush = {
	/** 聚合键（良性为类别 key，非良性由调用方给定）。 */
	key: string;
	/** 本条代表的事件条数。 */
	count: number;
	/** 落盘级别（汇总行为降档后的级别）。 */
	level: AppLogLevel;
	message: string;
	windowMs: number;
	/** true = 重复汇总（首条已即时写过，count 为被折叠的重复条数）。 */
	summary: boolean;
	/** 首条事件携带的明细，汇总行沿用同一份便于定位首次发生位置。 */
	detail?: unknown;
};

export type RendererNoiseRecordOptions = {
	/** 首个聚合窗口；缺省 RENDERER_NOISE_WINDOW_MS。 */
	windowMs?: number;
	/**
	 * true = 首条也等到窗口结束再写（良性专用：只留一条 ×N，不产生首条 + 汇总两条）；
	 * false = 首条即时写盘（真实报错不能被窗口延迟）。
	 */
	deferFirst?: boolean;
	/** 首条事件的明细。 */
	detail?: unknown;
};

type NoiseWindow = {
	windowStart: number;
	total: number;
	suppressed: number;
	level: AppLogLevel;
	message: string;
	windowMs: number;
	deferFirst: boolean;
	detail?: unknown;
};

/**
 * 渲染层噪音聚合器：按 key + 时间窗口把重复事件折叠成「一条日志 + 计数」。
 *
 * 故意不用定时器——窗口到期由下一条事件或显式 `flushAll()` 触发，
 * 不引入常驻 timer 与随之而来的清理义务；尾部计数在窗口关闭时由调用方 flush 补齐。
 */
export class RendererNoiseAggregator {
	private readonly windows = new Map<string, NoiseWindow>();

	constructor(private readonly now: () => number = Date.now) {}

	/** 计入一条事件，返回本次应写盘的结算（0~2 条：可能同时结算上一窗口并写首条）。 */
	record(key: string, level: AppLogLevel, message: string, options: RendererNoiseRecordOptions = {}): RendererNoiseFlush[] {
		const time = this.now();
		const windowMs = options.windowMs ?? RENDERER_NOISE_WINDOW_MS;
		const deferFirst = options.deferFirst ?? false;
		const current = this.windows.get(key);
		if (current && time - current.windowStart < current.windowMs) {
			current.total += 1;
			current.suppressed += 1;
			return [];
		}
		const flushes: RendererNoiseFlush[] = [];
		if (current) flushes.push(...this.settle(key, current));
		this.windows.set(key, { windowStart: time, total: 1, suppressed: 0, level, message, windowMs, deferFirst, detail: options.detail });
		if (!deferFirst) {
			flushes.push({ key, count: 1, level, message, windowMs, summary: false, detail: options.detail });
		}
		return flushes;
	}

	/** 结算全部未完成窗口（窗口关闭/退出时补齐尾部计数，避免「刷了一路却一条没写」）。 */
	flushAll(): RendererNoiseFlush[] {
		const flushes: RendererNoiseFlush[] = [];
		for (const [key, window] of this.windows) {
			flushes.push(...this.settle(key, window));
		}
		this.windows.clear();
		return flushes;
	}

	private settle(key: string, window: NoiseWindow): RendererNoiseFlush[] {
		// 持续刷屏：下一窗口翻倍（封顶 1h），避免长时间循环把日志重新堆满。
		const nextWindowMs = Math.min(window.windowMs * RENDERER_NOISE_WINDOW_GROWTH, RENDERER_NOISE_WINDOW_MAX_MS);
		if (nextWindowMs !== window.windowMs) window.windowMs = nextWindowMs;
		const base = { key, message: window.message, windowMs: window.windowMs, detail: window.detail };
		// 良性（deferFirst）：窗口内一条都没写过，结算行写出总条数。
		if (window.deferFirst) return [{ ...base, count: window.total, level: window.level, summary: false }];
		// 非良性：首条已即时写过，确实折叠掉重复时才补一条降档汇总。
		if (window.suppressed <= 0) return [];
		return [{ ...base, count: window.suppressed, level: toRendererNoiseSummaryLevel(window.level), summary: true }];
	}
}

/** 把一次结算转成写日志用的参数（文案里的计数与「repeated」标记统一在此处，三条管道一致）。 */
export function toRendererNoiseLog(flush: RendererNoiseFlush): { level: AppLogLevel; message: string; detail: unknown } {
	return {
		level: flush.level,
		message: flush.summary || flush.count > 1 ? `${flush.message} (${flush.count} in ${Math.round(flush.windowMs / 1000)}s)` : flush.message,
		detail: { ...(typeof flush.detail === "object" && flush.detail !== null ? (flush.detail as Record<string, unknown>) : { detail: flush.detail }), noiseKey: flush.key, count: flush.count, windowMs: flush.windowMs, repeated: flush.summary },
	};
}
