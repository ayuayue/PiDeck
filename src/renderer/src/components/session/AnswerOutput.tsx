import { memo } from "react";
import { useAtomValue } from "jotai";
import { streamingTextBySessionIdAtomFamily } from "../../atoms/session-atoms";
import { MarkdownStream } from "./MarkdownStream";

/** 与 TimelineFormat 同逻辑的内联副本（node 单测可直接加载，零外部依赖）。 */
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

function stripAnsi(text: string): string {
	return text.replace(ANSI_RE, "");
}

function stripThinkingTags(text: string): string {
	return text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "").trim();
}

/**
 * 中间回答视觉档位。
 * 两档正文都走 chat 主尺寸/主色（中间段也是回答）；
 * process 只加上下间距，从密度上把它和紧贴的思考/工具行拉开。
 * OpenCode 相邻 assistant part 约 pt-3；Codex/Cursor 过程行紧、正文段松。
 */
export type AnswerOutputVariant = "process" | "answer";

/** execution-interim 是 typewriter E2E / settle 动画锚点，不能改名。 */
function answerOutputClassName(variant: AnswerOutputVariant): string {
	// 折叠区 gap 为 0：settled 中间段必须自己留空，否则贴着思考/工具行。
	// live 挂在折叠容器外，父级 flex gap-3 已经分隔，不能再叠 mt-3。
	if (variant === "process") {
		// my-5 = 段前段后各 20px（--spacing 4px × 5，原为 my-3 的 12px）。
		// ⑤ 在这里用**段前段后距**而不是加大行高把中间回复"托"出来：
		//   - 段前段后距与回复行数无关，10 行也不会再加倍；
		//   - 行高（leading-*）会随行数线性变高，且会让中间回复与最终回复在同一屏
		//     出现两种行距（都是正文，行距不一致看着像 bug）。
		// 行高保持 --line-height-chat(1.6)，不额外加 leading-*。
		return "execution-interim markdown-body my-5 text-chat text-text-primary";
	}
	return "execution-interim markdown-body text-chat text-text-primary";
}

/**
 * 助手正文唯一输出入口。
 *
 * - live：读 streamingTextByIdAtom，MarkdownStream 轻量渲染（与思考同构，
 *   打字机/超长纯文本兜底都在 MarkdownStream 内部）
 * - settled：原文一次交给全量 Streamdown（高亮/mermaid/math）
 *
 * 视觉容器仍用 execution-interim.markdown-body，兼容 typewriter E2E 选择器。
 */
export const AnswerOutput = memo(function AnswerOutput(props: {
	mode: "live" | "settled";
	/** live 模式：订阅该 session 的独立正文通道 */
	sessionId?: string;
	/** settled 模式：History 消息正文 */
	text?: string;
	hidden?: boolean;
	isStreaming?: boolean;
	/** live→settled 交接时播放一次淡入（assistant-answer-settle） */
	settle?: boolean;
	/** 视觉档位；live 忽略，始终按 answer 渲染（边打边读）。 */
	variant?: AnswerOutputVariant;
	/** 引用锚点：settled 中间回复透传消息 id，渲染为 data-message-id（划选引用解析用）。 */
	messageId?: string;
	onOpenExternal: (url: string, forceSystem?: boolean) => void;
	onOpenFile?: (path: string) => void;
}) {
	if (props.mode === "live") {
		return <LiveAnswerBody sessionId={props.sessionId ?? ""} hidden={props.hidden} isStreaming={props.isStreaming} onOpenExternal={props.onOpenExternal} onOpenFile={props.onOpenFile} />;
	}
	const cleanText = stripThinkingTags(stripAnsi(props.text ?? ""));
	if (!cleanText.trim()) return null;
	return (
		<div className={answerOutputClassName(props.variant ?? "process")} data-message-id={props.messageId} data-is-streaming="0" data-variant={props.variant ?? "process"} data-settle={props.settle ? "1" : undefined} style={{ display: props.hidden ? "none" : undefined }}>
			<MarkdownStream text={cleanText} isStreaming={false} onOpenExternal={props.onOpenExternal} onOpenFile={props.onOpenFile} />
		</div>
	);
});

/**
 * Live 正文：atom → MarkdownStream（打字机在 MarkdownStream 内部，
 * 不再自持打字机，避免双重逐字；流式轻量渲染与思考同构）。
 */
const LiveAnswerBody = memo(function LiveAnswerBody(props: { sessionId: string; hidden?: boolean; isStreaming?: boolean; onOpenExternal: (url: string, forceSystem?: boolean) => void; onOpenFile?: (path: string) => void }) {
	const streaming = useAtomValue(streamingTextBySessionIdAtomFamily(props.sessionId));
	const sourceText = streaming?.content ?? "";
	const text = stripThinkingTags(stripAnsi(sourceText));
	return (
		<div className={answerOutputClassName("answer")} data-live-answer="true" data-is-streaming={props.isStreaming ? "1" : "0"} data-variant="answer" style={{ display: props.hidden ? "none" : undefined }}>
			<MarkdownStream text={text} isStreaming={Boolean(props.isStreaming)} onOpenExternal={props.onOpenExternal} onOpenFile={props.onOpenFile} />
		</div>
	);
});
