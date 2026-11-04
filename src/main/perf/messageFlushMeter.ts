/**
 * agents:message 投递计量（Phase 0，见 docs/acp-replay-batching-plan.md）。
 *
 * 为什么要有：ACP 重放「卡一下」的归因缺一个可复现的数字——是 payload 太大、
 * 还是渲染层处理太重？没有测量就不该动跨进程改造。这里只记录，不改变任何投递行为。
 *
 * 能力边界（对齐 RemoteCallMeter 的纪律）：
 * - 内存 only、无 IPC、无新通道；
 * - 有界：每个 backend 只留聚合值 + 最近一次样本，不随会话增长；
 * - 默认静默：只在 `PIDECK_PERF_LOG=1` 时打印，且关闭时 record 只做一次布尔判断。
 *
 * 关闭时不计算 JSON 体积（那是这条链上唯一明显的额外开销）。
 */

/** 单次投递样本。messages 是**实际投递**的条数，totalLength 是会话全量条数。 */
export type MessageFlushSample = {
	backend: string;
	agentId: string;
	/** 本次投递携带的消息条数（窗口化/增量后可能远小于全量）。 */
	delivered: number;
	/** 会话全量条数（载荷里的 totalLength；缺省时等于 delivered）。 */
	total: number;
	/** JSON 体积（字节）。 */
	bytes: number;
	/** 增量尾部起点；undefined = 全量投递。 */
	upsertFrom?: number;
	/** 窗口起点；undefined = 从数组头部开始。 */
	windowStart?: number;
	/** 从 emit 调用到返回的耗时（结构化克隆前的序列化 + 发送）。 */
	emitMs: number;
};

export type MessageFlushAggregate = {
	backend: string;
	flushes: number;
	totalBytes: number;
	maxBytes: number;
	maxDelivered: number;
	/** 带 windowStart 的投递次数（窗口化已生效）。 */
	windowed: number;
	/** 带 upsertFrom 的投递次数（增量已生效）。 */
	incremental: number;
	maxEmitMs: number;
	last: MessageFlushSample | null;
};

export type MessageFlushMeter = {
	readonly enabled: boolean;
	record(sample: MessageFlushSample): void;
	snapshot(): MessageFlushAggregate[];
	reset(): void;
};

/** 单个 payload 超过这个体积就立即打一行——正是重放卡顿要找的那种投递。 */
const DEFAULT_LARGE_FLUSH_BYTES = 256 * 1024;
const DEFAULT_LOG_INTERVAL_MS = 5_000;

/** 一行汇总：`flush-meter acp flushes=3 maxBytes=812KB maxDelivered=812 windowed=0/3 incremental=0/3 maxEmitMs=4.1`。 */
export function formatMessageFlushMeter(aggregates: readonly MessageFlushAggregate[]): string {
	if (aggregates.length === 0) return "flush-meter (no flush recorded)";
	return aggregates
		.map((entry) => {
			const avgKb = entry.flushes > 0 ? Math.round(entry.totalBytes / entry.flushes / 1024) : 0;
			return `flush-meter ${entry.backend} flushes=${entry.flushes} maxBytes=${Math.round(entry.maxBytes / 1024)}KB avgBytes=${avgKb}KB maxDelivered=${entry.maxDelivered} windowed=${entry.windowed}/${entry.flushes} incremental=${entry.incremental}/${entry.flushes} maxEmitMs=${entry.maxEmitMs.toFixed(1)}`;
		})
		.join(" | ");
}

/** 单次投递的一行明细（超过阈值时立即打印，便于把「卡的那一下」和具体投递对上）。 */
export function formatMessageFlushSample(sample: MessageFlushSample): string {
	return `flush-large ${sample.backend} agent=${sample.agentId.slice(0, 8)} bytes=${Math.round(sample.bytes / 1024)}KB delivered=${sample.delivered} total=${sample.total} upsertFrom=${sample.upsertFrom ?? "-"} windowStart=${sample.windowStart ?? "-"} emitMs=${sample.emitMs.toFixed(1)}`;
}

