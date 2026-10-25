import { useEffect, useRef, type RefObject } from "react";
import { captureSelectionSnapshot, isRangeInsideElement, restoreSelectionSnapshot, type SelectionSnapshot } from "../lib/selectionTextOffsets";

/**
 * 流式正文划选保持：流式渲染（MarkdownStream 每帧重渲染 + 冻结前缀推进时重挂尾部子树 +
 * settle 时 live→settled 整树替换）会把用户刚拖出来的选区「清理」掉（Chromium 在选区覆盖
 * 的文本节点被移除时会把 Selection 折叠掉或重锚到父元素整段文本）。本 hook 不暂停流式、
 * 不改 MarkdownStream，只在 DOM 变更后把选区按文本锚点还原回去。
 *
 * 设计边界（为什么这样做）：
 * - 恢复时机：MutationObserver 回调（微任务，早于绘制）里同步 removeAllRanges/addRange，
 *   用户看不到塌陷那一帧；不用 rAF 循环、不用 React state，不会引入额外重渲染。
 * - 只有「DOM 变更把选区搞坏」时才恢复：用户主动动作（pointerdown/非修饰键 keydown/
 *   window blur）一律丢弃快照；拖选进行中（pointer 按下）绝不插手。
 * - 恢复后 selectionchange 只会重新拍到同一段文本的快照，不会自激循环。
 * - 与 useTimelineSelection（划选引用浮层）共存：浮层的健在性键是 range.toString()，
 *   还原出的选区文本逐字相同，所以浮层不会因为这次恢复被误撤。
 */

/**
 * 连续失配多少次才判定选区真的丢了：settle 交接期正文可能短暂「双无」（live 副本已卸、settled 未挂），
 * 每个 React 提交 = 一个 mutation 批次，给到 8 个批次（≈100ms）的宽限；真的丢了也只多留 ~100ms 快照。
 */
const MAX_RESTORE_MISSES = 8;
/**
 * 键盘输入后的静默期：Shift+方向键等键盘扩选在 keyup 之前，DOM 变更触发的自动恢复不能抢在
 * 用户本次按键前面。鼠标拖选不需要这个闸：pointerDown 标志已经保证拖选中不插手，而松手后
 * 立刻恢复才是正确行为（churn 往往就在下一帧，静默期反而会把最关键的还原吞掉）。
 */
const KEYBOARD_RESTORE_QUIET_MS = 250;

/**
 * 在 TurnRow 的根节点上挂「选区保持」监听。
 *
 * rootRef 指向整轮容器（article.turn-row）：live 正文与 settled 正文都在里面，
 * 所以流式 churn 与 settle 换树两种替换都能被同一个 MutationObserver 覆盖。
 */
export function useStreamSelectionPreserve(rootRef: RefObject<HTMLElement | null>): void {
	const observedRootRef = useRef<HTMLElement | null>(null);
	const disposeRef = useRef<(() => void) | null>(null);

	// 故意不写依赖数组：TurnRow 在 displayItems 为空时先 return null（没有 <article>），
	// 正文到达后才把 rowRef 挂到真实节点上；依赖 [rootRef] 只会跑一次，首轮拿不到 DOM
	// 就永远不挂监听（首轮流式正文正是最需要保护的场景）。用「已观察根节点」做幂等守卫：
	// 同一个根不重复挂，根节点换了才重建。
	useEffect(() => {
		const root = rootRef.current;
		if (observedRootRef.current === root) return;
		disposeRef.current?.();
		observedRootRef.current = root;
		disposeRef.current = root ? attachSelectionPreserve(root) : null;
	});

	// 卸载清理：上面的 effect 只负责「根节点变化时换挂」，真正的收尾在这里。
	useEffect(() => {
		return () => {
			disposeRef.current?.();
			disposeRef.current = null;
			observedRootRef.current = null;
		};
	}, []);
}

