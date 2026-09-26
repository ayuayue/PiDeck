import { memo } from "react";
import { AnswerOutput, type AnswerOutputVariant } from "../AnswerOutput";

/**
 * 中间回答：执行过程折叠区内的阶段性正文。
 *
 * - live：订阅独立流式通道（AnswerOutput），History 骨架可为空；视觉始终按 answer 档
 * - settled：渲染 message.text 的全量 Markdown；正文尺寸与最终回答相同，process 只加与过程行的间距
 */
export const InterimAnswer = memo(function InterimAnswer(props: {
	/** live 时读 streamingTextByIdAtom；settled 时用 text */
	mode?: "live" | "settled";
	sessionId?: string;
	text?: string;
	hidden?: boolean;
	isStreaming?: boolean;
	/** live→settled 交接淡入 */
	settle?: boolean;
	/** settled 视觉档位；live 忽略。正文同尺寸；process 只多上下间距。 */
	variant?: AnswerOutputVariant;
	/** 引用锚点：settled 时透传给 AnswerOutput 渲染 data-message-id。 */
	messageId?: string;
	onOpenExternal: (url: string) => void;
	onOpenFile?: (path: string) => void;
}) {
	const mode = props.mode ?? "settled";
	return <AnswerOutput mode={mode} sessionId={props.sessionId} text={props.text} hidden={props.hidden} isStreaming={props.isStreaming} settle={props.settle} variant={props.variant} messageId={props.messageId} onOpenExternal={props.onOpenExternal} onOpenFile={props.onOpenFile} />;
});
