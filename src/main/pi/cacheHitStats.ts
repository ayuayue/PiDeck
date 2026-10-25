import { open } from "node:fs/promises";
import { estimateTokensFromJsonValue, estimateTokensFromText } from "../tokenEstimate";
import { applyPromptMessage, createPromptLoadout, estimatePromptLoadoutTokens, hasMeasuredPromptLoadout, type PromptLoadout, resetPromptLoadoutFromSnapshot } from "./promptLoadout";

/**
 * 会话缓存命中率统计：
 * 解析 session JSONL 中所有 assistant 消息的 usage，计算
 * - latest：最后一条 assistant 消息的命中率（与 pi CLI footer 的 latestCacheHitRate 一致）
 * - average：全部 assistant 消息的算术平均命中率（「当前会话平均缓存率」）
 *
 * 命中率口径（与 pi 一致）：cacheRead / (input + cacheRead + cacheWrite) * 100
 *
 * ── 2026-09 大会话闪退（务必先读）────────────────────────────────
 * 本模块原先把整份会话文件 `readFile(path, "utf8")` 再 `split(/\r?\n/)` 逐行统计。
 * 它被 `AgentManager.getRuntimeState` 调用，而该接口是**高频轮询路径**，于是
 * Codex 导入产生的 1GB 级会话一旦被选中就必然踩中主进程的两个硬边界：
 *  - 文件字符数超过 V8 单字符串上限（2^29-24 ≈ 5.37 亿字符）→ ERR_STRING_TOO_LONG；
 *  - 更常见的是几百 MB 的文件先建出大字符串，再撞主进程 384MB 老生代堆上限 →
 *    V8 `FatalProcessOutOfMemory` **abort 整个主进程**。abort 不是可捕获异常，
 *    AppLogger 拿不到堆栈，主进程即应用本体，用户看到的就是「打开/停留在大会话就闪退」。
 *
 * 因此现在的实现有两条硬约束：
 *  1. **流式扫描**（`scanJsonlLines`），任何时刻只驻留单行；绝不 materialize 整个文件；
 *  2. **增量 + 有界**，见下方 `createCacheHitStatsReader`。
 *
 * 另外注意 latest 的语义：原来是「逆序遍历取首个命中」，流式只能顺序读，
 * 这里改为「顺序取最后一次命中」，结果等价且不必反向读整个文件。
 *
 * 每次扫描同时维护两样派生数据（口径与命中率无关，但同一次扫描里顺手算出，
 * 避免为圆环面板另扫一遍文件）：
 *  - `conversationTokens`：当前上下文纪元内对话消息的 token 估算（压缩行重置）；
 *  - `systemTokens` / `toolsTokens`：从系统消息条目重放出的提示词装载两段
 *    （见 promptLoadout.ts，压缩快照重置）。
 */

export type CacheHitStats = {
	/** 最后一条 assistant 消息的命中率（0-100），无样本时为 undefined */
	latest: number | undefined;
	/** 全部 assistant 消息的平均命中率（0-100），无样本时为 undefined */
	average: number | undefined;
	/** 参与统计的 assistant 消息条数 */
	sampleCount: number;
	/** 当前上下文纪元内对话消息的 token 估算（CJK 加权，含工具调用/结果文本，压缩后重置），
	 *  渲染层据此展示「对话占上下文比例」（见 SessionContextMeter）。 */
	conversationTokens?: number;
	/** 系统提示词 token 估算（会话文件里重放出的 sections；没有提示词装载时为 undefined）。 */
	systemTokens?: number;
	/** 工具声明 token 估算（会话文件里重放出的工具定义；没有提示词装载时为 undefined）。 */
	toolsTokens?: number;
	/** @deprecated 已由 conversationTokens 取代；保留字段仅为旧快照反序列化兼容，不再写入。 */
	messageChars?: number;
};

type UsageLike = {
	input?: number | null;
	cacheRead?: number | null;
	cacheWrite?: number | null;
};

/** 单条 usage → 命中率百分比；无有效 token 数据返回 undefined */
export function hitRateFromUsage(usage: UsageLike | undefined): number | undefined {
	if (!usage) return undefined;
	const input = usage.input ?? 0;
	const cacheRead = usage.cacheRead ?? 0;
	const cacheWrite = usage.cacheWrite ?? 0;
	const promptTokens = input + cacheRead + cacheWrite;
	if (promptTokens <= 0) return undefined;
	return (cacheRead / promptTokens) * 100;
}

