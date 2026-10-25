/**
 * 疑似「未解析工具调用原文」检测（issue #315）。
 *
 * 背景：部分模型/推理服务端（Muse-Glimmer/Onyx 的 ATEM 协议、Qwen 的
 * <tool_call>、GLM 的 <function_calls> 等）用文本协议表达工具调用，由服务端
 * 流式 parser 解析回结构化 tool_calls。parser 在长参数/特殊字符上失败时会把
 * 协议 XML 原文漏进 content 文本通道——pi 与 PiDeck 都不该、也不会去执行这种
 * 文本（工具执行不受影响），但整段 XML 直接按 markdown 渲染会刷屏、吞 `<`、
 * 把路径误渲染成链接。这里只做**展示层兜底**：命中则折叠成一条提示卡片。
 *
 * 判定刻意保守：协议开闭标记成对出现，且协议块覆盖 ≥ 一半正文——
 * 正常回答里顺带提到一两个标签（教程、示例）不会被折叠。
 */

/** 已知文本工具调用协议（开标记用前缀匹配以兼容 <tool_calls> 等变体；闭标记完整）。 */
const PROTOCOL_PAIRS: ReadonlyArray<readonly [open: string, close: string]> = [
	["<atem:function_calls", "</atem:function_calls>"],
	["<function_calls", "</function_calls>"],
	["<tool_call", "</tool_call>"],
];

/** 协议块覆盖正文的比例阈值：低于它视为「顺带提及」，不折叠。 */
const COVERAGE_RATIO = 0.5;

/**
 * 检测文本是否主要是漏出的工具调用协议原文。
 * 流式进行中（只有开标记、闭标记未到）返回 false，避免半截 XML 抖动切换卡片。
 */
export function detectLeakedToolCallXml(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed) return false;
	let covered = 0;
	for (const [open, close] of PROTOCOL_PAIRS) {
		const openIndex = trimmed.indexOf(open);
		if (openIndex === -1) continue;
		const closeIndex = trimmed.indexOf(close, openIndex + open.length);
		if (closeIndex === -1) continue;
		covered += closeIndex + close.length - openIndex;
	}
	if (covered === 0) return false;
	return covered >= trimmed.length * COVERAGE_RATIO;
}
