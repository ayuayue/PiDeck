import { useCallback, useEffect, useRef, type RefObject } from "react";

/** 视口内的一行：id 来自 data-message-id，top/bottom 相对滚动容器顶部。 */
export interface VisibleTimelineRow {
	id: string;
	top: number;
	bottom: number;
	/** 是否是「轮根」节点（user-turn / turn-row）：锚点优先钉轮根，卡类节点只做降级。 */
	isRootRow: boolean;
	/** 布局盒尺寸（readVisibleRows 填入）。缺省视为非零面积，便于纯函数用例只给几何。 */
	width?: number;
	height?: number;
}

/** 轮根选择器：锚点与浏览钉优先钉它，也是观察器唯一登记的对象。导出是为了让控制器共用同一份字面量。 */
export const ROOT_ROW_SELECTOR = "article.user-turn[data-message-id], .turn-row[data-message-id]";

/**
 * 观察区上下各扩一屏。
 *
 * scroll 事件的派发早于 IntersectionObserver 回调：滚动后集合里仍留着上一帧
 * 已经离开视口的行。扩到两屏后，刚滚出/刚滚入的行都能留在集合里，读路径用
 * rect 几何筛掉它们即可——原实现要求「最上面那条顶边不超过视口顶 1px」，否则
 * 整份集合判废、回落全量遍历；行间空白或上方迟到行都会触发，快速滚动时等于
 * 把这次的收益全部丢掉。
 */
const VIEWPORT_ROOT_MARGIN = "100% 0px 100% 0px";

/** 读取一行的时间线 id。 */
export function timelineRowId(element: Element): string {
	return (element as HTMLElement).dataset?.messageId ?? "";
}

/** 是否是轮根节点（锚点优先用它：工具卡/思考步骤会随折叠卸载，钉上去只能降级到顶部）。 */
export function isRootTimelineRow(element: Element): boolean {
	return element.matches(ROOT_ROW_SELECTOR);
}

/**
 * 纯函数：把候选行裁成「视口内的行」，保持调用方给的顺序（DOM 侧已按文档序排好）。
 *
 * 判据与全量回落分支同义：
 * - bottom < 1：整行在视口顶边上方（原 findAnchor / findBrowsePin 在这里 continue）；
 * - top >= viewportHeight：整行在视口底边下方，不属于「视口内」。视口内没有轮根时
 *   调用方会回落全量，全量仍能选到视口下方最近的轮根。
 *
 * 不要求第一行 top <= 1：视口顶部常常落在两行之间的空白里（.turn-row 的 mb-6
 * 是 24px，顶部还有「加载更多」块），那一行本来就是全量会选的下一行；要求
 * top <= 1 会让每滚过一段空白就整份判废、退回一次 O(窗口) 全量遍历。
 * 残余风险：新挂载的行要等 IO 回调（约一帧）才进集合；这段窗口内若恰好有
 * scroll 事件，读路径可能选到视口下方那条轮根（偏一行），下一次 scroll 自愈。
 * rootMargin 只把「刚滚出视口」的迟到行留在集合里，补不了「从未登记」的新行。
 *
 * 零面积（width/height 都为 0）= 没被布局（display:none、折叠区被卸下）：它们是
 * 看不见的行，有意不参与锚点与浏览钉——钉上去只会把视口补偿到不可见位置。
 */
export function selectVisibleRows(rows: readonly VisibleTimelineRow[], viewportHeight: number): VisibleTimelineRow[] {
	const selected: VisibleTimelineRow[] = [];
	for (const row of rows) {
		if (row.bottom < 1) continue;
		if (row.top >= viewportHeight) continue;
		if (row.width === 0 && row.height === 0) continue;
		selected.push(row);
	}
	return selected;
}

