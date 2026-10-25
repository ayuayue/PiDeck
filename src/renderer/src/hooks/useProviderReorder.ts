import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { DragEvent, KeyboardEvent } from "react";
import { PROVIDER_CARD_DRAG_MIME, moveProviderByStep, moveProviderRelative } from "../utils/providerOrder";
import { createDragGhost } from "../utils/dragGhost";

/** 当前落点：插到哪个供应商卡片的前/后。 */
export type ProviderDropTarget = { name: string; position: "before" | "after" };

/** 卡片拖拽事件（HTML5 原生 DnD，与仓库既有拖拽一致：不引第三方 dnd 库）。 */
type ProviderCardHandlers = {
	onDragOver: (event: DragEvent<HTMLDivElement>) => void;
	onDragLeave: (event: DragEvent<HTMLDivElement>) => void;
	onDrop: (event: DragEvent<HTMLDivElement>) => void;
};

type ProviderGripHandlers = {
	draggable: true;
	onDragStart: (event: DragEvent<HTMLButtonElement>) => void;
	onDragEnd: () => void;
	/** 手柄聚焦时的 ↑/↓ 键盘重排（上移/下移按钮的无障碍替代）。 */
	onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
};

/** FLIP 落位动画时长（毫秒）：重排后卡片从旧位置滑到新位置。 */
const REORDER_FLIP_DURATION_MS = 220;

