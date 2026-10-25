import type { SessionRecord } from "../../../../shared/types";

/**
 * 会话分支族派生（纯函数，node 单测直接加载，保持零运行时依赖）。
 *
 * pi 的分支模型：/fork、/clone 生成的新会话在文件头记录 parentSession 路径，
 * SessionCatalog 解析为 parentSessionId。因此 PiDeck 的分支单位是「会话」——
 * parent = 来源会话，siblings = 同源分支（含自身，按创建时间排序），
 * children = 以当前会话为来源的下游分支。
 */
export type BranchFamily = {
	parent?: SessionRecord;
	/** 同源分支（含自身），按 createdAt 升序，分页器 ◀ i/N ▶ 的顺序依据 */
	siblings: SessionRecord[];
	currentIndex: number;
	children: SessionRecord[];
};

function byCreatedAt(a: SessionRecord, b: SessionRecord): number {
	return a.createdAt - b.createdAt || a.id.localeCompare(b.id);
}

/**
 * 从会话记录派生当前会话的分支族。
 * 记录缺失、或当前会话既无来源也无兄弟/子分支时返回 undefined（导航条不渲染）。
 */
export function deriveBranchFamily(records: Record<string, SessionRecord>, sessionId: string): BranchFamily | undefined {
	const record = records[sessionId];
	if (!record) return undefined;
	// 只有同项目、已落盘的会话参与分支关系；noSession 是运行时匿名会话，无文件可导航
	const all = Object.values(records).filter((candidate) => candidate.projectId === record.projectId && !candidate.noSession);

	// parentSessionId 由目录按路径解析；父会话不在目录内（其它项目/已删除）时
	// 退回 parentSessionPath 直接匹配，仍能找到来源链接
	const parent = record.parentSessionId ? records[record.parentSessionId] : record.parentSessionPath ? all.find((candidate) => candidate.filePath === record.parentSessionPath) : undefined;

	// 兄弟分支：同 parentSessionId 或同 parentSessionPath（解析失败时的兜底），
	// 用 Map 按 id 去重并保证自身一定在内
	const siblingMap = new Map<string, SessionRecord>();
	if (record.parentSessionId || record.parentSessionPath) {
		for (const candidate of all) {
			const sameParent = Boolean((record.parentSessionId && candidate.parentSessionId === record.parentSessionId) || (record.parentSessionPath && candidate.parentSessionPath === record.parentSessionPath));
			if (sameParent) siblingMap.set(candidate.id, candidate);
		}
	}
	siblingMap.set(record.id, record);
	const siblings = [...siblingMap.values()].sort(byCreatedAt);
	const currentIndex = siblings.findIndex((candidate) => candidate.id === record.id);

	const children = all.filter((candidate) => candidate.parentSessionId === record.id).sort(byCreatedAt);

	// 无任何分支关系（无来源、无兄弟、无子分支）时不显示导航条
	if (!parent && siblings.length <= 1 && children.length === 0) return undefined;
	return { parent, siblings, currentIndex, children };
}
