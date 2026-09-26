import { useAtomValue } from "jotai";
import { Check, MessageCircle, X } from "lucide-react";
import { askEchoBySessionIdAtomFamily } from "../../atoms/ask-echo-atoms";
import { sessionMessageCacheBySessionIdAtomFamily } from "../../atoms/session-atoms";
import { sessionRuntimeBySessionIdAtomFamily, sessionRuntimeUiBySessionIdAtomFamily } from "../../atoms/session-selectors";
import { t } from "../../i18n";
import { resolveActiveAskRequest } from "../../utils/askUi";
import { batchAnswerLabel } from "../overlays/SessionRuntimeUiOverlay";

/**
 * DSH 已作答提问的时间线回显卡。
 *
 * pi 的提问应答后由工具消息 meta._askCard 在时间线留静态卡；DSH 提问是带外
 * server-request，completed 后卡片直接消失（用户反馈「dsh 提交后的渲染没有做」）。
 * 本卡读 recordAskEchoAtom 写入的内存级回显（数据流见 ask-echo-atoms.ts），
 * 挂在时间线尾部；不做历史留痕——DSH 历史由 host 全量折叠，合成消息会被冲掉。
 *
 * 失效判据（任一命中即不渲染）：
 * - runtime 换代/重启（agentId 或 runtimeGeneration 与应答时不一致）；
 * - 又出现新的待应答 ask（常驻底栏的交互卡优先，回显让位）；
 * - 用户开始下一轮发言（user 消息数超过应答时刻快照）——回显使命（确认答案送达）已结束。
 */
export function SessionAskEcho(props: { sessionId: string }) {
	const entry = useAtomValue(askEchoBySessionIdAtomFamily(props.sessionId));
	const runtime = useAtomValue(sessionRuntimeBySessionIdAtomFamily(props.sessionId));
	const runtimeUi = useAtomValue(sessionRuntimeUiBySessionIdAtomFamily(props.sessionId));
	const cache = useAtomValue(sessionMessageCacheBySessionIdAtomFamily(props.sessionId));
	if (!entry || !runtime) return null;
	if (runtime.agentId !== entry.agentId || runtime.runtimeGeneration !== entry.runtimeGeneration) return null;
	if (resolveActiveAskRequest(runtime, runtimeUi)) return null;
	let userMessageCount = 0;
	for (const message of cache?.messages ?? []) {
		if (message.role === "user") userMessageCount += 1;
	}
	if (userMessageCount > entry.userMessageCount) return null;
	const { echo } = entry;
	return (
		<div className="mx-auto w-full min-w-0 py-1.5" aria-label={t(echo.cancelled ? "ask.cancelled" : "ask.answered")}>
			<div className="flex min-w-0 flex-col gap-1 rounded-md border border-border-subtle bg-bg-panel px-2.5 py-2">
				<div className="flex min-w-0 items-center gap-1.5 text-control font-semibold text-text-primary">
					{/* 取消态用 X（danger），作答完成用 Check（success）——与提问卡选项对勾同一组语义色 */}
					{echo.cancelled ? <X size={14} aria-hidden="true" className="shrink-0 text-[var(--color-danger)]" /> : <Check size={14} aria-hidden="true" className="shrink-0 text-[var(--color-success)]" />}
					<MessageCircle size={14} aria-hidden="true" className="shrink-0 text-text-tertiary" />
					<span>{t(echo.cancelled ? "ask.cancelled" : "ask.answered")}</span>
				</div>
				{echo.items.map((item, index) => (
					<div key={`${item.question}:${index}`} className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,30ch)] items-start gap-2 text-caption leading-[1.6] text-text-primary">
						<span className="min-w-0 [overflow-wrap:anywhere]">{item.question}</span>
						<span className={`min-w-0 text-right font-mono font-medium [overflow-wrap:anywhere]${item.answered ? " text-[var(--color-success)]" : " text-text-tertiary"}`}>{item.answered ? batchAnswerLabel(item.answer) : t("ask.unanswered")}</span>
					</div>
				))}
			</div>
		</div>
	);
}
