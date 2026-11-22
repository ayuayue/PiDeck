import type { RemoteFileDraft } from "./remoteFileDrafts";

/**
 * 有界远端文本草稿的**预算**：单份上限 + 全量上限。
 *
 * 单份上限跟主进程的正文上限（UTF-8 字节）同号；全量上限单独存在，因为「最多 5 份」本身
 * 挡不住堆占用——5 份 8 MiB 草稿就是 40 MiB。超预算一律**拒绝这次输入**：既不截断，也不
 * 驱逐别人的脏草稿（那等于静默丢用户内容）。
 */
export const REMOTE_FILE_DRAFT_MAX_CHARS = 8 * 1024 * 1024;
export const REMOTE_FILE_DRAFT_TOTAL_MAX_CHARS = 32 * 1024 * 1024;
const DRAFT_TOO_LARGE = "REMOTE_FILE_DRAFT_TOO_LARGE";
const DRAFT_OVER_BUDGET = "REMOTE_FILE_DRAFT_BUDGET_EXCEEDED";

/** 除 `key` 之外全部草稿的正文长度合计：预算只算正文，不把版本/路径等元数据折进来。 */
export function remoteFileDraftHeldChars(drafts: ReadonlyMap<string, RemoteFileDraft>, key: string): number {
	let total = 0;
	for (const [other, draft] of drafts) if (other !== key) total += draft.content.length;
	return total;
}

/** 超过单份或全量预算时拒绝，保留已接收内容与版本；下一次合法输入清掉预算错误码。 */
export function editRemoteFileDraft(draft: RemoteFileDraft, content: string, heldChars = 0): RemoteFileDraft {
	const code = content.length > REMOTE_FILE_DRAFT_MAX_CHARS ? DRAFT_TOO_LARGE : heldChars + content.length > REMOTE_FILE_DRAFT_TOTAL_MAX_CHARS ? DRAFT_OVER_BUDGET : undefined;
	if (code !== undefined) return { ...draft, errorCode: code, rejectedEdits: (draft.rejectedEdits ?? 0) + 1 };
	return { ...draft, content, errorCode: draft.errorCode === DRAFT_TOO_LARGE || draft.errorCode === DRAFT_OVER_BUDGET ? undefined : draft.errorCode };
}
