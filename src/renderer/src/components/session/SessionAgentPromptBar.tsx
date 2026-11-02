import { useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { agentMarketSettingsAtom, agentProfilesAtom, pendingAgentBindingAtom } from "../../atoms/agent-atoms";
import { t } from "../../i18n";
import { GUIDE_BOOTSTRAP_SESSION_ID } from "../../utils/chatSessionBootstrap";
import { resolveBoundSessionAgent } from "../../utils/sessionAgentBinding";
import { AgentIcon } from "../agents/AgentIcon";
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
 *
 * 「待绑定」形态：市场里点「使用」只把智能体带到新会话页（还没有会话可绑），此时提示条
 * 展示将要绑定谁并给一个「取消」，首次发送建会话时才真正落绑定（见 App.ensureSessionForSend）。
 */
export function SessionAgentPromptBar({ sessionId }: SessionAgentPromptBarProps) {
	const agents = useAtomValue(agentProfilesAtom);
	const settings = useAtomValue(agentMarketSettingsAtom);
	const pendingAgentId = useAtomValue(pendingAgentBindingAtom);
	const clearPendingAgent = useSetAtom(pendingAgentBindingAtom);
	const boundAgent = resolveBoundSessionAgent(settings.sessionAgentBindings, agents, sessionId);
	// 只在引导页（新会话页）认待绑定智能体：真实会话里提示条永远只反映落盘的绑定。
	const pendingAgent = !boundAgent && sessionId === GUIDE_BOOTSTRAP_SESSION_ID && pendingAgentId ? (agents.find((profile) => profile.id === pendingAgentId) ?? null) : null;
	const agent = boundAgent ?? pendingAgent;
	const [expanded, setExpanded] = useState(false);
	if (!agent) return null;
	const armed = Boolean(pendingAgent);

	return (
		<div data-testid="session-agent-prompt-bar" className="shrink-0 overflow-hidden rounded-xl border border-border/50 bg-bg-panel/40" aria-label={t("agentPromptBar.aria")}>
			<div className="flex items-center">
				<button type="button" aria-expanded={expanded} className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-accent-soft/60" onClick={() => setExpanded((value) => !value)}>
					<span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-bg-muted text-xs leading-none" aria-hidden="true">
						<AgentIcon icon={agent.icon} />
					</span>
					<span className="min-w-0 truncate text-xs font-medium text-foreground">{agent.name}</span>
					<span className="shrink-0 text-micro text-muted-foreground">{t(armed ? "agentPromptBar.pendingLabel" : "agentPromptBar.roleLabel")}</span>
					<span className="ml-auto flex shrink-0 items-center gap-1 text-micro text-muted-foreground">
						{expanded ? t("agentPromptBar.collapse") : t("agentPromptBar.expand")}
						{expanded ? <ChevronUp className="size-3" aria-hidden="true" /> : <ChevronDown className="size-3" aria-hidden="true" />}
					</span>
				</button>
				{armed && (
					// 与展开按钮并列而不是嵌套：根节点是 div，展开按钮已是整行 button，嵌套 button 不合法。
					<button
						type="button"
						className="mr-1.5 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent-soft hover:text-foreground"
						aria-label={t("agentPromptBar.pendingCancel")}
						title={t("agentPromptBar.pendingCancel")}
						onClick={() => clearPendingAgent(null)}
					>
						<X className="size-3.5" aria-hidden="true" />
					</button>
				)}
			</div>
			{/* 折叠体走共享折叠原语（真高度渐变 + exit 后卸载 + reduced-motion 回退）；
			    display:contents 根不生成盒子，折叠态零空档。 */}
			<Collapsible open={expanded} className="contents">
				<CollapsibleContent className="border-t border-border/40 px-3 py-2">
					<p className="mb-1.5 text-micro text-text-tertiary">{t(armed ? "agentPromptBar.pendingHint" : "agentPromptBar.hint")}</p>
					{/* scroll-ok: text —— 单一文本块（pre / markdown 正文），没有行列表可切，虚拟化无从下手。 */}
					<pre className="max-h-40 overflow-y-auto rounded-md bg-bg-muted/40 p-2 font-mono text-micro leading-relaxed whitespace-pre-wrap break-words text-foreground/90">{agent.systemPrompt}</pre>
				</CollapsibleContent>
			</Collapsible>
		</div>
	);
}
