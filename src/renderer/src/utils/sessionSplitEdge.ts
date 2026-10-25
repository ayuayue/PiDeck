/**
 * 会话 Tab 拖到聊天区时的分屏落点解析与布局变换（两层树模型）。
 *
 * 布局模型：根层是 1..3 个面板的行/列分屏（真多栏，左中右/上中下）；
 * 每个面板可以是会话，也可以是切分面板（nested，固定 2 会话，终端式）。
 * 总会话数上限 SESSION_SPLIT_MAX_SESSIONS（2×2 四宫格 / 三栏再切分均封顶于此，4 屏）。
 *
 * 形态覆盖：
 * - 双栏：        [A, B]
 * - 真三栏：      [A, B, C]（根层同层，非嵌套模拟）
 * - 左上下+右单： [nested(V,A,B), C]（切分 A，终端式）
 * - 2×2 四宫格：  [nested(V,A,B), nested(V,C,D)]
 *
 * 拖拽语义（与 SessionSplitStage 共用的纯策略）：
 * - 拖到面板边缘，方向与根层同向 → 根层插入一栏（真三栏，根层 ≤ 3 栏）
 * - 拖到面板边缘，方向与根层垂直 → 切分该面板（仅根层面板可切，两层封顶）
 * - 拖到面板中心 → 替换该面板
 * - 单栏时拖到边缘   → 根层双栏
 */

export type SessionSplitEdge = "left" | "right" | "top" | "bottom";

export type SessionSplitOrientation = "horizontal" | "vertical";

/** 嵌套分屏面板：固定 2 个会话（第二层，不可再嵌套） */
export type SessionSplitNestedPane = {
	kind: "nested";
	orientation: SessionSplitOrientation;
	/** 嵌套分屏左/上会话 */
	first: string;
	/** 嵌套分屏右/下会话 */
	second: string;
};

export type SessionSplitPane = { kind: "session"; sessionId: string } | SessionSplitNestedPane;

/** 分屏布局：根层行/列分屏，面板为会话或嵌套分屏 */
export type SessionSplitLayout = {
	orientation: SessionSplitOrientation;
	panels: SessionSplitPane[];
};

/** 拖拽落点：会话面板内边缘（嵌套分屏）或中心（替换） */
export type SessionSplitDropTarget = { kind: "session-edge"; sessionId: string; edge: SessionSplitEdge } | { kind: "session-center"; sessionId: string };

/** 与 SessionTabsBar 共用的拖拽 MIME，便于跨组件识别会话 Tab 拖拽。 */
export const SESSION_TAB_DRAG_MIME = "text/pideck-session-tab";

/** 边缘热区占面板宽/高的比例（外 28%）。 */
export const SESSION_SPLIT_EDGE_THRESHOLD = 0.28;

/** 分屏总会话数上限：2×2 四宫格（4 屏）封顶，三栏再切分同此。 */
export const SESSION_SPLIT_MAX_SESSIONS = 4;

/** 根层面板数上限：真多栏（左中右/上中下）最多 3 栏。 */
export const SESSION_SPLIT_ROOT_MAX_PANELS = 3;

/**
 * 根据指针相对容器矩形的位置，解析分屏落点边。
 * @returns 命中边，或中心区域时返回 null
 */
export function resolveSessionSplitEdge(clientX: number, clientY: number, rect: Pick<DOMRect, "left" | "top" | "width" | "height">, thresholdRatio = SESSION_SPLIT_EDGE_THRESHOLD): SessionSplitEdge | null {
	if (rect.width <= 0 || rect.height <= 0) return null;
	const x = (clientX - rect.left) / rect.width;
	const y = (clientY - rect.top) / rect.height;
	if (x < 0 || x > 1 || y < 0 || y > 1) return null;

	const distLeft = x;
	const distRight = 1 - x;
	const distTop = y;
	const distBottom = 1 - y;
	const nearest = Math.min(distLeft, distRight, distTop, distBottom);
	if (nearest > thresholdRatio) return null;

	if (nearest === distLeft) return "left";
	if (nearest === distRight) return "right";
	if (nearest === distTop) return "top";
	return "bottom";
}

