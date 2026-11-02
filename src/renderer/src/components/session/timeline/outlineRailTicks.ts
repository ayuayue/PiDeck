/**
 * 会话定位轴（右缘刻度）的刻度规划（纯函数，可单测）。
 *
 * 数量上限：用户反馈「旁边横条太多」。调研三个真实实现后的取舍——
 * Proma 的 scroll-minimap 用 20 根**不可点的桶**做位置图（`MAX_BARS = 20`），
 * dsh TurnNavigator 与 vivid-layer Chat Minimap 都是「全部条目 + 能滚」。
 * 没有一家把游标窗口里的条当成跳转按钮：刻度可点就必须点得动。
 *
 * 取哪几条：先截**最近 `RAIL_RECENT_TICK_ITEMS` 条**提问（更早的交给展开态目录面板），
 * 再按**可用高度**算段数（`railCapacity` = 高度 / 12，无下限）——能一条一根就一条一根；
 * 放不下才把这段均分成 capacity 个连续段，每段只画段首（`railBuckets`）。段内其它提问
 * 没有消失：点这一段就跳到段首，再往下翻即可。
 *
 * 废弃过三种取法：稀疏采样（相邻提问整段丢掉、留下的常超出补页预算，点了没反应）、
 * 滑动窗口（纵向位置不等于会话进度，翻上翻下整列平移）、固定 30 段覆盖全量（一根代表
 * 两三条提问，点下去只落到段首，看起来像「定位到别的地方」）。
 *
 * 间距：能舒展就舒展（上限 14px），放不下就按条数收缩，硬下限 12px。段数由高度反推
 * （height / 12），所以刻度**永远不会溢出容器**，也就不需要导轨内部滚动（2026-10 重构
 * 删掉了那一整套滚动/渐隐/跟随机制）。反过来，若给条数加「不低于 30」的下限，小窗 +
 * 终端坞（消息列约 194px）就会被 30 × 12 = 360px 撑出边缘——那正是 2026-11 真机报的
 * 「长度快溢出了」。
 */

/** 刻度间距上限（px）：与既有观感一致（每格 14px）。 */
export const RAIL_TICK_MAX_SIZE = 14;
/**
 * 刻度间距下限（px）= **可点准的密度目标**，不是「能塞多密」的极限。
 *
 * 曾经是 6：那时的用意是「宁可密一点也不缩到不可点」，结果它被当成硬指标用——
 * railCapacity 拿它当分母（height/6），于是 1000px 的面板画 104 根、间距 6px、
 * 2px 线 + 4px 空隙连成一条虚线。2026-11 真机（136 轮会话）用户一次报了六条：
 * 「滑动不上去 / 卡 / 离得太近容易误触 / 无法停止 / 太密集 / 长度快溢出了」——
 * 六条全是这一个数字的副作用：太密则点不准、DOM 也多、滚动条还被这一列盖住。
 *
 * 改成 12：同一高度条数减半（1000px → 83 根），间距 12px、2px 线 + 10px 空隙，
 * 相邻刻度不再抢同一次点击。代价是一根可能代表 2 条提问（点它落到段首），
 * 这是拿「段内精确度」换「点得准 + 不卡」，用户当前抱怨的是后者。
 */
export const RAIL_TICK_MIN_SIZE = 12;
/** 刻度条数的**下限**（不是上限）：放得下时条数按可用高度算，见 railCapacity。 */
export const RAIL_TICK_LIMIT = 30;

/** 刻度条只覆盖「最近的这么多条提问」，更早的交给展开态目录面板。
 *
 *  为什么要有这个上限：刻度数 = 可用高度 / 12（约 66~90 根），与提问条数无关；
 *  147 条提问会被均分成 66 段以上，一根刻度背后可能差两三条。用户想找「第 87 条」
 *  点完还要往下翻 —— 于是有了展开态面板（全量检索）。两者分工之后，刻度条不必
 *  再承担「覆盖整段会话」的职责：它只负责最近这一段的快速定位。
 *
 *  取值演变：60 → 30（2026-11 真机）。用户的理由不是「太长」，是**一根要对应一条**：
 *  30 条固定小于任何正常窗口的容量（h=792 时 capacity=66），于是每根刻度恰好一条提问，
 *  点哪根就是哪条，不用再按段首猜测。代价是更早的提问只能走面板，但那正是面板的职责。
 *
 *  为什么不按「当前阅读位置附近的 N 条」（滑动窗口）：试过，被否决 ——
 *  纵向位置不再代表会话第几成、翻上翻下整列平移（2026-11 真机反馈）。
 *  这里取的是**固定尾部窗口**：永远是最新 N 条，位置稳定、不会随滚动漂移。
 */
