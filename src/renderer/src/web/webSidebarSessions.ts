/**
 * webSidebarSessions — Web 侧栏「父会话 + 子代理会话」归组（纯函数，vm 沙箱可单测）。
 *
 * 桌面端按 SessionSummary.parentSessionPath 把子代理会话折叠到父行下
 * （agentListDisplay.getProjectAgentSessionDisplay）；Web 端不下发文件路径，
 * 改由 /api/state 投影后的 parentSessionId 归组。
 *
 * 语义与桌面一致的两条兜底：
 * - 父会话不在本列表（跨项目 / 已删除 / 被搜索过滤）→ 子会话降级回顶层，入口不能消失；
 * - 子代理再派子代理 → 统一挂到最近的顶层祖先下。侧栏只渲染两层，挂到不会展开的
 *   中间行会让整条链从列表里消失。
 */
import type { WebSession } from "./webTypes";

export type WebSessionTree = {
	/** 顶层行（父会话 + 无父/父缺失的会话），保持入参顺序 */
	roots: WebSession[];
	/** 父会话 id → 直接子会话，保持入参顺序 */
	childrenByParentId: Map<string, WebSession[]>;
	/** 非顶层会话 id → 所属顶层祖先 id（切到子会话时用来展开对应分组） */
	rootByChildId: Map<string, string>;
};

/**
 * 按 parentSessionId 归组。入参顺序即渲染顺序（调用方已按 updatedAt 降序排好），
 * 这里只做分流、不重排，避免侧栏排序语义出现第二套。
 */
export function groupWebSessionsByParent(sessions: readonly WebSession[]): WebSessionTree {
	const byId = new Map(sessions.map((session) => [session.id, session]));
	const roots: WebSession[] = [];
	const childrenByParentId = new Map<string, WebSession[]>();
	const rootByChildId = new Map<string, string>();

	/** 最近的顶层祖先；父缺失或成环（脏数据）时返回 undefined，按顶层处理。 */
	const topAncestorOf = (session: WebSession): string | undefined => {
		let current = session;
		const visited = new Set<string>([session.id]);
		while (current.parentSessionId) {
			const parent = byId.get(current.parentSessionId);
			if (!parent || visited.has(parent.id)) return undefined;
			visited.add(parent.id);
			current = parent;
		}
		return current.id === session.id ? undefined : current.id;
	};

	for (const session of sessions) {
		const rootId = topAncestorOf(session);
		if (!rootId) {
			roots.push(session);
			continue;
		}
		rootByChildId.set(session.id, rootId);
		const bucket = childrenByParentId.get(rootId);
		if (bucket) bucket.push(session);
		else childrenByParentId.set(rootId, [session]);
	}

	return { roots, childrenByParentId, rootByChildId };
}
