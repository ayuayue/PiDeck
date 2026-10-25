import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useInsertionEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { resolveRunHeight, splitVirtualRunsByTail, VIRTUAL_ESTIMATED_RUN_HEIGHT } from "./virtualTimelinePolicy";

/**
 * 包装行的统一测量基准：flow-root 让子元素的下边距计入行高（solid 行与虚拟行同一高度基准），
 * marginTop 清零接管 .message-list > * + * 的行距 —— 行距只由内容自身的下边距提供。
 * solid 分支与虚拟分支必须共用这一份样式：两边口径不同时（例如一边含下边距、一边不含），
 * 切换后 estimateSize 命中的缓存值与真实高度差一个下边距，行会整体漂移（#401 评审）。
 */
const RUN_WRAP_STYLE = { display: "flow-root", marginTop: 0 } as const;
/**
 * 虚拟区容器：absolute + translateY 的行不撑开父容器，实测高度大于估值的那一帧会溢出到底部
 * 真实区上（压住 solid 首行）。overflow: clip 只裁掉那一帧的溢出部分（裁掉的不是任何一行：
 * 行的盒高由 translateY + height 决定，估值一旦被实测替换，行就落回容器内），也不影响
 * overscan 行 —— 它们在视口外，本来就不可见。
 */
const VIRTUAL_LIST_STYLE = { position: "relative", width: "100%", overflow: "clip" } as const;

/** 视口顶部那一行：id + 相对滚动容器顶的偏移。solid/虚拟切换与宽度重排都用它换算 scrollTop。 */
interface ViewportAnchor {
	id: string;
	offset: number;
}

function rowIdOf(element: HTMLElement): string {
	return element.dataset.virtualRunId ?? element.dataset.solidRunId ?? "";
}

function queryRunRow(scroller: HTMLElement, id: string): HTMLElement | null {
	const escaped = typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(id) : id;
	return scroller.querySelector<HTMLElement>(['[data-virtual-run-id="', escaped, '"], [data-solid-run-id="', escaped, '"]'].join(""));
}

/**
 * 读「视口顶部正在看的那一行」。跨视口顶边的行优先（用户视线落点），否则取最靠上的一条。
 * 只遍历已挂载行（虚拟区之外的轮本就不在 DOM 里，也没有几何可读）。
 *
 * 只在 commit 阶段调用（insertion effect / ResizeObserver / rAF），绝不在 render 体里跑：
 * 它做一次全量 getBoundingClientRect，放 render 里会变成 render 期的强制布局，且 StrictMode
 * 双渲染会读两遍。
 */
function readViewportAnchor(scroller: HTMLElement): ViewportAnchor | null {
	const viewportTop = scroller.getBoundingClientRect().top;
	let fallback: ViewportAnchor | null = null;
	let fallbackOffset = Number.POSITIVE_INFINITY;
	for (const row of Array.from(scroller.querySelectorAll<HTMLElement>("[data-virtual-run-id], [data-solid-run-id]"))) {
		const id = rowIdOf(row);
		if (!id) continue;
		const rect = row.getBoundingClientRect();
		if (rect.bottom <= viewportTop + 1) continue;
		const offset = rect.top - viewportTop;
		if (rect.top <= viewportTop + 1) return { id, offset };
		if (offset < fallbackOffset) {
			fallbackOffset = offset;
			fallback = { id, offset };
		}
	}
	return fallback;
}

/** 滚动容器的 scrollTop 上限（负值截成 0）。 */
function maxScrollTop(scroller: HTMLElement): number {
	return Math.max(0, scroller.scrollHeight - scroller.clientHeight);
}

