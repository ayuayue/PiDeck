import {
	Fragment,
	isValidElement,
	useEffect,
	useRef,
	useState,
	type ComponentPropsWithoutRef,
	type ReactNode,
} from "react";
import { Check, Copy } from "lucide-react";
import { t } from "../../i18n";
import { showNotice } from "../../utils/notice";

/**
 * Markdown 渲染辅助（Streamdown 转正后精简）：
 * mermaid 由 @streamdown/mermaid 插件渲染、数学公式由 @streamdown/math；
 * 代码高亮已移除（2026-08 内存优化）。本文件仅保留通用文本提取工具与公式复制包装。
 */

/** 从 ReactNode 树提取纯文本（复制/导出场景使用）。 */
export function extractText(node: ReactNode): string {
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(extractText).join("");
	if (isValidElement<{ children?: ReactNode }>(node)) {
		return extractText(node.props.children);
	}
	return "";
}

/**
 * 段落级公式复制包装：把「唯一子元素是 KaTeX 的段落」（块级公式 $$...$$）包一层
 * .math-copy-wrap 并在右侧挂复制按钮。LaTeX 源码取自 katex-mathml 里的
 * annotation[encoding="application/x-tex"]（rehype-katex 固定输出）。
 *
 * 为什么在 p 层拦截而不是自定义 math 组件：@streamdown/math 走 remark-math +
 * rehype-katex，渲染产物是纯 HTML span，不进组件 map，段落是唯一可挂的节点。
 * props 类型对齐 streamdown Components 的 p 槽位（JSX.IntrinsicElements["p"] & ExtraProps），
 * 其余运行时字段（node/className）经解构丢弃，不影响渲染。
 */
export function MathBlockParagraph(
	props: ComponentPropsWithoutRef<"p"> & { children?: ReactNode },
) {
	const { children, ...rest } = props;
	const wrapRef = useRef<HTMLSpanElement | null>(null);
	const [copied, setCopied] = useState(false);
	const timerRef = useRef<number | null>(null);
	useEffect(() => () => { if (timerRef.current) window.clearTimeout(timerRef.current); }, []);

	// 块级公式判定：段落唯一子元素是 .katex（streamdown 输出不带 katex-display 类，
	// 行内公式与文字混排时子元素不止一个，天然排除）
	const kids = Array.isArray(children) ? children : [children];
	const first = kids.length === 1 ? kids[0] : null;
	const firstProps = isValidElement<{ className?: unknown }>(first) ? first.props : undefined;
	const className = typeof firstProps?.className === "string" ? firstProps.className : "";
	const katexOnly = Boolean(first && isValidElement(first) && /(^|\s)katex(\s|$)/.test(className));

	// 非公式段落保持 streamdown 默认 p 行为：单 img / 单 code[data-block] 直通
	//（与 streamdown 内建 MarkdownParagraph 一致，避免图片/代码块段落被 <p> 包裹）
	if (!katexOnly) {
		if (first && isValidElement<{ node?: { tagName?: string } }>(first)) {
			const tagName = first.props.node?.tagName;
			if (tagName === "img") return <Fragment>{children}</Fragment>;
			if (tagName === "code" && "data-block" in first.props) return <Fragment>{children}</Fragment>;
		}
		return <p {...rest}>{children}</p>;
	}

	const copyTex = async () => {
		const tex =
			wrapRef.current
				?.querySelector('.katex-mathml annotation[encoding="application/x-tex"]')
				?.textContent?.trim() ?? "";
		try {
			await navigator.clipboard.writeText(tex);
			setCopied(true);
			showNotice(t("copy.formulaCopied"), 1200);
			timerRef.current = window.setTimeout(() => setCopied(false), 1500);
		} catch {
			showNotice(t("copy.failed"), 2000);
		}
	};

	return (
		<p {...rest}>
			<span ref={wrapRef} className="math-copy-wrap">
				{children}
				<button
					type="button"
					className="math-copy-btn"
					title={t("copy.formula")}
					aria-label={t("copy.formula")}
					onClick={() => void copyTex()}
				>
					{copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
				</button>
			</span>
		</p>
	);
}
