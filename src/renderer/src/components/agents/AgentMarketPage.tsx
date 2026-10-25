import { useEffect } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import type { AgentProfile } from "../../../../shared/types/agentProfile";
import { agentMarketEditingAgentIdAtom, agentMarketPageOpenAtom, closeAgentMarketPageAtom } from "../../atoms/agent-atoms";
import { t } from "../../i18n";
import { cn } from "../../lib/utils";
import { AgentMarketWorkspace } from "./market/AgentMarketWorkspace";

interface AgentMarketPageProps {
	/** 当前呈现的是不是本页面：失活时保持挂载、只隐藏，切回来搜索/详情/编辑状态不丢。 */
	active: boolean;
	/**
	 * 「使用」= 在该智能体指定的后端新建会话并绑定它（角色设定经隐藏通道注入，时间线只显示用户输入）。
	 * 成功返回 true：本页收起并露出新会话；失败返回 false：页面留在市场，原因由宿主的 toast 承担。
	 */
	onUseAgent: (agent: AgentProfile) => Promise<boolean>;
}

/**
 * 「智能体」页面宿主：会话 Tab 栏里的专属页面 Tab（不是弹窗、也不是会话 Tab）。
 *
 * 页面覆盖会话列（侧栏/抽屉/底部停靠栏保持可交互），打开状态由 workspace-page-atoms 驱动：
 * 切到会话只是失活（子树保持挂载），关闭 Tab 才卸载并复原会话视图；Esc 关闭 Tab。
 */
export function AgentMarketPage({ active, onUseAgent }: AgentMarketPageProps) {
	const open = useAtomValue(agentMarketPageOpenAtom);
	const editingAgentId = useAtomValue(agentMarketEditingAgentIdAtom);
	const close = useSetAtom(closeAgentMarketPageAtom);

	// 只有当前呈现的页面响应 Esc：失活（隐藏）的页面不得抢走会话区的 Esc。
	useEffect(() => {
		if (!open || !active) return;
		const onKeyDown = (event: KeyboardEvent) => {
			// 下拉/模型选择器/确认框等 Radix 弹层自己消费 Escape（它们已 preventDefault），
			// 页面不能把「关掉下拉」抢成「关掉整个页面」。
			if (event.key !== "Escape" || event.defaultPrevented) return;
			close();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [active, close, open]);

	// 关闭后整棵子树卸载（路由/搜索状态随之复位）。
	if (!open) return null;

	return (
		// inset-0 只覆盖会话列：与 HostPluginPageOverlay/定时任务页同一层级约定，页面打开时会话树不卸载。
		<div className={cn("absolute inset-0 z-30 flex flex-col bg-background", !active && "hidden")} role="region" aria-label={t("agentMarket.title")}>
			<AgentMarketWorkspace initialEditingAgentId={editingAgentId} onUseAgent={onUseAgent} onClose={close} />
		</div>
	);
}
