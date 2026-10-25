/**
 * 流式正文划选保持的「文本锚点」工具（纯计算 + 少量 DOM 映射）。
 *
 * 为什么需要（用户反馈：「在渲染中的，选中会被清理，导致无法在回复中的时候选中一些文本」）：
 * MarkdownStream 每帧（打字机 ~8ms）都会重渲染，冻结前缀推进时尾部 React 子树会整体
 * 重挂（key = generation:prefixEnd），settle 时 live 副本又被 settled 副本替换。Chromium 在
 * 选区覆盖的文本节点被移除时会把 DOM Selection 收成折叠态或重锚到父元素（撑成整段文本），
 * 用户拖出来的选区下一帧就没了/变了。本模块只负责「把选区变成抗抖动的锚点」与「从锚点
 * 还原 Range」，恢复时机由 useStreamSelectionPreserve 决定（这里不碰事件、不碰计时器）。
 *
 * 为什么偏移按「根元素文本节点顺序拼接」计数，而不是 Selection.toString()/Range.toString() 的
 * 绝对长度：Chromium 只在 Selection.toString() 里给块级边界补 \n\n，Range.toString() 不留分隔，
 * 同一段跨段落选区两个 API 的长度必然不同。锚点必须与 rangeOffsetsInRoot 用同一套计数
 * （Range 从根节点起算的纯文本拼接），否则跨段落选区恢复后用 range.toString() 校验恒失配。
 * 详见 selectionToolbarPolicy.ts 的 selectionIntegrityKey 注释（那里记录过同类根因）。
 */

/** 锚点上下文长度：选区前后各取多少字符，用于偏移漂移后的唯一匹配。 */
export const SELECTION_CONTEXT_CHARS = 32;

/** 选区的纯文本描述：文本本身 + 前后文片段（都是「文本节点拼接」口径，不含块级分隔）。 */
export type SelectionContext = {
	/** 选中的文本（= Range.toString()，用于恢复后逐字校验）。 */
	text: string;
	/** 选区起点之前的上下文（最多 SELECTION_CONTEXT_CHARS 个字符）。 */
	prefix: string;
	/** 选区终点之后的上下文（最多 SELECTION_CONTEXT_CHARS 个字符）。 */
	suffix: string;
};

/** 一次划选的完整快照：文本上下文 + 绝对偏移 + 原始端点文本节点引用。 */
export type SelectionSnapshot = SelectionContext & {
	/** 选区起点在根元素文本节点序列里的绝对字符偏移。 */
	start: number;
	/** 选区终点在根元素文本节点序列里的绝对字符偏移。 */
	end: number;
	/** 原始起点文本节点（流式重挂后可能已脱离文档，恢复时先校验 isConnected/长度）。 */
	startNode: Text | null;
	startNodeOffset: number;
	/** 原始终点文本节点。 */
	endNode: Text | null;
	endNodeOffset: number;
};

/**
 * 从整段根文本里切出「选中文本 + 前后文」。
 * 纯函数：offsets 会被夹紧到 [0, fullText.length]，顺序颠倒时退化成空选区（不抛错）。
 */
export function buildSelectionContext(fullText: string, start: number, end: number, contextChars: number = SELECTION_CONTEXT_CHARS): SelectionContext {
	const from = Math.max(0, Math.min(start, fullText.length));
	const to = Math.max(from, Math.min(end, fullText.length));
	return {
		text: fullText.slice(from, to),
		prefix: fullText.slice(Math.max(0, from - contextChars), from),
		suffix: fullText.slice(to, Math.min(fullText.length, to + contextChars)),
	};
}

/**
 * 找出 needle 在 haystack 里的全部出现位置（允许重叠：索引每次 +1）。
 * 重叠也要列出来，否则「重复片段里第 2 个出现」这类候选会漏掉，上下文评分随之失真。
 */
export function findTextOccurrences(haystack: string, needle: string): number[] {
	if (!needle || !haystack) return [];
	const indexes: number[] = [];
	let index = haystack.indexOf(needle);
	while (index !== -1) {
		indexes.push(index);
		index = haystack.indexOf(needle, index + 1);
	}
	return indexes;
}

/**
 * 候选位置的上下文匹配分：与快照前后文「从选区向外」连续匹配的字符总数。
 * 流式只会往尾部追加、settle 会重排 markdown，两种情况下前后文都比绝对偏移可靠。
 */
