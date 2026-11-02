/**
 * 时间线虚拟化的纯策略（可单测）：什么时候该虚拟化、虚拟区与「真实渲染尾部」怎么切、
 * 哪条渲染条目真的会产出 DOM，以及高度缓存怎么参与估算。
 *
 * 为什么只虚拟化「历史轮」：跟底引擎、流式增量和锚点恢复都建立在真实几何上，
 * 把当前轮和最近几轮留在 DOM 里，这三处契约一行都不用改；虚拟区只承担
 * 「早就结束、用户很少回看」的轮次。
 */
import { isNotifiableCustomType } from "../notifySummary";
import { isRetryStatusMessage } from "../timelineFailureNotice";
import type { ChatMessage } from "../../../../../shared/types";

/** 轮数不超过这个值时不虚拟化：固定开销（测量 + 两层 div）不值得。 */
export const VIRTUAL_MIN_TURNS = 8;
/** 尾部始终真实渲染的轮数：当前轮 + 最近两轮，保证跟底/流式/自动展开不走虚拟路径。 */
export const VIRTUAL_SOLID_TAIL_TURNS = 3;
/** 未测量轮的高度估值（px）：宁大勿小，总高度偏小会让滚动条把内容「挤」上去。 */
export const VIRTUAL_ESTIMATED_RUN_HEIGHT = 900;

export function shouldVirtualizeTurnList(agentRunCount: number, minTurns: number = VIRTUAL_MIN_TURNS): boolean {
	return Number.isFinite(agentRunCount) && agentRunCount > minTurns;
}

export interface VirtualTurnSplit {
	/** 进入虚拟区（可回收）的轮数，从列表头部算起。 */
	virtualCount: number;
	/** 真实渲染的起始下标（含），到列表末尾为止。 */
	solidStart: number;
}

/**
 * 按「轮」切分（渲染列表里 user 气泡与 agent-run 混排，所以不能按条目数切）。
 *
 * 从尾部往前数 solidTailRuns 个 agent-run，找到后把切点再前移到它前面最近的 user 条目——
 * 这样整轮（提问 + 回复）一起留在真实渲染区，不会出现「只剩回复、找不到提问」。
 * 找不到足够 run 时全部真实渲染。
 */
export function splitVirtualRunsByTail<T>(items: readonly T[], isAgentRun: (item: T) => boolean, solidTailRuns: number = VIRTUAL_SOLID_TAIL_TURNS, minTurns: number = VIRTUAL_MIN_TURNS): VirtualTurnSplit {
	// 阈值按「总轮数」判断：尾部数到的 run 数不能与总量混用（否则 20 轮会被判成 2 轮）。
	const totalRuns = items.reduce((count, item) => (isAgentRun(item) ? count + 1 : count), 0);
	if (totalRuns <= minTurns) return { virtualCount: 0, solidStart: 0 };
	const wanted = Math.max(1, Math.trunc(solidTailRuns) || 1);
	let runs = 0;
	for (let index = items.length - 1; index >= 0; index -= 1) {
		if (!isAgentRun(items[index] as T)) continue;
		runs += 1;
		if (runs >= wanted) {
			// 切点前移到该 run 前最近的 user 条目：整轮（user 气泡 + 回复）一起留在真实渲染区，
			// 否则提问会被切进虚拟区，只剩回复。
			let start = index;
			for (let j = index - 1; j >= 0; j -= 1) {
				if (isAgentRun(items[j] as T)) break;
				start = j;
			}
			return { virtualCount: start, solidStart: start };
		}
	}
	return { virtualCount: 0, solidStart: 0 };
}

/** 某轮的高度：优先用实测缓存，未测量或非法值回落到估值。 */
export function resolveRunHeight(cache: ReadonlyMap<string, number>, id: string, estimate: number = VIRTUAL_ESTIMATED_RUN_HEIGHT): number {
	const measured = cache.get(id);
	return typeof measured === "number" && Number.isFinite(measured) && measured > 0 ? measured : estimate;
}

/**
 * 渲染条目的最小结构：只读 role / meta，兼容 RenderMessage 的各分支。
 * 声明成结构类型而不是 import RenderMessage，是因为本模块要能被 Node 纯测试直接加载。
 */
export interface RenderableTimelineItem {
	kind: string;
	message?: { role?: string; meta?: unknown } | undefined;
}

