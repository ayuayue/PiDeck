/**
 * 「会话文件过大」错误的展示参数（纯函数，便于单测）。
 *
 * 背景：SessionFileEditor 的编辑类操作需要定位条目 + 重算 parentId 链。旧实现整读成
 * 单一字符串 + 全量对象图，超过 32MB 时用 `assertInMemoryReadSafe` 拒绝并抛
 * `SESSION_FILE_TOO_LARGE`；现在超限会话改走流式路径（sessionFileStream.ts），
 * 本错误退为「流式分流不可用」的兜底（stat 不可用等），但仍带 `details: { size, limit }`
 *（见 v8HeapLimits.ts 的第三次事故补记）。
 *
 * 这里把字节换算成 MB 供 i18n 文案的 `{sizeMb}` / `{limitMb}` 占位使用。
 * 单独成模块的原因：文案里两个占位符缺一不可——只填 size 会让 `{limitMb}` 原样
 * 显示给用户；这条规则需要能被测试直接钉住，而不是埋在 2000+ 行的协调器里。
 */

/** 字节 → 向上取整的 MB（0 视为 0，避免「0MB」误导）。 */
export function bytesToMb(bytes: number): number {
	if (!Number.isFinite(bytes) || bytes <= 0) return 0;
	return Math.ceil(bytes / (1024 * 1024));
}

/**
 * 会话文件体积参数的展示取值。
 *
 * 取不到值时给保守默认（而非漏出原始占位符）：编辑器正常路径一定带 details，
 * 缺失只可能来自异常对象被换包/跨 IPC 丢字段——那种情况下宁可显示一个粗略值，
 * 也不能把 `{sizeMb}` 这种模板串直接展示给用户。
 */
export function sessionFileSizeMb(input: { size?: number; limit?: number }): {
	sizeMb: number;
	limitMb: number;
} {
	const sizeMb = bytesToMb(input.size ?? 0);
	// limit 缺省按 SessionFileEditor 的 32MB 护栏口径兜底，保证文案两个数字都成立
	const limitMb = bytesToMb(input.limit ?? 32 * 1024 * 1024);
	return { sizeMb, limitMb };
}