export const RAIL_RECENT_TICK_ITEMS = 30;

/** 刻度条顶端的「更早」占位项 id。
 *
 *  切片后刻度顶端不再是第 1 条提问。不标的话，用户看到 60 根会以为那就是全部，
 *  往上滚到会话开头才发现最上面那根不是最早的问题。
 *
 *  **这个 id 不能交给 jumpToMessage**：它不在消息里，查不到节点会弹「跳转失败」——
 *  用户点一个「⋯」得到报错。点击它 = 打开目录面板（那才是查更早内容的入口）。
 *  判断分支在 SurfaceComponents 的 onItemSelect 里，两边都写了注释。
 */
/**
 * 刻度间距：按**实际渲染条数**算，不是按 railBuckets 之前那个数。
 *
 *  PreviewRail 的导轨总高 = items.length x itemSize（preview-rail.tsx 的 rowTemplate），
 *  而 planRailTicks 的分母是 visibleItems.length —— 顶端占位项让实际条数多 1，
 *  直接用 plan.itemSize 会让总高超出容器：h=800、count=66 时 plan 给 12px，
 *  67 x 12 = 804 就把导轨撑破（刻度被裁或顶出视口）。
 *
 *  下限 RAIL_TICK_MIN_SIZE 仍然生效，所以**调用方必须保证 total <= floor(h/12)**，
 *  否则 12px 的下限会把总高顶破 —— 占位项要从 railCapacity 里扣掉一格，
 *  这个扣除在 SurfaceComponents 的 railLimit 里做，两边是一对。
 */
export function planRailItemSize(total: number, availableHeight: number, fallback: number): number {
	if (total === 0 || availableHeight <= 0) return fallback;
	const fitted = Math.floor(availableHeight / total);
	return Math.max(RAIL_TICK_MIN_SIZE, Math.min(RAIL_TICK_MAX_SIZE, fitted));
}

export const OUTLINE_WINDOW_HEAD_ID = "outline-window-head";

/**
 * 刻度条数，按**可用高度**算：能一条一根就一条一根，放不下才均分。
 *
 * 为什么不再固定 30：固定 30 段时一根代表好几条提问，点下去只能落到段首——
 * 用户点的是「我想要的第 87 条」，落到的却是第 85 条所在的段首，看起来就是
 * 「定位到别的地方」（2026-11 真机，85 轮会话）。85 条 × 12px = 1020px，正常窗口
 * 装得下，没有理由为了 30 这个数字牺牲精确度。
 *
 * 放不下时（几百轮会话）仍按条数均分成 capacity 段，此时段内提问点段首可达。
 */
export function railCapacity(availableHeight: number): number {
	if (availableHeight <= 0) return RAIL_TICK_LIMIT;
	// 段数 = 可用高度 / 可点间距，**不再有「不低于 30」的下限**：30 x 12px = 360px，
	// 而小窗 + 终端坞的消息列只有约 194px —— 那条下限会把刻度撑出容器边缘，正是用户报的
	// 「长度快溢出了」。高度不够就少给几段，宁可段内多容几条，不能溢出去。
	return Math.max(1, Math.floor(availableHeight / RAIL_TICK_MIN_SIZE));
}
/**
 * 点未加载刻度时最多发起几次补页（保险丝，不是预算）。
 *
 * 旧实现是「每 60ms 轮询一次、最多 10 次」：`loadMoreMessages` 在上一页仍在飞时
 * 直接 return（in-flight 守卫），这些轮询全部空转，把 10 次预算烧在没有进展的等待上；
 * 一页 3 轮 × 实际成功的几页，很快就连「点最上面那一条」都够不着，于是弹出
 * 「这条提问还在更早的历史里」（2026-10 真机反馈：62 轮会话，点最上面的刻度必弹）。
 *
 * 现在由渲染层等 `isLoadingMoreMessages` 落地后再发下一页，本常量只做防死循环的保险丝：
 * 60 页 × 3 轮 ≈ 180 轮深度，够覆盖单会话的极端长度。
 */
export const RAIL_PENDING_MAX_ATTEMPTS = 60;
export type RailTickPlan<T> = {
	/** 实际渲染的条目（已按窗口截取）。 */
	items: T[];
	/** 每格间距（px），同时用于刻度行高与预览卡对位。 */
	itemSize: number;
};

