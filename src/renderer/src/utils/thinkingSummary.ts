/**
 * 折叠态思考单行摘要的取行策略（纯函数）。
 *
 * - 流式中（running）：取最新一行（lastIndexOf('\n') 之后），配合容器 scrollLeft
 *   跟随尾部，语义类似终端 tail -f——看到的始终是最新的思考内容
 * - 结束后：取第一行（indexOf('\n') 之前），摘要从头部读起，配合 ellipsis
 */
export function firstLine(text: string): string {
	// 思考 delta 裸拼接可能以换行/空白开头（deepseek 模型思考常以 "\n" 起笔，
	// 主进程仅 stripAnsi 不裁剪）：先裁首部空白，保证结束态摘要显示第一个非空行，
	// 而不是空行（思考文本先规范化再取行）。
	const visible = text.trimStart();
	const newline = visible.indexOf("\n");
	return newline === -1 ? visible : visible.slice(0, newline);
}

export function latestLine(text: string): string {
	const visible = text.trimEnd();
	const newline = visible.lastIndexOf("\n");
	return newline === -1 ? visible : visible.slice(newline + 1);
}
