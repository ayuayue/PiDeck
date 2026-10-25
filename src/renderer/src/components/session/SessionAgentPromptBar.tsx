import { useState } from "react";
import { useAtomValue } from "jotai";
import { Bot, ChevronDown, ChevronUp } from "lucide-react";
import { agentMarketSettingsAtom, agentProfilesAtom } from "../../atoms/agent-atoms";
import { t } from "../../i18n";
import { resolveBoundSessionAgent } from "../../utils/sessionAgentBinding";
import { Collapsible, CollapsibleContent } from "../ui-shadcn/collapsible";

interface SessionAgentPromptBarProps {
	sessionId: string;
}

/**
 * 会话绑定的智能体提示条：输入框上方常驻，可展开查看完整角色设定。
 *
 * 为什么需要它：绑定会话每次发送时由主进程把 systemPrompt 拼进隐藏 agentMessage
 *（pi/acp）或可见前缀（DSH），时间线里看不到角色设定（用户反馈「使用后不知道提示词
 * 是什么」）。这里只做只读展示：不写入对话正文、不参与发送载荷，展开状态仅本组件内存。
 * 绑定智能体被删除/解绑后返回 null，不留下悬空提示条。
 */
export function SessionAgentPromptBar({ sessionId }: SessionAgentPromptBarProps) {
	const agents = useAtomValue(agentProfilesAtom);
	const settings = useAtomValue(agentMarketSettingsAtom);
	const agent = resolveBoundSessionAgent(settings.sessionAgentBindings, agents, sessionId);
	const [expanded, setExpanded] = useState(false);
	if (!agent) return null;

	return (
		<div data-testid="session-agent-prompt-bar" className="shrink-0 overflow-hidden rounded-xl border border-border/50 bg-bg-panel/40" aria-label={t("agentPromptBar.aria")}>
			<button type="button" aria-expanded={expanded} className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-accent-soft/60" onClick={() => setExpanded((value) => !value)}>
				<span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-bg-muted text-xs leading-none" aria-hidden="true">
					{agent.icon || <Bot className="size-3.5 text-muted-foreground" />}
				</span>
				<span className="min-w-0 truncate text-xs font-medium text-foreground">{agent.name}</span>
				<span className="shrink-0 text-micro text-muted-foreground">{t("agentPromptBar.roleLabel")}</span>
				<span className="ml-auto flex shrink-0 items-center gap-1 text-micro text-muted-foreground">
					{expanded ? t("agentPromptBar.collapse") : t("agentPromptBar.expand")}
					{expanded ? <ChevronUp className="size-3" aria-hidden="true" /> : <ChevronDown className="size-3" aria-hidden="true" />}
				</span>
			</button>
			{/* 折叠体走共享折叠原语（真高度渐变 + exit 后卸载 + reduced-motion 回退）；
			    display:contents 根不生成盒子，折叠态零空档。 */}
			<Collapsible open={expanded} className="contents">
				<CollapsibleContent className="border-t border-border/40 px-3 py-2">
					<p className="mb-1.5 text-micro text-text-tertiary">{t("agentPromptBar.hint")}</p>
					<pre className="max-h-40 overflow-y-auto rounded-md bg-bg-muted/40 p-2 font-mono text-micro leading-relaxed whitespace-pre-wrap break-words text-foreground/90">{agent.systemPrompt}</pre>
				</CollapsibleContent>
			</Collapsible>
		</div>
	);
}
