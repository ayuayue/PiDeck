/**
 * 将模型常用的 LaTeX 括号分隔符转换为 remark-math 支持的美元分隔符。
 * 只改渲染副本；代码、已有美元公式和未闭合的流式片段必须原样保留。
 */
export function normalizeMathDelimiters(text: string): string {
	if (!text.includes("\\(") && !text.includes("\\[")) return text;
	// 保护区优先匹配；围栏允许缺少结束行，避免流式代码被当成公式。
	// CommonMark 允许关闭围栏长于开启围栏；分别匹配两种字符，不能混用。
	const fence = /^(?: {0,3})(`{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1`*[ \t]*(?=\r?$)|(?![\s\S]))|^(?: {0,3})(~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\2~*[ \t]*(?=\r?$)|(?![\s\S]))/;
	const protectedOrMath = /^(?: {4}|\t)[^\n]*|(`+)[\s\S]*?\3(?!`)|(?<!\\)(\${1,2})(?!\$)[\s\S]*?\4(?!\$)|\\\\|\\\(([^\n]*?)\\\)|\\\[([\s\S]*?)\\\]/;
	// 捕获组编号跨两个表达式连续：1/2 围栏，3 代码，4 美元，5/6 新公式。
	const tokens = new RegExp(`${fence.source}|${protectedOrMath.source}`, "gm");
	return text.replace(tokens, (match: string, _indent: string | undefined, _fence: string | undefined, _code: string | undefined, _dollar: string | undefined, inline: string | undefined, display: string | undefined) => {
		if (inline !== undefined) return `$${inline}$`;
		// 两端换行确保结束 $$ 独占一行，不能让后续正文落进公式块。
		if (display !== undefined) return `\n$$\n${display.trim()}\n$$\n`;
		return match;
	});
}