/** 从消息对象估算 token：兼容 content 数组（text / toolCall 参数）与裸 text 字段。
 *  工具调用参数与工具结果也占上下文，漏计会把「系统+工具」段反向高估。 */
function messageConversationTokens(message: { role?: unknown; usage?: unknown; text?: unknown; content?: unknown; details?: unknown }): number {
	let tokens = 0;
	if (typeof message.text === "string") tokens += estimateTokensFromText(message.text);
	if (typeof message.content === "string") {
		tokens += estimateTokensFromText(message.content);
	} else if (Array.isArray(message.content)) {
		for (const part of message.content) {
			if (!part || typeof part !== "object") continue;
			const block = part as { type?: unknown; text?: unknown; arguments?: unknown };
			if (block.type === "text" && typeof block.text === "string") {
				tokens += estimateTokensFromText(block.text);
			} else if (block.type === "toolCall") {
				// pi 的历史把工具参数存在 assistant.content 的 toolCall 块里
				tokens += estimateTokensFromJsonValue(block.arguments);
			} else if ((block.type === "toolResult" || block.type === "resource") && block.arguments != null) {
				// 防御：非 pi 标准块形状也尽量计入，未知形状不丢估
				tokens += estimateTokensFromJsonValue(block.arguments);
			}
		}
	}
	// toolResult 角色消息：结果正文在 content（上面已计），details 里可能是结构化补充
	if (message.role === "toolResult" && message.details != null) {
		tokens += estimateTokensFromJsonValue(message.details);
	}
	return tokens;
}

/** 流式统计的累加器：顺序扫描时不断累积，最后交给 finishCacheHitStats 收敛。 */
export type CacheHitAccumulator = {
	/** 命中率累加值（避免为平均值长期持有一个 rates 数组，大会话下可达数万项） */
	rateSum: number;
	/** 参与统计的样本数（= rates.length 的等价计数） */
	rateCount: number;
	/** 顺序扫描中最后一次命中的命中率 */
	latest: number | undefined;
	/** 当前上下文纪元的对话 token 估算（遇 compaction 行重置） */
	conversationTokens: number;
	/** 当前提示词装载（sections + 工具声明）：系统消息按文件顺序重放，压缩快照重置 */
	loadout: PromptLoadout;
};

export function createCacheHitAccumulator(): CacheHitAccumulator {
	return { rateSum: 0, rateCount: 0, latest: undefined, conversationTokens: 0, loadout: createPromptLoadout() };
}

/**
 * 消费一行 JSONL 到累加器。坏行 / 非消息行 / 无 usage 行一律跳过，
 * 与会话历史读取的容错口径一致（单行损坏不该让整场统计失败）。
 */
export function consumeCacheHitLine(state: CacheHitAccumulator, line: string): void {
	const trimmed = line.trim();
	if (!trimmed) return;
	try {
		const entry = JSON.parse(trimmed) as Record<string, unknown>;
		// compaction 行：压缩后旧消息归档、不再计入上下文，统计整体重置到「压缩摘要」纪元；
		// 提示词装载重置到压缩快照（pi 在压缩边界写完整 sections + 工具声明）。
		if (entry?.type === "compaction") {
			const summary = typeof entry.summary === "string" ? entry.summary : "";
			state.rateSum = 0;
			state.rateCount = 0;
			state.latest = undefined;
			state.conversationTokens = estimateTokensFromText(summary);
			resetPromptLoadoutFromSnapshot(state.loadout, entry.systemMessage);
			return;
		}
		const message = entry?.message as { role?: unknown; usage?: unknown; text?: unknown; content?: unknown; details?: unknown } | undefined;
		if (!message) return;
		// 系统消息属于「系统」段（内容在 sections 里），不再计入对话估算，否则三段重复计量。
		if (message.role === "system") {
			applyPromptMessage(state.loadout, message);
			return;
		}
		state.conversationTokens += messageConversationTokens(message);
		if (message.role !== "assistant" || !message.usage) return;
		const rate = hitRateFromUsage(message.usage as UsageLike);
		if (rate === undefined) return;
		// 顺序扫描：后命中的覆盖先命中的，结束时即「最后一条 assistant 消息」的命中率
		state.latest = rate;
		state.rateSum += rate;
		state.rateCount += 1;
	} catch {
		// 单行解析失败忽略，继续统计其余行
	}
}

