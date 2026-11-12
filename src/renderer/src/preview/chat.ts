import type { PiDesktopApi } from "../../../preload";
import { now, PREVIEW_QUICK_MESSAGES, PREVIEW_REPLY_ACTIONS } from "./fixtures";

/**
 * 对话外壳域桩：快捷消息、回复动作、自动化、智能体档案与收藏。
 */
export function createChatPreview(): Pick<PiDesktopApi, "quickMessages" | "replyActions" | "automation" | "agentProfiles" | "favorites"> {
	return {
		// 快捷消息预览桩：预览模式没有真实配置文件（配置在 userData/quick-messages.json），
		// 用固定夹具让弹框在预览/截图里可用，不假装能读写磁盘。
		quickMessages: {
			get: async () => ({
				items: [...PREVIEW_QUICK_MESSAGES],
				defaults: [...PREVIEW_QUICK_MESSAGES],
				filePath: "(preview)",
				seeded: false,
				defaultsAvailable: false,
			}),
			save: async (items) => ({
				ok: true as const,
				snapshot: { items, defaults: [...PREVIEW_QUICK_MESSAGES], filePath: "(preview)", seeded: false, defaultsAvailable: false },
			}),
			openFile: async () => undefined,
		},
		// 回复快捷操作预览桩：与快捷消息同策略，固定夹具让设置区在预览/截图里可用。
		replyActions: {
			get: async () => ({
				items: PREVIEW_REPLY_ACTIONS.map((rule) => ({ ...rule, triggers: rule.triggers.map((trigger) => ({ ...trigger })) })),
				defaults: [],
				filePath: "(preview)",
				seeded: false,
				defaultsAvailable: false,
			}),
			save: async (items) => ({
				ok: true as const,
				snapshot: { items, defaults: [], filePath: "(preview)", seeded: false, defaultsAvailable: false },
			}),
			openFile: async () => undefined,
		},
		automation: {
			getSnapshot: async () => ({
				revision: 0,
				settings: { maxConcurrentRuns: 1, historyLimit: 200 },
				tasks: [],
				runs: [],
			}),
			createTask: async (input) => ({
				id: "preview-task",
				name: input.name,
				projectId: input.projectId,
				prompt: input.prompt,
				schedule: input.schedule,
				enabled: input.enabled !== false,
				budget: {
					// 预览桩模拟主进程 normalizeBudget 的落盘形态：null/缺省键不输出（=不限），
					// 既不在预览里伪造默认值，也保持与 AutomationTask.budget（无 null）同型。
					...(input.budget?.timeoutMs == null ? {} : { timeoutMs: input.budget.timeoutMs }),
					...(input.budget?.maxTokens == null ? {} : { maxTokens: input.budget.maxTokens }),
					...(input.budget?.maxCostUsd == null ? {} : { maxCostUsd: input.budget.maxCostUsd }),
					...(input.budget?.maxSteps == null ? {} : { maxSteps: input.budget.maxSteps }),
				},
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
			updateTask: async (taskId, patch) => ({
				id: taskId,
				name: patch.name ?? "Updated Task",
				projectId: patch.projectId ?? "preview-project",
				prompt: patch.prompt ?? "",
				schedule: patch.schedule ?? { type: "manual" },
				enabled: patch.enabled !== false,
				budget: { timeoutMs: 30 * 60_000 },
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
			deleteTask: async () => true,
			runNow: async (taskId) => ({
				id: "preview-run",
				taskId,
				taskName: "Preview Task",
				projectId: "preview-project",
				trigger: "manual",
				status: "succeeded",
				queuedAt: Date.now(),
				startedAt: Date.now(),
				endedAt: Date.now(),
				durationMs: 1000,
				updatedAt: Date.now(),
				inputTokens: 100,
				outputTokens: 200,
				costUsd: 0.01,
				stepCount: 2,
				events: [],
			}),
			abortRun: async () => true,
			deleteRuns: async (runIds) => runIds.length,
			clearRuns: async () => 0,
			updateSettings: async (patch) => ({
				maxConcurrentRuns: patch.maxConcurrentRuns ?? 1,
				historyLimit: patch.historyLimit ?? 200,
			}),
			previewCron: async () => ({ valid: true, nextRuns: [] }),
			onChanged: () => () => {},
		},
		// 智能体预览桩：预览模式没有 userData/agent-profiles.json 可读，市场显示空态；
		// 写操作按邻近桩的惯例直接抛错（不伪造成功，避免预览里以为真存了盘）。
		// 一次性调用（划词/市场面板）在预览环境必然失败，返回结构化错误而不是 reject，
		// 让调用面板走正常错误提示路径。
		agentProfiles: {
			getSnapshot: async () => ({
				revision: 0,
				agents: [],
				settings: { selectionToolEnabled: true, systemSelectionEnabled: false, selectionToolAgentId: null, sessionAgentBindings: {} },
				agentOrder: [],
			}),
			create: async () => {
				throw new Error("preview stub");
			},
			update: async () => {
				throw new Error("preview stub");
			},
			remove: async () => {
				throw new Error("preview stub");
			},
			resetBuiltin: async () => {
				throw new Error("preview stub");
			},
			duplicate: async () => {
				throw new Error("preview stub");
			},
			// 设置返回合并结果：预览里开关/下拉要能点，但不产生真实写入。
			updateSettings: async (patch) => ({
				selectionToolEnabled: patch.selectionToolEnabled ?? true,
				systemSelectionEnabled: patch.systemSelectionEnabled ?? false,
				selectionToolAgentId: patch.selectionToolAgentId ?? null,
				sessionAgentBindings: {},
			}),
			/** 会话绑定在预览/Web 端没有落盘位置，返回空绑定表（不报错，避免「使用」路径炸掉）。 */
			bindSession: async () => ({ selectionToolEnabled: true, systemSelectionEnabled: false, selectionToolAgentId: null, sessionAgentBindings: {} }),
			/** 排序在预览里没有落盘位置：原样回显，不报错（市场本身也是空态）。 */
			reorder: async (agentIds) => agentIds,
			onChanged: () => () => {},
			invoke: async () => ({ ok: false as const, errorKind: "spawn-failed" as const, message: "unavailable" }),
			cancelInvoke: async () => ({ ok: false }),
			onInvokeEvent: () => () => {},
		},
		// 收藏：预览/Web 端没有 userData/favorites.json 落盘位置，列表恒空、写入抛错（不伪造成功）。
		favorites: {
			list: async () => [],
			add: async () => {
				throw new Error("preview stub");
			},
			remove: async () => false,
			removeMany: async () => 0,
			// 列表恒空：排序无可命中的条目，与主进程「剔除未知 id」后的结果一致。
			reorder: async () => [],
		},
	};
}
