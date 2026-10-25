import { HelpCircle } from "lucide-react";
import { t } from "../../i18n";
import { Badge } from "../ui-shadcn/badge";

/**
 * 「待确认提问」徽章 —— 侧栏所有待确认入口的唯一渲染点。
 *
 * 使用方：工作区项目行（ProjectTree.renderProject）、Chat 标题栏（ProjectTree.chatSection）、
 * 活动会话行（ActiveSessionsTree）。同一状态在任何入口的视觉语义、无障碍标题与
 * 计数文案必须完全一致，因此不允许各处自行复制这段 JSX。
 *
 * count <= 0 时返回 null，调用方无需自行判空。
 */
export function PendingAskBadge({ count }: { count: number }) {
	if (count <= 0) return null;
	return (
		<Badge variant="warning" className="h-4 shrink-0 gap-0.5 px-1 py-0 leading-none" title={t("sidebar.pendingConfirmationHint", { count: String(count) })}>
			<HelpCircle className="size-2.5 shrink-0 animate-pulse" aria-hidden="true" />
			<span>{count > 1 ? t("sidebar.pendingConfirmationCount", { count: String(count) }) : t("sidebar.pendingConfirmation")}</span>
		</Badge>
	);
}
