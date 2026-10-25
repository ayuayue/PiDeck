import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * 划选期间冻结「指针下这块正文」的渲染文本。
 *
 * 为什么需要（真机上流式选区保持的第三处根因，比 DOM churn 更早发生）：鼠标按下到 pointerup 之间
 * 只要来一个 chunk，live 正文的文本节点就会重挂，Chromium 会当场把拖选中的 Selection 收掉/重锚——
 * 快照根本来不及拍，pointerup 拿到的已经是折叠选区，后面什么都还原不了（实测：松手后下一次读取
 * 已经是 collapsed）。所以拖选期间必须让指针下的文本「原地不动」。
 *
 * 做法与边界：
 * - 只在主键按下且落点位于 rootRef 元素内（[data-live-answer]）时冻结，pointerup/pointercancel/
 *   window blur 立刻解冻；冻结期间用冻结时刻的文本渲染，不暂停数据接收（streaming atom 照常更新）。
 * - 解冻时把最新文本一次性画出来，不需要重新挂载 MarkdownStream（打字机自己追平）；因此每次拖选
 *   只多 2 次 React 提交（按下/松开各一次），对长列表没有额外负担。
 * - 这是刻意的产品行为：指针下的正文在拖选期间不能移动，否则「选中一段文字」这件事根本无法完成。
 *
 * 渲染用文本以 heldRef 为准（同步，不依赖 setState 提交）：按下事件与随后的流式渲染若发生在同一帧，
 * setHeld 还没提交时 heldRef 已经是 true，那一帧也不会漏冻结；held state 只负责在按下/松开时
 * 各触发一次重渲染（否则冻结期间没有新 props 时不会重绘、解冻后也画不出积压的最新文本）。
 */
export function useHoldTextWhileSelecting<T extends string>(text: T, rootRef: RefObject<HTMLElement | null>): T {
	/** 冻结标志（同步生效）：true 时渲染走 heldTextRef。 */
	const heldRef = useRef(false);
	/** held 只用于「按下/松开各触发一次重渲染」，见头注释。 */
	const [held, setHeld] = useState(false);
	/** 冻结前最后一次渲染的文本；只在未冻结时更新。 */
	const heldTextRef = useRef(text);

	// 未冻结时把最新文本记进 ref：render 阶段写 ref（与 MarkdownStream 的冻结字符串缓存同一写法），
	// 保证 pointerdown 之前渲染过的文本一定已经在 ref 里。held 参与条件是为了兜住「松开后
	// setHeld(false) 还没提交」的那一两帧：此时已解冻，直接返回最新文本即可。
	if (!held && !heldRef.current) heldTextRef.current = text;

	useEffect(() => {
		const release = () => {
			if (!heldRef.current) return;
			heldRef.current = false;
			setHeld(false);
		};
		const onPointerDown = (event: PointerEvent) => {
			// 只认主键：右键/中键（消息右键菜单、自动滚动等）不该冻结正文
			if (event.button !== 0) return;
			const root = rootRef.current;
			if (!root || !(event.target instanceof Node) || !root.contains(event.target)) return;
			heldRef.current = true;
			setHeld(true);
		};
		document.addEventListener("pointerdown", onPointerDown, true);
		// 松开/取消/失焦都要解冻：漏一个就会让 live 正文永久停在旧文本上
		window.addEventListener("pointerup", release, true);
		window.addEventListener("pointercancel", release, true);
		window.addEventListener("blur", release);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown, true);
			window.removeEventListener("pointerup", release, true);
			window.removeEventListener("pointercancel", release, true);
			window.removeEventListener("blur", release);
		};
	}, [rootRef]);

	return heldRef.current ? heldTextRef.current : text;
}
