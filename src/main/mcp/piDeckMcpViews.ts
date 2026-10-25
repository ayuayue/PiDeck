/**
 * 宿主级 MCP 视图的纯投影函数。
 *
 * 两条纪律（与 `docs/pideck-mcp.md` 的「数据与权限边界」一致）：
 * 1. 只做显式允许清单——不做「先整份导出再删敏感字段」，新增设置项默认不可见；
 * 2. 不产生副作用——不跑 `pi list`、不扫扩展目录、不碰网络，只读设置快照、内置清单常量
 *    与调用方已经算好的运行时列表。
 */
import { basename } from "node:path";
import type { AgentProfile } from "../../shared/types/agentProfile";
import type { AutomationRun, AutomationTaskSummary } from "../../shared/types/automation";
import type { PiDeckMcpAgentSummary, PiDeckMcpAutomationRunSummary, PiDeckMcpAutomationTaskDetail, PiDeckMcpAutomationTaskSummary, PiDeckMcpBuiltInExtension, PiDeckMcpExtensionsView, PiDeckMcpRuntimeView, PiDeckMcpSettingsView } from "../../shared/types/piDeckMcp";
import type { AppSettings } from "../../shared/types/settings";
import { BUILT_IN_EXTENSIONS, INTERNAL_BUILT_IN_EXTENSIONS } from "../extensions/builtInExtensions";

/** PiDeck 自身配置摘要。刻意不含路径类字段（customPiPath/gitExecutablePath/dshHomeDir）与凭据类字段（令牌、代理 URL、ACP env）。 */
export function buildPiDeckMcpSettingsView(settings: AppSettings): PiDeckMcpSettingsView {
	return {
		app: { language: settings.language, theme: settings.theme },
		agent: {
			backend: settings.defaultAgentBackend,
			offline: settings.piRpcOffline,
			noExtensions: settings.piRpcNoExtensions,
			noSkills: settings.piRpcNoSkills,
			lastUsedModel: settings.lastUsedModel ?? null,
			favoriteModels: [...settings.favoriteModels],
			showThinking: settings.showThinking,
			autoSessionTitle: settings.autoSessionTitle,
		},
		workspace: {
			gitManagement: settings.enableGitManagement,
			cuaEnabled: settings.cuaEnabled,
			cuaAutoApprove: settings.cuaAutoApprove,
			wslEnabled: settings.wslEnabled,
			wslDistro: settings.wslDistro,
		},
	};
}

/**
 * 内置扩展加载状态 + 用户扩展开关。
 *
 * `builtIn[].enabled` 必须与 `listActiveBuiltInExtensionPaths()` 的注入判定同口径，否则客户端会看到
 * 「已启用但实际没注入」。两处口径（顺序也一致）：内部适配器不受 removed 影响 → 其余成员看 removed。
 * 差异只在于本函数不检查文件是否存在（那是安装完整性，不是配置状态）。
 */
export function buildPiDeckMcpExtensionsView(input: { settings: AppSettings; builtInVersion: string | null }): PiDeckMcpExtensionsView {
	// 与 listActiveBuiltInExtensionPaths 同口径：历史数据里可能存的是完整路径，先 basename 归一化再比对，
	// 否则视图会报「已启用」而实际注入被跳过。
	const normalize = (items: readonly string[]) => new Set(items.map((item) => basename(item.trim())).filter(Boolean));
	const removed = normalize(input.settings.removedBuiltInExtensions);
	const builtIn: PiDeckMcpBuiltInExtension[] = [];
	const names: [string, boolean][] = [...BUILT_IN_EXTENSIONS.map((name): [string, boolean] => [name, false]), ...INTERNAL_BUILT_IN_EXTENSIONS.map((name): [string, boolean] => [name, true])];
	for (const [id, internal] of names) {
		builtIn.push({ id, enabled: internal || !removed.has(id), internal });
	}
	return {
		builtInVersion: input.builtInVersion,
		injectionDisabled: input.settings.piRpcNoExtensions,
		builtIn,
		removedBuiltInExtensions: [...input.settings.removedBuiltInExtensions],
		disabledExtensions: input.settings.disabledExtensions.map((entry) => ({ scope: entry.scope, source: entry.source })),
	};
}

/**
 * 单个智能体的元信息投影。
 *
 * 允许清单之外的字段一律不出去，尤其 **systemPrompt**（用户自写的角色设定）：
 * 客户端按 id 使用即可，角色设定只在主进程内解析；也不带磁盘路径或绑定表。
 * 新增 AgentProfile 字段默认不可见。
 */
