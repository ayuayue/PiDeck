import type { SessionBranchNode, SessionBranchTree } from "../../../../../shared/types";

/**
 * 分支树面板的**纯视图策略**（无 React、无 DOM）：把 pi 的原始条目树折算成一行行
 * 可直接渲染的 BranchRow。独立成模块的原因是可单测——「缩进怎么长、哪些行折叠」
 * 是这个面板最容易出错也最容易回归的产品规则，不能只活在 JSX 的递归里。
 *
 * 三条规则（对应长会话的实际观感问题）：
 * 1) **缩进只表达嵌套，不表达先后**：线性链上的孩子与父同缩进，只有分支点
 *    （children.length > 1）的孩子才加一级。原始树深度随对话长度线性增长（动辄上百），
 *    按深度缩进会把文字推出屏幕。
 * 2) **默认折叠助手/工具步骤**：一段连续的非锚点节点折成一行（steps = 被折叠的步数），
 *    只保留用户消息、分支点、压缩点、分支摘要——它们是「读分支结构」与「fork 落点」的锚点。
 * 3) **非活动分支的子树默认收起**：废弃分支只露一行备选，点开才展开后代。
 */

/** 缩进封顶：更深的嵌套不再右移（渲染层用 ⋮ 提示还有更深层级），避免横向被推爆。 */
export const MAX_INDENT_DEPTH = 6;

/** 锚点节点：折叠步骤时必须保留可见的行。 */
export function isAnchor(node: SessionBranchNode): boolean {
	return node.role === "user" || node.children.length > 1 || node.entryType === "compaction" || node.entryType === "branch_summary";
}

/**
 * 折叠纯中转节点：无预览、单孩子、且不是消息/摘要类的节点直接消失，用孩子顶替它的位置。
 * pi 会话文件里这类结构化占位（如仅有元数据的包装条目）数量可观，渲染成行只是噪音。
 */
export function compactPassThrough(node: SessionBranchNode): SessionBranchNode {
	const children = node.children.map(compactPassThrough);
	const isContentish = node.entryType === "message" || node.entryType === "compaction" || node.entryType === "branch_summary";
	if (!isContentish && node.preview === "" && children.length === 1) return { ...children[0], parentId: node.parentId };
	return { ...node, children };
}

/** 活动分支节点集合：leafId 沿 parentId 上溯。孤儿（父链断裂）止步于根，不抛错。 */
export function collectActiveIds(tree: SessionBranchTree): Set<string> {
	const byId = new Map<string, SessionBranchNode>();
	const walk = (node: SessionBranchNode) => {
		byId.set(node.id, node);
		for (const child of node.children) walk(child);
	};
	for (const root of tree.roots) walk(root);
	const active = new Set<string>();
	let cursor: SessionBranchNode | undefined = tree.leafId ? byId.get(tree.leafId) : undefined;
	while (cursor) {
		active.add(cursor.id);
		cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
	}
	return active;
}

/** 默认折叠集 = 全部非活动路径上有孩子的节点：直接备选行仍可见（一行），后代收起。 */
export function defaultCollapsedIds(tree: SessionBranchTree, activeIds: ReadonlySet<string>): Set<string> {
	const collapsed = new Set<string>();
	const walk = (node: SessionBranchNode) => {
		if (node.children.length > 0 && !activeIds.has(node.id)) collapsed.add(node.id);
		for (const child of node.children) walk(child);
	};
	for (const root of tree.roots) walk(root);
	return collapsed;
}

/** 全部节点 id（「看全部」时把每个节点都标记成已展开的步骤段）。 */
export function collectAllIds(tree: SessionBranchTree): string[] {
	const ids: string[] = [];
	const walk = (node: SessionBranchNode) => {
		ids.push(node.id);
		for (const child of node.children) walk(child);
	};
	for (const root of tree.roots) walk(root);
	return ids;
}

/**
 * 折叠从 node 开始的非锚点连续段，返回该段末节点与步数（末节点的内容最有信息量）。
 * 锚点自身不作为段首：压缩点/用户消息的标记与文案必须留在屏幕上，不能被助手步骤的预览顶掉。
 */
export function foldRun(node: SessionBranchNode, expandedRuns: ReadonlySet<string>): { tail: SessionBranchNode; steps: number } {
	if (expandedRuns.has(node.id) || isAnchor(node)) return { tail: node, steps: 0 };
	let tail = node;
	let steps = 0;
	while (tail.children.length === 1 && !isAnchor(tail.children[0])) {
		tail = tail.children[0];
		steps += 1;
	}
	return { tail, steps };
}

/** 一段折叠段里藏着的所有节点 id（点 ⌄ 时一次展开整段，不用逐行点）。 */
export function collectRunIds(node: SessionBranchNode, expandedRuns: ReadonlySet<string>): string[] {
	const { tail, steps } = foldRun(node, expandedRuns);
	if (steps === 0) return [node.id];
	const ids = [node.id];
	let cursor = node;
	while (cursor.id !== tail.id) {
		cursor = cursor.children[0];
		ids.push(cursor.id);
	}
	return ids;
}