/** 系统开了「减少动态效果」时跳过 FLIP 与指示线以外的动效（跟随 OS 无障碍设置，hook 内只判这一次）。 */
function prefersReducedMotion(): boolean {
	return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * 供应商卡片排序交互（拖动 + 手柄方向键）的共享状态机，Pi 模型页、Pi 认证页与 DSH 模型页复用同一份。
 *
 * 为什么抽成 hook 而不是各页各写一套：
 * 1. 落点判定、拖动中视觉、插入指示线、FLIP 落位动画这些规则必须三页一致，复制多份必然漂移；
 * 2. DOM 结构各页不同（Pi 卡的标题行是内联 JSX，DSH 用 ProviderRowHead），
 *    所以 hook 只暴露事件/ref 工厂，由调用方决定贴到哪个元素上。
 *
 * 交互形态：只保留拖拽（卡头左侧的 ⋮⋮ 手柄），不渲染上移/下移按钮——按钮在整行点击展开的卡片上
 * 是纯视觉噪音，且一次只能挪一位。键盘可达性没有丢：手柄聚焦后 ↑/↓ 以可见邻居为锚点移动一位。
 *
 * 顺序语义交给 utils/providerOrder 的纯函数：names 是完整顺序（含隐藏项），
 * visibleNames 只用于方向键取邻居，避免隐藏项打断可见区的相对顺序。
 */
export function useProviderReorder(options: { names: readonly string[]; visibleNames: readonly string[]; onReorder: (nextOrder: string[]) => void }) {
	const { names, visibleNames, onReorder } = options;
	const cardRefs = useRef<Record<string, HTMLElement | null>>({});
	// 拖动源与落点必须用 state：拖动过程要实时渲染半透明卡片与插入指示线。
	const [draggingName, setDraggingName] = useState<string | null>(null);
	const [dropTarget, setDropTarget] = useState<ProviderDropTarget | null>(null);
	// FLIP（First-Last-Invert-Play）落位动画：提交重排前记录每张卡的旧视口位置（First），
	// DOM 换到新顺序后量新位置（Last），把卡片先反向平移回旧位置（Invert）再过渡回 0（Play）。
	// 重排瞬间不再「跳变」，整列卡片平滑滑动落位；连续快速触发时中途重采样，动画不跳跃。
	const rectsBeforeReorder = useRef(new Map<string, DOMRect>());
	const flipPending = useRef(false);
	// 拖拽影像节点：dragstart 时克隆卡头挂到 body，dragend 才能移除（Chromium 在拖动全程引用它截图）。
	const dragGhostRef = useRef<HTMLDivElement | null>(null);

	/** 卡片容器 ref：落点判定需要读取卡片的实际位置。 */
	const registerCard = useCallback((name: string, element: HTMLDivElement | null) => {
		if (element) cardRefs.current[name] = element;
		else delete cardRefs.current[name];
	}, []);

	/**
	 * 落点判定：以卡片标题行（data-provider-head）的中线为准，指针在上半区→插到该卡之前，下半区→之后。
	 * 展开态卡片很高，拿整张卡的中线会让落点偏到折叠区，所以固定量标题行；
	 * 不能用 firstElementChild：拖拽中卡内会插入绝对定位的指示线 span，会抢到头子元素。
	 * 取不到矩形（列表刚更新、元素未挂载）时退化为「插到之前」，不会抛错。
	 */
	const resolveDropPosition = useCallback((event: DragEvent<HTMLDivElement>, name: string): "before" | "after" => {
		const card = cardRefs.current[name];
		const headRow = card?.querySelector("[data-provider-head]") ?? card?.firstElementChild;
		const rect = (headRow ?? card)?.getBoundingClientRect();
		if (!rect) return "before";
		return event.clientY < rect.top + rect.height / 2 ? "before" : "after";
	}, []);

	/**
	 * 提交一次重排（拖拽落点与方向键共用）：先记旧位置再上抛，父级 setState 回流后
	 * 由下面的 useLayoutEffect 播 FLIP。「减少动态效果」开启时直接上抛，保持瞬时落位。
	 */
	const commitReorder = useCallback(
		(nextOrder: string[]) => {
			if (prefersReducedMotion()) {
				onReorder(nextOrder);
				return;
			}
			for (const [key, element] of Object.entries(cardRefs.current)) {
				if (element) rectsBeforeReorder.current.set(key, element.getBoundingClientRect());
			}
			flipPending.current = true;
			onReorder(nextOrder);
		},
		[onReorder],
	);

	// FLIP 的 Invert+Play 段。依赖 names（完整顺序）而不是 visibleNames：隐藏区卡片也要跟着滑动。
	// names 可能每次渲染都是新数组（调用方传内联派生值），所以用 flipPending 标记区分
	// 「本次渲染是重排后的」还是普通重渲染——普通重渲染不量位置、不播动画。
	useLayoutEffect(() => {
		if (!flipPending.current) return;
		flipPending.current = false;
		const beforeRects = rectsBeforeReorder.current;
		if (beforeRects.size === 0) return;
		for (const [key, element] of Object.entries(cardRefs.current)) {
			const beforeRect = beforeRects.get(key);
			if (!element || !beforeRect) continue;
			const dy = beforeRect.top - element.getBoundingClientRect().top;
			// 位移小于 1px 不播动画（拖回原位等无感变化），避免无意义的合成层开销。
			if (Math.abs(dy) < 1) continue;
			element.animate([{ transform: `translateY(${dy}px)` }, { transform: "translateY(0px)" }], { duration: REORDER_FLIP_DURATION_MS, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
		}
		beforeRects.clear();
	}, [names]);

	const handleDragStart = useCallback((event: DragEvent<HTMLButtonElement>, name: string) => {
		event.dataTransfer.effectAllowed = "move";
		// 自定义 MIME 防止外部拖入的文本/链接被当成本列表内部重排；text/plain 兜底便于调试。
		event.dataTransfer.setData(PROVIDER_CARD_DRAG_MIME, name);
		event.dataTransfer.setData("text/plain", name);
		setDraggingName(name);
		// 拖拽影像：原生默认影像是被拖的手柄按钮本身（十几像素的图标），拖起来不知道自己拿着什么。
		// 克隆整条卡头当影像（样式与其它列表共用 dragGhost 工具）；克隆节点不处于 hover 态，
		// hover 浮现的操作按钮在影像里自动隐藏，比真卡还干净。dragend 时移除（Chromium 拖动全程引用它截图）。
		const head = cardRefs.current[name]?.querySelector<HTMLElement>("[data-provider-head]");
		if (!head) return;
		dragGhostRef.current?.remove();
		const ghost = createDragGhost(head);
		dragGhostRef.current = ghost.node;
		event.dataTransfer.setDragImage(ghost.node, ghost.x, ghost.y);
	}, []);

	const handleDragEnd = useCallback(() => {
		setDraggingName(null);
		setDropTarget(null);
		dragGhostRef.current?.remove();
		dragGhostRef.current = null;
	}, []);

	const handleDragOver = useCallback(
		(event: DragEvent<HTMLDivElement>, name: string) => {
			// 只接自己发起的拖动：不 preventDefault，浏览器就不会把该位置当合法落点。
			if (!draggingName || draggingName === name) return;
			event.preventDefault();
			event.dataTransfer.dropEffect = "move";
			const position = resolveDropPosition(event, name);
			// 仅在落点真正变化时 setState：dragover 每次鼠标移动都触发，不去重会持续重渲染整个列表。
			setDropTarget((prev) => (prev?.name === name && prev.position === position ? prev : { name, position }));
		},
		[draggingName, resolveDropPosition],
	);

	const handleDragLeave = useCallback((event: DragEvent<HTMLDivElement>, name: string) => {
		// 拖到卡片内部子元素上也会触发 dragleave，此时 relatedTarget 仍在卡片内，不能清除指示线。
		const related = event.relatedTarget;
		if (related instanceof Node && event.currentTarget.contains(related)) return;
		setDropTarget((prev) => (prev?.name === name ? null : prev));
	}, []);

	const handleDrop = useCallback(
		(event: DragEvent<HTMLDivElement>, name: string) => {
			event.preventDefault();
			const source = draggingName;
			// 松手瞬间 dropTarget 可能还没跟上最后一次 dragover，此时按当前指针位置重算。
			const position = dropTarget?.name === name ? dropTarget.position : resolveDropPosition(event, name);
			setDraggingName(null);
			setDropTarget(null);
			if (!source || source === name) return;
			commitReorder(moveProviderRelative(names, source, name, position));
		},
		[draggingName, dropTarget, names, commitReorder, resolveDropPosition],
	);

	/**
	 * 手柄聚焦时的键盘重排：↑/↓ 以可见邻居为锚点在完整顺序上移动一位。
	 * 这是被删掉的上移/下移按钮的无障碍替代——纯键盘用户与想精确微调的用户仍有入口，
	 * 且不占任何常驻/悬停视觉空间。到顶/到底由 moveProviderByStep 返回 null 自然忽略。
	 */
	const handleGripKeyDown = useCallback(
		(event: KeyboardEvent<HTMLButtonElement>, name: string) => {
			if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
			event.preventDefault();
			event.stopPropagation();
			const next = moveProviderByStep(names, visibleNames, name, event.key === "ArrowUp" ? -1 : 1);
			if (next) commitReorder(next);
		},
		[names, visibleNames, commitReorder],
	);

	const cardProps = useCallback(
		(name: string): ProviderCardHandlers => ({
			onDragOver: (event) => handleDragOver(event, name),
			onDragLeave: (event) => handleDragLeave(event, name),
			onDrop: (event) => handleDrop(event, name),
		}),
		[handleDragOver, handleDragLeave, handleDrop],
	);

	const gripProps = useCallback(
		(name: string): ProviderGripHandlers => ({
			draggable: true,
			onDragStart: (event) => handleDragStart(event, name),
			onDragEnd: handleDragEnd,
			onKeyDown: (event) => handleGripKeyDown(event, name),
		}),
		[handleDragStart, handleDragEnd, handleGripKeyDown],
	);

	return { draggingName, dropTarget, registerCard, cardProps, gripProps };
}
