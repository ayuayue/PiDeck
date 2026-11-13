/**
 * preload sessions 域：会话：目录/运行时/导入面与用量统计。
 *
 * 组装口 `src/preload/index.ts` 只做 spread；方法体 / 参数名 / 通道引用与拆分前逐字一致。
 */
import { ipcRenderer } from "electron";
import { ipcChannels } from "../../shared/ipc";
import { subscribe } from "./ipcHelpers";
import type {
	AgentRuntimeState,
	AvailableModel,
	ChatMessage,
	CreateAnonymousSessionInput,
	CreateAnonymousSessionResult,
	CreateSessionDraftInput,
	DshModelDiscoveryInput,
	FetchedModel,
	ImageContent,
	ModelListReport,
	PiCommand,
	ResolveLaunchDefaultsInput,
	ResolvedLaunchDefaults,
	RewindCheckpointPage,
	RewindCheckpointPageParams,
	RewindRestoreResult,
	RewindRestoreScope,
	RuntimePromptTemplate,
	SendSessionPromptInput,
	SendSessionPromptResult,
	SessionBranchTree,
	SessionCommandResult,
	SessionFactsResult,
	SessionOutlineSnapshot,
	SessionRecord,
	SessionRuntimeEvent,
	SessionRuntimeInfo,
	SessionRuntimeModelSelection,
	SessionRuntimeReplacement,
	SessionRuntimeTarget,
	SessionSearchResult,
	SessionSummary,
	SessionTargetedValue,
	SessionUiResponseInput,
	UpdateSessionRecordInput,
} from "../../shared/types";
import type { DshHomeSharingState } from "../../shared/types/dshHome";
import type { DshRunnerNodeInfo, DshRunnerNodeInstallResult } from "../../shared/types/dshRunnerNode";
import type { DshRuntimeInstallProgress, DshRuntimeStatus } from "../../shared/types/dshRuntime";
import type { SessionSharePrepareInput, SessionSharePreview, SessionShareResult } from "../../shared/types/sessionExport";

