import { useVirtualizer } from "@tanstack/react-virtual";
import { Fragment, useCallback, useMemo, useRef, type MutableRefObject, type ReactNode, type RefObject } from "react";

/**
 * 通用虚拟栈：把一个「可能很长的行列表」收敛成「只挂视口附近的行」。
 *
 * 为什么做成通用件（2026-10，用户指令：每一个有滑动的东西都复用虚拟化）：
 * 这个应用里有一批结构相同的长列表——执行过程的组体成员、大折叠栏的一级节点、子代理列表、
 * 待办清单、状态面板、会话树、轨迹视图、Git 提交图、模型 trace……它们的共同点不是业务，而是
 * 「行数随数据无限长 + 外壳是限高滚动窗」。每个地方各写一遍虚拟化 = 8 份重复的测量/缓存代码，
 * 一处改不齐就又多一个卡顿入口。所以这里只留一份实现，各接入点只描述「怎么画一行」。
 *
 * 设计取舍（三条，改动前先读）：
 * 1. **短列表不改变 DOM**：行数 <= minRows 时直接 `items.map` 返回 Fragment，不额外包一层
 *    relative 容器。接入点的既有 CSS（flex-col 直接子项、`> * + *` 行距、e2e 选择器）全部沿用，
 *    接入虚拟化不会改变短列表的排版与测试断言。
 * 2. **行高靠实测**：`estimateHeight` 只用于首帧，`measureElement` 之后以真实高度为准。
 *    本应用的行高差异极大（单行思考 28px、展开的工具卡几百 px），固定估值会让滚动位置长期漂移。
 *
 *    **判据（2026-10 修正，之前写错过一次，别照旧的办）**：
 *    能不能虚拟化，看的不是「行高方差小不小」，而是「**能不能测准行高**」。
 *
 *    - 纯估值（`estimateSize` 返回常数、不 measure）→ 只适合行高方差小的列表。
 *      方差 > 2 倍必然错位：这是组体那次「展开方向反了」的真因，记录当时归因成
 *      「方差大所以不能虚拟化」，错了——真因是**纯估值没有实测**。
 *    - 实测（`measureElement` + ResizeObserver，本组件的默认行为）→ 行高方差大照样能虚拟化。
 *      折叠区（组头 32px / 展开组 352px / 中间回复几百 px）就是按实测接入的。
 *
 *    所以真正的红线只有一条：**虚拟化必须配 measureElement**。这条不满足，方差再小也会漂。
 * 3. **ref 回调按行 key 缓存**：内联箭头每帧换引用会让 React 逐行 detach/attach，反而制造强制布局；
 *    缓存后同一行的回调引用恒定，挂载/卸载才变化。
 *
 * 不变量（测试钉住）：
 * - 虚拟化时行根必须带 `data-index`（virtual-core 的 `indexFromElement` 靠它定位）与稳定 key；
 * - 内容盒高度取 `getTotalSize()`，行用 absolute + translateY —— 滚动容器的 scrollHeight 因此正确，
 *   依赖「内容变高」的跟底引擎（useStickToBottom 的 ResizeObserver）仍然有效；
 * - 行数 <= minRows 时不渲染 `data-virtual-stack` 包裹层。
 */

/** 低于该行数时全量渲染：虚拟器自身有固定开销（一条 ResizeObserver、每帧行集合计算）。 */
export const VIRTUAL_STACK_MIN_ROWS = 16;

/** 默认视口外预挂行数：行高不高，4 行足够覆盖滚动惯性。 */
const DEFAULT_OVERSCAN = 4;

