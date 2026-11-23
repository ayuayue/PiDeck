/** 有界远端文本草稿策略；不持久化正文，不允许驱逐脏文件。代数挡住迟到的加载/保存结果。 */
export type RemoteFileDraft = {
	projectId: string;
	path: string;
	content: string;
	savedContent: string;
	version: string;
	generation: number;
	phase: "loading" | "ready" | "saving" | "failed";
	errorCode?: string;
	blocked?: boolean;
	rejectedEdits?: number;
	/** 该路径（或其所在目录）已被 rename/delete：脏草稿保留并标记，干净草稿已回收。 */
	stale?: boolean;
};
export { REMOTE_FILE_DRAFT_MAX_CHARS, REMOTE_FILE_DRAFT_TOTAL_MAX_CHARS, editRemoteFileDraft, remoteFileDraftHeldChars } from "./remoteFileDraftBudget";
export const REMOTE_FILE_DRAFT_LIMIT = 5;
export const remoteFileDraftKey = (projectId: string, path: string) => JSON.stringify([projectId, path]);
export const remoteFileDraftDirty = (draft: RemoteFileDraft) => draft.content !== draft.savedContent;

/** 显式重载才能替换已有草稿；调用方须先确认丢弃脏内容。 */
export function beginRemoteFileLoad(current: ReadonlyMap<string, RemoteFileDraft>, projectId: string, path: string, reload = false): Map<string, RemoteFileDraft> {
	const key = remoteFileDraftKey(projectId, path);
	const held = current.get(key);
	if (held && !reload) return new Map(current);
	if (held?.phase === "saving") throw new Error("REMOTE_FILE_BUSY");
	const next = new Map(current);
	if (!held && next.size >= REMOTE_FILE_DRAFT_LIMIT) {
		// 未拿到正文的失败打开不含用户编辑，可回收；loading/saving或任何脏草稿仍禁止驱逐。
		const victim = [...next].find(([, draft]) => (draft.phase === "ready" || draft.phase === "failed") && !remoteFileDraftDirty(draft));
		if (!victim) throw new Error("REMOTE_FILE_DRAFT_LIMIT");
		next.delete(victim[0]);
	}
	// 重载失败也不丢旧正文：只有读成功才会替换，失败仍可复制草稿。
	next.set(key, { projectId, path, content: held?.content ?? "", savedContent: held?.savedContent ?? "", version: "", generation: (held?.generation ?? 0) + 1, phase: "loading" });
	return next;
}

/** 对指定文件及代数应用结果；换项目/文件或后续重载的结果互不污染。 */
export function updateRemoteFileDraft(current: ReadonlyMap<string, RemoteFileDraft>, key: string, generation: number, update: (draft: RemoteFileDraft) => RemoteFileDraft): Map<string, RemoteFileDraft> {
	const next = new Map(current);
	const held = current.get(key);
	if (held?.generation === generation) next.set(key, update(held));
	return next;
}

/** 成功保存只推进基准，不把请求发出时的正文盖回编辑器（用户可能仍在输入）。 */
export function completeRemoteFileSave(draft: RemoteFileDraft, sentContent: string, version: string): RemoteFileDraft {
	return { ...draft, savedContent: sentContent, version, phase: "ready", blocked: false, errorCode: undefined };
}
/**
 * rename/delete 成功后的草稿回收（§5.7）：只回收**干净**草稿；脏草稿一律保留并标记 stale。
 * 目录子树内已打开的草稿也算受影响（path 前缀匹配），不允许自动丢弃用户输入。
 */
export function applyRemoteFileMutation(drafts: ReadonlyMap<string, RemoteFileDraft>, projectId: string, path: string): Map<string, RemoteFileDraft> {
	const next = new Map(drafts);
	for (const [key, draft] of next) {
		if (draft.projectId !== projectId) continue;
		if (draft.path !== path && !draft.path.startsWith(path + "/")) continue;
		if (remoteFileDraftDirty(draft)) next.set(key, { ...draft, stale: true });
		else next.delete(key);
	}
	return next;
}
