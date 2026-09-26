import { useMemo } from "react";
import { GitCommitHorizontal, GitPullRequestArrow } from "lucide-react";
import type { AgentRunItem } from "./timeline/types";
import { commitSuggestionsForRun } from "../../utils/commitIntentSuggestions";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";

/**
 * composer 上方 widgets 列的「提交/推送」快捷建议条。
 *
 * 只在最新一轮的最终回复提到提交/推送时出现（判据见 commitIntentSuggestions），
 * 点击即直发对应消息（正文不经草稿，与底栏「快捷消息」同一 sendQuickMessage
 * 通道）；用户发起新一轮后 run 身份变化，条目随之消失，无需显式关闭。
 * 刻意不用 ComposerWidgetFrame 折叠卡：这是两个一次性动作按钮，不是浏览内容。
 */
export function SessionCommitSuggestionStrip(props: { sessionId: string; run?: AgentRunItem; sendDisabled?: boolean; onSend: (text: string) => void }) {
	const suggestions = useMemo(() => commitSuggestionsForRun(props.run), [props.run]);
	if (suggestions.length === 0) return null;

	return (
		<div data-testid="session-commit-suggestion-strip" role="group" aria-label={t("commitSuggest.aria")} className="flex min-w-0 shrink-0 flex-wrap items-center gap-1.5 px-0.5">
			{suggestions.map((suggestion, index) => (
				<Button key={suggestion.id} variant="outline" size="xs" className="rounded-full text-text-secondary" disabled={props.sendDisabled} onClick={() => props.onSend(t(suggestion.textKey))}>
					{index === 0 ? <GitCommitHorizontal size={12} aria-hidden="true" /> : <GitPullRequestArrow size={12} aria-hidden="true" />}
					<span>{t(suggestion.labelKey)}</span>
				</Button>
			))}
		</div>
	);
}
