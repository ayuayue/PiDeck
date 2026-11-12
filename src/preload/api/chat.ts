/**
 * preload chat 域：聊天输入面：快捷消息、回复动作、自动化、智能体档案、收藏。
 *
 * 组装口 `src/preload/index.ts` 只做 spread；方法体 / 参数名 / 通道引用与拆分前逐字一致。
 */
import { ipcRenderer } from "electron";
import { ipcChannels } from "../../shared/ipc";
import { subscribe } from "./ipcHelpers";
import type { AutomationChangedEvent, AutomationCronPreview, AutomationRun, AutomationSettings, AutomationSnapshot, AutomationTask, CreateAutomationTaskInput, UpdateAutomationSettingsInput, UpdateAutomationTaskInput } from "../../shared/types";
import type { AgentChangedEvent, AgentInvokeEventPayload, AgentInvokeInput, AgentInvokeResult, AgentMarketSettings, AgentProfile, AgentProfileSnapshot, BindAgentSessionInput, CreateAgentProfileInput, UpdateAgentMarketSettingsInput, UpdateAgentProfileInput } from "../../shared/types/agentProfile";
import type { AddFavoriteInput, FavoriteEntry } from "../../shared/types/favorites";
import type { QuickMessagesSaveResult, QuickMessagesSnapshot } from "../../shared/types/quickMessages";
import type { ReplyActionRule, ReplyActionsSaveResult, ReplyActionsSnapshot } from "../../shared/types/replyActions";