export function contextMatchScore(fullText: string, index: number, text: string, prefix: string, suffix: string): number {
	let score = 0;
	for (let i = 0; i < prefix.length && index - 1 - i >= 0; i += 1) {
		if (fullText[index - 1 - i] !== prefix[prefix.length - 1 - i]) break;
		score += 1;
	}
	const end = index + text.length;
	for (let i = 0; i < suffix.length && end + i < fullText.length; i += 1) {
		if (fullText[end + i] !== suffix[i]) break;
		score += 1;
	}
	return score;
}

/**
 * 在当前根文本里定位快照文本的可信位置。
 *
 * 规则（宁可放弃也不能把选区恢复到错误位置）：
 * - 文本只出现一次 → 直接命中；
 * - 出现多次 → 取上下文匹配分最高的那一个，且最高分必须唯一；
 *   最高分并列（例如同文本多处的上下文一模一样）→ 返回 null，交给调用方丢弃快照。
 */
export function locateSelectionContext(fullText: string, context: SelectionContext): { start: number; end: number } | null {
	if (!context.text) return null;
	const candidates = findTextOccurrences(fullText, context.text);
	if (candidates.length === 0) return null;
	if (candidates.length === 1) return { start: candidates[0], end: candidates[0] + context.text.length };
	let bestIndex = -1;
	let bestScore = -1;
	let bestCount = 0;
	for (const index of candidates) {
		const score = contextMatchScore(fullText, index, context.text, context.prefix, context.suffix);
		if (score > bestScore) {
			bestIndex = index;
			bestScore = score;
			bestCount = 1;
		} else if (score === bestScore) {
			bestCount += 1;
		}
	}
	if (bestCount !== 1 || bestIndex < 0) return null;
	return { start: bestIndex, end: bestIndex + context.text.length };
}

/**
 * 选区两端是否都还在根元素内（节点已脱离文档时 contains 恒 false）。
 * 折叠/无选区由调用方自行判断，这里只管范围合法性。
 */
export function isRangeInsideElement(root: HTMLElement, range: Range): boolean {
	const start = range.startContainer;
	const end = range.endContainer;
	return start.isConnected && end.isConnected && root.contains(start) && root.contains(end);
}

/** 根元素内按文档顺序收集文本节点（顺序与 Range.toString() 的文本遍历一致）。 */
function textNodesOf(root: Node): Text[] {
	const nodes: Text[] = [];
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	let current = walker.nextNode();
	while (current) {
		if (current instanceof Text) nodes.push(current);
		current = walker.nextNode();
	}
	return nodes;
}

/** 根元素的纯文本（文本节点按序拼接，不含块级分隔——与 rangeOffsetsInRoot 同一口径）。 */
export function readRootText(root: Node): string {
	return textNodesOf(root)
		.map((node) => node.data)
		.join("");
}

/**
 * 把根文本偏移映射到「文本节点 + 节点内偏移」；偏移越界返回 null。
 *
 * bias 决定「偏移正好落在两个文本节点交界处」时落到哪一侧（真机实测的块级换行根因）：
 * - "next"（起点用）：落到后一个文本节点的开头。起点若落到前一个节点的末尾，而前一个节点在
 *   别的块里（如行头 <time>10/20 15:12</time>），浏览器会认为选区从一个块「跨到」正文块，
 *   Selection.toString() 在文本前补一个换行（实测 '以下是' → '\n以下是'），与快照文本不再相等。
 * - "previous"（终点用）：落到前一个文本节点的末尾；终点贴块尾时仍留在同一块内，不产生尾部换行。
 *
 * 偏移 0 恒落到第一个非空文本节点；空文本节点（长度 0）不参与映射，它们既存不住选区，
 * 又可能落在别的块里。
 */
function pointAtTextOffset(nodes: Text[], offset: number, bias: "next" | "previous"): { node: Text; offset: number } | null {
	if (offset < 0) return null;
	let remaining = offset;
	let lastNonEmpty: Text | null = null;
	for (const node of nodes) {
		const length = node.length;
		if (length === 0) continue;
		lastNonEmpty = node;
		// next：只有偏移严格小于节点末尾才落进来；正好等于末尾时继续找下一个节点
		if (bias === "next" ? remaining < length : remaining <= length) return { node, offset: remaining };
		remaining -= length;
	}
	// start 偏后：偏移等于整段文本长度时没有「下一个节点」，退化为最后一个节点末尾
	if (bias === "next" && lastNonEmpty && remaining === 0) return { node: lastNonEmpty, offset: lastNonEmpty.length };
	return null;
}