/**
 * 按锚点补齐 scrollTop：让 anchor.id 那一行回到切换前的视口偏移。
 * 直接写 scrollTop（不用 smooth）：补偿必须发生在同一帧的绘制之前，带过渡反而会看到位移过程。
 *
 * 三种结局都算「本轮结束」：
 * - 对齐（残差 <= 0.5px）；
 * - 目标行已被虚拟器回收（没有几何可测，保留锚点会反复重试）；
 * - scrollTop 被文档边界 clamp（贴顶 / 贴底）：此时残差不可能消掉，视口已经停在用户能到达的
 *   最近位置，视为已对齐并留一条 debug 日志 —— 早先的实现在这里静默返回 false，两次尝试后
 *   丢掉锚点，表现为切换后位置轻微错位且无任何痕迹。
 */
function settleScrollAnchor(scroller: HTMLElement, anchor: ViewportAnchor): boolean {
	const row = queryRunRow(scroller, anchor.id);
	if (!row) return false;
	const viewportTop = scroller.getBoundingClientRect().top;
	const delta = row.getBoundingClientRect().top - viewportTop - anchor.offset;
	if (Math.abs(delta) <= 0.5) return true;
	const before = scroller.scrollTop;
	const desired = before + delta;
	const limit = maxScrollTop(scroller);
	scroller.scrollTop = desired;
	const applied = scroller.scrollTop;
	const clamped = Math.abs(applied - desired) > 0.5;
	const after = queryRunRow(scroller, anchor.id);
	// 行已被回收（视口外）：没有几何可测，按本轮处理结束，避免保留锚点反复重试。
	if (!after) return true;
	const residual = after.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.offset;
	if (Math.abs(residual) <= 0.5) return true;
	if (clamped || applied <= 0.5 || applied >= limit - 0.5) {
		console.debug("[VirtualRunList] scroll anchor clamped at document edge", {
			id: anchor.id,
			desired,
			applied,
			limit,
			residual,
		});
		return true;
	}
	return false;
}

/**
 * 宽度分桶的高度缓存：id -> (宽度 -> 实测高度)。
 *
 * 为什么按宽度分桶：行高是宽度的函数（Markdown 换行），宽度变了以后，未挂载行没有任何机会
 * 重新测量。只留「最后一次实测」会让窄→宽的总高偏大、宽→窄偏小（后者会让虚拟区矮于内容）。
 * 分桶后按当前宽度取精确值，取不到就用最近宽度的实测值按宽度比例外推（夹在 0.5x–2x），
 * 挂载后立即被实测覆盖 —— 这是估值，不是承诺。
 */
type HeightBuckets = Map<string, Map<number, number>>;

/** 当前宽度下该 id 的最佳高度估计：精确桶 -> 最近邻按宽度比例缩放。 */
function pickHeightForWidth(buckets: ReadonlyMap<number, number>, width: number): number | undefined {
	if (buckets.size === 0) return undefined;
	const exact = buckets.get(width);
	if (exact !== undefined) return exact;
	let nearestWidth = -1;
	let nearestHeight = 0;
	for (const [bucketWidth, height] of buckets) {
		if (nearestWidth < 0 || Math.abs(bucketWidth - width) < Math.abs(nearestWidth - width)) {
			nearestWidth = bucketWidth;
			nearestHeight = height;
		}
	}
	if (nearestWidth <= 0) return nearestHeight > 0 ? nearestHeight : undefined;
	if (width <= 0) return nearestHeight > 0 ? nearestHeight : undefined;
	const ratio = Math.min(2, Math.max(0.5, width / nearestWidth));
	const scaled = nearestHeight * ratio;
	return Number.isFinite(scaled) && scaled > 0 ? scaled : undefined;
}