/**
 * 把整段会话切成最多 limit 段的刻度（每段只画第一条）。
 *
 * 为什么不是「滑动窗口」：窗口跟着阅读位置走，底部时只有最新 30 条，刻度纵向位置
 * 既不等于会话进度，翻上翻下还会整列平移（2026-11 真机反馈「一开始显示不全、
 * 翻回来又退化」）。
 *
 * 为什么不是「全量」：条数随会话增长，73 轮就把右缘拉满（2026-11 真机反馈
 * 「怎么越来越长，屏幕装不下」）；而且「放得下就全量、放不下就窗口」存在断崖，
 * 阈值两侧行为突变，「纵向位置代表进度」在另一侧直接不成立。
 *
 * 所以按条数均分：条数 ≤ limit 时一根一条；超过则切成 limit 个连续段，每段只画
 * 第一根。刻度纵向位置从此代表「整段会话的第几成」，条数恒定、高度恒定。
 * 段内其它提问没有消失——点这一段就跳到段首。
 */
export function railBuckets<T>(items: readonly T[], limit = RAIL_TICK_LIMIT): T[] {
	const count = items.length;
	if (count <= limit) return [...items];
	const buckets: T[] = [];
	for (let index = 0; index < limit; index += 1) {
		// 段首取 ceil：与 railBucketIndexOf 的 floor 互为逆运算，两边算出的归属必须一致
		buckets.push(items[Math.min(count - 1, Math.ceil((index * count) / limit))]);
	}
	return buckets;
}

/**
 * 按容器可用高度规划刻度。
 * availableHeight ≤ 0（首帧未测量）时按上限间距渲染，测量后由
 * ResizeObserver 触发重算，不阻塞首帧。
 */
export function planRailTicks<T>(items: readonly T[], availableHeight: number): RailTickPlan<T> {
	const visible = [...items];
	const count = visible.length;
	if (count === 0) return { items: visible, itemSize: RAIL_TICK_MAX_SIZE };
	if (availableHeight <= 0) return { items: visible, itemSize: RAIL_TICK_MAX_SIZE };
	// 放得下就按上限间距舒展，放不下就按条数收缩，但不低于可点击下限
	const fitted = Math.floor(availableHeight / count);
	return { items: visible, itemSize: Math.max(RAIL_TICK_MIN_SIZE, Math.min(RAIL_TICK_MAX_SIZE, fitted)) };
}

export type OutlineRailItem = { id: string; role: string; title: string; time: string; entryId?: string; pending?: boolean };

/**
 * 合并「已加载消息大纲」与「索引目录」（计划 §6 S4）。
 *
 * 为什么需要：刻度原先只覆盖已加载消息，长会话最上面的刻度不是第一条提问。
 * 目录项按 entryId 去重：已加载的保留原文标题，未加载的用目录给的标题
 * （索引建表时带走的用户消息 preview，不是序号占位），顺序按目录（= 活动链）为准。
 */
export function mergeOutlineRailItems(loaded: readonly OutlineRailItem[], directory: readonly { entryId: string; title: string; time?: string }[]): OutlineRailItem[] {
	if (directory.length === 0) return [...loaded];
	const byEntryId = new Map<string, OutlineRailItem>();
	for (const item of loaded) if (item.entryId) byEntryId.set(item.entryId, item);
	const merged: OutlineRailItem[] = [];
	for (const entry of directory) {
		const hit = byEntryId.get(entry.entryId);
		if (hit) {
			merged.push(hit);
			continue;
		}
		merged.push({ id: `outline-pending:${entry.entryId}`, entryId: entry.entryId, role: "user", title: entry.title, time: entry.time ?? "", pending: true });
	}
	// 目录只覆盖用户检查点；已加载但没有 entryId 的 live 消息追加在尾部，不能凭空丢刻度。
	const seen = new Set(merged.map((item) => item.id));
	for (const item of loaded) if (!seen.has(item.id)) merged.push(item);
	return merged;
}

/** 是否为「目录里有、消息还没加载」的占位刻度。 */
export function isPendingRailItemId(id: string): boolean {
	return id.startsWith("outline-pending:");
}

/** 从占位刻度 id 取回 entryId。 */
export function pendingEntryIdOf(id: string): string | undefined {
	return id.startsWith("outline-pending:") ? id.slice("outline-pending:".length) : undefined;
}