/**
 * Range → 根元素文本偏移区间。
 *
 * 用「起点固定为根元素开头」的临时 Range 数前缀文本长度：与 textNodesOf/readRootText 完全同一
 * 套文本节点拼接口径，跨块级边界时也不会像 Selection.toString() 那样被塞进 \n\n。
 * 两端不在根内返回 null。
 */
export function rangeOffsetsInRoot(root: HTMLElement, range: Range): { start: number; end: number } | null {
	if (!isRangeInsideElement(root, range)) return null;
	const counter = document.createRange();
	counter.selectNodeContents(root);
	try {
		counter.setEnd(range.startContainer, range.startOffset);
	} catch {
		// 端点在不可比对的节点树里（理论不可达）：当作不可计算
		return null;
	}
	const start = counter.toString().length;
	try {
		counter.setEnd(range.endContainer, range.endOffset);
	} catch {
		return null;
	}
	return { start, end: counter.toString().length };
}

/**
 * 根元素文本偏移区间 → Range。
 *
 * 起点取「下一个文本节点」（bias=next）、终点取「上一个文本节点」（bias=previous）：
 * 两点都收在各自所在的块内，跨块边界时不会凭空多出 Selection.toString() 的块级换行，
 * 见 pointAtTextOffset 的注释。
 */
export function rangeFromOffsets(root: HTMLElement, start: number, end: number): Range | null {
	if (start < 0 || end < start) return null;
	const nodes = textNodesOf(root);
	const startPoint = pointAtTextOffset(nodes, start, "next");
	const endPoint = pointAtTextOffset(nodes, end, "previous");
	if (!startPoint || !endPoint) return null;
	const range = document.createRange();
	try {
		range.setStart(startPoint.node, startPoint.offset);
		range.setEnd(endPoint.node, endPoint.offset);
	} catch {
		// 极端情况下两个端点映射到逆序位置（DOM 刚被重挂）：当作不可恢复
		return null;
	}
	return range;
}

/** 从实时 Range 拍快照；选区落在根外、为空或两端文本与偏移对不上时返回 null。 */
export function captureSelectionSnapshot(root: HTMLElement, range: Range): SelectionSnapshot | null {
	if (range.collapsed) return null;
	if (!isRangeInsideElement(root, range)) return null;
	const text = range.toString();
	if (!text) return null;
	const offsets = rangeOffsetsInRoot(root, range);
	if (!offsets) return null;
	const context = buildSelectionContext(readRootText(root), offsets.start, offsets.end);
	// 双口径自校验：Range 文本必须等于「根文本按偏移切片」。相等才说明两套计数一致，
	// 后面恢复时才能用 range.toString() === snapshot.text 做校验。
	if (context.text !== text) return null;
	return {
		...context,
		...offsets,
		startNode: range.startContainer instanceof Text ? range.startContainer : null,
		startNodeOffset: range.startOffset,
		endNode: range.endContainer instanceof Text ? range.endContainer : null,
		endNodeOffset: range.endOffset,
	};
}

/** 三段式恢复：原始文本节点 → 绝对偏移 → 前后文唯一匹配；每段都用 range.toString() 逐字校验。 */
export function restoreSelectionSnapshot(root: HTMLElement, snapshot: SelectionSnapshot): Range | null {
	// (a) 原始节点引用：流式追加时选中区若已落在冻结前缀里，节点根本没被换过，最精确
	if (snapshot.startNode && snapshot.endNode) {
		const startOk = snapshot.startNode.isConnected && root.contains(snapshot.startNode) && snapshot.startNodeOffset <= snapshot.startNode.length;
		const endOk = snapshot.endNode.isConnected && root.contains(snapshot.endNode) && snapshot.endNodeOffset <= snapshot.endNode.length;
		if (startOk && endOk) {
			const range = document.createRange();
			range.setStart(snapshot.startNode, snapshot.startNodeOffset);
			range.setEnd(snapshot.endNode, snapshot.endNodeOffset);
			if (range.toString() === snapshot.text) return range;
		}
	}
	// (b) 绝对偏移：追加式流式渲染时选区之前的文本没有变化，偏移仍指向同一段
	const offsetRange = rangeFromOffsets(root, snapshot.start, snapshot.end);
	if (offsetRange && offsetRange.toString() === snapshot.text) return offsetRange;
	// (c) 前后文唯一匹配：settle 会把 markdown 语法字符渲染掉（`**x**` → x），绝对偏移整体漂移
	const currentText = readRootText(root);
	const located = locateSelectionContext(currentText, snapshot);
	if (!located) return null;
	const contextRange = rangeFromOffsets(root, located.start, located.end);
	if (contextRange && contextRange.toString() === snapshot.text) return contextRange;
	return null;
}
