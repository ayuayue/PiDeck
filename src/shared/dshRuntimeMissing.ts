/**
 * DSH 运行时缺失的 sentinel 文案（单一数据源）。
 *
 * 场景：@deepseek-ai/* 自阶段 2 起外置为 runtime 资源（app.asar 里本就没有它们），
 * 未安装 runtime 时 host 引导处的 require.resolve 必然失败。原始 MODULE_NOT_FOUND
 * 会沿 ensureClient → IPC 一路抛到渲染层，让会话历史分页整页失败且原因不可读。
 *
 * 放在 shared 层是因为渲染层要按这个前缀把 IPC 错误映射成 i18n 文案，
 * 主进程与渲染层必须认同一个值。
 */
export const DSH_RUNTIME_MISSING_ERROR = "DSH_RUNTIME_MISSING";

/** 判定错误消息是否属于「运行时未安装」（容错：真实消息带解析路径详情）。 */
export function isDshRuntimeMissingMessage(message: string): boolean {
	return typeof message === "string" && message.startsWith(DSH_RUNTIME_MISSING_ERROR);
}
