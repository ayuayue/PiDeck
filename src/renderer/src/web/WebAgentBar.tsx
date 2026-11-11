/**
 * WebAgentBar — 会话绑定的智能体提示条（对齐桌面 SessionAgentPromptBar 的只读形态）。
 *
 * 为什么需要：角色设定由主进程在首轮发送时拼进隐藏载荷，时间线里看不到
 * （用户反馈「使用后不知道提示词是什么」）。这里只读展示，可展开看完整角色设定；
 * 不参与发送、不改绑定——解绑/换人请在桌面端「智能体」页处理。
 */
import { useState } from "react";
import { Bot, ChevronDown, ChevronUp } from "lucide-react";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { AgentIcon } from "@/components/agents/AgentIcon";
import type { WebAgentProfile } from "./webTypes";

export function WebAgentBar({ agent }: { agent?: WebAgentProfile }) {
	const [expanded, setExpanded] = useState(false);
	if (!agent) return null;
	return (
		<div className="composer-above shrink-0 border-t border-border/60 bg-background px-3 py-1" data-testid="web-agent-bar">
			<button type="button" className="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-muted/60" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
				<span className="flex size-4 shrink-0 items-center justify-center text-sm leading-none text-text-tertiary" aria-hidden="true">
					{agent.icon ? <AgentIcon icon={agent.icon} /> : <Bot className="size-4" aria-hidden="true" />}
				</span>
				<span className="max-w-[45%] shrink-0 truncate text-control font-medium text-foreground">{agent.name}</span>
				<span className="min-w-0 flex-1 truncate text-control text-text-tertiary">{t("web.agentBarLabel")}</span>
				{expanded ? <ChevronDown className="size-4 shrink-0 text-text-tertiary" aria-hidden="true" /> : <ChevronUp className="size-4 shrink-0 text-text-tertiary" aria-hidden="true" />}
			</button>
			<div className={cn("grid transition-[grid-template-rows] duration-200 ease-standard motion-reduce:transition-none", expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}>
				<div className="min-h-0 overflow-hidden">
					<p className="px-1.5 pt-0.5 text-micro leading-4 text-text-tertiary">{t("web.agentBarHint")}</p>
					{/* scroll-ok: text —— 单一文本块（pre），没有行列表可切。 */}
					<pre className="mx-1.5 mt-1 mb-1.5 max-h-40 overflow-y-auto rounded-md bg-bg-muted/40 p-2 font-mono text-micro leading-relaxed break-words whitespace-pre-wrap text-foreground/90">{agent.systemPrompt}</pre>
				</div>
			</div>
		</div>
	);
}
