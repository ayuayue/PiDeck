/**
 * 会话文件编辑的错误契约（`SessionFileEditorErrorCode` / `SessionFileEditorError`）。
 *
 * 单独成文件的理由：整读路径（宿主 SessionFileEditor）、纯解析模块与 target 定位模块
 * 都要抛同一套稳定错误码与同一个错误类。若把它留在宿主里，下游模块就得反向 import 宿主，
 * 形成循环依赖；这里抽出叶子模块，宿主原样 re-export，公开 import 路径与错误码联合类型不变。
 */

export type SessionFileEditorErrorCode =
	| "SESSION_FILE_EMPTY"
	| "SESSION_FILE_INVALID_JSONL"
	/** 文件超出可安全整读的上限（正常已分流到流式路径，见 assertInMemoryReadSafe） */
	| "SESSION_FILE_TOO_LARGE"
	| "SESSION_ENTRY_NOT_FOUND"
	| "SESSION_ENTRY_AMBIGUOUS"
	| "SESSION_ENTRY_ROLE_INVALID"
	| "SESSION_FILE_CHANGED"
	| "SESSION_BACKUP_FAILED"
	| "SESSION_ATOMIC_WRITE_FAILED"
	| "SESSION_RELOAD_FAILED"
	| "SESSION_ROLLBACK_FAILED"
	| "SESSION_ROLLBACK_RELOAD_FAILED"
	| "SESSION_ROLLBACK_CONFLICT"
	| "SESSION_MARKER_CONFLICT";

export class SessionFileEditorError extends Error {
	readonly code: SessionFileEditorErrorCode;
	readonly details?: Record<string, string | number>;
	readonly backupPath?: string;

	constructor(
		code: SessionFileEditorErrorCode,
		message: string,
		options: {
			cause?: unknown;
			details?: Record<string, string | number>;
			backupPath?: string;
		} = {},
	) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "SessionFileEditorError";
		this.code = code;
		this.details = options.details;
		this.backupPath = options.backupPath;
	}
}

/**
 * reload 尝试失败的内部载体（不对外）：同时带上本次事务「写过的文件状态」，
 * 供回滚判断当前文件是否仍是我们写的（整读路径比 Buffer，流式路径比 sha256）。
 */
export class ReloadAttemptFailure extends Error {
	constructor(
		readonly error: unknown,
		readonly ownedStates: Buffer[],
		/** 流式路径的「已写入内容」哈希（与 ownedStates 同义，因为大文件不能驻留 Buffer）。 */
		readonly ownedHashes: string[] = [],
	) {
		super("Session reload attempt failed", { cause: error });
	}
}