/** 落点边 → 布局方向 */
export function edgeToOrientation(edge: SessionSplitEdge): SessionSplitOrientation {
	return edge === "left" || edge === "right" ? "horizontal" : "vertical";
}

/** 布局内全部会话 id（根层面板 + 嵌套面板，按视觉顺序）。 */
export function splitLayoutSessionIds(layout: SessionSplitLayout): string[] {
	const ids: string[] = [];
	for (const panel of layout.panels) {
		if (panel.kind === "session") ids.push(panel.sessionId);
		else ids.push(panel.first, panel.second);
	}
	return ids;
}

/** 布局内会话总数。 */
export function countSplitSessions(layout: SessionSplitLayout): number {
	return splitLayoutSessionIds(layout).length;
}

/**
 * session 是否位于根层面板（可切分 / 可作为根层插入目标）。
 * 切分面板内的子会话已处于第二层，两层封顶下不可再切。
 */
export function isRootSplitPane(layout: SessionSplitLayout, sessionId: string): boolean {
	return layout.panels.some((p) => p.kind === "session" && p.sessionId === sessionId);
}

/**
 * 把布局中的指定会话替换为另一会话（任意层级：根层面板或嵌套内）。
 * 未找到 from 时返回原布局（不变式：调用方先校验目标存在）。
 */
export function replaceSessionInLayout(layout: SessionSplitLayout, from: string, to: string): SessionSplitLayout {
	return {
		...layout,
		panels: layout.panels.map((panel) => {
			if (panel.kind === "session") {
				return panel.sessionId === from ? { kind: "session", sessionId: to } : panel;
			}
			return {
				...panel,
				first: panel.first === from ? to : panel.first,
				second: panel.second === from ? to : panel.second,
			};
		}),
	};
}

/**
 * 单栏（无分屏）时拖入会话：按落点边生成根层双栏布局。
 * 拖入会话放在落点侧；宿主会话（host，即被拖拽命中的唯一面板）占据另一侧。
 */
export function buildSplitLayoutFromDrop(input: { hostSessionId: string; draggedSessionId: string; edge: SessionSplitEdge }): SessionSplitLayout | null {
	const { hostSessionId, draggedSessionId, edge } = input;
	if (!hostSessionId || !draggedSessionId || hostSessionId === draggedSessionId) {
		return null;
	}
	const orientation = edgeToOrientation(edge);
	const first = edge === "left" || edge === "top" ? draggedSessionId : hostSessionId;
	const second = edge === "left" || edge === "top" ? hostSessionId : draggedSessionId;
	return {
		orientation,
		panels: [
			{ kind: "session", sessionId: first },
			{ kind: "session", sessionId: second },
		],
	};
}

/**
 * 单栏分屏时的宿主会话：另一栏要保留谁。
 * - 拖的不是当前焦点 → 宿主 = 被拖拽命中的唯一面板（当前焦点）
 * - 拖的就是当前焦点 → 宿主 = Tab 栏里另一个会话（否则「当前 Tab 无法分屏」）
 * - 只有自己一个 Tab 且拖的是自己 → 无法分屏，返回 null
 */
export function resolveSplitHostSessionId(input: { draggedSessionId: string; hitSessionId: string; tabIds: readonly string[] }): string | null {
	const { draggedSessionId, hitSessionId, tabIds } = input;
	if (!draggedSessionId || !hitSessionId) return null;
	if (hitSessionId !== draggedSessionId) return hitSessionId;
	const other = tabIds.find((id) => id && id !== draggedSessionId);
	return other ?? null;
}