export const chatApi = {

	// ── 快捷消息（独立配置文件 userData/quick-messages.json，可直接编辑） ──
	quickMessages: {
		get: () => ipcRenderer.invoke(ipcChannels.quickMessagesGet) as Promise<QuickMessagesSnapshot>,
		/** 整体保存条目数组（顺序即弹框顺序，空数组 = 清空） */
		save: (items: string[]) => ipcRenderer.invoke(ipcChannels.quickMessagesSave, items) as Promise<QuickMessagesSaveResult>,
		/** 用系统默认程序打开配置文件（路径由主进程解析，文件不存在时会先生成） */
		openFile: () => ipcRenderer.invoke(ipcChannels.quickMessagesOpenFile) as Promise<void>,
	},

	// ── 回复快捷操作（规则文件 userData/reply-actions.json，结构与快捷消息同构） ──
	replyActions: {
		get: () => ipcRenderer.invoke(ipcChannels.replyActionsGet) as Promise<ReplyActionsSnapshot>,
		/** 整体保存规则数组（顺序即展示顺序，空数组 = 清空） */
		save: (items: ReplyActionRule[]) => ipcRenderer.invoke(ipcChannels.replyActionsSave, items) as Promise<ReplyActionsSaveResult>,
		/** 用系统默认程序打开规则文件（路径由主进程解析，文件不存在时会先生成） */
		openFile: () => ipcRenderer.invoke(ipcChannels.replyActionsOpenFile) as Promise<void>,
	},

	// ── 定时任务与自动化 ──
	automation: {
		getSnapshot: () => ipcRenderer.invoke(ipcChannels.automationGetSnapshot) as Promise<AutomationSnapshot>,
		createTask: (input: CreateAutomationTaskInput) => ipcRenderer.invoke(ipcChannels.automationCreateTask, input) as Promise<AutomationTask>,
		updateTask: (taskId: string, patch: UpdateAutomationTaskInput) => ipcRenderer.invoke(ipcChannels.automationUpdateTask, taskId, patch) as Promise<AutomationTask>,
		deleteTask: (taskId: string) => ipcRenderer.invoke(ipcChannels.automationDeleteTask, taskId) as Promise<boolean>,
		runNow: (taskId: string) => ipcRenderer.invoke(ipcChannels.automationRunNow, taskId) as Promise<AutomationRun>,
		abortRun: (runId: string) => ipcRenderer.invoke(ipcChannels.automationAbortRun, runId) as Promise<boolean>,
		deleteRuns: (runIds: string[]) => ipcRenderer.invoke(ipcChannels.automationDeleteRuns, runIds) as Promise<number>,
		clearRuns: () => ipcRenderer.invoke(ipcChannels.automationClearRuns) as Promise<number>,
		updateSettings: (patch: UpdateAutomationSettingsInput) => ipcRenderer.invoke(ipcChannels.automationUpdateSettings, patch) as Promise<AutomationSettings>,
		previewCron: (expression: string, count?: number) => ipcRenderer.invoke(ipcChannels.automationPreviewCron, expression, count) as Promise<AutomationCronPreview>,
		onChanged: (callback: (event: AutomationChangedEvent) => void) => subscribe<AutomationChangedEvent>(ipcChannels.automationChanged, callback),
	},

	// ── 智能体（Agent Market）：配置 CRUD + 一次性调用（划词工具共用同一协议） ──
	agentProfiles: {
		getSnapshot: () => ipcRenderer.invoke(ipcChannels.agentProfilesGetSnapshot) as Promise<AgentProfileSnapshot>,
		create: (input: CreateAgentProfileInput) => ipcRenderer.invoke(ipcChannels.agentProfilesCreate, input) as Promise<AgentProfile>,
		update: (agentId: string, patch: UpdateAgentProfileInput) => ipcRenderer.invoke(ipcChannels.agentProfilesUpdate, agentId, patch) as Promise<AgentProfile>,
		/** 删除自定义智能体；内置智能体返回 false（不抛错，UI 用同一路径提示不可删）。 */
		remove: (agentId: string) => ipcRenderer.invoke(ipcChannels.agentProfilesDelete, agentId) as Promise<boolean>,
		/** 把内置智能体恢复到内置原文（用户改坏了可一键回退）。 */
		resetBuiltin: (agentId: string) => ipcRenderer.invoke(ipcChannels.agentProfilesResetBuiltin, agentId) as Promise<AgentProfile>,
		duplicate: (agentId: string) => ipcRenderer.invoke(ipcChannels.agentProfilesDuplicate, agentId) as Promise<AgentProfile>,
		updateSettings: (patch: UpdateAgentMarketSettingsInput) => ipcRenderer.invoke(ipcChannels.agentProfilesUpdateSettings, patch) as Promise<AgentMarketSettings>,
		onChanged: (callback: (event: AgentChangedEvent) => void) => subscribe<AgentChangedEvent>(ipcChannels.agentProfilesChanged, callback),
		/** 一次性调用：受理后流式事件经 onInvokeEvent 推送（与提示词增强同一协议形态）。 */
		invoke: (input: AgentInvokeInput) => ipcRenderer.invoke(ipcChannels.agentProfilesInvoke, input) as Promise<AgentInvokeResult>,
		cancelInvoke: () => ipcRenderer.invoke(ipcChannels.agentProfilesInvokeCancel) as Promise<{ ok: boolean }>,
		onInvokeEvent: (callback: (payload: AgentInvokeEventPayload) => void) => subscribe<AgentInvokeEventPayload>(ipcChannels.agentProfilesInvokeEvent, callback),
		/** 绑定/解绑会话与智能体：绑定后该会话每次发送由主进程注入隐藏角色设定。 */
		bindSession: (input: BindAgentSessionInput) => ipcRenderer.invoke(ipcChannels.agentProfilesBindSession, input) as Promise<AgentMarketSettings>,
		/** 保存拖拽出的展示顺序（完整 id 数组）；主进程剔除未知 id 后落盘并返回生效的顺序。 */
		reorder: (agentIds: string[]) => ipcRenderer.invoke(ipcChannels.agentProfilesReorder, agentIds) as Promise<string[]>,
	},

	// ── 收藏（整条回复 / 划选片段的本地快照；不写入会话文件） ──
	favorites: {
		list: () => ipcRenderer.invoke(ipcChannels.favoritesList) as Promise<FavoriteEntry[]>,
		add: (input: AddFavoriteInput) => ipcRenderer.invoke(ipcChannels.favoritesAdd, input) as Promise<FavoriteEntry>,
		remove: (favoriteId: string) => ipcRenderer.invoke(ipcChannels.favoritesRemove, favoriteId) as Promise<boolean>,
		/** 批量删除：一次写盘，返回实际删除条数（未知 id 忽略）。 */
		removeMany: (favoriteIds: string[]) => ipcRenderer.invoke(ipcChannels.favoritesRemoveMany, favoriteIds) as Promise<number>,
		/** 保存拖拽出的顺序（完整 id 数组）；返回主进程落地后的列表。 */
		reorder: (favoriteIds: string[]) => ipcRenderer.invoke(ipcChannels.favoritesReorder, favoriteIds) as Promise<FavoriteEntry[]>,
	},
};