/** 累加器 → 对外统计结果。 */
export function finishCacheHitStats(state: CacheHitAccumulator): CacheHitStats {
	// 提示词装载只在重放出内容时才有测量值：没有系统消息的老会话（或只剩删除补丁的空装载）
	// 保持两段都是 undefined，调用方据此退回旧口径，而不是当成「系统为 0」。
	const loadoutTokens = hasMeasuredPromptLoadout(state.loadout) ? estimatePromptLoadoutTokens(state.loadout) : undefined;
	const base: CacheHitStats = {
		latest: state.latest,
		average: undefined,
		sampleCount: 0,
		/** 当前纪元对话 token 估算：始终返回（可能为 0），渲染层据此估算对话占比 */
		conversationTokens: state.conversationTokens,
		...(loadoutTokens ? { systemTokens: loadoutTokens.systemTokens, toolsTokens: loadoutTokens.toolsTokens } : {}),
	};
	if (state.rateCount === 0) return base;
	return {
		...base,
		// 逐项相加再除，与旧的 rates.reduce 口径一致（浮点结果逐位相同量级）
		average: state.rateSum / state.rateCount,
		sampleCount: state.rateCount,
	};
}

/** 把一份（已读入内存的）JSONL 文本统计为命中率。仅供小文件 / 单测使用。 */
export function computeCacheHitStats(raw: string): CacheHitStats {
	const state = createCacheHitAccumulator();
	const lines = raw.split(/\r?\n/);
	for (const line of lines) consumeCacheHitLine(state, line);
	return finishCacheHitStats(state);
}

export type CacheHitStatsReader = (sessionPath: string) => Promise<CacheHitStats>;

type FileMeta = { size: number; mtimeMs: number };

type CacheHitStatsReaderInput = {
	/**
	 * 流式扫描会话文件（生产环境传 `scanJsonlLines`）。
	 * **不要**在这里退回 readFile 整读——那正是大会话闪退的成因。
	 *
	 * 回调第二个参数是行上下文（offset / byteLength / complete），增量续算靠它确定
	 * 「上次消费到哪个字节」；接收方可用不到-完整上下文的实现（仅限测试），
	 * 此时不做增量（每次整扫）。
	 */
	scanLines: (filePath: string, visitor: (line: string, context?: JsonlLineContextLike) => void, options: { start: number }) => Promise<void>;
	stat: (path: string) => Promise<FileMeta>;
	/** 缓存条目上限，超出时整体清空（会话数远小于该值，防御性上限） */
	maxEntries?: number;
};

/** 增量续算依赖的最小行上下文（与 jsonlLineStream.JsonlLineContext 的结构子集）。 */
export type JsonlLineContextLike = {
	offset: number;
	byteLength: number;
	complete: boolean;
};

/** 增量扫描的起始位置：只允许从「上次统计结束的整洁行边界」继续。 */
type CacheEntry = {
	meta: FileMeta;
	stats: CacheHitStats;
	/** 已消费到的字节偏移（= 最后一条完整行末尾 + 1），无完整行时为 0 */
	consumedBytes: number;
	/** 该偏移处的累加器状态，供下次增量续算 */
	accumulator: CacheHitAccumulator;
	/**
	 * 续扫锚点：`consumedBytes` 之前最后 ANCHOR_BYTES 字节的原文。
	 * 续扫前比对，用来证明「前缀没变、后续真的是追加」——否则会把改了前缀的文件当追加算错。
	 * 空字符串 = 本次无有效锚点（不续扫）。
	 */
	anchor: string;
};

/**
 * 锚点窗口大小。取 256B：足够拦住任何前缀改写（改名/修复会重写整文件），
 * 又小到每次续扫只多读一次 256B（相比尾部扫描可忽略）。
 */
const ANCHOR_BYTES = 256;

/**
 * 读取 `[end - ANCHOR_BYTES, end)` 的原文作为续扫锚点。
 * 读不到（文件变短 / 读失败）返回空串，调用方据此放弃续扫。
 */
async function readAnchor(sessionPath: string, end: number): Promise<string> {
	if (end <= 0) return "";
	const start = Math.max(0, end - ANCHOR_BYTES);
	const length = end - start;
	const handle = await open(sessionPath, "r");
	try {
		const buffer = Buffer.allocUnsafe(length);
		const { bytesRead } = await handle.read(buffer, 0, length, start);
		if (bytesRead !== length) return "";
		return buffer.toString("utf8");
	} finally {
		await handle.close();
	}
}

