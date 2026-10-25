/**
 * WebAssistantText — Web 端助手消息 Markdown 渲染。
 *
 * 与桌面端同一 Streamdown 引擎（MarkdownStream，迁移自 react-markdown）：
 * - 流式半截 markdown 由引擎 remend 容错补全、按 block memo；
 * - 复用 MarkdownComponents 的 CodeBlock/MathSpan（仅依赖 lucide/Button/t）；
 * - Web 端无系统浏览器通道，外链直接 window.open 新窗口。
 */
import { isValidElement, memo, type ReactNode } from "react";
import "katex/dist/katex.min.css";
import { MarkdownStream } from "@/components/session/MarkdownStream";
import { stripAnsi } from "@/components/session/TimelineFormat";

/** 从正文里剥除 <thinking> 标签（思考内容由 reasoning part 单独渲染）。 */
function stripThinkingTags(text: string): string {
	return text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "").trim();
}

function extractText(node: ReactNode): string {
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(extractText).join("");
	if (isValidElement<{ children?: ReactNode }>(node)) {
		return extractText(node.props.children);
	}
	return "";
}

export const WebAssistantText = memo(
	function WebAssistantText(props: { text: string; isStreaming?: boolean; onOpenFile?: (path: string, line?: number) => void }) {
		// 清理 ANSI 转义码与 <thinking> 标签，thinking 由调用方折叠渲染
		const cleanText = stripThinkingTags(stripAnsi(props.text));
		return (
			<div className="assistant-text markdown-body">
				<MarkdownStream
					text={cleanText}
					isStreaming={Boolean(props.isStreaming)}
					onOpenExternal={(url: string) => {
						// Web 端无系统浏览器通道，直接当前标签页新窗口打开
						window.open(url, "_blank", "noopener");
					}}
					onOpenFile={props.onOpenFile}
				/>
			</div>
		);
	},
	// 文本与流式标记一致时跳过重渲染：历史消息在流式期间不重复解析 Markdown。
	// onOpenFile 不参与比较：调用方保证稳定身份（ref 快照），避免整树 memo 失效。
	(prev, next) => prev.text === next.text && prev.isStreaming === next.isStreaming,
);

/** 供调用方复用的文本提取（复制等场景）。 */
export function extractWebText(node: ReactNode): string {
	return extractText(node);
}