export const sessionsApi = {
	sessions: {
		list: (projectId?: string) => ipcRenderer.invoke(ipcChannels.sessionsList, projectId) as Promise<SessionSummary[]>,
		/** 跨会话正文搜索（Go sidecar）；null = 不可用（未构建/boot 中/失败），调用方回退标题过滤。 */
		searchContent: (query: string) => ipcRenderer.invoke(ipcChannels.sessionsSearchContent, query) as Promise<SessionSearchResult | null>,
		/** 会话内查找（Ctrl/Cmd+Shift+F）：sessionId = SessionRecord.id，主进程按后端分派（pi 走索引 / DSH 走 host 历史）。 */
		searchInSession: (sessionId: string, query: string) => ipcRenderer.invoke(ipcChannels.sessionsSearchInSession, sessionId, query) as Promise<SessionSearchResult | null>,
		listCatalog: (projectId: string, options?: { scan?: boolean }) => ipcRenderer.invoke(ipcChannels.sessionsCatalogList, projectId, options) as Promise<SessionRecord[]>,
		/** 后台扫描完成推送：目录缓存已合并，监听方应以 scan:false 重新拉取。返回退订函数。 */
		onCatalogRefreshed: (listener: (input: { projectId: string }) => void) => {
			const handler = (_event: unknown, payload: { projectId: string }) => listener(payload);
			ipcRenderer.on(ipcChannels.sessionsCatalogRefreshed, handler);
			return () => {
				ipcRenderer.removeListener(ipcChannels.sessionsCatalogRefreshed, handler);
			};
		},
		createDraft: (input: CreateSessionDraftInput) => ipcRenderer.invoke(ipcChannels.sessionsCatalogCreateDraft, input) as Promise<SessionRecord>,
		/** 按当前 pi 配置解析默认启动偏好（引导页预选展示用，与 createDraft 缺省同源）。 */
		resolveLaunchDefaults: (input: ResolveLaunchDefaultsInput = {}) => ipcRenderer.invoke(ipcChannels.sessionsResolveLaunchDefaults, input) as Promise<ResolvedLaunchDefaults>,
		createAnonymous: (input: CreateAnonymousSessionInput) => ipcRenderer.invoke(ipcChannels.sessionsCreateAnonymous, input) as Promise<CreateAnonymousSessionResult>,
		updateRecord: (sessionId: string, patch: UpdateSessionRecordInput) => ipcRenderer.invoke(ipcChannels.sessionsCatalogUpdate, sessionId, patch) as Promise<SessionRecord>,
		/** DSH host 级模型目录（llm.models），未装配时返回空列表。 */
		listDshModels: () => ipcRenderer.invoke(ipcChannels.dshListModels) as Promise<AvailableModel[]>,
		/** DSH 配置页模型发现：只返回候选，apiKey 仅本次探测使用。 */
		discoverDshModels: (input: DshModelDiscoveryInput) => ipcRenderer.invoke(ipcChannels.dshDiscoverModels, input) as Promise<FetchedModel[]>,
		/** DSH 可配置提供方目录（llm.providers：内置 catalog + 已注册路由）。 */
		listDshProviders: () =>
			ipcRenderer.invoke(ipcChannels.dshListProviders) as Promise<
				Array<{
					provider: string;
					displayName: string;
					active: boolean;
					declared?: boolean;
				}>
			>,
		/** DSH agent 预设目录（agentPreset.list），未装配时返回空列表。 */
		listDshAgentPresets: () =>
			ipcRenderer.invoke(ipcChannels.dshAgentPresets) as Promise<
				Array<{
					id: string;
					isDefault: boolean;
					name?: string;
					description?: string;
					broken?: string;
				}>
			>,
		/** DSH 部署默认模型选择（settings.yaml agent-default-model），未装配/不可读时 undefined。 */
		getDshDefaultModel: () =>
			ipcRenderer.invoke(ipcChannels.dshDefaultModel) as Promise<
				| {
						provider: string;
						model: string;
						reasoningEffort?: string;
				  }
				| undefined
			>,
		/** DSH 配置管理页状态（host 启动状态 + DSH_HOME 目录 + 最近 boot 失败原因 + 共享状态）。 */
		getDshStatus: () =>
			ipcRenderer.invoke(ipcChannels.dshGetStatus) as Promise<{
				started: boolean;
				homeDir: string;
				bootError?: string | null;
				/** 共享/冲突状态（issue #189）；旧主进程未回传时缺省。 */
				sharing?: DshHomeSharingState;
				/** 用户是否手动停止了 host（true 时不会自动启动）；旧主进程未回传时缺省。 */
				manuallyStopped?: boolean;
			}>,
		/** 探测本机 CUI node（DSH 沙箱 runner）。传草稿路径可在保存前预览。 */
		detectDshRunnerNode: (configuredPath?: string) => ipcRenderer.invoke(ipcChannels.dshDetectRunnerNode, configuredPath) as Promise<DshRunnerNodeInfo>,
		/** 打开文件选择框挑 node.exe；取消返回 null。 */
		chooseDshRunnerNode: () => ipcRenderer.invoke(ipcChannels.dshChooseRunnerNode) as Promise<string | null>,
		/** 下载 Node 24 到应用数据目录（不改系统 PATH）。 */
		installDshRunnerNode: () => ipcRenderer.invoke(ipcChannels.dshInstallRunnerNode) as Promise<DshRunnerNodeInstallResult>,
		/**
		 * DSH runtime 安装态（AgentRuntimeProvider 阶段 1）：notInstalled/broken 时
		 * DSH UI 整体降级为安装引导，新建 dsh 会话被拒。
		 */
		getDshRuntimeStatus: () => ipcRenderer.invoke(ipcChannels.dshRuntimeGetStatus) as Promise<DshRuntimeStatus>,
		/** DSH runtime 安装态变更推送（阶段 2 安装/卸载时广播）；返回退订函数。 */
		onDshRuntimeStatusChanged: (callback: (status: DshRuntimeStatus) => void) => subscribe(ipcChannels.dshRuntimeStatusChanged, callback),
		/**
		 * 按需安装 DSH runtime（阶段 2）。进度不在这里返回——下载可能持续数十秒，
		 * 走 onDshRuntimeInstallProgress 推送。
		 */
		installDshRuntime: () =>
			ipcRenderer.invoke(ipcChannels.dshRuntimeInstall) as Promise<{
				ok: boolean;
				error?: string;
			}>,
		/** 从本地导入 runtime 归档（.tgz；主进程弹文件对话框；离线/镜像不可达时的兜底）。 */
		importDshRuntimeFile: () =>
			ipcRenderer.invoke(ipcChannels.dshRuntimeInstallLocal) as Promise<{
				ok: boolean;
				error?: string;
			}>,
		/** 从本地导入「已解压」的 runtime 目录（主进程弹目录对话框；与归档入口分开，见 shared/ipc.ts）。 */
		importDshRuntimeDir: () =>
			ipcRenderer.invoke(ipcChannels.dshRuntimeInstallLocalDir) as Promise<{
				ok: boolean;
				error?: string;
			}>,
		/** 卸载已安装的 runtime。 */
		uninstallDshRuntime: () =>
			ipcRenderer.invoke(ipcChannels.dshRuntimeUninstall) as Promise<{
				ok: boolean;
				error?: string;
			}>,
		/** 安装进度推送（阶段 2）；返回退订函数。 */
		onDshRuntimeInstallProgress: (callback: (progress: DshRuntimeInstallProgress) => void) => subscribe(ipcChannels.dshRuntimeInstallProgress, callback),
		/** DSH settings.describe（脱敏 namespace 视图 + schema）。 */
		describeDshSettings: () =>
			ipcRenderer.invoke(ipcChannels.dshConfigDescribe) as Promise<{
				writable: boolean;
				hasDocument: boolean;
				namespaces: Array<{
					ns: string;
					applies: string;
					revision: number;
					value: unknown;
					base?: unknown;
					user?: unknown;
					secrets: Array<{ path: string[]; set: boolean }>;
					schema: unknown;
				}>;
			}>,
		/** DSH settings.update。 */
		updateDshSettings: (ns: string, patch: Record<string, unknown>, expectedRevision?: number) => ipcRenderer.invoke(ipcChannels.dshConfigUpdate, ns, patch, expectedRevision) as Promise<unknown>,
		/** DSH settings.mutate（路径级操作；删除 provider/字段用 unset op）。 */
		mutateDshSettings: (ns: string, ops: Array<{ op: "set"; path: string[]; value: unknown } | { op: "unset"; path: string[] }>, expectedRevision?: number) => ipcRenderer.invoke(ipcChannels.dshConfigMutate, ns, ops, expectedRevision) as Promise<unknown>,
		/** DSH credentials.describe。 */
		describeDshCredentials: (refs: string[]) =>
			ipcRenderer.invoke(ipcChannels.dshCredentialDescribe, refs) as Promise<
				Record<
					string,
					{
						configured: boolean;
						source?: string;
						writable: boolean;
					}
				>
			>,
		/** DSH credentials.set。 */
		setDshCredential: (ref: string, value: string) => ipcRenderer.invoke(ipcChannels.dshCredentialSet, ref, value) as Promise<void>,
		/** DSH credentials.unset。 */
		unsetDshCredential: (ref: string) => ipcRenderer.invoke(ipcChannels.dshCredentialUnset, ref) as Promise<void>,
		/** DSH 凭证明文读取（渲染层点「眼睛」时按 ref 取一次；无值返回 undefined）。 */
		readDshCredential: (ref: string) => ipcRenderer.invoke(ipcChannels.dshCredentialRead, ref) as Promise<string | undefined>,
		/** DSH settings.openDocument（平台打开配置文档）。 */
		openDshDocument: () => ipcRenderer.invoke(ipcChannels.dshOpenDocument) as Promise<void>,
		/** DSH host 重启（DSH_HOME 切换后立即生效；有活跃 DSH 会话时返回 false）。 */
		restartDshHost: () => ipcRenderer.invoke(ipcChannels.dshRestartHost) as Promise<boolean>,
		/** DSH host 手动停止（停活跃 DSH 会话 + dispose + 持久化停止标记，跨重启不自动启动）。 */
		stopDshHost: () => ipcRenderer.invoke(ipcChannels.dshStopHost) as Promise<boolean>,
		/** DSH host 显式启动（清除手动停止标记并 boot；返回 host 是否就绪）。 */
		startDshHost: () => ipcRenderer.invoke(ipcChannels.dshStartHost) as Promise<boolean>,
		deleteRecord: (sessionId: string) => ipcRenderer.invoke(ipcChannels.sessionsCatalogDelete, sessionId) as Promise<boolean>,
		/** 归档会话（移入 .pideck-archive/ 并从目录移除）；运行中的会话会抛错 */
		archiveRecord: (sessionId: string) => ipcRenderer.invoke(ipcChannels.sessionsCatalogArchive, sessionId) as Promise<boolean>,
		/** 恢复归档会话（移回原路径并重新入目录） */
		unarchiveRecord: (archivedPath: string) => ipcRenderer.invoke(ipcChannels.sessionsCatalogUnarchive, archivedPath) as Promise<boolean>,
		/** 恢复**远端**归档会话（按本机 catalog 会话 id；远端文件由主进程按归档索引移回原位） */
		unarchiveRemoteRecord: (sessionId: string) => ipcRenderer.invoke(ipcChannels.sessionsCatalogUnarchiveRemote, sessionId) as Promise<boolean>,
		/** 列出已归档会话（恢复 UI 用；带归档前原始路径供按项目归属过滤） */
		listArchived: () => ipcRenderer.invoke(ipcChannels.sessionsCatalogListArchived) as Promise<import("../../shared/types").ArchivedPiSession[]>,
		/** 永久删除已归档会话（归档文件移入系统回收站并移出索引；不可恢复） */
		deleteArchivedRecord: (archivedPath: string) => ipcRenderer.invoke(ipcChannels.sessionsCatalogDeleteArchived, archivedPath) as Promise<boolean>,
		/**
		 * 请求永久删除**远端归档会话**的数据（Phase 5）：只传本机 catalog 会话 id，远端路径永不过 IPC。
		 * 返回一次性确认 requestId；真正删除要再调用 answerDeleteArchivedRemoteRecord(approve)。
		 */
		deleteArchivedRemoteRecord: (sessionId: string) => ipcRenderer.invoke(ipcChannels.sessionsCatalogDeleteArchivedRemote, sessionId) as Promise<import("../../shared/types").RemoteArchivedSessionDeleteRequestResult>,
		/** 回答上面的一次性确认；只有 approve 才执行不可恢复的远端删除。 */
		answerDeleteArchivedRemoteRecord: (requestId: string, choice: "approve" | "deny") => ipcRenderer.invoke(ipcChannels.sessionsCatalogAnswerDeleteArchivedRemote, requestId, choice) as Promise<import("../../shared/types").RemoteArchivedSessionDeleteAnswerResult>,
		readRecordMessages: (sessionId: string) => ipcRenderer.invoke(ipcChannels.sessionsCatalogReadMessages, sessionId) as Promise<import("../../shared/types").ChatMessage[]>,
		readRecordMessagePage: (sessionId: string, before?: number, pageSize?: number, options?: { beforeEntryId?: string }) => ipcRenderer.invoke(ipcChannels.sessionsCatalogReadMessagePage, sessionId, before, pageSize, options) as Promise<import("../../shared/types").SessionMessagePage>,
		/** 无 runtime 时直接改 JSONL（编辑）。运行中必须先停 Agent。 */
		editCatalogMessage: (sessionId: string, messageId: string, newText: string, entryId?: string) => ipcRenderer.invoke(ipcChannels.sessionsCatalogEditMessage, sessionId, messageId, newText, entryId) as Promise<SessionCommandResult<void>>,
		/** 原地移除单图：只传快照，main 在文件锁内校验目标；运行中必须先停。 */
		removeCatalogMessageImage: (sessionId: string, messageId: string, imageTarget: import("../../shared/types").SessionMessageImageTarget, entryId?: string) => ipcRenderer.invoke(ipcChannels.sessionsCatalogRemoveMessageImage, sessionId, messageId, imageTarget, entryId) as Promise<SessionCommandResult<void>>,
		/** 无 runtime 时直接改 JSONL（删除）。运行中必须先停 Agent。 */
		deleteCatalogMessage: (sessionId: string, messageId: string, entryId?: string) => ipcRenderer.invoke(ipcChannels.sessionsCatalogDeleteMessage, sessionId, messageId, entryId) as Promise<SessionCommandResult<void>>,
		/** 无 runtime 时截断 JSONL 供重发。运行中必须先停 Agent。 */
		prepareCatalogResend: (sessionId: string, messageId: string, entryId?: string) => ipcRenderer.invoke(ipcChannels.sessionsCatalogPrepareResend, sessionId, messageId, entryId) as Promise<SessionCommandResult<{ text: string; images?: ImageContent[] }>>,
		/** 会话 JSONL 过程事件（session/model/thinking/custom），轨迹复盘用。 */
		readProcessEvents: (sessionId: string) => ipcRenderer.invoke(ipcChannels.sessionsCatalogReadProcessEvents, sessionId) as Promise<SessionFactsResult>,
		readOutline: (sessionId: string, limit?: number) => ipcRenderer.invoke(ipcChannels.sessionsCatalogReadOutline, sessionId, limit) as Promise<SessionOutlineSnapshot>,
		/** DSH 会话轨迹系统提示（request/header 的 EpochHeader.system；非 DSH/无数据返回 undefined）。 */
		/** 按需读取单条消息完整文本（工具结果截断后的「查看完整输出」）。
		 *  sessionId 用于运行期绑定不可用时的历史会话文件回退（_viewer 投影）。 */
		readMessageFullText: (sessionId: string | undefined, agentId: string, messageId: string, entryId?: string) => ipcRenderer.invoke(ipcChannels.sessionsCatalogReadMessageFullText, sessionId, agentId, messageId, entryId) as Promise<{ text: string }>,
		readReferenceMessages: (sessionId: string) => ipcRenderer.invoke(ipcChannels.sessionsCatalogReadReferenceMessages, sessionId) as Promise<Array<{ role: string; content: string; timestamp: number }>>,
		copyRecord: (sessionId: string) =>
			ipcRenderer.invoke(ipcChannels.sessionsCatalogCopy, sessionId) as Promise<{
				cancelled?: boolean;
				targetSessionId?: string;
			}>,
		/** truncated=true 表示只导出了部分历史，UI 必须如实告知。 */
		exportRecordHtml: (sessionId: string) => ipcRenderer.invoke(ipcChannels.sessionsCatalogExportHtml, sessionId) as Promise<{ path: string; truncated?: boolean }>,
		prepareShareExport: (input: SessionSharePrepareInput) => ipcRenderer.invoke(ipcChannels.sessionsSharePrepare, input) as Promise<SessionShareResult<SessionSharePreview>>,
		saveShareExport: (previewId: string) => ipcRenderer.invoke(ipcChannels.sessionsShareSave, previewId) as Promise<SessionShareResult<{ path: string }>>,
		releaseShareExport: (previewId: string) => ipcRenderer.invoke(ipcChannels.sessionsShareRelease, previewId) as Promise<void>,
		/** DSH 会话文件路径推导（右键「复制会话文件路径」；非 DSH/不可推导返回 undefined）。 */
		getDshSessionPath: (sessionId: string) => ipcRenderer.invoke(ipcChannels.sessionsGetDshSessionPath, sessionId) as Promise<string | undefined>,
		/** DSH 会话内容搜索（侧栏搜索框全文搜索；结果含 dshSessionId + snippet）。 */
		searchDshSessions: (query: string) => ipcRenderer.invoke(ipcChannels.sessionsSearchDsh, query) as Promise<Array<{ sessionId: string; snippet: string }>>,
		/** DSH 创建目标（goal.create）。 */
		createDshGoal: (agentId: string, objective: string, maxGoalRounds?: number) => ipcRenderer.invoke(ipcChannels.dshCreateGoal, agentId, objective, maxGoalRounds) as Promise<void>,
		/** DSH 目标操作（pause/resume/complete/clear）。 */
		runDshGoalAction: (agentId: string, action: "pause" | "resume" | "complete" | "clear") => ipcRenderer.invoke(ipcChannels.dshGoalAction, agentId, action) as Promise<void>,
		/** DSH 取消 host 侧排队消息（session/updateQueue remove；幂等：已消费也成功）。 */
		cancelDshQueuedMessage: (agentId: string, itemId: string) => ipcRenderer.invoke(ipcChannels.dshCancelQueuedMessage, agentId, itemId) as Promise<void>,
		/** DSH 子代理列表（subagent.list）。 */
		listDshSubagents: (agentId: string) =>
			ipcRenderer.invoke(ipcChannels.dshListSubagents, agentId) as Promise<
				Array<{
					id: string;
					label?: string;
					activity: "running" | "inactive";
					hasChildren: boolean;
					mode: "one-shot" | "continuable";
					kind: "child" | "diagnostic";
				}>
			>,
		/** DSH 子代理历史（subagent.history 只读 transcript）。 */
		readDshSubagentHistory: (agentId: string, childSessionId: string, beforeSeq?: number, maxMessages?: number) =>
			ipcRenderer.invoke(ipcChannels.dshSubagentHistory, agentId, childSessionId, beforeSeq, maxMessages) as Promise<{ messages: import("../../shared/types").ChatMessage[]; hasMore: boolean; oldestSeq?: number }>,
		/** pi-subagents 扩展子代理列表（record + 子会话回填）。 */
		listSessionSubagents: (sessionId: string) => ipcRenderer.invoke(ipcChannels.sessionsListSubagents, sessionId) as Promise<import("../../shared/types").PiSubagentEntry[]>,
		/** 会话级 todo 快照（pi-deck-todo custom 条目重建，历史会话任务 tab）。 */
		listSessionTodo: (sessionId: string) => ipcRenderer.invoke(ipcChannels.sessionsListSessionTodo, sessionId) as Promise<import("../../shared/types").SessionTodoSnapshot | undefined>,
		/**
		 * 会话级模型目录（按 location 分流）：远端会话由它自己那台远端 pi 回答，
		 * 本机会话与 projects:list-models-report 同源。force = 手动刷新（仅本机分支生效）。
		 * projectId 是可选的兜底：没有真实会话身份的入口（小窗新建/自动化编辑器）用它判远端项目。
		 */
		listModels: (sessionId: string, force?: boolean, projectId?: string) => ipcRenderer.invoke(ipcChannels.sessionsListModels, sessionId, force, projectId) as Promise<import("../../shared/types").ModelListReport>,
		/**
		 * DSH 技能目录（skill.list 只读；/name 斜杠调用，G7）。
		 * 运行中会话传 agentId；草稿会话传 { sessionId }：主进程懒建/复用 host 会话后读取
		 * （不启动 agent），会话启动前也能看到技能列表。
		 */
		listDshSkills: (target: string | { sessionId: string }) => ipcRenderer.invoke(ipcChannels.dshListSkills, target) as Promise<import("../../shared/types").DshSkillView[]>,
		/** DSH 孤儿会话 id 列表（host 有但 catalog 无映射；G3/D11 清理提示用）。 */
		listDshOrphans: () => ipcRenderer.invoke(ipcChannels.dshListOrphans) as Promise<string[]>,
		/** DSH 外部会话清单（dsh-web 等其他工具创建的 host 根会话，跨工具导入用）。 */
		listDshForeignSessions: () =>
			ipcRenderer.invoke(ipcChannels.dshListForeignSessions) as Promise<
				Array<{
					dshSessionId: string;
					title?: string;
					cwd?: string;
					updatedAt?: number;
				}>
			>,
		/** DSH 外部会话导入（把 host 会话映射进 catalog，侧栏可见可加载）。 */
		importDshForeignSession: (dshSessionId: string) => ipcRenderer.invoke(ipcChannels.dshImportForeignSession, dshSessionId) as Promise<import("../../shared/types").SessionRecord>,
		/** DSH 外部会话全量同步（自动发现：catalog 未映射的 host 根会话全部导入）。 */
		syncDshForeignSessions: () => ipcRenderer.invoke(ipcChannels.dshSyncForeignSessions) as Promise<{ imported: number; skipped: number }>,
		/** DSH 归档区会话清单（G14：恢复入口用；目录已移入 .pideck-archive 的 host 会话，含标题）。 */
		listArchivedDshSessions: () => ipcRenderer.invoke(ipcChannels.dshListArchived) as Promise<import("../../shared/types").ArchivedDshSession[]>,
		/** DSH 会话恢复（G14：目录按 manifest 移回 sessions 树并重建 catalog 记录）。 */
		unarchiveDshSession: (dshSessionId: string) => ipcRenderer.invoke(ipcChannels.dshUnarchive, dshSessionId) as Promise<boolean>,
		/** 永久删除已归档 DSH 会话（归档目录移入系统回收站；不可恢复） */
		deleteArchivedDshSession: (dshSessionId: string) => ipcRenderer.invoke(ipcChannels.dshDeleteArchived, dshSessionId) as Promise<boolean>,
		/** DSH 动态插件清单（G13 深化：进程内临时扩展，重启即失；按会话归属）。 */
		listDshDynamicPlugins: () => ipcRenderer.invoke(ipcChannels.dshPluginList) as Promise<import("../../shared/types").DshPluginView[]>,
		/** DSH 静态 Loader 条目清单（origin 标注 user/builtin 来源）。 */
		listDshStaticPlugins: () => ipcRenderer.invoke(ipcChannels.dshPluginStaticList) as Promise<import("../../shared/types").DshStaticPluginView[]>,
		/** DSH 用户自装静态插件卸载（移除用户补丁层行 + 可选回收插件目录；host 重启后生效）。 */
		uninstallDshUserPlugin: (input: import("../../shared/types").DshUserPluginUninstallInput) => ipcRenderer.invoke(ipcChannels.dshPluginUserUninstall, input) as Promise<import("../../shared/types").DshUserPluginUninstallResult>,
		/** DSH 插件市场搜索（官方目录 + npm 双源；单源失败降级 warnings）。 */
		searchDshPluginMarket: (keyword: string) => ipcRenderer.invoke(ipcChannels.dshPluginMarketSearch, keyword) as Promise<import("../../shared/types").DshPluginMarketSearchResult>,
		/** DSH 用户自装静态插件安装（npm pack → 受管目录 → 用户补丁层行；幂等）。 */
		installDshUserPlugin: (spec: string) => ipcRenderer.invoke(ipcChannels.dshPluginUserInstall, { spec }) as Promise<import("../../shared/types").DshUserPluginInstallResult>,
		/** DSH 用户补丁层清单（安装服务视角：受管目录内的行补全包名/版本/uiOnly）。 */
		listDshUserPlugins: () => ipcRenderer.invoke(ipcChannels.dshPluginUserList) as Promise<import("../../shared/types").DshUserPluginListEntry[]>,
		/** DSH 动态插件安装（define：定义源码包，不运行）。 */
		installDshPlugin: (input: import("../../shared/types").DshPluginInstallInput) => ipcRenderer.invoke(ipcChannels.dshPluginInstall, input) as Promise<unknown>,
		/** DSH 动态插件运行（面板手势，无需审批）。 */
		runDshPlugin: (input: import("../../shared/types").DshPluginLifecycleInput) => ipcRenderer.invoke(ipcChannels.dshPluginRun, input) as Promise<unknown>,
		/** DSH 动态插件停止（保留全部包版本）。 */
		stopDshPlugin: (input: import("../../shared/types").DshPluginLifecycleInput) => ipcRenderer.invoke(ipcChannels.dshPluginStop, input) as Promise<unknown>,
		/** DSH 动态插件卸载（undefine：删除插件与全部包版本）。 */
		uninstallDshPlugin: (input: import("../../shared/types").DshPluginLifecycleInput) => ipcRenderer.invoke(ipcChannels.dshPluginUninstall, input) as Promise<unknown>,
		sendPrompt: (input: SendSessionPromptInput) => ipcRenderer.invoke(ipcChannels.sessionsSendPrompt, input) as Promise<SendSessionPromptResult>,
		sendUiResponse: (input: SessionUiResponseInput) => ipcRenderer.invoke(ipcChannels.sessionsUiResponse, input) as Promise<void>,
		onRuntimeEvent: (callback: (event: SessionRuntimeEvent) => void) => subscribe(ipcChannels.sessionsRuntimeEvent, callback),
		listRuntimes: () => ipcRenderer.invoke(ipcChannels.sessionsRuntimeList) as Promise<SessionRuntimeInfo[]>,
		activateRuntime: (sessionId: string) => ipcRenderer.invoke(ipcChannels.sessionsRuntimeActivate, sessionId) as Promise<SessionCommandResult<SessionRuntimeInfo>> /** 汇报当前聚焦的会话（主进程据此决定非聚焦会话的 Ask 桌面通知） */,
		setFocusedSession: (sessionId?: string) => ipcRenderer.invoke(ipcChannels.sessionsSetFocusedSession, sessionId) as Promise<void>,
		/** 汇报主窗口实际挂载的聊天栏（当前 + 分屏）；主进程据此裁剪后台会话的 live 流。 */
		setVisibleSessions: (sessionIds: string[]) => ipcRenderer.invoke(ipcChannels.sessionsSetVisibleSessions, sessionIds) as Promise<void>,
		stopRuntime: (target: SessionRuntimeTarget) => ipcRenderer.invoke(ipcChannels.sessionsRuntimeStop, target) as Promise<SessionCommandResult<SessionRuntimeTarget>>,
		abortRuntime: (target: SessionRuntimeTarget) => ipcRenderer.invoke(ipcChannels.sessionsRuntimeAbort, target) as Promise<SessionCommandResult<SessionTargetedValue<void>>>,
		restartRuntime: (target: SessionRuntimeTarget) => ipcRenderer.invoke(ipcChannels.sessionsRuntimeRestart, target) as Promise<SessionCommandResult<SessionRuntimeReplacement>>,
		compactRuntime: (target: SessionRuntimeTarget, prompt?: string) => ipcRenderer.invoke(ipcChannels.sessionsRuntimeCompact, target, prompt) as Promise<SessionCommandResult<SessionTargetedValue<AgentRuntimeState>>>,
		getRuntimeState: (target: SessionRuntimeTarget) => ipcRenderer.invoke(ipcChannels.sessionsRuntimeState, target) as Promise<SessionCommandResult<SessionTargetedValue<AgentRuntimeState>>>,
		listRuntimeCommands: (target: SessionRuntimeTarget) => ipcRenderer.invoke(ipcChannels.sessionsRuntimeCommands, target) as Promise<SessionCommandResult<SessionTargetedValue<PiCommand[]>>>,
		listRuntimePromptTemplates: (target: SessionRuntimeTarget) => ipcRenderer.invoke(ipcChannels.sessionsRuntimePromptTemplates, target) as Promise<SessionCommandResult<SessionTargetedValue<RuntimePromptTemplate[]>>>,
		/** 热重载 pi 扩展/技能/提示词；返回刷新后的命令表。 */
		reloadResources: (target: SessionRuntimeTarget) => ipcRenderer.invoke(ipcChannels.sessionsRuntimeReloadResources, target) as Promise<SessionCommandResult<SessionTargetedValue<PiCommand[]>>>,
		/** 草稿会话命令预览（pi standby 进程只读查询；不可用/非 pi 返回 null）。 */
		draftCommands: (projectId: string) => ipcRenderer.invoke(ipcChannels.sessionsDraftCommands, projectId) as Promise<PiCommand[] | null>,
		draftPromptTemplates: (projectId: string) => ipcRenderer.invoke(ipcChannels.sessionsDraftPromptTemplates, projectId) as Promise<RuntimePromptTemplate[] | null>,
		/** 运行中 Agent 快照里的模型；不在此列表 = 新加配置，切过去要重启。 */
		listRuntimeModels: (target: SessionRuntimeTarget) => ipcRenderer.invoke(ipcChannels.sessionsRuntimeListModels, target) as Promise<SessionCommandResult<SessionTargetedValue<AvailableModel[]>>>,
		/** Pi 当前模型支持的 thinking levels；旧 Pi/非 Pi 后端返回 undefined，渲染层回退静态列表。 */
		listRuntimeThinkingLevels: (target: SessionRuntimeTarget) => ipcRenderer.invoke(ipcChannels.sessionsRuntimeThinkingLevels, target) as Promise<SessionCommandResult<SessionTargetedValue<string[] | undefined>>>,
		exportRuntimeHtml: (target: SessionRuntimeTarget) => ipcRenderer.invoke(ipcChannels.sessionsRuntimeExportHtml, target) as Promise<SessionCommandResult<SessionTargetedValue<unknown>>>,
		editRuntimeMessage: (target: SessionRuntimeTarget, messageId: string, newText: string) => ipcRenderer.invoke(ipcChannels.sessionsRuntimeEditMessage, target, messageId, newText) as Promise<SessionCommandResult<SessionTargetedValue<void>>>,
		deleteRuntimeMessage: (target: SessionRuntimeTarget, messageId: string) => ipcRenderer.invoke(ipcChannels.sessionsRuntimeDeleteMessage, target, messageId) as Promise<SessionCommandResult<SessionTargetedValue<void>>>,
		listRewindCheckpoints: (target: SessionRuntimeTarget, params?: RewindCheckpointPageParams) => ipcRenderer.invoke(ipcChannels.sessionsRewindList, target, params) as Promise<SessionCommandResult<SessionTargetedValue<RewindCheckpointPage>>>,
		getRewindCheckpointDiff: (target: SessionRuntimeTarget, checkpointId: string) => ipcRenderer.invoke(ipcChannels.sessionsRewindDiff, target, checkpointId) as Promise<SessionCommandResult<SessionTargetedValue<string>>>,
		restoreRewindCheckpoint: (target: SessionRuntimeTarget, checkpointId: string, scope: RewindRestoreScope) => ipcRenderer.invoke(ipcChannels.sessionsRewindRestore, target, checkpointId, scope) as Promise<SessionCommandResult<SessionTargetedValue<RewindRestoreResult>>>,
		/** 会话分支树（只读文件索引；非 pi 后端返回 null）。 */
		getBranchTree: (sessionId: string) => ipcRenderer.invoke(ipcChannels.sessionsGetBranchTree, sessionId) as Promise<SessionBranchTree | null>,
		prepareRuntimeResend: (target: SessionRuntimeTarget, messageId: string) =>
			ipcRenderer.invoke(ipcChannels.sessionsRuntimePrepareResend, target, messageId) as Promise<
				SessionCommandResult<
					SessionTargetedValue<{
						text: string;
						images?: ImageContent[];
					}>
				>
			>,
		setRuntimeModel: (target: SessionRuntimeTarget, provider: string, modelId: string, modelName?: string) => ipcRenderer.invoke(ipcChannels.sessionsRuntimeSetModel, target, provider, modelId, modelName) as Promise<SessionCommandResult<SessionTargetedValue<SessionRuntimeModelSelection>>>,
		setRuntimeThinking: (target: SessionRuntimeTarget, level: string) => ipcRenderer.invoke(ipcChannels.sessionsRuntimeSetThinking, target, level) as Promise<SessionCommandResult<SessionTargetedValue<{ thinkingLevel: string }>>>,
		setRuntimePermission: (target: SessionRuntimeTarget, preset: string) => ipcRenderer.invoke(ipcChannels.sessionsRuntimeSetPermission, target, preset) as Promise<SessionCommandResult<SessionTargetedValue<AgentRuntimeState>>>,
		cloneRuntime: (target: SessionRuntimeTarget) =>
			ipcRenderer.invoke(ipcChannels.sessionsRuntimeClone, target) as Promise<
				SessionCommandResult<{
					cancelled?: boolean;
					targetSessionId?: string;
					[key: string]: unknown;
				}>
			>,
		/** 列出可 fork 的用户消息 entryId，用于 meta.entryId 缺失时的正文回退匹配。 */
		getRuntimeForkMessages: (target: SessionRuntimeTarget) => ipcRenderer.invoke(ipcChannels.sessionsRuntimeGetForkMessages, target) as Promise<SessionCommandResult<SessionTargetedValue<Array<{ entryId: string; text: string }>>>>,
		/** 从指定 entryId fork 新会话（pi /fork），成功后会替换当前 runtime 绑定。
		 *  options.mutationFork：重发/编辑 fork 化重试——子会话继承原标题且旧会话打 supersededBy 从列表隐藏。 */
		forkRuntimeSession: (target: SessionRuntimeTarget, entryId: string, options?: { mutationFork?: boolean; branchMode?: boolean }) =>
			ipcRenderer.invoke(ipcChannels.sessionsRuntimeFork, target, entryId, options) as Promise<
				SessionCommandResult<{
					cancelled?: boolean;
					text?: string;
					targetSessionId?: string;
					[key: string]: unknown;
				}>
			>,
	},
	usageStats: {
		detect: () => ipcRenderer.invoke(ipcChannels.usageStatsDetect) as Promise<import("../../shared/types").UsageStatsDetectResult>,
		refresh: () => ipcRenderer.invoke(ipcChannels.usageStatsRefresh) as Promise<import("../../shared/types").UsageStatsRefreshResult>,
		get: () => ipcRenderer.invoke(ipcChannels.usageStatsGet) as Promise<import("../../shared/types").UsageAggregated>,
	},
};
