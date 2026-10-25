import { createPortal } from "react-dom";
import { MessagesSquare } from "lucide-react";
import type { ChatMessage } from "../../../../shared/types";
import type { ReplyActionRule } from "../../../../shared/types/replyActions";
import { replyActionTextsForMessages } from "../../utils/replyActionRules";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";

/**
 * 最新回复末尾的快捷操作。按钮文案与触发条件来自用户规则文件
 * （userData/reply-actions.json，出厂规则 reply-actions.default.json），
 * 组件只做「信号归约 × 规则求值 → 展示」，不内置任何场景判断。
 *
 * 发送仍由本栏唯一的 composer 拥有，portal 只改变落点，不另建发送控制器
 * 或把提示词塞进草稿；切换会话时拒绝尚未替换的旧 DOM 落点。
 */
export function SessionReplyActions(props: { sessionId: string; messages: readonly ChatMessage[]; rules: readonly ReplyActionRule[]; target: HTMLDivElement | null; hidden: boolean; sendDisabled: boolean; onSend: (text: string) => void }) {
	const texts = replyActionTextsForMessages(props.rules, props.messages);
	// texts 是纯派生值（纯函数求值），直接用即可；useMemo 收益为零还多一层依赖。
	if (props.hidden || !props.target || props.target.dataset.sessionId !== props.sessionId || texts.length === 0) return null;

	return createPortal(
		<div data-testid="session-reply-action-strip" role="group" aria-label={t("replySuggest.aria")} className="flex min-w-0 flex-wrap items-center gap-1.5 pt-2">
			{texts.map((text) => (
				<Button key={text} type="button" variant="outline" size="xs" className="rounded-full" disabled={props.sendDisabled} title={text} onClick={() => props.onSend(text)}>
					<MessagesSquare data-icon="inline-start" aria-hidden="true" />
					<span>{text}</span>
				</Button>
			))}
		</div>,
		props.target,
	);
}