export interface VirtualRunListProps<T> {
	/** 完整渲染列表（已按轮次窗口裁剪过的结果）。 */
	runs: readonly T[];
	/** 时间线的滚动容器（.message-timeline），虚拟化以它为 viewport。 */
	scrollRef: RefObject<HTMLElement | null>;
	/** 每轮的渲染函数，只在真正要挂载这一行时调用。 */
	renderRun: (run: T, index: number) => ReactNode;
	/** 取稳定 id（渲染列表里的 message 条目 id 在 message.id 上，所以由调用方提供）。 */
	getRunId: (run: T) => string;
	/** 判断条目是不是 agent-run：渲染列表里 user 气泡与 agent-run 混排，切分必须按轮。 */
	isAgentRun: (run: T) => boolean;
	/**
	 * 这一条是否真的产出 DOM。必须与 renderRun 内部的第一道判定同源
	 * （virtualTimelinePolicy.isRenderableRunItem），否则空 div 会多吃掉一条行距。
	 */
	isRenderable: (run: T) => boolean;
	/** 尾部保持真实渲染的轮数；默认见 virtualTimelinePolicy。 */
	solidTailCount?: number;
	/**
	 * 全部行真实渲染（不走 virtualizer）。用于锚点恢复 / 挂起跳转 / 多选导出期间：
	 * 前两者按 [data-message-id] 查 DOM，后者克隆整表，虚拟区外的行都不在 DOM 里。
	 * 用 prop 而不是在父层换组件类型 —— 换类型会整棵卸载，高度缓存随之丢失。
	 */
	solid?: boolean;
	/**
	 * 布局档位切换 / 宽度重排后，本组件会直接写 scrollTop 做锚点补偿。调用方（controller）
	 * 要把这类写入标记成程序化滚动，否则它的 scroll 监听会把补偿当成用户滚动去改写浏览钉
	 * （#401 复审）。传 controller.markProgrammaticScroll 即可。
	 */
	onBeforeScrollCorrection?: () => void;
}

/**
 * 历史轮虚拟化（复用 @tanstack/react-virtual）。
 *
 * 结构：虚拟区（绝对定位 + translateY，只有视口附近的行在 DOM 里）+ 尾部真实渲染区。
 * 尾部不进虚拟区是为了让跟底引擎、流式增量、自动展开的组都还能依赖真实几何。
 *
 * 三处容易漏的细节：
 * - 动态高度：虚拟行挂 data-index 并把节点交给 virtualizer.measureElement（库对该节点挂
 *   ResizeObserver，内容后增高会自动重测）。库测到的尺寸经 onChange 回写进宽度分桶缓存，
 *   estimateSize 只读这份缓存 —— 挂载那一刻的初测高度不会被永久钉死。
 * - 间距：行距统一由内容自身的下边距提供（user 气泡 mb-4 / 轮次行 mb-6 / 卡片各自补 mb-4）。
 *   包装 div 用 display:flow-root 把子元素 margin 收进高度，solid 与虚拟行同一高度口径。
 * - 偏移：虚拟区之前可能还有「显示更早」栏、分页失败行等兄弟节点，scrollMargin 用实测的
 *   容器偏移，否则可视窗口判定整体错位一个头部高度。
 *
 * 补偿职责：本组件只负责「自身布局档位切换（solid <-> 虚拟）与宽度重排」造成的高度基准变化，
 * 在切换的同一帧按「视口顶部那一行」补齐 scrollTop。扩窗/翻页的顶部插入不在这里补 ——
 * 那条路径的唯一真值是 controller.pinBrowseRow（按钉住的行相对视口的漂移补）。
 * 为什么不在 controller 层做这件事：solid 是渲染层的局部状态（多选打开、恢复/跳转在途），
 * controller 看不到切换时刻，也没有对应的记账位；在这里补，位置信息与 DOM 都在手边。
 * 两处补偿不会叠加：都按「行相对视口」对齐，先补的一方把 delta 吃掉后另一方读到 0。
 *
 * known limitations（不在本次改动里重构，登记在此）：
 * 1) solid 期整表真实挂载，turn 窗口轮数没有上限（controller 的 scrolledWindowTurns 只增）。
 *    用户在很长的历史上打开多选时，可能一次挂出全部已加载轮，回到 #213 治理前的全量挂载形态。
 *    要收敛需要「solid 也只渲染选中行附近的窗口」，属于独立改动。
 * 2) solid 与虚拟分支的 DOM 层级不同（虚拟行多包一层 absolute 容器），虚拟区里的行在切换时
 *    会被卸载重建，行内局部展开态（过程组的批次计数、组内滚动位置）随之重置；尾部 solid 行
 *    在两种分支同在 .message-list 顶层、同 type 同 key，React 会复用。
 */