/** 给单个根节点挂监听，返回解绑函数（observer + 事件监听 + 快照一起释放）。 */
function attachSelectionPreserve(root: HTMLElement): () => void {
	/** 当前划选快照；null = 没有需要保护的选区（observer 热路径直接返回）。 */
	let snapshot: SelectionSnapshot | null = null;
	/** 指针是否按下（拖选中）：按下期间一律不恢复，也不把 DOM 变更当作「选区被搞坏」。 */
	let pointerDown = false;
	/** 连续恢复失配计数：settle 交接窗口允许短暂失败，连续多次才丢快照。 */
	let misses = 0;
	/** 最近一次键盘输入时间（performance.now()）：键盘扩选尚未收尾时不让自动恢复抢先。 */
	let lastKeyboardInputAt = 0;

	const now = () => performance.now();

	const dropSnapshot = () => {
		snapshot = null;
		misses = 0;
	};

	const liveSelectionRange = (): Range | null => {
		const selection = window.getSelection();
		if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
		return selection.getRangeAt(0);
	};

	/**
	 * 从实时选区拍快照。
	 *
	 * trusted=true 只用于「刚刚由用户亲手产生/刷新的选区」（拖选收尾的 pointerup、键盘 keyup）：
	 * 这类文本变化是用户意图，直接覆盖快照。trusted=false（普通 selectionchange）时，
	 * 若文本与旧快照不同则不覆盖——流式重挂会把选区重锚成父元素整段文本（撑大），
	 * 那不是用户的新选区，必须以旧快照为准等 MutationObserver 还原。
	 */
	const capture = (trusted: boolean) => {
		if (!root.isConnected) return;
		const range = liveSelectionRange();
		if (!range) return; // 折叠/无选区：可能正是 churn 挤掉的，保留旧快照交给 observer 恢复
		if (!isRangeInsideElement(root, range)) return; // 选区不在本轮内：不归这里管（清理由 pointerdown 负责）
		const text = range.toString();
		if (!trusted) {
			// 未信任的 selectionchange（DOM churn 触发）只有两个合法动作：刷新已有快照的节点引用，
			// 或者什么都不做。没有快照时**绝不新建**——churn 产出的选区可能是「跨块/撑大」的残影
			// （实测起点落到行头 <time>，恢复后 Selection.toString() 多出块级换行、变成 '\\n以下是'），
			// 一旦被当成快照，之后每次还原都按错误锚点走，再也修不回来。
			if (!snapshot || snapshot.text !== text) return;
		}
		const next = captureSelectionSnapshot(root, range);
		if (!next) return;
		snapshot = next;
		misses = 0;
	};

	/**
	 * DOM 变更后的恢复。
	 * 判定顺序：无快照直接返回（每帧热路径）→ 拖选中不插手 → 选区完好（文本一致）不动 →
	 * 用户刚有输入让位 → 选区被移到本轮之外则放弃 → 三段式锚点还原。
	 */
	const onMutations = () => {
		if (!snapshot) return;
		if (pointerDown) return;
		const range = liveSelectionRange();
		if (range) {
			// 选区已在本轮之外（Ctrl+A / 用户选到别处）：不抢，也不丢快照——用户下次 pointerdown
			// 才是真正的清理点；在这里丢掉反而会在「重锚暂时落到祖先节点外」时白白失去选区。
			if (!isRangeInsideElement(root, range)) return;
			if (range.toString() === snapshot.text) return;
		}
		// 只有键盘输入需要让位：鼠标拖选由 pointerDown 拦住，松手后的恢复越快越好
		if (now() - lastKeyboardInputAt < KEYBOARD_RESTORE_QUIET_MS) return;
		const restored = restoreSelectionSnapshot(root, snapshot);
		if (!restored) {
			misses += 1;
			if (misses >= MAX_RESTORE_MISSES) dropSnapshot();
			return;
		}
		misses = 0;
		const selection = window.getSelection();
		if (!selection) return;
		selection.removeAllRanges();
		selection.addRange(restored);
	};

	const onSelectionChange = () => {
		// selectionchange 本身不区分「用户选的」和「DOM 变更挤的」：只有拖选中才当成用户意图；
		// 其余情况交给 capture(false) 按文本是否变化自行判定（见 capture 注释）。
		capture(pointerDown);
	};

	const onPointerDown = (event: PointerEvent) => {
		// 只认主键：右键/中键（如消息右键菜单）不能清快照，否则菜单打开期间流式 churn 会把
		// 选区清掉，右键复制就没了选区。
		if (event.button !== 0) return;
		dropSnapshot();
		pointerDown = true;
	};

	const onPointerUp = (event: PointerEvent) => {
		if (event.button !== 0) return;
		pointerDown = false;
		// 拖选收尾：此刻的实时选区就是用户的最终选区，直接信任并拍快照
		// （浏览器可能在 pointerup 后还有一次 selectionchange，那次会因文本一致只刷新节点引用）。
		capture(true);
	};

	const onPointerCancel = () => {
		pointerDown = false;
	};

	const onKeyDown = (event: KeyboardEvent) => {
		lastKeyboardInputAt = now();
		// Ctrl/Meta/Shift：Ctrl+C 复制与 Shift+方向键扩选都还在进行，不能在这里丢快照；
		// 其它按键 = 用户切走/中断当前划选意图（Escape、输入字符等），丢弃快照。
		if (event.ctrlKey || event.metaKey || event.shiftKey) return;
		dropSnapshot();
	};

	const onKeyUp = () => {
		lastKeyboardInputAt = now();
		// 键盘扩选（Shift+方向键 / Ctrl+A）在 keyup 后才是最终态：信任并刷新快照
		capture(true);
	};

	const onWindowBlur = () => {
		pointerDown = false;
		dropSnapshot();
	};

	const observer = new MutationObserver(onMutations);
	observer.observe(root, { childList: true, subtree: true, characterData: true });
	document.addEventListener("selectionchange", onSelectionChange, true);
	window.addEventListener("pointerdown", onPointerDown, true);
	window.addEventListener("pointerup", onPointerUp, true);
	window.addEventListener("pointercancel", onPointerCancel, true);
	document.addEventListener("keydown", onKeyDown, true);
	document.addEventListener("keyup", onKeyUp, true);
	window.addEventListener("blur", onWindowBlur);

	return () => {
		observer.disconnect();
		document.removeEventListener("selectionchange", onSelectionChange, true);
		window.removeEventListener("pointerdown", onPointerDown, true);
		window.removeEventListener("pointerup", onPointerUp, true);
		window.removeEventListener("pointercancel", onPointerCancel, true);
		document.removeEventListener("keydown", onKeyDown, true);
		document.removeEventListener("keyup", onKeyUp, true);
		window.removeEventListener("blur", onWindowBlur);
		dropSnapshot();
	};
}