/** 缩进封顶后的层数：渲染层直接乘像素宽度。 */
export function indentUnits(depth: number): number {
	return Math.min(depth, MAX_INDENT_DEPTH);
}

export interface BranchRow {
	/** 行首节点（折叠段的首节点）：折叠标记与 fork 落点都挂在它上面。 */
	node: SessionBranchNode;
	/** 折叠段的末节点：行文案、角色图标、后续孩子都取自它。 */
	tail: SessionBranchNode;
	/** 被折叠进这一行的步数（0 = 未折叠）。 */
	steps: number;
	/** 显示深度（已按「只有分支点加一级」折算）。 */
	depth: number;
	/** 是否位于活动分支（末节点或首节点在 leaf→root 路径上）。 */
	active: boolean;
	/** 是否是当前叶（活动分支末端）。 */
	isLeaf: boolean;
	/** 子树是否收起（点击 ⌄ 切的就是它）。 */
	collapsed: boolean;
	/** 视觉父行（← 键回退的目标；根行没有）。父行可能不是直接上层 entry，而是拥有它的那一行。 */
	parentRowId?: string;
}

/** 是否还有可展开的东西（决定行首渲染 ⌄ 还是端点圆点）。 */
export function rowHasDisclosure(row: BranchRow): boolean {
	return row.steps > 0 || row.tail.children.length > 0;
}

/** 当前行的第一个子行 id（→ 键前进的目标）；没有子行返回 undefined。 */
export function childRowId(rows: BranchRow[], id: string): string | undefined {
	const index = rows.findIndex((row) => row.node.id === id);
	if (index < 0) return undefined;
	const next = rows[index + 1];
	return next && next.parentRowId === id ? next.node.id : undefined;
}

/**
 * 纯键盘焦点移动（↑/↓/Home/End）：返回应聚焦的行 id。
 * 上下移动按**可见行序列**走，与缩进无关（树形控件里按视觉顺序移动是预期行为）。
 */
export function moveRowFocus(rows: BranchRow[], currentId: string, key: "ArrowDown" | "ArrowUp" | "Home" | "End"): string {
	if (rows.length === 0) return currentId;
	const index = rows.findIndex((row) => row.node.id === currentId);
	if (index < 0) return rows[0].node.id;
	if (key === "Home") return rows[0].node.id;
	if (key === "End") return rows[rows.length - 1].node.id;
	const target = key === "ArrowDown" ? Math.min(index + 1, rows.length - 1) : Math.max(index - 1, 0);
	return rows[target].node.id;
}

/**
 * 把树折成可见行序列（前序遍历）。深度只在分支点增长，线性链保持同缩进——
 * 这条规则让 200 条消息的长会话从「200 层缩进」变成个位数层级。
 */
export function buildBranchRows(tree: SessionBranchTree, view: { collapsedIds: ReadonlySet<string>; expandedRuns: ReadonlySet<string> }): BranchRow[] {
	const activeIds = collectActiveIds(tree);
	const rows: BranchRow[] = [];
	const walk = (node: SessionBranchNode, depth: number, parentRowId: string | undefined) => {
		const { tail, steps } = foldRun(node, view.expandedRuns);
		const runFolded = steps > 0;
		const collapsed = !runFolded && view.collapsedIds.has(tail.id) && tail.children.length > 0;
		rows.push({
			node,
			tail,
			steps,
			depth,
			active: activeIds.has(node.id) || activeIds.has(tail.id),
			isLeaf: tail.id === tree.leafId,
			collapsed,
			parentRowId,
		});
		// 折叠段的行一定要继续走 tail 的孩子（最多一个锚点，通常是下一条用户消息），
		// 否则展开步骤后才会出现的锚点会在收起状态凭空消失。
		const descend = runFolded || !collapsed;
		if (!descend) return;
		const nextDepth = depth + (tail.children.length > 1 ? 1 : 0);
		for (const child of tail.children) walk(child, nextDepth, node.id);
	};
	for (const root of tree.roots) walk(root, 0, undefined);
	return rows;
}

/** 原始树 → 面板使用的紧凑树 + 活动集 + 节点数（一次遍历，避免渲染期重复算）。 */
export function prepareTree(raw: SessionBranchTree): { tree: SessionBranchTree; activeIds: Set<string>; nodeCount: number } {
	const roots = raw.roots.map(compactPassThrough);
	let nodeCount = 0;
	const countNodes = (node: SessionBranchNode) => {
		nodeCount += 1;
		for (const child of node.children) countNodes(child);
	};
	for (const root of roots) countNodes(root);
	const tree: SessionBranchTree = { roots, leafId: raw.leafId };
	return { tree, activeIds: collectActiveIds(tree), nodeCount };
}