export function createMessageFlushMeter(
	options: {
		enabled?: () => boolean;
		log?: ((line: string) => void) | null;
		now?: () => number;
		logIntervalMs?: number;
		largeFlushBytes?: number;
		/** 体积计算口：测试可替换，避免真去 stringify。 */
		measureBytes?: (payload: unknown) => number;
	} = {},
): MessageFlushMeter {
	const enabled = options.enabled ?? (() => process.env.PIDECK_PERF_LOG === "1");
	// 默认打到主进程 console：`PIDECK_PERF_LOG=1 npm run dev` 时直接可见，不引入新通道。
	// 打包产物从终端启动同样能拿到；需要落文件时由调用方注入 log。
	const log = options.log === undefined ? (line: string) => console.info(line) : options.log;
	const now = options.now ?? Date.now;
	const logIntervalMs = Math.max(0, options.logIntervalMs ?? DEFAULT_LOG_INTERVAL_MS);
	const largeFlushBytes = Math.max(1, options.largeFlushBytes ?? DEFAULT_LARGE_FLUSH_BYTES);
	const measureBytes = options.measureBytes ?? ((payload: unknown) => Buffer.byteLength(JSON.stringify(payload) ?? "", "utf8"));
	const aggregates = new Map<string, MessageFlushAggregate>();
	// 从创建时刻起算：第一次投递不立刻刷汇总，避免「刚启动就一行 flush-meter」的噪声。
	let lastLogAt = now();

	function flushSummaryIfDue(): void {
		if (!log) return;
		const at = now();
		if (at - lastLogAt < logIntervalMs) return;
		lastLogAt = at;
		log(formatMessageFlushMeter([...aggregates.values()]));
	}

	return {
		get enabled() {
			return enabled();
		},
		record(sample: MessageFlushSample): void {
			const current = aggregates.get(sample.backend) ?? {
				backend: sample.backend,
				flushes: 0,
				totalBytes: 0,
				maxBytes: 0,
				maxDelivered: 0,
				windowed: 0,
				incremental: 0,
				maxEmitMs: 0,
				last: null,
			};
			current.flushes += 1;
			current.totalBytes += sample.bytes;
			current.maxBytes = Math.max(current.maxBytes, sample.bytes);
			current.maxDelivered = Math.max(current.maxDelivered, sample.delivered);
			current.maxEmitMs = Math.max(current.maxEmitMs, sample.emitMs);
			if (sample.windowStart !== undefined) current.windowed += 1;
			if (sample.upsertFrom !== undefined) current.incremental += 1;
			current.last = sample;
			aggregates.set(sample.backend, current);
			if (log && sample.bytes >= largeFlushBytes) log(formatMessageFlushSample(sample));
			flushSummaryIfDue();
		},
		snapshot(): MessageFlushAggregate[] {
			return [...aggregates.values()].map((entry) => ({ ...entry }));
		},
		reset(): void {
			aggregates.clear();
			lastLogAt = now();
		},
	};
}

/** 默认实例：emit 点直接用；关闭时 record 走一次布尔判断即返回。 */
export const messageFlushMeter = createMessageFlushMeter();

/**
 * 发一次 agents:message 并计量。关闭时行为与直接 emit 完全一致（多一次函数调用）。
 *
 * payload 形状是既有的 { agentId, messages, totalLength?, upsertFrom?, windowStart? }，
 * 这里只读不写，投递内容原样透传。
 */
export function emitAgentMessageMeasured<T extends { messages?: unknown; totalLength?: unknown; upsertFrom?: unknown; windowStart?: unknown }>(backend: string, agentId: string, payload: T, emit: (payload: T) => void): void {
	if (!messageFlushMeter.enabled) {
		emit(payload);
		return;
	}
	const startedAt = performance.now();
	emit(payload);
	const delivered = Array.isArray(payload.messages) ? payload.messages.length : 0;
	const total = typeof payload.totalLength === "number" ? payload.totalLength : delivered;
	messageFlushMeter.record({
		backend,
		agentId,
		delivered,
		total,
		bytes: Buffer.byteLength(JSON.stringify(payload) ?? "", "utf8"),
		...(typeof payload.upsertFrom === "number" ? { upsertFrom: payload.upsertFrom } : {}),
		...(typeof payload.windowStart === "number" ? { windowStart: payload.windowStart } : {}),
		emitMs: performance.now() - startedAt,
	});
}
