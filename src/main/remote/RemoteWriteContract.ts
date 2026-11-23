/**
 * 远端**写面**的跨文件契约：上传的比较交换 + 会话历史就地维护。
 *
 * 为什么单独成模块：`RemoteHelperContract.ts` 是存量巨文件，仓库门禁要求它只准更薄，而写面在
 * 「版本一致才替换」和「会话就地维护」这两项上各自长出了类型与上限。名字仍从契约模块 re-export，
 * 调用方不需要知道它搬到了哪。
 *
 * 边界：这里只有类型、常量与稳定码，没有任何 I/O；真正的白名单在 helper 入口，执行在 artifact 里。
 */

/**
 * `policy: "replace"` 的比较交换身份。与 `RemoteSessionWriteGuard` 的 revision 结构相同，但它声明在这里
 * 而不是 import 那份模块：守卫要 import 本文件，反向引用会成环。
 */
export type RemoteFileRevisionWire = { mode: number; size: number; dev: string; ino: string; uid: string; gid: string; mtimeNs: string; ctimeNs: string; digest: string };

/** `create` 只新建；`replace` 在目标仍是调用方读到的 revision 时原子替换，否则一个字节都不改。 */
export type RemoteFileUploadPolicy = "create" | "replace";

export type RemoteFileUploadPrepareParams = {
	uploadId: string;
	path: string;
	policy: RemoteFileUploadPolicy;
	size: number;
	sha256: string;
	/** `replace` 必填：目标必须仍是这一份 revision，否则拒绝替换。 */
	expected?: RemoteFileRevisionWire;
};

/**
 * 远端会话就地维护（helper 1.38.0）：一次有界、带 revision 比较交换的 pi 会话 JSONL 改写。
 * 文件始终在宿主上，调用方只发操作、id 候选与读到的 revision，从不搬整份历史。
 */
export const REMOTE_HELPER_METHOD_SESSION_MAINTAIN = "session.maintain";
/** 放宽是因为传输不再随文件大小增长；worker 仍流式处理，不整份驻留。 */
export const REMOTE_SESSION_MAINTAIN_MAX_FILE_BYTES = 512 * 1024 * 1024;
/** 单条 JSONL 记录上限（带 base64 图片的消息可能几十 MiB）。 */
export const REMOTE_SESSION_MAINTAIN_MAX_LINE_BYTES = 32 * 1024 * 1024;
export const REMOTE_SESSION_MAINTAIN_MAX_ENTRIES = 200_000;
/** 必须留在单帧 8 MiB 之下（base64 要 ×4/3，再算信封）。 */
export const REMOTE_SESSION_MAINTAIN_MAX_DRAFT_BYTES = 5 * 1024 * 1024;
export const REMOTE_SESSION_MAINTAIN_MAX_CANDIDATE_IDS = 3;
export const REMOTE_SESSION_MAINTAIN_MAX_ALLOWED_ROOTS = 4;
export const REMOTE_SESSION_MAINTAIN_REQUEST_TIMEOUT_MS = 120_000;

export type RemoteSessionMaintainOperation = "edit" | "delete" | "resend";
export type RemoteSessionMaintainLimits = {
	maxFileBytes: number;
	maxLineBytes: number;
	maxEntries: number;
	maxDraftBytes: number;
};
export type RemoteSessionMaintainParams = {
	path: string;
	operation: RemoteSessionMaintainOperation;
	/** 最具体在前；远端取第一个「在活动分支上且未被墓碑」的 id。 */
	candidateIds: readonly string[];
	newText: string;
	/** 文件 realpath 必须落在这些目录之下；远端拒绝空列表。 */
	allowedRoots: readonly string[];
	expected: RemoteFileRevisionWire;
	limits: RemoteSessionMaintainLimits;
};
export type RemoteSessionMaintainDraft = { text: string; images: ReadonlyArray<{ mime: string; dataBase64: string }> };
export type RemoteSessionMaintainResult = { revision: RemoteFileRevisionWire; draft: RemoteSessionMaintainDraft | null };

/**
 * 写面新增的稳定码。展开进 `REMOTE_HELPER_ERROR_CODES`（helper 的允许码表与 main 的闭集必须同源），
 * 所以每个码只在这里写一次。
 */
export const REMOTE_WRITE_ERROR_CODES = [
	/* 发布形态：`replace` 的目标不是调用方读到的那份文件（缺失也算）。什么都没替换，重读后再决定。 */
	"FILE_UPLOAD_SOURCE_CHANGED",
	/* 就地维护：每个码都能区分「什么都没改」与「可能已发布」；只有最后一个表示不确定，必须重读核对。 */
	"SESSION_MAINTAIN_INPUT_INVALID",
	"SESSION_MAINTAIN_PATH_INVALID",
	"SESSION_MAINTAIN_FILE_TOO_LARGE",
	"SESSION_MAINTAIN_FILE_CHANGED",
	"SESSION_MAINTAIN_FILE_INVALID",
	"SESSION_MAINTAIN_MESSAGE_NOT_FOUND",
	"SESSION_MAINTAIN_ROLE_INVALID",
	"SESSION_MAINTAIN_DRAFT_TOO_LARGE",
	"SESSION_MAINTAIN_COMMIT_UNCONFIRMED",
] as const;
