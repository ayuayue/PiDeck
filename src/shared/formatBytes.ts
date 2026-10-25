/**
 * 字节 → 人类可读字符串（B/KB/MB/GB）。
 * 主进程进程监控与渲染层展示共用，避免两侧重复实现。
 * 非法输入（NaN/负数）统一返回 "-"。
 */
export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return "-";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * 字节 → 固定 MB 单位（进程监控面板统一以 MB 展示，便于横向对比）。
 * 非法输入（NaN/负数）统一返回 "-"。
 */
export function formatMb(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return "-";
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