export type VirtualStackProps<T> = {
	items: readonly T[];
	/** 行 key：必须稳定（行内状态、测量缓存、ref 回调都挂在它上面）。 */
	getKey: (item: T, index: number) => string;
	renderItem: (item: T, index: number) => ReactNode;
	/**
	 * 滚动容器：**必填**。调用方自己的那个限高滚动窗，同一个 ref 必须同时挂在容器元素上。
	 *
	 * 为什么必填而不是「不传就自建一个」（2026-10 审查后收紧）：
	 * 自建分支要求内容盒自算高度，而内容盒高度又取自 virtualizer.getTotalSize()——滚动元素的
	 * clientHeight 于是等于内容高度，virtual-core 的 calculateRange 一路走到底、**全部行都渲染**，
	 * 虚拟化名存实亡；更早的形态更糟：自建窗没把容器交给虚拟器时 getScrollElement 恒 null，
	 * 视口恒 0、一行都不渲染（整块空白）。这两种失败都只发生在「不传」这条路上，
	 * 而本仓 11 个接入点全都有自己的滚动窗。把 ref 收成必填后，接错在 tsc 阶段就报，
	 * 不用等到某天有人不传时表现为「空白」或「全渲染」。
	 */
	scrollRef: RefObject<HTMLElement | null>;
	/** 首帧行高估值（实测随即覆盖）。*/
	estimateHeight?: number;
	/** 行数不超过它就全量渲染（默认 VIRTUAL_STACK_MIN_ROWS）。 */
	minRows?: number;
	overscan?: number;
	/** 虚拟化时行外层的额外属性（例如既有 e2e 锚点）。 */
	rowProps?: (item: T, index: number) => Record<string, string> | undefined;
	/**
	 * 虚拟化时行外层的 className。
	 *
	 * 用途几乎只有一个：**替代父容器的 `gap`**。虚拟行是 absolute 定位，不参与 flex 布局，
	 * 所以原列表靠 `gap-2` 提供的行距在虚拟化后会消失——把它写成行自己的 `pb-2` 传进来即可。
	 * 短列表路径不用这个字段（直出 Fragment），因此既有排版不受影响。
	 */
	rowClassName?: string;
	/**
	 * 把 virtualizer 实例交出去。
	 *
	 * 为什么需要：虚拟化后离屏行不挂载，任何「按 id 找 DOM 再 .focus()」的代码都会静默变成
	 * no-op（键盘导航、Home/End、焦点恢复）。接入点得先 scrollToIndex 把目标行拉进视口，
	 * 下一帧才拿得到节点。没有这个出口，接入点只能靠估算行高硬滚，估错就 focus 不到。
	 */
	virtualizerRef?: MutableRefObject<{ scrollToIndex: (index: number, options?: { align?: "start" | "center" | "end" | "auto" }) => void } | null>;
	/** 容器上的额外属性（role / aria-* 等）。className 与 style 由本组件独占。 */
	containerProps?: Record<string, string>;
};