export function VirtualRunList<T>(props: VirtualRunListProps<T>) {
	const { runs, scrollRef, renderRun, getRunId, isAgentRun, isRenderable, solidTailCount, solid = false, onBeforeScrollCorrection } = props;
	/** 按宽度分桶的实测高度（唯一真值，来自 ref 初测 + 库的后续重测）。 */
	const heightBucketsRef = useRef<HeightBuckets>(new Map());
	/** 当前宽度下解算好的高度，供 estimateSize 直接查（避免每帧遍历分桶）。 */
	const resolvedHeightsRef = useRef<Map<string, number>>(new Map());
	/** 当前滚动容器宽度（取整），写入新实测值时用它作桶键。 */
	const widthRef = useRef(0);
	const listRef = useRef<HTMLDivElement | null>(null);
	const [scrollMargin, setScrollMargin] = useState(0);

	// 只做「是否产出 DOM」的判定，不调用 renderRun：虚拟化省的是渲染，元素构造要等到真正挂载
	// 这一行时才发生。反过来，若在这里先渲染再过滤，虚拟区外的轮每帧都会被构造一次元素，
	// 虚拟化就只省了 DOM、省不掉 React 元素这一笔（#401 评审）。
	const entries = useMemo(() => {
		const rows: Array<{ run: T; index: number }> = [];
		runs.forEach((run, index) => {
			if (isRenderable(run)) rows.push({ run, index });
		});
		return rows;
	}, [runs, isRenderable]);

	// 阈值与「整轮切分」合并成一次判定：splitVirtualRunsByTail 内部已按总轮数阈值判过一次，
	// 再单独调 shouldVirtualizeTurnList 会出现「判虚拟化但切不出虚拟区」（solidTailCount >= 轮数）
	// 的状态 —— 那时 layoutKey 会写成 "virtual"，实际却渲染全部 solid 行，切换补偿前提失效。
	// 现在只认 split 的结果：切不出虚拟区就等于不虚拟化。
	const split = useMemo(() => splitVirtualRunsByTail(entries, (entry) => isAgentRun(entry.run), solidTailCount), [entries, isAgentRun, solidTailCount]);
	const virtualize = split.virtualCount > 0;
	const virtualEntries = useMemo(() => (split.virtualCount > 0 ? entries.slice(0, split.virtualCount) : []), [entries, split.virtualCount]);
	const solidEntries = useMemo(() => entries.slice(split.solidStart), [entries, split.solidStart]);

	// 结构键：流式 token 每帧重建 reconciledRuns → runs 每帧换引用。布局 effect 若依赖 runs 引用，
	// 就会每帧读 scrollHeight / getBoundingClientRect 而触发强制布局。这里只认标量。
	const firstRunId = entries.length > 0 ? getRunId(entries[0].run) : "";
	const runsLength = entries.length;
	// solid 与「不虚拟化」渲染同一套真实行，切换补偿只在两种 DOM 结构之间需要。
	const layoutKey = solid || !virtualize ? "solid" : "virtual";

	// virtualizer 的 estimateSize / getItemKey 必须是稳定引用：它们的引用参与 virtual-core 的
	// measurements memo（getMeasurementOptions 的 deps 含 getItemKey），内联箭头会让每个渲染
	// 都 O(N) 重算全部行起点。索引到条目的映射放在 ref 里由 render 同期更新 —— 虚拟器在
	// commit 阶段读它，放 layout effect 会晚一帧。
	const entriesRef = useRef<readonly { run: T; index: number }[]>([]);
	entriesRef.current = virtualEntries;
	const getRunIdRef = useRef(getRunId);
	getRunIdRef.current = getRunId;

	/** 写一条实测高度（按宽度分桶），并同步当前宽度下的解算值。 */
	const recordHeight = useCallback((id: string, width: number, height: number) => {
		if (!id || !Number.isFinite(height) || height <= 0) return;
		const bucketWidth = Math.round(width);
		if (bucketWidth <= 0) return;
		let buckets = heightBucketsRef.current.get(id);
		if (!buckets) {
			buckets = new Map();
			heightBucketsRef.current.set(id, buckets);
		}
		const previous = buckets.get(bucketWidth);
		if (previous === undefined || Math.abs(previous - height) > 1) buckets.set(bucketWidth, height);
		if (bucketWidth === widthRef.current) resolvedHeightsRef.current.set(id, height);
	}, []);

	/** 按当前宽度重建「id -> 高度」快照，未挂载行也跟着换到新宽度的估值。 */
	const rebuildResolvedHeights = useCallback((width: number) => {
		const resolved = new Map<string, number>();
		for (const [id, buckets] of heightBucketsRef.current) {
			const height = pickHeightForWidth(buckets, width);
			if (height !== undefined) resolved.set(id, height);
		}
		resolvedHeightsRef.current = resolved;
	}, []);

	const estimateSize = useCallback((index: number) => {
		const entry = entriesRef.current[index];
		return resolveRunHeight(resolvedHeightsRef.current, entry ? getRunIdRef.current(entry.run) : "", VIRTUAL_ESTIMATED_RUN_HEIGHT);
	}, []);
	const getItemKey = useCallback((index: number) => {
		const entry = entriesRef.current[index];
		return entry ? getRunIdRef.current(entry.run) || index : index;
	}, []);

	const virtualizer = useVirtualizer({
		// solid 期虚拟器不应工作：否则它按 scrollTop 变化 flushSync 重渲染整表（#401 终审 P2）。
		count: solid || !virtualize ? 0 : virtualEntries.length,
		getScrollElement: () => scrollRef.current,
		estimateSize,
		getItemKey,
		overscan: 3,
		scrollMargin,
		// 库自己测到的尺寸才是「内容后增高」的最新真值：ref 初测只发生在挂载那一帧，
		// ResizeObserver 的后续重测不会经过 ref 回调。onChange 每次几何变化触发，只回写
		// 当前可见行（数量 = 视口行数 + overscan），成本与滚动帧同阶。
		onChange: (instance) => {
			const width = widthRef.current;
			if (width <= 0) return;
			// 只回写库**真正测过**的行：itemSizeCache 没有该 key 时 item.size 是 estimateSize 的
			// 结果，把它当“实测”写进分桶会把估值固化成「该宽度的精确实测」，之后宽度来回切
			// 时这份桶值会压过最近邻外推，直到该行再次挂载才被真实测量覆盖。
			for (const item of instance.getVirtualItems()) {
				if (typeof item.key !== "string" || !item.key) continue;
				if (!instance.itemSizeCache.has(item.key)) continue;
				recordHeight(item.key, width, item.size);
			}
		},
	});

	// 每 id 一个稳定 ref 回调：内联箭头每帧换引用 → React 对每行 detach/attach → 逐帧强制布局。
	const measureRefs = useMemo(() => new Map<string, (node: HTMLDivElement | null) => void>(), [virtualizer]);
	const measure = useCallback(
		(id: string) => {
			const cached = measureRefs.get(id);
			if (cached) return cached;
			const callback = (node: HTMLDivElement | null) => {
				if (!node) return;
				// 只有虚拟行带 data-index：solid 行没有，交给库的 indexFromElement 会拿到 -1 并警告。
				if (node.hasAttribute("data-index")) virtualizer.measureElement(node);
				if (!id) return;
				const width = widthRef.current || node.clientWidth;
				recordHeight(id, width, node.getBoundingClientRect().height);
			};
			measureRefs.set(id, callback);
			return callback;
		},
		[measureRefs, virtualizer, recordHeight],
	);

	// solid <-> 虚拟切换的补偿锚点。必须在 DOM 变更**之前**读旧几何：layout effect 的 cleanup
	// 在 mutation 之后才执行（那时两套行已被替换），useInsertionEffect 则在 mutation 阶段之前
	// flush，读到的还是切换前那一套 DOM。它只写 ref（不 setState、不读后写），StrictMode 的
	// 二次调用因 previousLayoutRef 已更新而直接返回，幂等。
	const previousLayoutRef = useRef(layoutKey);
	const pendingAnchorRef = useRef<ViewportAnchor | null>(null);
	const anchorAttemptsRef = useRef(0);
	useInsertionEffect(() => {
		if (previousLayoutRef.current === layoutKey) return;
		previousLayoutRef.current = layoutKey;
		const scroller = scrollRef.current;
		pendingAnchorRef.current = scroller ? readViewportAnchor(scroller) : null;
		anchorAttemptsRef.current = 0;
	}, [layoutKey, scrollRef]);

	// 补偿：同一次提交里先按锚点对齐一次；scrollMargin 的 setState 会触发第二次 layout，
	// 用同一个锚点再对齐一次（最多两次，避免陈旧锚点把视口拽回旧位置）。
	useLayoutEffect(() => {
		const scroller = scrollRef.current;
		const anchor = pendingAnchorRef.current;
		if (!scroller || !anchor) return;
		// 标记一帧程序化滚动：补偿写 scrollTop 会派发原生 scroll 事件，不标记的话
		// controller 会把浏览钉的 expected 改写成补偿后的位置（#401 复审 P2）。
		onBeforeScrollCorrection?.();
		const settled = settleScrollAnchor(scroller, anchor);
		anchorAttemptsRef.current += 1;
		if (settled || anchorAttemptsRef.current >= 2) {
			pendingAnchorRef.current = null;
			return;
		}
		// 没对齐（多半是 scrollMargin 的重测还没落）：把锚点留给同帧内的下一次 layout effect。
		// 若那一帧没来，就在下一次绘制后丢掉 —— 陈旧锚点会把用户之后的滚动位置拽回旧行。
		const frame = requestAnimationFrame(() => {
			pendingAnchorRef.current = null;
		});
		return () => cancelAnimationFrame(frame);
	}, [layoutKey, scrollMargin, scrollRef]);

	// 虚拟区相对滚动容器的偏移：前面可能有「显示更早」栏、错误态块等兄弟节点。
	// 依赖 solid 而不是执行时机：solid 期 listRef 为 null，切回虚拟区时列表节点是新挂的，
	// 不重测就会拿 0 当偏移。上方兄弟的高度变化（分页失败行插入、按钮换行）不改变
	// firstRunId/runsLength，所以额外观测紧邻的前一个兄弟（#401 评审）。
	useLayoutEffect(() => {
		const list = listRef.current;
		const scroller = scrollRef.current;
		if (!list || !scroller) return;
		const measureMargin = () => {
			const next = list.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
			setScrollMargin((prev) => (Math.abs(prev - next) > 0.5 ? next : prev));
		};
		measureMargin();
		if (typeof ResizeObserver === "undefined") return;
		const previous = list.previousElementSibling;
		if (!previous) return;
		const observer = new ResizeObserver(() => measureMargin());
		observer.observe(previous);
		return () => observer.disconnect();
	}, [firstRunId, runsLength, solid, scrollRef]);

	// 宽度变化：行高按宽度重排，未挂载行没有几何可测，只能靠分桶 + 比例外推。
	// 顺序固定为「测挂载行 → 重建快照 → 丢弃库内旧宽度缓存 → 重新测挂载行 → 按锚点补 scrollTop」：
	// - 先测挂载行：拿到新宽度下的真实值，写进对应宽度的桶；
	// - rebuild：未挂载行从「旧宽度实测」换成「新宽度估值（或最近邻比例）」；
	// - virtualizer.measure()：清掉库按旧宽度缓存的所有尺寸，否则未挂载行继续用旧值
	//   （库内 itemSizeCache 优先于 estimateSize，不清就等于这次重建没发生）；
	// - 再测一次挂载行：measure() 清空后重新填充新宽度实测；
	// - rAF 里按「目视顶部那行」补 scrollTop：estimate 变会改总高，不补就会看到内容位移。
	useLayoutEffect(() => {
		const scroller = scrollRef.current;
		if (!scroller) return;
		widthRef.current = Math.round(scroller.clientWidth);
		rebuildResolvedHeights(widthRef.current);
		if (typeof ResizeObserver === "undefined") return;
		let lastWidth = widthRef.current;
		const observer = new ResizeObserver(() => {
			const nextWidth = Math.round(scroller.clientWidth);
			if (Math.abs(nextWidth - lastWidth) < 1) return;
			lastWidth = nextWidth;
			widthRef.current = nextWidth;
			const anchor = readViewportAnchor(scroller);
			const remeasure = () => {
				for (const node of Array.from(scroller.querySelectorAll<HTMLElement>("[data-index]"))) {
					virtualizer.measureElement(node);
					const id = node.dataset.virtualRunId ?? "";
					recordHeight(id, nextWidth, node.getBoundingClientRect().height);
				}
				for (const node of Array.from(scroller.querySelectorAll<HTMLElement>("[data-solid-run-id]"))) {
					recordHeight(node.dataset.solidRunId ?? "", nextWidth, node.getBoundingClientRect().height);
				}
			};
			remeasure();
			rebuildResolvedHeights(nextWidth);
			virtualizer.measure();
			remeasure();
			const list = listRef.current;
			if (list) {
				const next = list.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
				setScrollMargin((prev) => (Math.abs(prev - next) > 0.5 ? next : prev));
			}
			if (!anchor) return;
			requestAnimationFrame(() => {
				onBeforeScrollCorrection?.();
				settleScrollAnchor(scroller, anchor);
			});
		});
		observer.observe(scroller);
		return () => observer.disconnect();
	}, [scrollRef, virtualizer, rebuildResolvedHeights, recordHeight, onBeforeScrollCorrection]);

	if (solid || !virtualize) {
		// 与真实区同构：每轮一个 div（统一测量基准见 RUN_WRAP_STYLE）
		return (
			<>
				{entries.map((entry) => (
					<div key={getRunId(entry.run) || entry.index} className="min-w-0" data-solid-run-id={getRunId(entry.run)} ref={measure(getRunId(entry.run))} style={RUN_WRAP_STYLE}>
						{renderRun(entry.run, entry.index)}
					</div>
				))}
			</>
		);
	}

	return (
		<>
			{virtualEntries.length > 0 && (
				// 高度直接取 getTotalSize()：virtual-core 的 _getLayoutTotalSize 已经减掉 scrollMargin
				// （measurements 的 start 从 paddingStart + scrollMargin 起算），再减一次会让虚拟区
				// 矮掉 scrollMargin、末行溢出到真实区、总高不足。
				<div ref={listRef} style={{ ...VIRTUAL_LIST_STYLE, height: virtualizer.getTotalSize() + "px" }}>
					{virtualizer.getVirtualItems().map((virtualItem) => {
						const entry = virtualEntries[virtualItem.index];
						if (!entry) return null;
						const id = getRunId(entry.run);
						return (
							<div key={virtualItem.key} data-index={virtualItem.index} data-virtual-run-id={id} ref={measure(id)} style={{ ...RUN_WRAP_STYLE, position: "absolute", top: 0, left: 0, width: "100%", transform: "translateY(" + (virtualItem.start - scrollMargin) + "px)" }}>
								{renderRun(entry.run, entry.index)}
							</div>
						);
					})}
				</div>
			)}
			{solidEntries.map((entry) => (
				<div key={getRunId(entry.run) || entry.index} className="min-w-0" data-solid-run-id={getRunId(entry.run)} ref={measure(getRunId(entry.run))} style={RUN_WRAP_STYLE}>
					{renderRun(entry.run, entry.index)}
				</div>
			))}
		</>
	);
}