/**
 * 维护「当前视口内的时间线行」集合（IntersectionObserver + MutationObserver 自动登记）。
 *
 * 为什么需要：滚动热路径上的 computeCurrentAnchor 与 findBrowsePin 原来是
 * 「querySelectorAll 全量遍历 + 每行 getBoundingClientRect」——每次 scroll 事件要做
 * 三遍 O(窗口行数) 的强制布局读取。窗口随上滚扩窗单调变大，于是「越滚越慢」。
 * 换成可见行集合后，热路径的成本只与 rootMargin 三屏内的**行根**数有关
 * （视口内通常 2~4 个轮根），与窗口大小、行内工具卡数量都无关。
 * 生命周期：行被移除时由 MutationObserver 在**下一帧**批量 unobserve（rAF 合并，避免流式输出逐节点处理）；
 * 这一帧窗口内 visibleRef 可能仍含已卸载元素，readVisibleRows 用 isConnected / 零尺寸双过滤兜底 ——
 * 删掉该过滤就会把已脱离文档的行当成视口行；
 * timeline 元素被替换时重建观察者（否则 IO/MO 挂在旧节点上，hook 静默失效）。
 */
export function useVisibleTimelineRows(timelineRef: RefObject<HTMLElement | null>) {
	const visibleRef = useRef<Set<Element>>(new Set());
	const ioRef = useRef<IntersectionObserver | null>(null);
	const moRef = useRef<MutationObserver | null>(null);
	const observedTimelineRef = useRef<HTMLElement | null>(null);
	/** 在途的 MutationObserver 合并帧：teardown 必须取消，否则卸载后还会对已 disconnect 的 IO 调 observe。 */
	const flushFrameRef = useRef(0);

	const teardown = useCallback(() => {
		if (flushFrameRef.current) cancelAnimationFrame(flushFrameRef.current);
		flushFrameRef.current = 0;
		ioRef.current?.disconnect();
		moRef.current?.disconnect();
		ioRef.current = null;
		moRef.current = null;
		observedTimelineRef.current = null;
		visibleRef.current.clear();
	}, []);

	const connect = useCallback(() => {
		const timeline = timelineRef.current;
		// timeline 条件卸载后必须回收：否则旧 IO/MO 继续持有旧 DOM 与 visible 集合，
		// 直到新 timeline 出现或组件卸载。
		if (!timeline) {
			if (ioRef.current) teardown();
			return;
		}
		if (typeof IntersectionObserver === "undefined") return;
		// timeline 被替换（会话切换/条件渲染换节点）时必须重建，否则观察者挂在旧 DOM 上永久失效
		if (ioRef.current && observedTimelineRef.current === timeline) return;
		if (ioRef.current) teardown();

		const visible = new Set<Element>();
		visibleRef.current = visible;
		const io = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting) visible.add(entry.target);
					else visible.delete(entry.target);
				}
			},
			{ root: timeline, rootMargin: VIEWPORT_ROOT_MARGIN, threshold: 0 },
		);
		ioRef.current = io;
		observedTimelineRef.current = timeline;

		/**
		 * 只登记行根：行内工具卡/中间回复也带 data-message-id，但它们的可见性由所在轮根代表。
		 * 逐个 observe 会让集合随「行内卡片数」膨胀（单轮上百个工具卡时热路径仍是 O(卡片)），
		 * 而快路径的消费方（pickVisibleRootRow / computeCurrentAnchor）本来就只认轮根；
		 * 顶层诊断/扩展卡不是轮根，快路径本来就不选，miss 后由全量回落覆盖。
		 */
		const register = (node: Element) => {
			if (node.matches(ROOT_ROW_SELECTOR)) io.observe(node);
			for (const child of Array.from(node.querySelectorAll(ROOT_ROW_SELECTOR))) io.observe(child);
		};
		const unregister = (node: Element) => {
			if (node.matches(ROOT_ROW_SELECTOR)) {
				io.unobserve(node);
				visible.delete(node);
			}
			for (const child of Array.from(node.querySelectorAll(ROOT_ROW_SELECTOR))) {
				io.unobserve(child);
				visible.delete(child);
			}
		};
		for (const node of Array.from(timeline.querySelectorAll(ROOT_ROW_SELECTOR))) io.observe(node);

		if (typeof MutationObserver !== "undefined") {
			// 流式输出每个 token 都会改动子树：把整批 record 合并到一帧里处理，避免每个
			// added/removed 节点各跑一次 querySelectorAll。
			let pending: MutationRecord[] = [];
			let frame = 0;
			const flush = () => {
				flushFrameRef.current = 0;
				// 已 teardown 或已换成新 IO（会话切换后 connect 先 teardown 再新建）：这批 record
				// 属于旧观察者，继续处理会对已 disconnect 的 io 调 observe（重新激活它并挂住旧 DOM）。
				// 必须按身份比较，不能用 `!ioRef.current` —— 新 IO 已经把 ref 填回去了。
				if (ioRef.current !== io) {
					pending = [];
					return;
				}
				frame = 0;
				const records = pending;
				pending = [];
				for (const record of records) {
					for (const node of Array.from(record.removedNodes)) {
						if (node.nodeType === Node.ELEMENT_NODE) unregister(node as Element);
					}
					for (const node of Array.from(record.addedNodes)) {
						if (node.nodeType !== Node.ELEMENT_NODE) continue;
						const element = node as Element;
						// 流式输出每帧都在行内新增标记节点：它们既不可能是新行根，也不含行根，
						// 扫一遍 querySelectorAll 纯属浪费。只有「自身是行根」或「子树里还藏着
						// 行根」（整块新挂载 / 嵌套卡）才需要登记。
						if (!element.matches(ROOT_ROW_SELECTOR) && !element.querySelector(ROOT_ROW_SELECTOR)) continue;
						register(element);
					}
				}
			};
			const mo = new MutationObserver((records) => {
				pending.push(...records);
				if (!frame) frame = flushFrameRef.current = requestAnimationFrame(flush);
			});
			mo.observe(timeline, { childList: true, subtree: true });
			moRef.current = mo;
		}
	}, [teardown, timelineRef]);

	useEffect(() => teardown, [teardown]);
	/**
	 * timeline 条件卸载（切空会话 / 加载态）后不再有 scroll 事件，connect 里的惰性
	 * 回收永远不会被触发；旧 IO/MO 会一直持有整棵已脱离文档的时间线 DOM。
	 *
	 * 无依赖数组是有意的：React 不为 ref 变化提供通知，而 timeline 被条件卸载时组件
	 * 本身不卸载；只有每次提交后看一次 ref 才能在这一帧回收。持有观察者时才动作，
	 * 正常路径只是一次 ref 读取。
	 */
	useEffect(() => {
		if ((ioRef.current || moRef.current) && !timelineRef.current) teardown();
	});

	/**
	 * 同步读视口内的行（按文档序）。只对视口附近的行走布局读取。
	 *
	 * 集合里的行可能比视口多（VIEWPORT_ROOT_MARGIN），也可能比视口旧一帧：这里用
	 * rect 几何逐条筛选，而不是拿「第一名是否跨过顶边」判断整份集合是否可信——
	 * 后者会把行间空白与 IO 迟到行都当成缓存失效，静默退回全量扫描。
	 */
	const readVisibleRows = useCallback((): VisibleTimelineRow[] => {
		connect();
		const timeline = timelineRef.current;
		if (!timeline) return [];
		// IO 的 root 相交矩形以 padding box 为界（不含 border）；origin 必须同基准，
		// 否则 .message-timeline 一旦加 border，边界行的 top 会系统性偏一个 border 宽度。
		const origin = timeline.getBoundingClientRect().top + timeline.clientTop;
		const viewportBottom = timeline.clientHeight;
		const collected: { element: Element; row: VisibleTimelineRow }[] = [];
		for (const element of visibleRef.current) {
			if (!element.isConnected) continue;
			const id = timelineRowId(element);
			if (!id) continue;
			const rect = element.getBoundingClientRect();
			collected.push({
				element,
				row: { id, top: rect.top - origin, bottom: rect.bottom - origin, isRootRow: isRootTimelineRow(element), width: rect.width, height: rect.height },
			});
		}
		// 文档序与全量 querySelectorAll 的遍历次序一致；top 只在两个元素无法比较
		// （同一节点/脱离文档）时兜底，避免快路径与回落路径选中不同的行。
		collected.sort((a, b) => {
			const relation = a.element.compareDocumentPosition(b.element);
			if (relation & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
			if (relation & Node.DOCUMENT_POSITION_PRECEDING) return 1;
			return a.row.top - b.row.top;
		});
		return selectVisibleRows(
			collected.map((entry) => entry.row),
			viewportBottom,
		);
	}, [connect, timelineRef]);

	return { readVisibleRows };
}