/**
 * 占位刻度该往哪个方向找（纯函数，可单测）。
 *
 * 占位刻度只说明「目录里有、已加载消息里没有」，它本身不含方向：
 * 可能在对上号之前的老历史里（要向上补页），也可能比已加载的最新区间还新
 * （live 消息的 entryId 还没和目录对上，向上补页永远补不到）。
 *
 * 2026-11 真机：从第一条的位置点最后一条（最新提问），旧实现无条件向上补页，
 * 一路补到会话开头，然后弹「这条提问还在更早的历史里」——方向完全反了。
 *
 * 判据用目录顺序（= 时间顺序）：目标排在"最老的已加载条目"之前才需要补页。
 */
export function planRailJump(items: readonly OutlineRailItem[], targetId: string): { kind: "fill-earlier" } | { kind: "jump"; id: string } {
	const targetIndex = items.findIndex((item) => item.id === targetId);
	if (targetIndex < 0) return { kind: "jump", id: targetId };
	const firstLoadedIndex = items.findIndex((item) => item.pending !== true);
	// 一条都没加载（冷会话）：只能靠向上补页把数据拉进来
	if (firstLoadedIndex < 0) return { kind: "fill-earlier" };
	if (targetIndex < firstLoadedIndex) return { kind: "fill-earlier" };
	// 目标在已加载区间之内或之后：直接交给 controller 扩窗/落位。
	// 占位项没有投影 id，落到最接近的已加载项（目录尾部那一条）上。
	const anchor = items[targetIndex].pending === true ? lastLoadedItem(items) : items[targetIndex];
	return { kind: "jump", id: anchor?.id ?? targetId };
}

function lastLoadedItem(items: readonly OutlineRailItem[]): OutlineRailItem | undefined {
	for (let index = items.length - 1; index >= 0; index -= 1) if (items[index].pending !== true) return items[index];
	return undefined;
}
/**
 * 点击「目录里有、消息还没加载」的刻度后，下一步该做什么（纯函数，可单测）。
 *
 * 旧实现在渲染层每 60ms 轮询一次 loadMoreMessages，而它在上一页仍在飞时直接 return
 * （in-flight 守卫）——这些轮询全部空转，把次数预算烧在等待上，于是长会话里点最上面的
 * 刻度必弹「这条提问还在更早的历史里」。改成「等落地再发下一页」，预算只统计真正发起的补页。
 */
export type RailPendingStep = "jump" | "wait" | "load" | "settle";

export function planRailPendingStep(input: {
	/** 目标条目已经出现在已加载消息里（命中即可跳）。 */
	targetLoaded: boolean;
	/** 上一页仍在加载：原地等，不算一次尝试。 */
	isLoadingMore: boolean;
	/** 还有更早的历史页可补。 */
	hasMoreMessages: boolean;
	/** 上一次补页失败：再补也不会前进，直接交回落位逻辑。 */
	loadFailed: boolean;
	/** 已经真正发起的补页次数。 */
	attempts: number;
	/** 防死循环的保险丝次数。 */
	maxAttempts: number;
}): RailPendingStep {
	if (input.targetLoaded) return "jump";
	if (input.isLoadingMore) return "wait";
	if (input.hasMoreMessages && !input.loadFailed && input.attempts < input.maxAttempts) return "load";
	return "settle";
}

/**
 * 上一次补页是否「白补了」：发过一页、没在加载、已加载条数却没涨。
 *
 * 为什么必须单独判：续页锚点原地踏步或文件已到顶时，继续发只会空转到保险丝；
 * 而被动 effect 里连发 setState 正是 React #185 的直接成因（2026-11 真机：
 * 点大纲最上面的刻度 →「界面渲染异常」）。白补一次就交回落位逻辑。
 *
 * 判据里的 entryId 必须一起比：换了目标（用户点了别的刻度）时计数相同不代表停滞。
 */
export function isRailLoadStalled(input: {
	/** 上一轮记下的目标 entryId。 */
	previousEntryId: string | undefined;
	targetEntryId: string;
	/** 上一轮记下的已加载条数。 */
	previousCount: number;
	loadedCount: number;
	/** 已经真正发起的补页次数。 */
	attempts: number;
	isLoadingMore: boolean;
}): boolean {
	return input.previousEntryId === input.targetEntryId && input.attempts > 0 && input.previousCount === input.loadedCount && !input.isLoadingMore;
}
