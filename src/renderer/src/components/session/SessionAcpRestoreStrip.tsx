import { useAtomValue } from "jotai";
import { History, LoaderCircle, TriangleAlert } from "lucide-react";
import { acpToolsAtom } from "../../atoms/acp-atoms";
import { sessionRuntimeBySessionIdAtomFamily } from "../../atoms";
import { sessionRecordByIdAtomFamily } from "../../atoms/session-selectors";
import { t } from "../../i18n";
import { resolveAcpRestoreHint } from "../../utils/acpSessionRestore";
import { ComposerWidgetFrame } from "./ComposerWidgetLayout";

/**
 * 未激活 ACP 会话的恢复提示条（与 queued/todo 条同位同形态）。
 *
 * ACP 历史存在 agent CLI 侧：未激活会话的时间线是空的（不是新会话、更不是丢会话），
 * 给一行说明让用户知道「发消息即自动恢复」；绑定的工具被删降级为只读引导。
 * 选中会话即后台预热（ComposerArea prewarm）：预热期间（runtime starting）切换为
 * 加载动画，让「点开 → 加载 → 历史出现」成为连续的单一叙事。
 */
export function SessionAcpRestoreStrip(props: { sessionId: string }) {
	// 侧栏/分屏都各自按 sessionId 订阅（禁止读 currentSession 全局原子）。
	const record = useAtomValue(sessionRecordByIdAtomFamily(props.sessionId));
	const runtime = useAtomValue(sessionRuntimeBySessionIdAtomFamily(props.sessionId));
	const tools = useAtomValue(acpToolsAtom);
	const hint = resolveAcpRestoreHint(record, runtime, tools);
	if (!hint) return null;
	const text = hint.kind === "tool-missing" ? t("acp.restoreMissing") : hint.activating ? t("acp.restoringHistory", { tool: hint.toolName }) : t("acp.restoreHint", { tool: hint.toolName });
	return (
		<ComposerWidgetFrame data-testid="session-acp-restore-strip" aria-label={text}>
			<div className="flex h-9 w-full shrink-0 items-center gap-2.5 px-3">
				{hint.kind === "tool-missing" ? (
					<TriangleAlert size={14} aria-hidden="true" className="shrink-0 text-[var(--color-warning)]" />
				) : hint.activating ? (
					<LoaderCircle size={14} aria-hidden="true" className="shrink-0 animate-pideck-spin text-text-tertiary" />
				) : (
					<History size={14} aria-hidden="true" className="shrink-0 text-text-tertiary" />
				)}
				<span className="min-w-0 flex-1 truncate text-control leading-6 text-text-secondary" title={text}>
					{text}
				</span>
			</div>
		</ComposerWidgetFrame>
	);
}
