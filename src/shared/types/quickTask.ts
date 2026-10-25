/**
 * 启动目录校验失败的稳定错误码。
 *
 * 约定：主进程只往渲染层传「码」，不传原始 message——IPC 异常串（`Error invoking remote method …`、
 * `ENOENT: no such file or directory`）直接展示给用户既不可读也无法本地化。渲染层用
 * `quickTask.error.<code>` 映射成中英文文案。
 */
export type QuickTaskErrorCode = "invalidPath" | "notDirectory" | "notFound" | "permissionDenied" | "unknown";

/** Compact mode changes presentation only; execution stays in the normal session runtime. */
export interface QuickTaskState {
	active: boolean;
	requestId: number;
	path?: string;
	/** 稳定错误码（非 message）；渲染层负责本地化。 */
	error?: QuickTaskErrorCode;
}
