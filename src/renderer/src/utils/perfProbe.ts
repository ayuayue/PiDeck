/**
 * 渲染层长任务探针（Phase 0，见 docs/acp-replay-batching-plan.md）。
 *
 * 目的：ACP 重放「卡一下」需要知道渲染主线程到底被占了多久，才能判断要不要做跨进程的
 * 窗口化/分块改造。这里只观察不干预：不包 React、不改调度、不新增通道。
 *
 * 开关：DevTools 执行 `localStorage.setItem("pideck:perf-log", "1")` 后重载窗口。
 * 默认关闭时 install 直接返回，零订阅零开销。
 *
 * 输出走调用方给的 log（main.tsx 注入 writeRuntimeLog → 应用日志文件），
 * 这样「问题反馈」导出诊断时能一起带出来。
 */

export const PERF_PROBE_STORAGE_KEY = "pideck:perf-log";
/** 开关只解析一次（热路径上不重复读 localStorage）；测试可用 resetPerfProbeCache 复位。 */
let probeEnabledCache: boolean | null = null;
export function resetPerfProbeCache(): void {
	probeEnabledCache = null;
}
/** 超过这个时长才算 longtask（浏览器口径是 50ms）。 */
const DEFAULT_LONG_TASK_MS = 50;
const DEFAULT_SUMMARY_INTERVAL_MS = 5_000;

export type PerfProbeStats = { count: number; maxMs: number; totalMs: number; windowMs: number };

export function isPerfProbeEnabled(storage: Pick<Storage, "getItem"> | null | undefined): boolean {
	if (!storage) return false;
	try {
		return storage.getItem(PERF_PROBE_STORAGE_KEY) === "1";
	} catch {
		// 隐私模式 / 存储被禁用：当作关闭，不让探针本身变成新的失败源。
		return false;
	}
}

export function formatLongTaskLine(durationMs: number, startTime: number): string {
	return `[perf] longtask ${Math.round(durationMs)}ms @${Math.round(startTime)}ms`;
}

export function formatMeasureLine(name: string, durationMs: number): string {
	return `[perf] measure ${name} ${Math.round(durationMs)}ms`;
}

/**
 * 分段计时：返回 stop()，stop 时打一条 `[perf] measure <name> <ms>`。
 *
 * 用来把一次 longtask 拆开看——比如「结构化克隆 + 原子合并」和「React 提交」各占多少。
 * 只在探针开启时计时；关闭时 stop 是空函数，调用点只多一次判断。
 */
function probeEnabled(): boolean {
	if (typeof performance === "undefined") return false;
	if (probeEnabledCache === null) probeEnabledCache = isPerfProbeEnabled(typeof localStorage === "undefined" ? null : localStorage);
	return probeEnabledCache;
}

/**
 * 事件到达打点：`[perf] event <channel> @<performance.now()>`。
 *
 * 和 longtask 行用同一个时钟（performance.now），可以直接对齐：
 * 若 longtask 的起点明显早于事件打点，说明耗时在「反序列化 + 派发」这段（事件回调之前），
 * 不在回调里——这是区分「IPC 体量」与「渲染」的唯一手段。
 */
export function perfEvent(channel: string): void {
	if (!probeEnabled()) return;
	console.info(`[perf] event ${channel} @${Math.round(performance.now())}`);
}

export function perfSpan(name: string): () => void {
	// 每次消息事件都会调到这里：关闭时连 performance.now 都不取。
	if (!probeEnabled()) return () => undefined;
	const startedAt = performance.now();
	return () => {
		// 走 console 而不是注入 log：atoms 这类模块不该依赖 main.tsx 的日志出口，
		// 探针开启时 DevTools 控制台同样能看到（e2e 也从控制台抓）。
		console.info(formatMeasureLine(name, performance.now() - startedAt));
	};
}

export function formatLongTaskSummary(stats: PerfProbeStats): string {
	const average = stats.count > 0 ? Math.round(stats.totalMs / stats.count) : 0;
	return `[perf] longtask summary tasks=${stats.count} max=${Math.round(stats.maxMs)}ms avg=${average}ms total=${Math.round(stats.totalMs)}ms window=${Math.round(stats.windowMs)}ms`;
}

/**
 * 安装探针；返回卸载函数。重复调用幂等（第二次直接返回第一次的卸载函数）。
 */
export function installPerfProbe(options: {
	log: (message: string, detail?: unknown) => void;
	storage?: Pick<Storage, "getItem"> | null;
	longTaskThresholdMs?: number;
	summaryIntervalMs?: number;
	/** 测试注入时钟；缺省 Date.now。 */
	now?: () => number;
}): () => void {
	const storage = options.storage === undefined ? (typeof localStorage === "undefined" ? null : localStorage) : options.storage;
	if (!isPerfProbeEnabled(storage)) return () => undefined;
	const threshold = Math.max(1, options.longTaskThresholdMs ?? DEFAULT_LONG_TASK_MS);
	const interval = Math.max(0, options.summaryIntervalMs ?? DEFAULT_SUMMARY_INTERVAL_MS);
	const now = options.now ?? Date.now;
	// longtask 只有 Chromium 有；没有就静默退出，不影响功能。
	if (typeof PerformanceObserver === "undefined" || !PerformanceObserver.supportedEntryTypes?.includes("longtask")) return () => undefined;

	let stats: PerfProbeStats = { count: 0, maxMs: 0, totalMs: 0, windowMs: 0 };
	const windowStartedAt = now();
	let summaryTimer: ReturnType<typeof setInterval> | null = null;
	const flushSummary = () => {
		if (stats.count === 0) return;
		options.log(formatLongTaskSummary({ ...stats, windowMs: now() - windowStartedAt }));
		stats = { count: 0, maxMs: 0, totalMs: 0, windowMs: 0 };
	};
	const observer = new PerformanceObserver((list) => {
		for (const entry of list.getEntries()) {
			if (entry.duration < threshold) continue;
			stats = { count: stats.count + 1, maxMs: Math.max(stats.maxMs, entry.duration), totalMs: stats.totalMs + entry.duration, windowMs: stats.windowMs };
			options.log(formatLongTaskLine(entry.duration, entry.startTime), { name: entry.name });
		}
	});
	try {
		observer.observe({ entryTypes: ["longtask"] });
	} catch {
		return () => undefined;
	}
	if (interval > 0) summaryTimer = setInterval(flushSummary, interval);
	return () => {
		observer.disconnect();
		if (summaryTimer !== null) clearInterval(summaryTimer);
		flushSummary();
	};
}