/**
 * 这条渲染条目是否真的会产出 DOM（时间线 renderRunItem 与虚拟区 entries 共用的唯一判据）。
 *
 * 为什么必须共用：VirtualRunList 只为「可渲染」条目建包装 div。判据放宽，会为一堆返回 null
 * 的条目各挂一个空 div，相邻两轮的行距直接翻倍；判据收紧，则会把本该显示的卡片从虚拟区里
 * 静默丢掉。所以这里逐条复刻 renderRunItem 的 return null 分支：
 * - 非 agent-run / message（tool-group 等中间分组不收进时间线顶层）→ 不渲染；
 * - role 不是 user / error / system 的 message → 不渲染；
 * - system 的 askQuestion 占位、compaction 摘要卡 → 不渲染；
 * - system 的 customMessage 只渲染通知白名单（白名单表在 notifySummary，单一真值）；
 * - system 的重试状态卡（RETRY_STATUS_KEYS）→ 不渲染（过程行已承担留痕）。
 */
export function isRenderableRunItem(item: RenderableTimelineItem): boolean {
	if (item.kind === "agent-run") return true;
	if (item.kind !== "message") return false;
	const message = item.message;
	if (!message) return false;
	if (message.role === "user" || message.role === "error") return true;
	if (message.role !== "system") return false;
	const meta = message.meta && typeof message.meta === "object" ? (message.meta as { type?: unknown; customType?: unknown }) : undefined;
	if (meta?.type === "askQuestion") return false;
	if (meta?.type === "customEntry") return true;
	if (meta?.type === "customMessage") return isNotifiableCustomType(meta.customType);
	if (meta?.type === "compaction") return false;
	// isRetryStatusMessage 只读 meta.i18nKey，这里给最小结构即可（不需要完整 ChatMessage 字段）。
	if (isRetryStatusMessage(message as ChatMessage)) return false;
	return true;
}

/**
 * 把「必须挂载的行」并进虚拟器的可见范围。
 *
 * 为什么需要：扩窗/翻页在顶部插入轮次时，controller 要按 [data-message-id] 查 DOM
 * 把钉住的行拉回原位。插入后那一行会被推出 overscan，虚拟区不渲染它 -> 查不到 ->
 * 补偿落空 -> 视口掉位。整表渲染能解决，代价是全部已加载轮次真实挂载（137 轮必掉帧）。
 * 这里只多挂那一行。
 *
 * 库要求返回**升序去重**的数组。这里保证三件事：升序、无重复、每个下标都合法。
 * 引用优化是做不到的——调用方传进来的 base 来自 defaultRangeExtractor，每次都是新数组，
 * tanstack 也不按引用判缓存（calculateRange 由 scrollOffset / count 驱动）。别写这种承诺。
 *
 * limit 是行数上限（count）：越界下标一旦进 rangeExtractor，tanstack 会按它去取
 * virtualEntries[undefined] 渲染空行。调用方本来就只从合法范围里取，但纯函数不该依赖
 * 调用方自律 —— 换个调用方就是一次越界。
 */
export function mergePinnedRange(base: readonly number[], pinned: readonly number[], limit?: number): readonly number[] {
	if (pinned.length === 0) return base;
	let merged: number[] | undefined;
	for (const index of pinned) {
		if (!Number.isInteger(index) || index < 0) continue;
		if (limit !== undefined && index >= limit) continue;
		const source = merged ?? base;
		if (source.includes(index)) continue;
		merged = [...source, index];
	}
	if (!merged) return base;
	merged.sort((a, b) => a - b);
	return merged;
}

/**
 * 开发期自证：rangeExtractor 的产出必须**严格升序、无重复、无越界**。
 *
 * 为什么单独抽成函数：断言本身要能被单测喂坏样本（越界 / 乱序 / 重复都必须抛），
 * 而不是只靠「源码里出现过这几个字符串」钉住。放在这里是因为它是纯逻辑，不碰 DOM。
 *
 * 为什么它只该在开发期跑：mergePinnedRange 已经保证这三件事（见上一段注释），
 * 所以这条断言一旦触发，说明 mergePinnedRange 自己坏了。生产环境里 throw 会被
 * 根级 AppErrorBoundary 兜住 → 整个应用降级成错误页，用户丢的是全部会话，
 * 不是时间线里一行空白。开发期炸、生产期忍，是正确的取舍。
 */
export function assertRangeIndexes(indexes: readonly number[], limit: number): void {
	for (let i = 0; i < indexes.length; i += 1) {
		const index = indexes[i];
		if (!Number.isInteger(index) || index < 0 || index >= limit) {
			throw new Error("[virtualTimelinePolicy] range 下标越界：" + index + "（limit=" + limit + "）");
		}
		if (i > 0 && index <= indexes[i - 1]) {
			throw new Error("[virtualTimelinePolicy] range 未严格升序/重复：" + indexes[i - 1] + " then " + index);
		}
	}
}
