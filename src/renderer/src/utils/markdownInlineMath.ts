/**
 * 行内公式（单美元 `$...$`）的内容判别：内容不像公式时在 mdast 层降级为原文。
 *
 * 为什么需要：MarkdownStream 开启了 remark-math 的 singleDollarTextMath
 * （AI 输出行内公式普遍用单美元，不开则整句原样输出）。remark-math 只按「成对的 $」
 * 切分、不看内容（GitHub 同样如此），于是货币/占位符写法会被切成行内公式：
 *   `报价 $5 元，含税 $6 元` → 行内公式内容 `5 元，含税 `
 * KaTeX 用数学模式渲染它：丢空格、`.katex .base{white-space:nowrap}` 不换行，
 * 并对每个中文字符打一条 “LaTeX-incompatible input and strict mode is set to 'warn'”
 * 警告（katex 的 strict 默认 'warn'）→ 渲染层 console.warn 经主进程镜像后刷屏。
 *
 * 判别规则（只看定界符内部内容；`$$...$$` 是显式数学定界符，不参与判别）：
 * 1. 含 LaTeX 记号（\命令、上下标 ^ _、分组 {}）→ 是公式，`\text{中文}` 这类混排照常渲染；
 * 2. 含中日韩文字/全角标点 → 自然语言或货币文本，不是公式；
 * 3. 含空白却没有数学算符（= + - * / < > ( ) 等）→ 多词自然语言（`5 and 6`、`5 to `），不是公式。
 * 其余（单个 token、含算符的表达式）保持为公式，行为与 GitHub 数学渲染对齐。
 */

/** remark mdast 节点的最小内部形状：remark 插件边界类型包未随包引入，字段按实际访问点声明（与 MarkdownLinkCore 同策略） */
type MdNode = {
	type: string;
	value?: string;
	position?: { start?: { offset?: number }; end?: { offset?: number } };
	children?: MdNode[];
	[key: string]: unknown;
};

/** LaTeX 记号：反斜杠命令、上下标、分组 —— 命中即认定作者在写公式 */
const LATEX_MARKER = /[\\^_{}]/;
/** 数学算符（含 Unicode 数学符号）：把「多词自然语言」排除在公式之外 */
const MATH_OPERATOR = /[=+\-*/<>()[\]|~,]|[≈≤≥≠±×÷→←↑↓↔∀∃∈∉⊂⊆∪∩∑∏∫√∞°′″]/;
/** 中日韩文字、假名、谚文与全角标点：出现即判定为自然语言/货币文本 */
const NATURAL_LANGUAGE = /[\u2e80-\u9fff\u3000-\u303f\u3040-\u30ff\uac00-\ud7af\uff01-\uff60\uffe0-\uffe6]/;

/** 判断单美元定界符内部的内容是否像公式（导出以便单测） */
export function looksLikeInlineMath(content: string): boolean {
	const text = content.trim();
	if (!text) return false;
	if (LATEX_MARKER.test(text)) return true;
	if (NATURAL_LANGUAGE.test(text)) return false;
	if (/\s/.test(text) && !MATH_OPERATOR.test(text)) return false;
	return true;
}

/** 取回节点对应的原始 markdown 片段（含定界符）；位置信息缺失时用 value 重建 */
function sliceSource(node: MdNode, source: string | undefined): string {
	const start = node.position?.start?.offset;
	const end = node.position?.end?.offset;
	if (source !== undefined && typeof start === "number" && typeof end === "number" && end > start) return source.slice(start, end);
	return `$${node.value ?? ""}$`;
}

/**
 * 把内容不像公式的单美元 `$...$` 还原成原文文本节点。
 * 只在 mdast 层换节点类型，不做字符串转义，因此原文（含空格、`*`、`_`）逐字保留；
 * 必须在流式与静态两套插件列表里都启用，否则流式中 KaTeX 渲染、settle 后变回文本。
 */
export const remarkInlineMathGuard = () => {
	const demote = (node: MdNode, source: string | undefined): MdNode => {
		const raw = sliceSource(node, source);
		// 双美元是显式数学定界符（含流式中残留的 `$$`），保持公式语义
		if (raw.startsWith("$$")) return node;
		if (looksLikeInlineMath(node.value ?? raw)) return node;
		return { type: "text", value: raw };
	};
	const walk = (node: MdNode, source: string | undefined): void => {
		const children = node.children;
		if (!Array.isArray(children)) return;
		node.children = children.map((child) => {
			if (!child || typeof child !== "object") return child;
			if (child.type === "inlineMath") return demote(child, source);
			walk(child, source);
			return child;
		});
	};
	// 传入原始文本：mdast 的 inlineMath 值已去掉定界符与首尾空白，只有源文本能逐字还原 `$ 5 元 $`
	return (tree: MdNode, file?: { value?: unknown }) => walk(tree, typeof file?.value === "string" ? file.value : undefined);
};
