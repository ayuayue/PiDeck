import type { SessionRecord } from "../../../shared/types";

/**
 * 会话列表刷新的等价判定。
 *
 * 侧栏在项目运行期间每 3 秒轮询一次 sessions.listCatalog，绝大多数轮次内容完全没变。
 * 若无条件写回 sessionRecordsAtom / sessionIdsByProjectAtom，对象身份每次都变，
 * 依赖这两个 atom 的 selector 与整棵侧栏都会重渲染。内容相同时必须跳过写入。
 */

/** model 是 SessionRecord 里唯一的嵌套对象，按字段比较而非引用。 */
function sameModel(a: SessionRecord["model"], b: SessionRecord["model"]) {
	if (a === b) return true;
	if (!a || !b) return false;
	return a.provider === b.provider && a.modelId === b.modelId;
}

/** 浅比较两条 SessionRecord 是否等效。 */
export function sameSessionRecord(a: SessionRecord, b: SessionRecord): boolean {
	if (a === b) return true;
	return (
		a.id === b.id &&
		a.projectId === b.projectId &&
		a.title === b.title &&
		a.noSession === b.noSession &&
		a.source === b.source &&
		a.environment === b.environment &&
		a.filePath === b.filePath &&
		a.wslDistro === b.wslDistro &&
		a.wslUser === b.wslUser &&
		a.importedSourceId === b.importedSourceId &&
		a.parentSessionId === b.parentSessionId &&
		a.parentSessionPath === b.parentSessionPath &&
		a.projectPath === b.projectPath &&
		a.preview === b.preview &&
		a.messageCount === b.messageCount &&
		a.status === b.status &&
		a.thinkingLevel === b.thinkingLevel &&
		a.createdAt === b.createdAt &&
		a.updatedAt === b.updatedAt &&
		a.wsl === b.wsl &&
		a.codexSessionId === b.codexSessionId &&
		a.codexThreadSource === b.codexThreadSource &&
		a.codexParentThreadId === b.codexParentThreadId &&
		a.codexAgentRole === b.codexAgentRole &&
		a.codexAgentNickname === b.codexAgentNickname &&
		sameModel(a.model, b.model)
	);
}

/**
 * 判断某个项目的会话列表是否与归一化 store 中的现状等效。
 * 先比 id 顺序（便宜），再逐条比字段。
 */
export function sameProjectSessionList(previousIds: readonly string[], records: Readonly<Record<string, SessionRecord>>, next: readonly SessionRecord[]): boolean {
	if (previousIds.length !== next.length) return false;
	for (let index = 0; index < next.length; index += 1) {
		const nextSession = next[index];
		if (previousIds[index] !== nextSession.id) return false;
		const previous = records[nextSession.id];
		if (!previous || !sameSessionRecord(previous, nextSession)) return false;
	}
	return true;
}
