import type { PiDesktopApi } from "../../../preload";
import type { SessionRecord } from "../../../shared/types";
import { now, projects, getSessions, noop } from "./fixtures";

/**
 * 会话域桩：会话列表/运行时/用量统计，以及会话分组与会话关联。
 */
export function createSessionsPreview(): Pick<PiDesktopApi, "sessions" | "usageStats" | "sessionGroups" | "linkedSessions"> {
	return {
		sessions: {
			list: async () => getSessions(),
			// 预览模式无 sidecar：null 让调用方回退标题过滤
			searchContent: async () => null,
			// 预览模式无 sidecar：会话内查找不可用（UI 显示不可用态而不是「无匹配」）
			searchInSession: async () => null,
			// 预览模式无 DSH host：空预设目录满足接口契约
			listDshAgentPresets: async () => [],
			getDshDefaultModel: async () => undefined,
			// 预览模式无主进程配置可解析：无启动默认（底栏不预选，不影响其它功能）
			resolveLaunchDefaults: async () => ({}),
			getDshSessionPath: async () => undefined,
			searchDshSessions: async () => [],
			createDshGoal: async () => undefined,
			runDshGoalAction: async () => undefined,
			cancelDshQueuedMessage: async () => undefined,
			listDshSubagents: async () => [],
			readDshSubagentHistory: async () => ({ messages: [], hasMore: false }),
			listSessionSubagents: async () => [],
			listSessionTodo: async () => undefined,
			// 预览 iframe 没有 runtime 也没有本机目录：与真实通道同形状的恒失败报告。
			listModels: async () => ({ models: [], ok: false, reason: "cli-failed" as const, version: null, detail: "", source: "none" as const, at: Date.now() }),
			listDshSkills: async () => [],
			listDshOrphans: async () => [],
			listDshForeignSessions: async () => [],
			importDshForeignSession: async () => {
				throw new Error("preview mode: DSH session import is not available");
			},
			syncDshForeignSessions: async () => ({ imported: 0, skipped: 0 }),
			listArchivedDshSessions: async () => [],
			unarchiveDshSession: async () => true,
			deleteArchivedDshSession: async () => true,
			listDshDynamicPlugins: async () => [],
			listDshStaticPlugins: async () => [],
			uninstallDshUserPlugin: async () => ({ rowRemoved: false, reason: "preview mode" }),
			// 预览模式无主进程 npm/市场链路：搜索与安装拒绝、已装列表为空，满足接口契约
			searchDshPluginMarket: async () => ({ entries: [], warnings: ["preview mode"] }),
			installDshUserPlugin: async () => {
				throw new Error("preview mode: DSH plugin install is not available");
			},
			listDshUserPlugins: async () => [],
			installDshPlugin: async () => undefined,
			runDshPlugin: async () => undefined,
			stopDshPlugin: async () => undefined,
			uninstallDshPlugin: async () => undefined,
			listCatalog: async (projectId, _options?: { scan?: boolean }): Promise<SessionRecord[]> =>
				getSessions().map((session) => ({
					id: `preview-record:${session.id}`,
					projectId,
					title: session.name || "Preview session",
					source: session.source || "pi",
					environment: session.wsl ? "wsl" : "native",
					filePath: session.filePath,
					parentSessionPath: session.parentSessionPath,
					projectPath: session.projectPath,
					preview: session.preview,
					messageCount: session.messageCount,
					status: "active",
					createdAt: session.updatedAt,
					updatedAt: session.updatedAt,
					wsl: session.wsl,
				})),
			// 预览模式无后台扫描推送：返回空退订函数满足接口契约
			onCatalogRefreshed: () => () => undefined,
			createDraft: async (input): Promise<SessionRecord> => ({
				id: `preview-draft:${input.projectId}`,
				projectId: input.projectId,
				title: input.title || "New session",
				source: "pi",
				environment: "native",
				preview: "",
				messageCount: 0,
				status: "draft",
				model: input.model,
				thinkingLevel: input.thinkingLevel,
				createdAt: now,
				updatedAt: now,
			}),
			createAnonymous: async (input) => ({
				session: {
					id: `preview-anonymous:${input.projectId}`,
					projectId: input.projectId,
					title: input.title || "Anonymous chat",
					noSession: true,
					source: "pi",
					environment: "native",
					preview: "",
					messageCount: 0,
					status: "active",
					createdAt: now,
					updatedAt: now,
				},
				runtime: {
					sessionId: `preview-anonymous:${input.projectId}`,
					agentId: "preview-anonymous-agent",
					runtimeGeneration: 1,
					projectId: input.projectId,
					cwd: projects.find((project) => project.id === input.projectId)?.path || "",
					status: "idle",
					createdAt: now,
					noSession: true,
				},
			}),
			updateRecord: async (sessionId, patch): Promise<SessionRecord> => ({
				id: sessionId,
				projectId: projects[0].id,
				title: patch.title || "Preview session",
				source: "pi",
				environment: "native",
				preview: "",
				messageCount: 0,
				status: "draft",
				model: patch.model ?? undefined,
				thinkingLevel: patch.thinkingLevel ?? undefined,
				createdAt: now,
				updatedAt: now,
			}),
			deleteRecord: async () => true,
			archiveRecord: async () => true,
			unarchiveRecord: async () => true,
			unarchiveRemoteRecord: async () => true,
			listArchived: async () => [],
			deleteArchivedRecord: async () => true,
			deleteArchivedRemoteRecord: async () => ({ ok: false as const, code: "REMOTE_FEATURE_DISABLED" }),
			answerDeleteArchivedRemoteRecord: async () => ({ ok: false as const, code: "REMOTE_FEATURE_DISABLED" }),
			copyRecord: async (sessionId) => ({
				cancelled: false,
				targetSessionId: `${sessionId}:copy`,
			}),
			exportRecordHtml: async () => ({ path: "preview-session.html" }),
			prepareShareExport: async () => ({ ok: false as const, error: "SESSION_SHARE_UNSUPPORTED" }),
			saveShareExport: async () => ({ ok: false as const, error: "SESSION_SHARE_UNSUPPORTED" }),
			releaseShareExport: async () => undefined,
			readRecordMessages: async () => [],
			readRecordMessagePage: async () => ({ messages: [], total: 0, nextBefore: null }),
			editCatalogMessage: async () => ({ ok: true as const, value: undefined }),
			removeCatalogMessageImage: async () => ({ ok: false as const, error: { code: "SESSION_COMMAND_FAILED" as const } }),
			deleteCatalogMessage: async () => ({ ok: true as const, value: undefined }),
			prepareCatalogResend: async () => ({ ok: true as const, value: { text: "" } }),
			readProcessEvents: async () => ({ events: [], version: "", coverage: { fromStart: true, chainComplete: true, readComplete: true, eventsTrimmed: false, reason: "unsupported" } }),
			readOutline: async () => ({ entries: [], total: 0, truncated: false }),
			readMessageFullText: async () => ({ text: "" }),
			readReferenceMessages: async () => [
				{ role: "user", content: "Preview user message", timestamp: Date.now() - 60000 },
				{ role: "assistant", content: "Preview assistant response", timestamp: Date.now() - 30000 },
			],
			sendPrompt: async (input) => ({
				accepted: true,
				sessionId: input.sessionId,
				requestId: input.requestId,
				agentId: "preview-agent",
				sessionPath: "C:/Users/preview/.pi/session.jsonl",
				runtimeGeneration: 1,
			}),
			sendUiResponse: async () => undefined,
			onRuntimeEvent: noop,
			listRuntimes: async () => [],
			activateRuntime: async () => ({
				ok: false,
				error: { code: "SESSION_NOT_FOUND", debugDetails: "preview runtime activation is disabled" },
			}),
			stopRuntime: async (target) => ({ ok: true, value: target }),
			abortRuntime: async (target) => ({
				ok: true,
				value: { target, value: undefined },
			}),
			restartRuntime: async (target) => ({
				ok: true,
				value: {
					previousTarget: target,
					runtime: {
						...target,
						projectId: projects[0].id,
						cwd: projects[0].path,
						status: "idle" as const,
						createdAt: now,
					},
					session: {
						id: target.sessionId,
						projectId: projects[0].id,
						title: "Preview session",
						source: "pi" as const,
						environment: "native" as const,
						preview: "",
						messageCount: 0,
						status: "active" as const,
						createdAt: now,
						updatedAt: now,
					},
				},
			}),
			compactRuntime: async (target) => ({
				ok: true,
				value: { target, value: {} },
			}),
			getRuntimeForkMessages: async (target) => ({
				ok: true,
				value: { target, value: [] },
			}),
			forkRuntimeSession: async (target) => ({
				ok: true,
				value: { cancelled: false, text: "", targetSessionId: `${target.sessionId}:fork` },
			}),
			listDshModels: async () => [],
			discoverDshModels: async () => [],
			listDshProviders: async () => [],
			getDshStatus: async () => ({
				started: false,
				homeDir: "",
				bootError: null,
			}),
			detectDshRunnerNode: async () => ({
				source: "not-found",
				executable: "",
				resolvedPath: "",
				version: "",
				error: null,
				compatible: false,
				system: null,
			}),
			chooseDshRunnerNode: async () => null,
			installDshRunnerNode: async () => ({ ok: false, error: "unavailable in preview" }),
			// 预览环境无 DSH 后端：按未安装处理（UI 走安装引导，不裸报错）。
			getDshRuntimeStatus: async () => ({ state: "notInstalled" as const }),
			onDshRuntimeStatusChanged: () => () => {},
			installDshRuntime: async () => ({ ok: false, error: "unavailable in preview" }),
			importDshRuntimeFile: async () => ({ ok: false, error: "unavailable in preview" }),
			importDshRuntimeDir: async () => ({ ok: false, error: "unavailable in preview" }),
			uninstallDshRuntime: async () => ({ ok: false, error: "unavailable in preview" }),
			onDshRuntimeInstallProgress: () => () => {},
			describeDshSettings: async () => ({ writable: false, hasDocument: false, namespaces: [] }),
			updateDshSettings: async () => undefined,
			mutateDshSettings: async () => undefined,
			describeDshCredentials: async () => ({}),
			setDshCredential: async () => undefined,
			unsetDshCredential: async () => undefined,
			readDshCredential: async () => undefined,
			openDshDocument: async () => undefined,
			// 预览模式无 host：stop/start 直接返回成功满足接口契约（UI 不渲染错误）。
			stopDshHost: async () => true,
			startDshHost: async () => true,
			restartDshHost: async () => true,
			setFocusedSession: async () => undefined,
			setVisibleSessions: async () => undefined,
			getRuntimeState: async (target) => ({
				ok: true,
				value: { target, value: {} },
			}),
			listRuntimeCommands: async (target) => ({
				ok: true,
				value: { target, value: [] },
			}),
			// 预览模式没有真实 pi 进程：无运行时模板正文，渲染层退回 prompts:list。
			listRuntimePromptTemplates: async (target) => ({
				ok: true,
				value: { target, value: [] },
			}),
			// 预览模式没有真实 pi 进程，热重载无操作（入口也不会渲染）。
			reloadResources: async (target) => ({
				ok: true,
				value: { target, value: [] },
			}),
			// 预览模式无 standby 池，草稿命令预览回退本地发现。
			draftCommands: async () => null,
			draftPromptTemplates: async () => null,
			listRuntimeModels: async (target) => ({
				ok: true,
				value: { target, value: [] },
			}),
			listRuntimeThinkingLevels: async (target) => ({
				ok: true,
				value: { target, value: undefined },
			}),
			exportRuntimeHtml: async (target) => ({
				ok: true,
				value: { target, value: { path: "preview-session.html" } },
			}),
			editRuntimeMessage: async (target) => ({
				ok: true,
				value: { target, value: undefined },
			}),
			deleteRuntimeMessage: async (target) => ({
				ok: true,
				value: { target, value: undefined },
			}),
			listRewindCheckpoints: async (target) => ({
				ok: true,
				value: { target, value: { items: [], hasMore: false } },
			}),
			// 分支树预览桩：预览环境无会话文件，空态即可。
			getBranchTree: async () => null,
			getRewindCheckpointDiff: async (target) => ({
				ok: true,
				value: { target, value: "" },
			}),
			restoreRewindCheckpoint: async (target) => ({
				ok: true,
				value: { target, value: { filesRestored: true } },
			}),
			prepareRuntimeResend: async (target) => ({
				ok: true,
				value: { target, value: { text: "" } },
			}),
			setRuntimeModel: async (target, provider, modelId, modelName) => ({
				ok: true,
				value: { target, value: { provider, modelId, modelName: modelName?.trim() || modelId } },
			}),
			setRuntimeThinking: async (target, thinkingLevel) => ({
				ok: true,
				value: { target, value: { thinkingLevel } },
			}),
			setRuntimePermission: async (target) => ({
				ok: true,
				value: { target, value: {} },
			}),
			cloneRuntime: async (target) => ({
				ok: true,
				value: { targetSessionId: `${target.sessionId}:copy` },
			}),
		},
		usageStats: {
			detect: async () => ({
				installed: false,
				logPath: null,
				recordCount: null,
				firstRecordAt: null,
				lastRecordAt: null,
			}),
			refresh: async () => ({
				fullRescan: false,
				parsedRecords: 0,
				skippedLines: 0,
			}),
			get: async () => null as unknown as import("../../../shared/types").UsageAggregated,
		},

		// 会话分组：预览/Web 端没有宿主 store，列表恒空、写入抛错（与 favorites 同语义）。
		sessionGroups: {
			list: async () => [],
			save: async () => {
				throw new Error("preview stub");
			},
			delete: async () => false,
			reorder: async () => [],
			onChanged: () => () => {},
		},
		// 关联会话：预览/Web 端没有宿主编排，快照恒空、作答返回失败。
		linkedSessions: {
			snapshot: async () => ({ links: [], proposals: [] }),
			answer: async () => ({ ok: false as const, error: "desktop-only" }),
			archive: async () => false,
			onChanged: () => () => {},
		},
	};
}
