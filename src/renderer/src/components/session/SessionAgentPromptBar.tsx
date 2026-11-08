import { useAtomValue, useSetAtom } from "jotai";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { agentMarketSettingsAtom, agentProfilesAtom, pendingAgentBindingAtom } from "../../atoms/agent-atoms";
import { t } from "../../i18n";
import { GUIDE_BOOTSTRAP_SESSION_ID } from "../../utils/chatSessionBootstrap";
import { resolveBoundSessionAgent } from "../../utils/sessionAgentBinding";
import { AgentIcon } from "../agents/AgentIcon";
import { Button } from "../ui-shadcn/button";
import { Collapsible, CollapsibleContent } from "../ui-shadcn/collapsible";
import { ComposerWidgetFrame, useComposerWidgetCollapsed } from "./ComposerWidgetLayout";

interface SessionAgentPromptBarProps {
	sessionId: string;
}

/**
 * 会话绑定的智能体角色设定卡：与待办/子代理同列展示，可展开查看完整角色设定。
 *
 * 为什么需要它：绑定会话首轮发送时由主进程把 systemPrompt 拼进隐藏 agentMessage
 *（pi/acp）或可见前缀（DSH），时间线里看不到角色设定（用户反馈「使用后不知道提示词
 * 是什么」）。这里只做只读展示：不写入对话正文、不参与发送载荷，折叠状态与其他
 * composer widget 共用同一份内存状态。
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
	const { collapsed, toggleCollapsed } = useComposerWidgetCollapsed(`agent:${sessionId}`, true);
	if (!agent) return null;
	const armed = Boolean(pendingAgent);

	return (
		<ComposerWidgetFrame data-testid="session-agent-prompt-bar" aria-label={t("agentPromptBar.aria")}>
			{/* 受控呈现：折叠状态归 composer 通道单一持有，Radix 只承载高度动画（同 todo/subagents 卡）。 */}
			<Collapsible open={!collapsed} className="contents">
				<div className="flex h-9 w-full items-center gap-2.5 px-3">
					<button type="button" className="flex min-w-0 flex-1 items-center gap-2.5 text-left" aria-expanded={!collapsed} onClick={toggleCollapsed}>
						<span className="flex size-4 shrink-0 items-center justify-center text-sm leading-none text-text-tertiary" aria-hidden="true">
							<AgentIcon icon={agent.icon} />
						</span>
						<span className="max-w-[60%] shrink-0 truncate text-control font-medium leading-6 text-foreground">{agent.name}</span>
						<span className="min-w-0 flex-1 truncate text-control leading-5 text-text-tertiary">{t(armed ? "agentPromptBar.pendingLabel" : "agentPromptBar.roleLabel")}</span>
						<span className="shrink-0 text-text-tertiary" aria-hidden="true">
							{collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
						</span>
					</button>
					{armed && (
						// 与展开按钮并列而不是嵌套：根节点是 div，展开按钮已是整行 button，嵌套 button 不合法。
						<Button variant="ghost" size="icon-xs" className="size-7 shrink-0 rounded-full text-text-tertiary hover:bg-muted/70 hover:text-foreground" aria-label={t("agentPromptBar.pendingCancel")} title={t("agentPromptBar.pendingCancel")} onClick={() => clearPendingAgent(null)}>
							<X size={14} aria-hidden="true" />
						</Button>
					)}
				</div>
				<CollapsibleContent className="px-3 pb-2">
					<p className="mb-1.5 text-micro leading-4 text-text-tertiary">{t(armed ? "agentPromptBar.pendingHint" : "agentPromptBar.hint")}</p>
					{/* scroll-ok: text —— 单一文本块（pre / markdown 正文），没有行列表可切，虚拟化无从下手。 */}
					<pre className="max-h-40 overflow-y-auto rounded-md bg-bg-muted/40 p-2 font-mono text-micro leading-relaxed whitespace-pre-wrap break-words text-foreground/90">{agent.systemPrompt}</pre>
				</CollapsibleContent>
			</Collapsible>
		</ComposerWidgetFrame>
	);
}