export function VirtualStack<T>(props: VirtualStackProps<T>) {
	const { items, getKey, renderItem, scrollRef, estimateHeight = 46, minRows = VIRTUAL_STACK_MIN_ROWS, overscan = DEFAULT_OVERSCAN, rowProps, rowClassName, virtualizerRef, containerProps } = props;
	const virtualize = items.length > minRows;
	// containerProps 可能带 className（例如分支树的 min-w-full，基线那层 div 就有）。
	// 本组件自己也管 className，所以必须先拆出来再合并，否则会被后写的 className 覆盖掉。
	const { className: containerClassName, ...containerRest } = containerProps ?? {};

	// estimateSize / getItemKey 必须是**稳定引用**：它们的引用参与 virtual-core 的 measurements
	// memo（getMeasurementOptions 的 deps 含 getItemKey），内联箭头会让每次渲染都 O(N) 重算
	// 全部行起点。分支树每次按键、轨迹视图与子代理条每秒 tick，都会白算一遍全表。
	// 索引到条目的映射与 getKey 放在 ref 里由 render 同期更新（虚拟器在 commit 阶段读它）。
	// 这是 `VirtualRunList.tsx` 已经踩过并写明的规则，通用件照做。
	const itemsRef = useRef(items);
	itemsRef.current = items;
	const getKeyRef = useRef(getKey);
	getKeyRef.current = getKey;
	const estimateRef = useRef(estimateHeight);
	estimateRef.current = estimateHeight;

	// hooks 不能条件调用：未虚拟化时 count=0，虚拟器空转（不观察、不算行），成本可忽略。
	const virtualizer = useVirtualizer({
		count: virtualize ? items.length : 0,
		getScrollElement: () => scrollRef.current,
		estimateSize: useCallback(() => estimateRef.current, []),
		getItemKey: useCallback((index: number) => {
			const list = itemsRef.current;
			const item = list[index];
			return item === undefined ? String(index) : getKeyRef.current(item as T, index);
		}, []),
		overscan,
	});

	// 交出实例：useState 创建的实例引用稳定，这里每次 render 重赋值只是兜底。
	if (virtualizerRef) virtualizerRef.current = virtualizer;

	const measureRefs = useMemo(() => new Map<string, (node: HTMLDivElement | null) => void>(), [virtualizer]);
	const measure = useCallback(
		(key: string) => {
			const cached = measureRefs.get(key);
			if (cached) return cached;
			const callback = (node: HTMLDivElement | null) => {
				if (node) {
					virtualizer.measureElement(node);
					return;
				}
				// 卸载：必须把 null 交给 measureElement —— 那是 virtual-core 里 elementsCache /
				// ResizeObserver 的唯一清理入口（virtual-core 的 measureElement 收到 null 时会遍历
				// elementsCache，对已脱离文档的节点 unobserve + delete）。旧写法直接 return，
				// detached 行会留在缓存里直到整个 VirtualStack 卸载；Chrome 对已移除节点通常不再
				// 触发 RO 回调，所以那条兜底分支基本不会走到。同时淘汰回调缓存，避免键数随
				// 「曾经挂载过的行数」无限增长（轨迹视图可达数千行）。
				virtualizer.measureElement(null);
				measureRefs.delete(key);
			};
			measureRefs.set(key, callback);
			return callback;
		},
		[measureRefs, virtualizer],
	);

	if (!virtualize) {
		// 行必须带 key：renderItem 的返回值是各接入点自己的 JSX（多数不产 key，接入虚拟化前
		// key 在它们自己的 map 回调上）。这里包一层 Fragment 提供稳定 key，否则 React 每帧
		// 报 "Each child in a list should have a unique key"，且行按位置协调而非按 id —— 删中间
		// 一行时 DOM 会被整体复用。
		const plainRows = items.map((item, index) => <Fragment key={getKey(item, index)}>{renderItem(item, index)}</Fragment>);
		// containerProps 不能只在虚拟化分支生效：分支树把 role="tree" / aria-label 放在这里，
		// 而「≤16 行的树」是常态 —— 只在虚拟化分支消费，等于常态下 treeitem 失去 tree 祖先，
		// 屏幕阅读器不再按树处理。有 containerProps 时包一层，没有时直出 Fragment（DOM 与
		// 接入虚拟化前一致，既有 flex / 子选择器排版不受影响）。
		return containerProps ? (
			<div {...containerRest} className={containerClassName}>
				{plainRows}
			</div>
		) : (
			<>{plainRows}</>
		);
	}

	// 行容器的宽度工具类：rowClassName 自带 w-* 时不再追加 w-full —— w-full 与 w-max 是同一组
	// 属性，谁生效取决于 Tailwind 生成的样式表顺序，不是代码里的书写顺序（file-diff 的
	// w-max 撞过这个：行高亮底色铺不满超长行）。
	const rowClass = ["absolute left-0 top-0", rowClassName !== undefined && /(?:^|\s)w-/.test(rowClassName) ? undefined : "w-full", rowClassName].filter(Boolean).join(" ");
	const rows = virtualizer.getVirtualItems().map((virtualItem) => {
		const item = items[virtualItem.index];
		if (item === undefined) return null;
		const key = getKey(item, virtualItem.index);
		return (
			<div key={virtualItem.key} data-index={virtualItem.index} {...(rowProps?.(item, virtualItem.index) ?? {})} ref={measure(key)} className={rowClass} style={{ transform: `translateY(${virtualItem.start}px)` }}>
				{renderItem(item, virtualItem.index)}
			</div>
		);
	});

	const stack = (
		<div data-virtual-stack="" {...containerRest} className={`relative w-full shrink-0${containerClassName ? ` ${containerClassName}` : ""}`} style={{ height: virtualizer.getTotalSize() }}>
			{rows}
		</div>
	);
	return stack;
}
