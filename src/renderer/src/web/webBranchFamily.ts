/**
 * webBranchFamily — Web 端分支家族推导（P3）。
 *
 * 与桌面 branchFamily.ts 同语义的数组版：给定 /api/state 的会话列表与当前
 * 会话 id，沿 parentSessionId 向上找根，再向下收集全部后代；返回按
 * createdAt 升序（老→新）的家族链。纯函数，便于单测（tests/webBranchFamily.test.mjs）。
 */
import type { WebSession } from "./webTypes";

/**
 * 推导 sessionId 所属的分支家族（含根与全部 fork 后代）。
 * - 无 parentSessionId 且无后代时返回 [session]（单会话，调用方按长度 ≤1 隐藏 UI）。
 * - 防环：向上/向下遍历都带 visited 集合，脏数据（互相指父）不会死循环。
 * - 排序：createdAt 升序；缺 createdAt 的排最前（视为最早）。
 */
export function deriveWebBranchFamily(sessions: WebSession[], sessionId: string): WebSession[] {
	const byId = new Map(sessions.map((session) => [session.id, session]));
	const active = byId.get(sessionId);
	if (!active) return [];

	// 向上找根（最多遍历全量，脏数据防环）
	const visitedUp = new Set<string>([active.id]);
	let root = active;
	while (root.parentSessionId) {
		const parent = byId.get(root.parentSessionId);
		if (!parent || visitedUp.has(parent.id)) break;
		visitedUp.add(parent.id);
		root = parent;
	}

	// 自根向下收集后代（children = parentSessionId 指向该节点的会话）
	const childrenOf = new Map<string, WebSession[]>();
	for (const session of sessions) {
		if (!session.parentSessionId) continue;
		const bucket = childrenOf.get(session.parentSessionId);
		if (bucket) bucket.push(session);
		else childrenOf.set(session.parentSessionId, [session]);
	}
	const family: WebSession[] = [];
	const queue: WebSession[] = [root];
	const visitedDown = new Set<string>();
	while (queue.length > 0) {
		const node = queue.shift();
		if (!node || visitedDown.has(node.id)) continue;
		visitedDown.add(node.id);
		family.push(node);
		for (const child of childrenOf.get(node.id) ?? []) queue.push(child);
	}

	family.sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0));
	return family;
}
