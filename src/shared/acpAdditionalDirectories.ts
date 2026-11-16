/**
 * ACP 会话附加根目录（#560）的归一化。
 *
 * 为什么放在 shared：主进程要把渲染层的入参当不可信数据收窄（绝对路径、去重、限量），
 * 渲染层在提交前也要用同一套规则预检，两份判定不能漂移。
 *
 * 语义（与 ACP `sessionCapabilities.additionalDirectories` 一致）：
 * - 列表是**完整目标集合**：空数组/null = 没有额外根目录（不沿用上次）；
 * - 顺序保留：agent 可能按顺序做优先级/搜索路径；
 * - 与 cwd 相同的项没有意义（agent 本来就能访问会话根目录），去掉。
 */

/** 上限：协议没规定，但一个会话挂几十个根目录只会让 agent 的搜索/审批变慢。 */
export const ACP_ADDITIONAL_DIRECTORIES_MAX = 20;

/** 绝对路径判定：POSIX `/x`、Windows 盘符 `C:\`/`C:/`、UNC `\\server\share`。 */
function isAbsolutePath(value: string): boolean {
	return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

/** 路径比较口径：Windows 大小写不敏感、分隔符可混用；其他平台按原样。 */
function comparablePath(value: string): string {
	return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * 归一化附加根目录。返回 `null` 表示「没有额外根目录」（清空/全部非法）。
 * 非法项（相对路径、空白）直接丢弃而不是整个拒绝：用户粘一大段时，能用的先留下。
 */
export function normalizeAcpAdditionalDirectories(value: unknown, cwd?: string): string[] | null {
	if (!Array.isArray(value)) return null;
	const seen = new Set<string>();
	if (cwd) seen.add(comparablePath(cwd));
	const result: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") continue;
		const trimmed = item.trim();
		if (!trimmed || !isAbsolutePath(trimmed)) continue;
		const key = comparablePath(trimmed);
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(trimmed);
		if (result.length >= ACP_ADDITIONAL_DIRECTORIES_MAX) break;
	}
	return result.length > 0 ? result : null;
}