/**
 * 会话所属根层面板的下标：根层会话 → 自身下标；切分面板内会话 → 所在面板下标；
 * 不在布局 → -1。用于「嵌套面板外缘也能根层插入」的定位（命中内层会话的边缘
 * 等价于命中外层根面板的边缘）。
 */
export function findRootPaneIndexForSession(layout: SessionSplitLayout, sessionId: string): number {
	for (let i = 0; i < layout.panels.length; i++) {
		const panel = layout.panels[i];
		if (panel.kind === "session" && panel.sessionId === sessionId) return i;
		if (panel.kind === "nested" && (panel.first === sessionId || panel.second === sessionId)) {
			return i;
		}
	}
	return -1;
}

/**
 * 落点是否可接受（预览门控 = drop 接受条件，供 Stage 预览与 chrome 最终校验共用）：
 * - 单栏（layout=null）：中心落点无效；边缘落点有效，但拖自己时需 Tab 栏还有其它宿主
 * - 已分屏：中心=替换任意层会话（拖入会话不在布局且目标在布局）；
 *   边缘=拖入会话不在布局，同向插入需根层 <3 栏，垂直切分需目标是根层面板且总屏 <4
 */
export function canAcceptSplitDrop(input: {
	layout: SessionSplitLayout | null;
	draggedSessionId: string;
	sessionId: string;
	/** null 表示中心落点 */
	edge: SessionSplitEdge | null;
	/** Tab 栏会话总数（单栏拖自己时判断是否有其它宿主可用） */
	tabCount: number;
}): boolean {
	const { layout, draggedSessionId, sessionId, edge, tabCount } = input;
	if (!draggedSessionId || !sessionId) return false;
	if (!layout) {
		if (!edge) return false;
		// 单栏拖当前会话自己：需要 Tab 栏里还有其它会话当宿主
		return draggedSessionId !== sessionId || tabCount > 1;
	}
	const ids = splitLayoutSessionIds(layout);
	if (ids.includes(draggedSessionId)) return false;
	if (!edge) {
		// 中心替换：目标必须在布局内
		return ids.includes(sessionId);
	}
	if (edgeToOrientation(edge) === layout.orientation) {
		// 同向边缘 = 根层插入（真多栏）：根层 <3 栏且总屏 <4
		// （2×2 满员时拒绝，避免「预览承诺、落空收场」）
		return layout.panels.length < SESSION_SPLIT_ROOT_MAX_PANELS && countSplitSessions(layout) < SESSION_SPLIT_MAX_SESSIONS;
	}
	// 垂直边缘 = 终端式切分：目标必须是根层面板，且总屏未满
	return layout.panels.some((p) => p.kind === "session" && p.sessionId === sessionId) && countSplitSessions(layout) < SESSION_SPLIT_MAX_SESSIONS;
}

/**
 * 已分屏时拖入新会话，落点方向与根层同向：根层插入一栏（真多栏）。
 * 双栏 → 三栏；根层已 3 栏封顶时返回 null。
 * 插入位置：命中会话所属根层面板的落点侧（left/top → 面板前；right/bottom → 面板后），
 * 切分面板内会话命中时定位到其外层面板（嵌套面板外缘可插入）。
 */
export function insertRootPaneFromDrop(input: { layout: SessionSplitLayout; draggedSessionId: string; sessionId: string; edge: SessionSplitEdge }): SessionSplitLayout | null {
	const { layout, draggedSessionId, sessionId, edge } = input;
	if (!draggedSessionId || draggedSessionId === sessionId) return null;
	if (edgeToOrientation(edge) !== layout.orientation) return null;
	if (layout.panels.length >= SESSION_SPLIT_ROOT_MAX_PANELS) return null;
	if (countSplitSessions(layout) >= SESSION_SPLIT_MAX_SESSIONS) return null;
	if (splitLayoutSessionIds(layout).includes(draggedSessionId)) return null;
	const index = findRootPaneIndexForSession(layout, sessionId);
	if (index < 0) return null;
	const insertAt = edge === "left" || edge === "top" ? index : index + 1;
	const panels = [...layout.panels];
	panels.splice(insertAt, 0, { kind: "session", sessionId: draggedSessionId });
	return { ...layout, panels };
}

