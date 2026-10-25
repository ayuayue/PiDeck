import { useAtomValue, useSetAtom } from "jotai";
import { Bot } from "lucide-react";
import { openAgentMarketPageAtom } from "../../atoms/agent-atoms";
import { agentsModuleHiddenAtom } from "../../atoms/app-ui-atoms";
import { t } from "../../i18n";

/**
 * 侧栏顶部动作区的「智能体」入口（定时任务下方，与 AutomationDockButton 同款行）。
 * 点击打开（或激活）会话 Tab 栏里的「智能体」页面 Tab（覆盖会话列，侧栏保持可交互）；
 * 行内不放徽标——页面没有「正在运行」这类需要行尾提示的状态。
 */
export function AgentMarketDockButton() {
	const openAgentMarketPage = useSetAtom(openAgentMarketPageAtom);
	// 外观设置→功能模块里隐藏了「智能体」：只摘掉入口，已有智能体与会话绑定不受影响
	const hidden = useAtomValue(agentsModuleHiddenAtom);
	if (hidden) return null;

	return (
		<button type="button" className="group flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-body text-foreground transition-colors hover:bg-muted/60" aria-label={t("agentMarket.title")} title={t("agentMarket.title")} onClick={() => openAgentMarketPage()}>
			<Bot className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
			<span className="min-w-0 flex-1 truncate font-medium">{t("agentMarket.title")}</span>
		</button>
	);
}
