/**
 * DSH host「用户手动停止」跨进程契约（单一数据源）。
 *
 * 场景：用户手动停止 DSH host 后，所有自动拉起路径被门控，host 相关 IPC 调用会以
 * `DSH_MANUALLY_STOPPED_ERROR` 这条 sentinel 文案 reject（主进程判定逻辑见
 * `src/main/dsh/dshManualStop.ts`）。
 *
 * 为什么放 shared：这条字符串会经 `ipcRenderer.invoke` 泄漏成渲染层可见的
 * `Error invoking remote method '<channel>': Error: ...`，渲染层要据此把它映射成
 * i18n 文案而不是原样展示内部 sentinel。主/渲染共用本常量，避免两处字面量漂移。
 */

/** 「DSH host 已被用户手动停止」的 sentinel 错误文案（单一数据源）。 */
export const DSH_MANUALLY_STOPPED_ERROR = "DSH host is manually stopped";

/**
 * 判定错误消息是否为「手动停止」拒绝。
 * 用 contains 而非全等：渲染层拿到的是 Electron 包装后的完整消息（前缀
 * `Error invoking remote method 'dsh:...':`），仍要能识别。
 */
export function isDshManuallyStoppedErrorMessage(message: string): boolean {
	return message.includes(DSH_MANUALLY_STOPPED_ERROR);
}