/**
 * 单文件解析超时 = 不设。
 *
 * 曾想过加超时保护，但「超时就放弃」与「必须落到缓存」互相矛盾：超时失败不写缓存时，
 * 一个 1GB 会话会在每次轮询都从 0 重扫一遍（超时 → 重试 → 再超时），比不设超时更糟。
 * 不阻塞主线程的职责已由 `scanJsonlLines` 承担（1MB 分块 + 每 400 行让出事件循环），
 * 首次扫描慢但只慢一次，结果落在缓存里。
 */

/**
 * 创建带「文件级缓存 + 增量续算」的命中率读取器。
 *
 * 两道防线应对高频轮询（`getRuntimeState`）：
 *  1. **未变化直接复用**：按 (size, mtimeMs) 判断，文件没动就是 O(1) 返回；
 *  2. **变化则增量续算**：会话是**只追加**的 JSONL，pi 每轮只往尾部写。因此只扫描
 *     `consumedBytes` 之后的新增内容，把新行的统计并进上次的累加器——1GB 老会话
 *     每次新增长尾时不再从头重扫（原先每次重算都是完整一遍 parse）。
 *
 * 边界与回退（保持与旧实现完全相同的对外语义）：
 *  - 文件变小（被重写/截断/换文件）→ 增量前提不成立，整文件重扫；
 *  - 上次结束位置带着末尾残行 → 从 `consumedBytes` 重扫该残行（不计半截行，也不丢它）；
 *  - 连 stat 都失败 → 返回空统计且**不写缓存**（下次仍会重试，不会把失败结果固化）。
 */
export function createCacheHitStatsReader(input: CacheHitStatsReaderInput): CacheHitStatsReader {
	const { scanLines, stat, maxEntries = 100 } = input;
	const cache = new Map<string, CacheEntry>();

	/** 扫描 [start, end) 区间，把结果并进给定累加器；返回实际消费到的字节偏移。 */
	const scanRange = async (sessionPath: string, accumulator: CacheHitAccumulator, start: number): Promise<number> => {
		let consumed = start;
		await scanLines(
			sessionPath,
			(line, context) => {
				consumeCacheHitLine(accumulator, line);
				// 残行（末尾未以 \n 结束）不计入已消费：pi 可能正在追加，下次要重扫它。
				// 缺上下文（测试替身）时不做增量，返回 start，调用方下次整扫。
				if (!context) return;
				if (context.complete) consumed = context.offset + context.byteLength + 1;
			},
			{ start },
		);
		return consumed;
	};

	return async function readCacheHitStats(sessionPath: string): Promise<CacheHitStats> {
		try {
			const meta = await stat(sessionPath);
			const cached = cache.get(sessionPath);

			// 防线 1：文件未变化 → 直接复用（高频轮询的主路径）
			if (cached && cached.meta.size === meta.size && cached.meta.mtimeMs === meta.mtimeMs) {
				return cached.stats;
			}

			// 防线 2：只追加 → 从上一次的行边界继续扫描。
			// 用锚点证实前缀未被改写：会话被 rename / 头部修复时是**整文件重写**
			// （rewriteJsonlLines 流式重写后原子改名），文件同样会变大，
			// 若只看 size 增长就会把「改过前缀的新文件」当成纯追加，统计出错。
			const previous = cached;
			let resume: { start: number; accumulator: CacheHitAccumulator } | null = null;
			if (previous && meta.size > previous.consumedBytes && previous.consumedBytes > 0) {
				const anchorMatched = await readAnchor(sessionPath, previous.consumedBytes)
					// 锚点读失败（文件正在被替换）：不续扫，至少不会算错
					.then((current) => current !== "" && current === previous.anchor)
					.catch(() => false);
				if (anchorMatched) {
					resume = { start: previous.consumedBytes, accumulator: previous.accumulator };
				}
			}

			const accumulator = resume?.accumulator ?? createCacheHitAccumulator();
			const consumedBytes = await scanRange(sessionPath, accumulator, resume?.start ?? 0);

			const stats = finishCacheHitStats(accumulator);
			if (cache.size >= maxEntries) cache.clear();
			// 锚点在扫描后重读（文件在此期间可能又变长，但 consumedBytes 之后的内容
			// 属于下次增量，不影响本次锚点对应的前缀；读失败则不续扫）
			const anchor = await readAnchor(sessionPath, consumedBytes).catch(() => "");
			cache.set(sessionPath, { meta, stats, consumedBytes, accumulator, anchor });
			return stats;
		} catch {
			// 文件不存在/无法读取：不缓存，返回空统计（下次重试；能读出 meta 的路径一定会落缓存）
			return { latest: undefined, average: undefined, sampleCount: 0 };
		}
	};
}