export function buildPiDeckMcpAgentSummary(agent: AgentProfile): PiDeckMcpAgentSummary {
	return {
		id: agent.id,
		name: agent.name,
		description: agent.description,
		icon: agent.icon,
		category: agent.category,
		builtin: agent.builtin === true,
		model: agent.model ? { provider: agent.model.provider, modelId: agent.model.modelId } : null,
		backend: agent.backend ?? null,
		usageCount: agent.usageCount,
		lastUsedAt: agent.lastUsedAt ?? null,
		createdAt: agent.createdAt,
		updatedAt: agent.updatedAt,
	};
}

/**
 * 定时任务元信息投影：列表用（不含 prompt，控制响应体积）。
 * 任务属于具体项目，授权由服务层按 projectId 先行校验；这里只做形状收敛。
 */
export function buildPiDeckMcpAutomationTaskSummary(task: AutomationTaskSummary): PiDeckMcpAutomationTaskSummary {
	return {
		id: task.id,
		name: task.name,
		projectId: task.projectId,
		schedule: task.schedule.type === "cron" ? { type: "cron", expression: task.schedule.expression } : { type: "manual" },
		enabled: task.enabled,
		backend: task.backend ?? null,
		model: task.model ? { provider: task.model.provider, modelId: task.model.modelId } : null,
		thinkingLevel: task.thinkingLevel ?? null,
		mode: task.mode ?? null,
		permissionPreset: task.permissionPreset ?? null,
		budget: { ...task.budget },
		createdAt: task.createdAt,
		updatedAt: task.updatedAt,
		lastScheduledAt: task.lastScheduledAt ?? null,
		nextRunAt: task.nextRunAt ?? null,
	};
}

/** 任务详情 = 元信息 + 提示词（项目授权范围内可见）。 */
export function buildPiDeckMcpAutomationTaskDetail(task: AutomationTaskSummary): PiDeckMcpAutomationTaskDetail {
	return { ...buildPiDeckMcpAutomationTaskSummary(task), prompt: task.prompt };
}

/** 运行结果投影：events 明细与堆栈不进 MCP；error 截断到 2000 字符。 */
export function buildPiDeckMcpAutomationRun(run: AutomationRun): PiDeckMcpAutomationRunSummary {
	return {
		id: run.id,
		taskId: run.taskId,
		taskName: run.taskName,
		projectId: run.projectId,
		trigger: run.trigger,
		status: run.status,
		scheduledFor: run.scheduledFor ?? null,
		sessionId: run.sessionId ?? null,
		queuedAt: run.queuedAt,
		startedAt: run.startedAt ?? null,
		endedAt: run.endedAt ?? null,
		durationMs: run.durationMs ?? null,
		inputTokens: run.inputTokens,
		outputTokens: run.outputTokens,
		costUsd: run.costUsd,
		stepCount: run.stepCount,
		changedFiles: run.changedFiles ?? null,
		error: run.error ? run.error.slice(0, 2000) : null,
		skippedReason: run.skippedReason ?? null,
		budgetReason: run.budgetReason ?? null,
	};
}

/** 调用方（服务层）已完成授权过滤；本函数只做形状投影与计数。 */
export function buildPiDeckMcpRuntimeView(input: { runtimes: ReadonlyArray<{ sessionId: string; projectId: string; runtimeGeneration: number; status: string; createdAt: number }>; authorizedProjectCount: number }): PiDeckMcpRuntimeView {
	const runtimes = input.runtimes.map((runtime) => ({
		sessionId: runtime.sessionId,
		projectId: runtime.projectId,
		// 必须给出代次：`sessions_abort` 的 expectedRuntimeGeneration 正是从这里取的，
		// 否则客户端的乐观并发只能靠猜。
		runtimeGeneration: runtime.runtimeGeneration,
		status: runtime.status,
		// 不从 runtime state 推 busy：那是每 agent 一轮 RPC，放在每次只读请求里代价过高。
		// 代价是回答收尾的瞬间可能短暂报 idle，所以它是「值不值得等」的提示而非精确信号。
		busy: runtime.status === "starting" || runtime.status === "running",
		createdAt: runtime.createdAt,
	}));
	return {
		runtimes,
		runningCount: runtimes.length,
		activeProjectCount: new Set(runtimes.map((runtime) => runtime.projectId)).size,
		authorizedProjectCount: input.authorizedProjectCount,
	};
}
