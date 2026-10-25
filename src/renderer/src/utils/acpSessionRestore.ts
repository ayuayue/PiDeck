/**
 * 未激活 ACP 会话「历史恢复提示」的判定（纯函数，组件薄壳）。
 *
 * 背景：ACP 会话没有本地历史文件——历史存在 agent CLI 侧，只有激活
 * （spawn + session/load 重放）后才能投影进时间线。用户从侧栏点开未激活
 * ACP 会话时，根本看到全空时间线 + 新会话起始页，容易被当成会话丢失 bug。
 * 据此渲染一条恢复提示；激活后（runtime 绑定）或新草稿（无 acpSessionId）不显示。
 *
 * 激活中（runtime 已绑定且 status 仍为 starting）：选中会话即后台预热，
 * 此时提示条切换为「正在恢复」加载态——用户点开会话看到的是加载动画而非
 * 「发送消息后恢复」的静态引导（2027-03 用户反馈：先静态提示、预热完突然
 * 冒出历史，观感像乱跳）。
 */
import type { AcpToolConfig } from "../../../shared/types/acp";

export type AcpRestoreHint = { kind: "restore"; toolName: string; activating?: boolean } | { kind: "tool-missing" };

export function resolveAcpRestoreHint(record: { backend?: string; acpSessionId?: string | null; acpToolId?: string | null } | undefined, runtime: { agentId?: string; status?: string } | undefined, tools: readonly AcpToolConfig[]): AcpRestoreHint | undefined {
	if (!record || record.backend !== "acp") return undefined;
	const hasAgent = Boolean(runtime?.agentId);
	// 激活完成（idle/running/error/closed…非 starting）：历史已重放或激活已终结，
	// 维持原语义不提示；激活进行中继续往下，给出「正在恢复」的加载态。
	// 合成 starting 事件（激活窗口主进程直发，agentId 为空占位）同样算激活中。
	if (hasAgent && runtime?.status !== "starting") return undefined;
	if (!record.acpSessionId) return undefined;
	const tool = record.acpToolId ? tools.find((candidate) => candidate.id === record.acpToolId) : undefined;
	if (!tool) return { kind: "tool-missing" };
	return { kind: "restore", toolName: tool.name, activating: runtime?.status === "starting" };
}