/**
 * 拖入新会话，落点方向与根层垂直：终端式切分命中面板（切出的会话占落点侧）。
 * 仅根层面板可切分（两层封顶）；总会话数达到上限后拒绝。
 */
export function nestSplitPaneFromDrop(input: { layout: SessionSplitLayout; draggedSessionId: string; sessionId: string; edge: SessionSplitEdge }): SessionSplitLayout | null {
	const { layout, draggedSessionId, sessionId, edge } = input;
	if (!draggedSessionId || draggedSessionId === sessionId) return null;
	// 同向边缘属根层插入（真多栏），切分只处理垂直方向
	if (edgeToOrientation(edge) === layout.orientation) return null;
	if (splitLayoutSessionIds(layout).includes(draggedSessionId)) return null;
	if (countSplitSessions(layout) >= SESSION_SPLIT_MAX_SESSIONS) return null;
	const index = layout.panels.findIndex((p) => p.kind === "session" && p.sessionId === sessionId);
	if (index < 0) return null;

	const orientation = edgeToOrientation(edge);
	const nested: SessionSplitNestedPane = edge === "left" || edge === "top" ? { kind: "nested", orientation, first: draggedSessionId, second: sessionId } : { kind: "nested", orientation, first: sessionId, second: draggedSessionId };
	const panels = [...layout.panels];
	panels[index] = nested;
	return { ...layout, panels };
}

/**
 * 拖到会话面板中心：把该会话替换为拖入会话（任意层级，含嵌套层内）。
 */
export function replaceSplitPaneFromDrop(input: { layout: SessionSplitLayout; draggedSessionId: string; sessionId: string }): SessionSplitLayout | null {
	const { layout, draggedSessionId, sessionId } = input;
	if (!draggedSessionId || draggedSessionId === sessionId) return null;
	if (splitLayoutSessionIds(layout).includes(draggedSessionId)) return null;
	if (!splitLayoutSessionIds(layout).includes(sessionId)) return null;
	return replaceSessionInLayout(layout, sessionId, draggedSessionId);
}

/**
 * 关闭某一栏会话后的布局收口：
 * - 切分面板内关掉一个 → 该面板退化为会话面板（幸存者）
 * - 根层面板被关 → 移除；只剩一个会话 → 退回单栏（soloSessionId）
 * - 只剩一个切分面板 → 展平为根层双栏（幸存双会话保留分屏）
 * - 全部关闭 → null
 */
export function resolveSplitAfterClose(layout: SessionSplitLayout, closedSessionId: string): { soloSessionId: string } | { layout: SessionSplitLayout } | null {
	// 1. 嵌套面板内关闭一个会话 → 退化为会话面板（幸存者）
	const panels: SessionSplitPane[] = layout.panels.map((panel) => {
		if (panel.kind === "session") return panel;
		if (panel.first === closedSessionId) {
			return { kind: "session", sessionId: panel.second };
		}
		if (panel.second === closedSessionId) {
			return { kind: "session", sessionId: panel.first };
		}
		return panel;
	});
	// 2. 移除根层被关闭的会话面板
	const remaining = panels.filter((p) => !(p.kind === "session" && p.sessionId === closedSessionId));
	if (remaining.length === 0) return null;
	if (remaining.length === 1) {
		const only = remaining[0];
		if (only.kind === "session") return { soloSessionId: only.sessionId };
		// 只剩一个嵌套面板：展平为根层双栏，保留幸存双会话的分屏形态
		return {
			layout: {
				orientation: only.orientation,
				panels: [
					{ kind: "session", sessionId: only.first },
					{ kind: "session", sessionId: only.second },
				],
			},
		};
	}
	return { layout: { ...layout, panels: remaining } };
}
