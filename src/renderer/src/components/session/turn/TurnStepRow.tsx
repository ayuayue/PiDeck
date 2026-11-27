import { memo } from "react";
import type { TurnDisplayItem } from "../timeline/types";
import { ErrorStep } from "./ErrorStep";
import { ExtensionEntryStep } from "./ExtensionEntryStep";
import { InterimAnswer } from "./InterimAnswer";
import { RetryStep } from "./RetryStep";
import { ThinkingStep } from "./ThinkingStep";
import { ToolStep } from "./ToolStep";

export type TurnStepRowProps = {
	item: TurnDisplayItem;
	/** 折叠栏是否展开：过程行在折叠态仍可能挂载（live 轮刻意不卸载），只是 hidden。 */
	stepsVisible: boolean;
	/** live 末条中间回复的 id：它在折叠容器外渲染，这里必须跳过以免双份。 */
	liveInterimId?: string;
	/** 刚结束流式的中间回复 id：settle 动画只作用于它。 */
	settleId?: string;
	showThinking?: boolean;
	agentRunning?: boolean;
	sessionId?: string;
	onOpenExternal: (url: string) => void;
	onOpenFile?: (path: string, line?: number) => void;
};

/**
 * 折叠栏里的单条过程行：思考 / 工具 / 自动重试 / 错误诊断 / 扩展输出 / 中间回答。
 *
 * 为什么单独一个组件，而不是留在 TurnRow 的 map 里就地展开：
 * 1. 这段 JSX 是流式期间最热的一处——`mountedSteps.items` 每 50ms 变一次，每种行都要
 *    重新决定挂什么子树。抽成组件后由 `memo` 兜住：行条目引用没变（结构复用保证了这一点）
 *    就直接复用上一帧结果。
 * 2. TurnRow 是「一轮怎么组织」，这里是「一行怎么画」。两者本来就该分文件：TurnRow 已因
 *    累积的历史修复长到单文件红线附近，再往里加东西只会让下一个人更难看清哪段归谁。
 *
 * 两条不变量（与 TurnRow 的分工）：
 * - final-answer 不经过这里（常驻区渲染），传进来直接返回 null；
 * - live 末条中间回答在折叠容器外渲染，同 id 在这里跳过。
 */
export const TurnStepRow = memo(function TurnStepRow(props: TurnStepRowProps) {
	const { item, stepsVisible } = props;
	if (item.kind === "interim-answer") {
		if (item.id === props.liveInterimId) return null;
		return (
			<InterimAnswer
				mode="settled"
				text={item.message.text}
				hidden={!stepsVisible}
				isStreaming={false}
				settle={props.settleId === item.id}
				// 折叠区内一律 process：正文已与最终回答同尺寸，process 只负责 my-3 间距。
				// 无最终回答的末段也要这段间距，否则会贴着上方工具行。
				variant="process"
				// 中间回复引用锚点：settled 正文根节点带 data-message-id，划选可解析来源消息。
				messageId={item.id}
				onOpenExternal={props.onOpenExternal}
				onOpenFile={props.onOpenFile}
			/>
		);
	}
	if (item.kind !== "process-entry") return null;
	const entry = item.entry;
	if (entry.kind === "thinking-entry") return <ThinkingStep group={entry.group} hidden={!stepsVisible} showThinking={props.showThinking} liveId={entry.liveId} onOpenExternal={props.onOpenExternal} onOpenFile={props.onOpenFile} />;
	// 自动重试过程行：与工具/思考同层，失败红、运行中旋转（见 RetryStep 注释）
	if (entry.kind === "retry-entry") return <RetryStep group={{ kind: "retry-group", id: entry.id, message: entry.message }} hidden={!stepsVisible} />;
	// 错误诊断过程行：429 等错误并入工具调用，可点开看具体错误（见 ErrorStep 注释）
	if (entry.kind === "error-entry") return <ErrorStep group={{ kind: "error-group", id: entry.id, message: entry.message }} hidden={!stepsVisible} />;
	// 扩展输出行（平铺路径）：无流式状态，隐藏时直接卸载即可
	if (entry.kind === "extension-entry") return stepsVisible ? <ExtensionEntryStep messages={entry.messages} /> : null;
	return <ToolStep group={entry.group} hidden={!stepsVisible} stopped={props.agentRunning !== true} sessionId={props.sessionId} onOpenFile={props.onOpenFile} />;
});
