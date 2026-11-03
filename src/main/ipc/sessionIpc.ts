/**
 * Session IPC handlers: session list, catalog, runtime management, importers.
 * Phase 3.7: extracted from src/main/index.ts registerIpc().
 */

import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { dialog, ipcMain, type BrowserWindow, type WebContents } from "electron";
import { agentEventTags, ipcChannels } from "../../shared/ipc";
import { isLocalProject } from "../../shared/projectLocation";
import { resolveProjectWslIdentity } from "../wsl/WslProjectEnvironment";
import { isDshPermissionPreset } from "../../shared/types/agent";
import { isRewindRestoreScope } from "../../shared/types/rewind";
import { canonicalizeSessionPath } from "../../shared/sessionIdentity";
import { createSessionModelPreference } from "../../shared/modelDisplayName";
import { modelThinkingLevelOf } from "../../shared/modelThinkingLevels";
import { readRuntimePromptTemplateBodies } from "../prompts/runtimeTemplateBodies";
import { sessionFileExistsCached } from "../sessions/sessionFileLiveness";
import type { VisibleSessionRegistry } from "../sessions/visibleSessionRegistry";
import { isDshAgentPresetLocked } from "../../shared/dshAgentPresetLock";
import type {
	AvailableModel,
	CreateSessionDraftInput,
	CreateAnonymousSessionInput,
	CreateAnonymousSessionResult,
	UpdateSessionRecordInput,
	SendSessionPromptInput,
	SessionUiResponseInput,
	SessionRuntimeTarget,
	SessionRuntimeInfo,
	SessionRuntimeReplacement,
	SessionRuntimeEvent,
	SessionCommandError,
	SessionCommandResult,
	SendPromptInput,
	SendPromptResult,
	SessionRecord,
	SessionFactsCoverage,
	SessionFactsResult,
	SessionProcessEvent,
	DshModelDiscoveryInput,
	FetchedModel,
	SessionBranchTree,
	SessionMessagePage,
	SessionModelPreference,
	RewindCheckpointPageParams,
	ResolveLaunchDefaultsInput,
	ResolvedLaunchDefaults,
	ArchivedDshSession,
	ArchivedPiSession,
	SessionSearchMatch,
	SessionSearchResult,
} from "../../shared/types";
import { parseSessionProcessEventsFromFile } from "../sessions/sessionProcessEventsFile";
import type { SessionOutlineSnapshot as OutlineSnapshot } from "../../shared/types/outline";
import type { SessionForkCommands } from "../sessions/sessionForkCommands";
import { dshUnavailablePageFor } from "../dsh/dshManualStop";
import { dshRuntimeMissingPageFor } from "../dsh/dshRuntimeMissing";
import { dshSessionModelPatch } from "../dsh/dshSessionModelSync";
import { missingSessionFilePage } from "../sessions/sessionFileMissingPage";
import { isSessionSearchFilePath } from "../sessions/sessionSearchPath";
import { findSessionMatches } from "../sessions/sessionFindMatches";
import { validateNpmSpec } from "../dsh/dshPluginNpmRunner";
import { validateSearchKeyword } from "../dsh/dshPluginMarket";
import { downgradeRunningStartedBefore, downgradeStaleRunning } from "../pi/derivedSubagents";
import { getCachedModelList } from "../pi/modelListCache";
import { resolveLaunchDefaultOptions, isModelInModelsConfig } from "../sessions/launchDefaults";
import { BackgroundScanCoordinator } from "../sessions/BackgroundScanCoordinator";
import { DIRECTORY_IMPORT_MAX_SUMMARIES } from "../sessions/directorySessionImport";
import type { DirectorySessionImporter } from "../sessions/DirectorySessionImporter";
import { REMOTE_SESSION_ARCHIVE_CODES } from "../remote/RemoteSessionArchive";
import type { SshSessionLocator } from "../../shared/projectLocation";
import { REMOTE_SESSION_DELETE_CODES } from "../../shared/sessionDeleteCodes";
import type { RemoteArchivedSessionDeleteAnswerResult, RemoteArchivedSessionDeleteRequestResult } from "../../shared/types";
import { createRemoteArchivedSessionDelete } from "../sessions/RemoteArchivedSessionDelete";
import { registerSessionImageMutationIpc } from "./sessionImageMutationIpc";
import { acpMessagePage } from "../acp/acpMessagePage";
import { composeAgentInstruction } from "../agents/agentPersonaInstruction";

function isDshModelDiscoveryInput(input: unknown): input is DshModelDiscoveryInput {
	if (!isRecord(input) || typeof input.settingsNs !== "string" || !input.settingsNs.trim()) return false;
	return ["provider", "baseURL", "api", "apiKey"].every((key) => {
		const value = input[key];
		return value === undefined || typeof value === "string";
	});
}

function isRecord(input: unknown): input is Record<string, unknown> {
	return typeof input === "object" && input !== null && !Array.isArray(input);
}

/**
 * 本机归档索引里的一条**远端归档**→ 列表行（`ArchivedPiSession`）。
 *
 * 为什么 `filePath` 留空而不填远端路径：本机字段里不该出现远端路径（读侧同样把 ssh 记录的 `filePath` 清空），
 * 而渲染层的本机归档行会把 `summary.filePath` 当成「要移回哪里」——填了远端路径就是一条点下去会失败的死行。
 * 远端恢复身份走 `archivedRemoteSessionId`（本机 catalog 会话 id）。
 */
function remoteArchivedRow(entry: ArchivedRemoteSessionEntry): ArchivedPiSession {
	return {
		summary: {
			id: entry.sessionId,
			filePath: "",
			name: entry.title,
			preview: "",
			updatedAt: entry.updatedAt,
			messageCount: 0,
			projectId: entry.projectId,
		},
		archivedRemoteSessionId: entry.sessionId,
	};
}

function parseSessionId(value: unknown): string {
	if (typeof value !== "string" || !value.trim() || value.length > 256) throw new Error("INVALID_SESSION_ID");
	return value;
}

function parseSessionPageCursor(value: unknown): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("INVALID_SESSION_PAGE_CURSOR");
	return value;
}

function parseSessionPageSize(value: unknown): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 1000) throw new Error("INVALID_SESSION_PAGE_SIZE");
	return value;
}

function parseSessionPageOptions(value: unknown): { beforeEntryId?: string } | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value) || Object.keys(value).some((key) => key !== "beforeEntryId")) throw new Error("INVALID_SESSION_PAGE_OPTIONS");
	if (value.beforeEntryId === undefined) return {};
	if (typeof value.beforeEntryId !== "string" || !value.beforeEntryId.trim() || value.beforeEntryId.length > 256) throw new Error("INVALID_SESSION_PAGE_OPTIONS");
	return { beforeEntryId: value.beforeEntryId };
}

/** Normalize untrusted model input before it reaches the persisted catalog. */
function normalizeSessionModelPreference(input: unknown): SessionModelPreference | undefined {
	if (!isRecord(input) || typeof input.provider !== "string" || typeof input.modelId !== "string" || (input.modelName !== undefined && typeof input.modelName !== "string")) return undefined;
	const provider = input.provider.trim();
	const modelId = input.modelId.trim();
	if (!provider || !modelId || provider.length > 128 || modelId.length > 256 || (typeof input.modelName === "string" && input.modelName.length > 256)) return undefined;
	return createSessionModelPreference(provider, modelId, input.modelName);
}
/**
 * 已扫描过项目的集合（模块级）：决定 catalogList 走「首次同步扫描」还是
 * 「缓存先回显 + 后台扫描推送」。进程生命周期内单调增长，无需清理。
 */
const scannedProjects = new Set<string>();

/** 后台目录扫描协调器：同项目触发去重 + 冷却合并（3 秒轮询不会演变成并发重扫）。 */
const catalogScanCoordinator = new BackgroundScanCoordinator(5000);

/**
 * 供主进程装配层（启动预扫描）触发的后台扫描调度入口。
 * 标记项目为已扫描，保证预热后首次展开项目走缓存回显路径。
 */
export function scheduleCatalogBackgroundScan(projectId: string, task: () => Promise<void>): boolean {
	scannedProjects.add(projectId);
	return catalogScanCoordinator.schedule(projectId, task);
}
import type { ProjectStore } from "../projects/ProjectStore";
import type { SettingsStore } from "../settings/SettingsStore";
import type { SessionScanner } from "../sessions/SessionScanner";
import type { SessionCatalog, ArchivedRemoteSessionEntry, SessionCatalogEntry } from "../sessions/SessionCatalog";
import type { SessionRuntimeCoordinator } from "../sessions/SessionRuntimeCoordinator";
import { SessionCommandIpcError } from "../sessions/SessionCommandIpcError";
import { appendSessionForkSuffix } from "../sessions/sessionForkTitle";
import type { AgentManager } from "../pi/AgentManager";
import type { ConfigManager } from "../config/ConfigManager";
import type { TerminalSessionManager } from "../terminal/TerminalSessionManager";
import type { CodexSessionImporter } from "../sessions/CodexSessionImporter";
import type { ClaudeSessionImporter } from "../sessions/ClaudeSessionImporter";
import type { QoderSessionImporter } from "../sessions/QoderSessionImporter";
import type { OpenCodeSessionImporter } from "../sessions/OpenCodeSessionImporter";
import type { ZCodeSessionImporter } from "../sessions/ZCodeSessionImporter";
import type { WorkBuddySessionImporter } from "../sessions/codebuddyFamilySessionImporter";
import type { CodeBuddySessionImporter } from "../sessions/codebuddyFamilySessionImporter";
import type { CursorSessionImporter } from "../sessions/CursorSessionImporter";
import type { KimiSessionImporter } from "../sessions/KimiSessionImporter";
import type { KimiWorkSessionImporter } from "../sessions/KimiWorkSessionImporter";
import type { MinimaxSessionImporter } from "../sessions/MinimaxSessionImporter";
import type { AppLogger } from "../logging/AppLogger";
import { REMOTE_SESSION_EXPORT_CODES } from "../remote/RemoteSessionHtmlExport";

/**
 * DSH 后端专用 IPC 依赖（C1 分组）：按后端收敛可选注入，为「后端注册表」铺路——
 * 未来新增后端时各自提供一份 BackendIpcDeps，装配层按 backendId 查注册表注入，
 * 而不是在 SessionIpcDeps 上继续堆可选字段。未装配（dshBackend undefined）= 无 DSH
 * 后端，相关通道降级返回空/错误。
 */
export type DshBackendIpcDeps = {
	/** DSH host 级模型目录；未装配时返回空列表。 */
	listDshModels?: () => Promise<import("../../shared/types").AvailableModel[]>;
	/** DSH 配置页模型发现（llm.discoverModels；只返回候选，不写配置）。 */
	discoverDshModels?: (input: DshModelDiscoveryInput) => Promise<FetchedModel[]>;
	/** DSH 可配置提供方目录（内置 catalog + 已注册路由）；未装配时返回空列表。 */
	listDshProviders?: () => Promise<
		Array<{
			provider: string;
			displayName: string;
			active: boolean;
			declared?: boolean;
		}>
	>;
	/** DSH agent 预设目录（agentPreset.list）；未装配时返回空列表。 */
	listDshAgentPresets?: () => Promise<
		Array<{
			id: string;
			isDefault: boolean;
			name?: string;
			description?: string;
			broken?: string;
		}>
	>;
	/** DSH 部署默认模型选择（settings.yaml agent-default-model）；未装配/不可读时 undefined。 */
	getDshDefaultModel?: () => Promise<
		| {
				provider: string;
				model: string;
				reasoningEffort?: string;
		  }
		| undefined
	>;
	/** DSH 配置管理页状态；未装配时返回空状态。 */
	getDshStatus?: () => Promise<{
		started: boolean;
		homeDir: string;
		/** 最近一次 host boot 失败的真实原因；无失败/未启动为 null。 */
		bootError?: string | null;
		/** DSH_HOME 共享/冲突状态（issue #189：与 dsh CLI 共用目录会互相覆盖状态）。 */
		sharing?: import("../../shared/types/dshHome").DshHomeSharingState;
	}>;
	/**
	 * DSH runtime 安装态（AgentRuntimeProvider 阶段 1）：installed/notInstalled/broken。
	 * 未装配 = 无 DSH 后端，按 notInstalled 处理（UI 走安装引导，新建 dsh 会话被拒）。
	 */
	getDshRuntimeStatus?: () => import("../../shared/types/dshRuntime").DshRuntimeStatus;
	/** DSH runtime 是否允许新建 dsh 会话（门控判定收敛在这里，避免各 handler 比对枚举）。 */
	canCreateDshSession?: () => boolean;
	/** 按需安装 DSH runtime（按下载源索引挑兼容版本）；进度经 dsh-runtime:install-progress 推送。 */
	installDshRuntime?: () => Promise<{ ok: boolean; error?: string }>;
	/** 从本地导入 runtime（.tgz 归档或已解压目录；离线兜底）；文件路径由主进程对话框给出。 */
	importDshRuntime?: (filePath: string) => Promise<{ ok: boolean; error?: string }>;
	/** 卸载当前启用的 runtime（先停 host 释放文件锁，故为异步）。 */
	uninstallDshRuntime?: () => Promise<{ ok: boolean; error?: string }>;
	/** DSH settings.describe（脱敏 namespace 视图 + schema）。 */
	describeDshSettings?: () => Promise<{
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
	}>;
	/** DSH settings.update。 */
	updateDshSettings?: (ns: string, patch: Record<string, unknown>, expectedRevision?: number) => Promise<unknown>;
	/** DSH settings.mutate（路径级操作；删除 provider/字段用 unset op）。 */
	mutateDshSettings?: (ns: string, ops: Array<{ op: "set"; path: string[]; value: unknown } | { op: "unset"; path: string[] }>, expectedRevision?: number) => Promise<unknown>;
	/** DSH credentials.describe。 */
	describeDshCredentials?: (refs: string[]) => Promise<
		Record<
			string,
			{
				configured: boolean;
				source?: string;
				writable: boolean;
			}
		>
	>;
	/** DSH credentials.set。 */
	setDshCredential?: (ref: string, value: string) => Promise<void>;
	/** DSH credentials.unset。 */
	unsetDshCredential?: (ref: string) => Promise<void>;
	/** DSH 凭证明文读取（渲染层点「眼睛」时按 ref 取一次；无值返回 undefined）。 */
	readDshCredential?: (ref: string) => Promise<string | undefined>;
	/** DSH settings.openDocument（平台打开配置文档）。 */
	openDshDocument?: () => Promise<void>;
	/** DSH host 重启；返回 false 表示有活跃 DSH 会话被拒绝。 */
	restartDshHost?: () => Promise<boolean>;
	/**
	 * DSH host 手动停止：停活跃 DSH 会话 + dispose host + 持久化手动停止标记。
	 * 返回 stopAll/dispose 是否顺利完成（false 时标记仍会写入，保证「停止后不再自动启动」语义优先）。
	 */
	stopDshHost?: () => Promise<boolean>;
	/** DSH host 显式启动：清除手动停止标记并 boot；返回 host 是否就绪。 */
	startDshHost?: () => Promise<boolean>;
	/**
	 * DSH 历史分页（session.history 事件流翻页）；未装配时返回空页。
	 * 第三个参数二选一：`turnCount` = 渲染层契约的轮数（首屏 9 / 加载更多 3，由 main 侧
	 * 按 24 条/轮换算成 host 的消息预算）；`maxMessages` = 显式消息窗口（Web/工具结果回读）。
	 */
	readDshHistoryPage?: (dshSessionId: string, beforeSeq: number | undefined, options: { turnCount?: number; maxMessages?: number }) => Promise<{ messages: import("../../shared/types").ChatMessage[]; total: number; nextBefore: number | null }>;
	/**
	 * DSH 会话 host 投影里的当前模型选择（session/projections 的 modelSelection.next ?? lastUsed）。
	 * 冷读、不激活会话；未装配 / host 未就绪 / 会话无选择时 undefined。
	 * 用途：打开历史会话读历史时把 host 真值补录回 catalog（底栏模型显示，见 dshSessionModelSync）。
	 */
	readDshSessionModel?: (dshSessionId: string) => Promise<{ provider: string; model: string; reasoningEffort?: string } | undefined>;
	/**
	 * ACP 会话消息回读（异步读口）：运行时投影 → 内存快照 → deck 侧归档（userData/acp-sessions）
	 * 逐级回退；未装配时返回空数组。归档读失败内部降级为空，永不抛。
	 */
	readAcpMessages?: (acpSessionId: string) => Promise<import("../../shared/types").ChatMessage[]>;
	/** DSH 轨迹过程事件（运行时会话按 mux/重放收集；历史会话从 host history 推导；未装配时返回空数组）。 */
	readDshProcessEvents?: (agentId: string | undefined, dshSessionId: string | undefined) => Promise<{ events: import("../../shared/types/trajectory").SessionProcessEvent[]; fromStart: boolean; unavailable?: boolean }>;
	/** pi 轨迹事实（索引候选 + 小批读取 + 内容版本缓存）；缺省时回退旧的全文件扫描。 */
	readSessionFacts?: (sessionPath: string) => Promise<import("../../shared/types/trajectory").SessionFactsResult>;
	/** 用户检查点目录（导轨）：pi 索引派生；缺省返回空目录。 */
	readSessionOutline?: (sessionPath: string, limit?: number) => Promise<import("../../shared/types/outline").SessionOutlineSnapshot>;
	/** DSH 轨迹系统提示（运行时会话读投影缓存；历史会话从 host history 折叠 request/header；未装配返回 undefined）。 */
	/** DSH 「查看完整输出」（工具结果全文随投影消息存 meta.fullText）；未装配时抛错。 */
	readDshMessageFullText?: (agentId: string, messageId: string) => Promise<{ text: string }>;
	/** DSH 会话文件路径推导（按 catalog entry 的 dshSessionId + cwd）；未装配/不可推导返回 undefined。 */
	resolveDshSessionFilePath?: (sessionId: string) => Promise<string | undefined>;
	/** DSH 会话内容搜索（session.search）；未装配时返回空列表。 */
	searchDshSessions?: (query: string) => Promise<Array<{ sessionId: string; snippet: string }>>;
	/**
	 * DSH 会话内查找（Ctrl/Cmd+Shift+F）：把整段 host 会话历史投影成消息后匹配。
	 * 未装配 / host 不可用时由调用方降级为 null（渲染层显示「暂时读不到」）。
	 */
	searchDshSessionMessages?: (dshSessionId: string, query: string) => Promise<{ matches: SessionSearchMatch[]; hitCount: number }>;
	/** DSH 创建目标（G5）；未装配时抛错。 */
	createDshGoal?: (agentId: string, objective: string, maxGoalRounds?: number) => Promise<void>;
	/** DSH 目标操作（G5：pause/resume/complete/clear）；未装配时抛错。 */
	runDshGoalAction?: (agentId: string, action: "pause" | "resume" | "complete" | "clear") => Promise<void>;
	/** DSH 取消 host 侧排队消息（session/updateQueue remove）；未装配时抛错。 */
	cancelDshQueuedMessage?: (agentId: string, itemId: string) => Promise<void>;
	/** DSH 子代理列表（G6）；未装配时返回空列表。 */
	listDshSubagents?: (agentId: string) => Promise<
		Array<{
			id: string;
			label?: string;
			activity: "running" | "inactive";
			hasChildren: boolean;
			mode: "one-shot" | "continuable";
			kind: "child" | "diagnostic";
		}>
	>;
	/** DSH 子代理历史（G6）；未装配时返回空页。 */
	readDshSubagentHistory?: (agentId: string, childSessionId: string, beforeSeq?: number, maxMessages?: number) => Promise<{ messages: import("../../shared/types").ChatMessage[]; hasMore: boolean }>;
	/** DSH 技能目录（G7：skill.list 只读）；未装配时返回空列表。 */
	listDshSkills?: (agentId: string) => Promise<import("../../shared/types").DshSkillView[]>;
	/**
	 * DSH 草稿会话的技能目录：按 deck sessionId 懒建/复用 host 会话后读 skill.list
	 * （不启动 agent）；未装配时返回空列表。
	 */
	listDshSessionSkills?: (deckSessionId: string) => Promise<import("../../shared/types").DshSkillView[]>;
	/** DSH 孤儿会话 id 列表（G3/D11：host 有但 catalog 无映射）；未装配时返回空列表。 */
	listDshOrphans?: () => Promise<string[]>;
	/** DSH 外部会话清单（dsh-web 等其他工具创建的 host 根会话）；未装配时返回空列表。 */
	listDshForeignSessions?: () => Promise<
		Array<{
			dshSessionId: string;
			title?: string;
			cwd?: string;
			updatedAt?: number;
		}>
	>;
	/** DSH 外部会话导入：按 host 会话 id 映射进 catalog（返回新 SessionRecord）。 */
	importDshForeignSession?: (dshSessionId: string) => Promise<import("../../shared/types").SessionRecord>;
	/** DSH 外部会话全量同步（磁盘扫描：catalog 未映射的根会话全部导入）；未装配时返回空统计。 */
	syncDshForeignSessions?: () => Promise<{ imported: number; skipped: number }>;
	/** DSH 会话归档（G14：host 目录移入 .pideck-archive + manifest，title 随归档写入）；未装配时抛错。 */
	archiveDshSession?: (dshSessionId: string, cwd: string, title?: string) => Promise<string | undefined>;
	/** DSH 会话恢复（G14：目录按 manifest 移回 sessions 树，返回恢复路径、原 cwd 与标题）；未装配时抛错。 */
	unarchiveDshSession?: (dshSessionId: string) => Promise<{ restoredPath: string; cwd: string; title?: string } | undefined>;
	/** DSH 归档区会话清单（G14：恢复入口用；含标题，旧归档由日志折叠补全）；未装配时返回空列表。 */
	/** 2027-02 起为异步实现（归档标题折叠按目录让出，避免主进程整段阻塞）。 */
	listArchivedDshSessions?: () => Array<ArchivedDshSession> | Promise<Array<ArchivedDshSession>>;
	/** DSH 永久删除已归档会话（G14：归档目录移入系统回收站）；未装配时抛错。 */
	deleteArchivedDshSession?: (dshSessionId: string) => Promise<boolean>;
	/** DSH 动态插件清单（G13 深化）；未装配时返回空列表。 */
	listDshDynamicPlugins?: () => Promise<import("../../shared/types").DshPluginView[]>;
	/** DSH 静态 Loader 条目清单（origin 标注 user/builtin 来源）；未装配时返回空列表。 */
	listDshStaticPlugins?: () => Promise<import("../../shared/types").DshStaticPluginView[]>;
	/** DSH 用户自装静态插件卸载（移除用户补丁层行 + 可选回收插件目录）；未装配时抛错。 */
	uninstallDshUserPlugin?: (input: import("../../shared/types").DshUserPluginUninstallInput) => Promise<import("../../shared/types").DshUserPluginUninstallResult>;
	/** DSH 插件市场搜索（官方目录 + npm 双源）；未装配时抛错。 */
	searchDshPluginMarket?: (keyword: string) => Promise<import("../../shared/types").DshPluginMarketSearchResult>;
	/** DSH 用户自装静态插件安装（npm pack → 受管目录 → 用户补丁层行；幂等）；未装配时抛错。 */
	installDshUserPlugin?: (spec: string) => Promise<import("../../shared/types").DshUserPluginInstallResult>;
	/** DSH 用户补丁层清单（安装服务视角）；未装配时返回空列表。 */
	listDshUserPlugins?: () => Promise<import("../../shared/types").DshUserPluginListEntry[]>;
	/** DSH 动态插件安装（define）；未装配时抛错。 */
	installDshPlugin?: (input: import("../../shared/types").DshPluginInstallInput) => Promise<unknown>;
	/** DSH 动态插件运行（面板手势）；未装配时抛错。 */
	runDshPlugin?: (input: import("../../shared/types").DshPluginLifecycleInput) => Promise<unknown>;
	/** DSH 动态插件停止；未装配时抛错。 */
	stopDshPlugin?: (input: import("../../shared/types").DshPluginLifecycleInput) => Promise<unknown>;
	/** DSH 动态插件卸载（undefine）；未装配时抛错。 */
	uninstallDshPlugin?: (input: import("../../shared/types").DshPluginLifecycleInput) => Promise<unknown>;
	/** 判断 agentId 是否属于 DSH 后端（fork 等 pi 专属命令按 backend 分流）。 */
	isDshAgent: (agentId: string) => boolean;
};

export type SessionIpcDeps = {
	projectStore: ProjectStore;
	settingsStore: SettingsStore;
	sessionScanner: SessionScanner;
	/** 第 14 步：按项目 WSL 档案解析独立 scanner（多发行版并存）；未装配时退回本机 scanner。 */
	resolveWslSessionScanner?: (identity: { distro: string; user: string }) => Promise<SessionScanner>;
	sessionCatalog: SessionCatalog;
	sessionRuntimeCoordinator: SessionRuntimeCoordinator;
	agentManager: AgentManager;
	configManager: ConfigManager;
	codexSessionImporter: CodexSessionImporter;
	claudeSessionImporter: ClaudeSessionImporter;
	qoderSessionImporter: QoderSessionImporter;
	openCodeSessionImporter: OpenCodeSessionImporter;
	zcodeSessionImporter: ZCodeSessionImporter;
	workbuddySessionImporter: WorkBuddySessionImporter;
	/** CodeBuddy（腾讯 CodeBuddy Code CLI）会话导入：~/.codebuddy/projects，与 WorkBuddy 同一套源格式。 */
	codebuddySessionImporter: CodeBuddySessionImporter;
	cursorSessionImporter: CursorSessionImporter;
	kimiSessionImporter: KimiSessionImporter;
	/** Kimi Work（桌面版）会话导入：daimon-share 位置可被用户自定义，scan/import 内部走探测链。 */
	kimiWorkSessionImporter: KimiWorkSessionImporter;
	/** MinimaxCode（CLI）会话导入：数据目录固定 ~/.minimax/v2/sessions，无探测链。 */
	minimaxSessionImporter: MinimaxSessionImporter;
	/** 外置目录会话导入（项目目录移动/改名后找回历史；只建 catalog 引用，不复制原文件）。 */
	directorySessionImporter: DirectorySessionImporter;
	appLogger: AppLogger;
	terminalManager: TerminalSessionManager;
	mainCopy: (key: string, params?: Record<string, string | number>) => string;
	getMainWindow: () => BrowserWindow | null;
	/** 主窗口可见会话登记（live 流裁剪，见 visibleSessionRegistry.ts）。 */
	visibleSessions: VisibleSessionRegistry;
	/** 可见性补帧：按 agentId 路由到对应后端（pi / dsh）的 live 通道。 */
	emitLiveSnapshot: (agentId: string) => void;
	emitSessionRuntimeEvent: (agentId: string, channel: string, payload: unknown) => boolean;
	emitSessionRuntimeDetach: (target: SessionRuntimeTarget) => void;
	/** 激活窗口的 session 级合成 starting 事件（bind 前 emitSessionRuntimeEvent 会丢弃一切状态，见 index.ts 实现注释）。 */
	emitSessionActivating?: (sessionId: string) => void;
	/** 激活失败的 session 级合成 error 事件：无绑定时失败终态同样被丢弃，不补发则加载态永挂。 */
	emitSessionActivationFailed?: (sessionId: string) => void;
	/** 激活被作废（换后端/换工具）的 session 级合成 detach：抵消合成 starting，否则侧栏永远停在「启动中」。 */
	emitSessionActivationCancelled?: (sessionId: string) => void;
	createAnonymousSession: (input: CreateAnonymousSessionInput) => Promise<CreateAnonymousSessionResult>;
	stopSessionRuntime: (target: SessionRuntimeTarget) => void;
	emitReplacementState: (runtime: SessionRuntimeInfo, includeMessages: boolean) => void;
	readCatalogSessionReferenceMessages: (sessionId: string) => Promise<unknown[]>;
	/**
	 * 无 pi 会话文件的会话（纯生图草稿）历史读取：回退 ImageSession 独立存储。
	 * 未装配（单测/无生图域）时 undefined；调用处 `?? []` 兜底空页。
	 */
	readImageSessionMessages?: (sessionId: string) => Promise<import("../../shared/types").ChatMessage[]>;
	/**
	 * 远端会话历史分页（ssh locator 记录）。未装配 = 远端历史读不了，按稳定码拒绝，
	 * **绝不**落回本机/生图那条「没有会话文件」的分支——那条分支会把远端历史读成一个空页，
	 * 再被渲染层 force 写进缓存（重启后点开远端会话看不到历史）。
	 */
	readRemoteSessionHistoryPage?: (input: { hostId: string; locator: import("../../shared/projectLocation").SshSessionLocator; before?: number }) => Promise<import("../../shared/types").SessionMessagePage>;
	copyCatalogSession: (sessionId: string) => Promise<{ cancelled: boolean; targetSessionId?: string }>;
	exportCatalogSessionHtml: (sessionId: string) => Promise<Record<string, unknown> & { path: string }>;
	/**
	 * 远端会话（ssh locator）HTML 导出：远端有界分页读 + 本机写文件，渲染复用同一套投影式导出渲染器。
	 * 未装配（远端实验开关关闭 / 旧装配）= 抛稳定码 `REMOTE_SESSION_EXPORT_UNAVAILABLE`，
	 * **绝不**回退成本机导出。
	 */
	exportRemoteCatalogSessionHtml?: (sessionId: string) => Promise<Record<string, unknown> & { path: string }>;
	/**
	 * 远端会话归档（P4.5b）：把远端文件 `mv` 进同目录旁的 `.pideck-archive/`，返回移动前后的远端绝对路径。
	 * 未装配（远端实验开关关掉 / 旧装配）时远端分支给 `REMOTE_SESSION_ARCHIVE_UNAVAILABLE`，
	 * **绝不**落回本机路径分支（那对 ssh locator 抛稳定码，会让一次可完成的归档整体失败）。
	 */
	archiveRemoteSession?: (input: { hostId: string; locator: SshSessionLocator }) => Promise<{ originalPath: string; archivedPath: string }>;
	/**
	 * 远端会话取消归档（P4.5b）：按本机归档索引记下的两个绝对路径把远端文件移回原位。
	 * 入参是本机 catalog 会话 id → 索引条目的路径，不是“本机归档路径”（远端没有这种路径）。
	 */
	unarchiveRemoteSession?: (input: { hostId: string; originalPath: string; archivedPath: string }) => Promise<void>;
	/**
	 * 远端归档会话**永久删除**（Phase 5）：删除归档区里的那一个 JSONL 文件（有界 Node rm + canonical
	 * containment 复核）。入参只来自本机归档索引（绝不由渲染层提供远端路径）；未装配 ⇒ 请求返回
	 * REMOTE_SESSION_DELETE_UNAVAILABLE，绝不落回本机路径分支。
	 */
	deleteArchivedRemoteSession?: (input: { hostId: string; archivedPath: string }) => Promise<void>;
	replaceAgentSession: (agentId: string, fn: () => Promise<unknown>, options?: { markForked?: boolean; markSuperseded?: boolean }) => Promise<unknown>;
	/** fork/clone 统一命令层（与 Web HTTP 共用）：重发/编辑 fork 化语义只在这一处维护。 */
	sessionForkCommands: SessionForkCommands;
	/**
	 * 模型存在性校验用的 pi 目录模型：必须与模型选择器同源（capability 快照 ∪ CLI 缓存）。
	 * 未装配（单测/无 pi 运行时的宿主）时退回仅 CLI 缓存（models.json）的旧行为。
	 */
	validationCatalogModels?: () => AvailableModel[] | null | undefined;
	/**
	 * 跨会话正文搜索（Go session-index sidecar 的适配闭包；装配层封装 roots
	 * 解析与降级）。未装配（单测）或返回 null（sidecar 缺失/boot 中/失败）时
	 * 渲染层回退现有标题过滤，搜索入口永远不报错。
	 */
	sessionContentSearch?: (query: string) => Promise<SessionSearchResult | null>;
	/**
	 * 会话内查找（同一 sidecar 的单文件检索）。入参是会话文件路径（= SessionRecord.id）。
	 * 返回 null 表示「索引未就绪/不可用」——渲染层据此提示而不是显示「无匹配」。
	 */
	sessionMessageSearch?: (sessionPath: string, query: string) => Promise<SessionSearchResult | null>;
	/**
	 * 无 pi 会话文件的会话（生视频后端）历史读取：回退 VideoSession 独立存储。
	 * 未装配（单测/无生视频域）时 undefined；调用处 `?? []` 兜底空页。
	 */
	readVideoSessionMessages?: (sessionId: string) => Promise<import("../../shared/types").ChatMessage[]>;
	/**
	 * 会话绑定的智能体角色设定（「使用」智能体时写入 AgentProfileStore.sessionAgentBindings）：
	 * 返回非空字符串时，sessionsSendPrompt 会把角色设定拼进本轮 prompt
	 * （pi/acp 走隐藏 agentMessage，dsh 退化为可见前缀，见 composeAgentInstruction）。
	 * 未装配（单测 / 旧宿主）时不做任何注入，发送行为与此前完全一致。
	 */
	resolveSessionAgentInstruction?: (sessionId: string) => string | undefined;
	/** DSH 后端专用 IPC 依赖（C1 分组；未装配 = 无 DSH 后端）。 */
	dshBackend?: DshBackendIpcDeps;
};

function sessionCommandIpcError(error: SessionCommandError, appLogger: Pick<AppLogger, "warn">, mainCopy: (key: string, params?: Record<string, string | number>) => string): SessionCommandIpcError {
	logSessionCommandFailure(appLogger, error);
	return new SessionCommandIpcError(error, mainCopy);
}

/**
 * 会话命令失败日志：edit/delete/resend 等 IPC 直接返回 SessionCommandResult，
 * 不走 sessionCommandIpcError 抛错，漏打这条就会出现「toast 失败、主进程无日志」。
 * 标题带上错误码：按 code/关键词（如 edit、BUSY）就能在日志里搜到对应失败，
 * 不依赖结构化字段（2026-10 教训：按「编辑」搜正文一无所获）。
 */
function logSessionCommandFailure(appLogger: Pick<AppLogger, "warn">, error: SessionCommandError, extra?: Record<string, unknown>): void {
	void appLogger.warn("session-command", `Session command failed (${error.code})`, {
		code: error.code,
		...(error.debugDetails ? { debugDetails: error.debugDetails } : {}),
		...extra,
	});
}

async function handleSessionCommandResult<T>(appLogger: Pick<AppLogger, "warn">, operation: string, target: SessionRuntimeTarget, extra: Record<string, unknown>, run: () => Promise<SessionCommandResult<T>>): Promise<SessionCommandResult<T>> {
	const result = await run();
	if (!result.ok) {
		logSessionCommandFailure(appLogger, result.error, {
			operation,
			sessionId: target.sessionId,
			agentId: target.agentId,
			runtimeGeneration: target.runtimeGeneration,
			...extra,
		});
	}
	return result;
}

export function registerSessionIpc(deps: SessionIpcDeps): void {
	const {
		projectStore,
		settingsStore,
		sessionScanner,
		resolveWslSessionScanner,
		sessionCatalog,
		sessionRuntimeCoordinator,
		agentManager,
		configManager,
		codexSessionImporter,
		claudeSessionImporter,
		qoderSessionImporter,
		openCodeSessionImporter,
		zcodeSessionImporter,
		workbuddySessionImporter,
		codebuddySessionImporter,
		cursorSessionImporter,
		kimiSessionImporter,
		kimiWorkSessionImporter,
		minimaxSessionImporter,
		directorySessionImporter,
		appLogger,
		terminalManager,
		mainCopy,
		getMainWindow,
		visibleSessions,
		emitLiveSnapshot,
		emitSessionRuntimeEvent,
		emitSessionRuntimeDetach,
		createAnonymousSession,
		stopSessionRuntime,
		emitSessionActivating,
		emitSessionActivationFailed,
		emitSessionActivationCancelled,
		emitReplacementState,
		readCatalogSessionReferenceMessages,
		// 无 pi 会话文件（纯生图草稿）历史读取回退：ImageSession 独立存储
		readImageSessionMessages,
		// 生视频后端会话历史读取回退：VideoSession 独立存储
		readVideoSessionMessages,
		copyCatalogSession,
		exportCatalogSessionHtml,
		exportRemoteCatalogSessionHtml,
		replaceAgentSession,
		resolveSessionAgentInstruction,
		dshBackend,
		readRemoteSessionHistoryPage,
		archiveRemoteSession,
		unarchiveRemoteSession,
		deleteArchivedRemoteSession,
		validationCatalogModels,
	} = deps;
	/**
	 * 远端归档会话永久删除（Phase 5）：main 持有一步式确认状态（sender 绑定/60s/一次性），
	 * 请求只收 id，执行目标由本机归档索引给出。窗口销毁时撤销该 sender 的待确认请求。
	 */
	const remoteArchivedSessionDelete = createRemoteArchivedSessionDelete({
		catalog: sessionCatalog,
		isRuntimeBound: (sessionId) => Boolean(sessionRuntimeCoordinator.getTarget(sessionId) || sessionRuntimeCoordinator.isActivating(sessionId)),
		deleteRemote: deleteArchivedRemoteSession,
	});
	const watchedDeleteSenders = new Set<number>();
	function watchDeleteConfirmationSender(sender: WebContents | undefined): number | undefined {
		const senderId = sender?.id;
		if (!Number.isSafeInteger(senderId) || senderId === undefined || senderId < 1) return undefined;
		if (!watchedDeleteSenders.has(senderId) && typeof sender?.once === "function") {
			watchedDeleteSenders.add(senderId);
			sender.once("destroyed", () => {
				watchedDeleteSenders.delete(senderId);
				remoteArchivedSessionDelete.cancelSender(senderId);
			});
		}
		return senderId;
	}
	const localSessionFilePath = (sessionId: string) => sessionCatalog.getLocalFilePath(sessionId);

	/**
	 * 创建草稿 / 匿名会话 / 引导页默认解析共用的模型存在性校验数据源。
	 * 必须与模型选择器同源：选择器展示的是 capability 快照，只用 CLI 缓存会把
	 * auth 渠道模型判为不存在，首发的点选被静默换成配置默认模型（issue #340）。
	 */
	const selectableModels = validationCatalogModels ?? getCachedModelList;
	// C1：DSH 后端依赖从 dshBackend 分组解构（未装配 = 空对象，相关通道降级）。
	const {
		listDshModels,
		discoverDshModels,
		listDshProviders,
		listDshAgentPresets,
		getDshDefaultModel,
		getDshStatus,
		getDshRuntimeStatus,
		canCreateDshSession,
		installDshRuntime,
		importDshRuntime,
		uninstallDshRuntime,
		describeDshSettings,
		updateDshSettings,
		mutateDshSettings,
		describeDshCredentials,
		setDshCredential,
		unsetDshCredential,
		readDshCredential,
		openDshDocument,
		restartDshHost,
		stopDshHost,
		startDshHost,
		readDshHistoryPage,
		readDshSessionModel,
		readAcpMessages,
		readDshProcessEvents,
		readSessionFacts,
		readSessionOutline,
		readDshMessageFullText,
		resolveDshSessionFilePath,
		searchDshSessions,
		createDshGoal,
		runDshGoalAction,
		cancelDshQueuedMessage,
		listDshSubagents,
		readDshSubagentHistory,
		listDshSkills,
		listDshSessionSkills,
		listDshOrphans,
		listDshForeignSessions,
		importDshForeignSession,
		syncDshForeignSessions,
		archiveDshSession,
		unarchiveDshSession,
		listArchivedDshSessions,
		deleteArchivedDshSession,
		listDshDynamicPlugins,
		listDshStaticPlugins,
		uninstallDshUserPlugin,
		searchDshPluginMarket,
		installDshUserPlugin,
		listDshUserPlugins,
		installDshPlugin,
		runDshPlugin,
		stopDshPlugin,
		uninstallDshPlugin,
		isDshAgent = () => false,
	} = dshBackend ?? {};

	/**
	 * 历史页读取后把文件里的最后模型/思考档位补回 catalog。
	 * 仅补缺失字段，避免旧历史读取覆盖用户后来明确选择的值；运行中 runtime
	 * 有自己的 state，历史回放不参与覆盖。
	 */
	const backfillHistoricalSessionMetadata = async (sessionId: string, metadata: Pick<SessionMessagePage, "model" | "thinkingLevel">): Promise<void> => {
		if (sessionRuntimeCoordinator.getTarget(sessionId)) return;
		const entry = sessionCatalog.get(sessionId);
		if (!entry || entry.backend === "dsh" || !localSessionFilePath(sessionId)) return;
		if (entry.model && entry.thinkingLevel) return;
		if (!metadata.model && !metadata.thinkingLevel) return;
		try {
			const current = sessionCatalog.get(sessionId);
			if (!current || current.backend === "dsh" || !localSessionFilePath(sessionId)) return;
			const patch: {
				model?: SessionModelPreference;
				thinkingLevel?: string;
				updatedAt: number;
			} = { updatedAt: current.updatedAt };
			if (!current.model && metadata.model) patch.model = createSessionModelPreference(metadata.model.provider, metadata.model.modelId, undefined);
			if (!current.thinkingLevel && metadata.thinkingLevel) {
				patch.thinkingLevel = metadata.thinkingLevel;
			}
			if (!patch.model && patch.thinkingLevel === undefined) return;
			const updated = await sessionCatalog.update(sessionId, patch);
			const window = getMainWindow();
			if (window && !window.isDestroyed()) {
				window.webContents.send(ipcChannels.sessionsCatalogRefreshed, {
					projectId: updated.projectId,
				});
			}
		} catch (error) {
			void appLogger.warn("session", "Historical session metadata backfill failed", {
				sessionId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	};

	/**
	 * DSH 历史会话的模型/档位补录（冷读 host 投影，不激活会话）。
	 *
	 * 为什么需要：`SessionRecord.model` 只在用户「通过 PiDeck 改模型」时写入，历史/外部
	 * DSH 会话的模型只存在 host 会话投影（modelSelection.next ?? lastUsed）里。catalog 缺
	 * model 时底栏回退「部署默认模型」这个全局单值——线上案例：会话实际 magpie/group/free，
	 * 底栏却显示部署默认 magpie/group/auto（用户表现为「改了一个会话，其他会话的模型显示
	 * 也跟着变」）。打开会话读历史时顺带冷读一次补回 catalog，之后底栏/选择器就有真值。
	 *
	 * 与 pi 的同名补录同纪律：只补缺失字段、不覆盖用户显式选择（dshSessionModelPatch 保证）；
	 * updatedAt 沿用当前值，避免「打开会话」把侧栏排序搅乱。运行中会话由 runtime state 展示，
	 * 不参与补录（host 投影的 next 是临时态，不写入持久记录）。失败只记日志、不影响历史展示。
	 */
	const backfillDshSessionModel = async (sessionId: string): Promise<void> => {
		if (!readDshSessionModel) return;
		const entry = sessionCatalog.get(sessionId);
		if (!entry || entry.backend !== "dsh" || !entry.dshSessionId) return;
		if (sessionRuntimeCoordinator.getTarget(sessionId)) return;
		if (entry.model && entry.thinkingLevel) return;
		try {
			const selection = await readDshSessionModel(entry.dshSessionId);
			const current = sessionCatalog.get(sessionId);
			if (!current || current.backend !== "dsh") return;
			const patch = dshSessionModelPatch(current, selection);
			if (!patch) return;
			const updated = await sessionCatalog.update(sessionId, { ...patch, updatedAt: current.updatedAt });
			const window = getMainWindow();
			if (window && !window.isDestroyed()) {
				window.webContents.send(ipcChannels.sessionsCatalogRefreshed, {
					projectId: updated.projectId,
				});
			}
		} catch (error) {
			void appLogger.warn("session", "DSH session model backfill failed", {
				sessionId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	};

	/**
	 * 冷启动里程碑（3/3）：首个会话列表返回。前两个里程碑（app ready / first window shown）
	 * 记在 index.ts，但用户真正看到内容要等这次扫描结束；scanMs 单独拆出来，才能区分
	 * 「窗口起得慢」和「会话扫描慢」（侧栏扫描是唯一未进 sidecar 的机械成本，见
	 * docs/archive/plans/session-data-plane-plan.md §7）。只在首个请求记录一次，切项目不再刷屏。
	 */
	let firstSessionListMilestoneLogged = false;
	ipcMain.handle(ipcChannels.sessionsList, async (_event, projectId?: string) => {
		const project = projectId ? projectStore.get(projectId) : undefined;
		const projectWsl = resolveProjectWslIdentity(project, settingsStore.get());
		let projectPath = project?.path;
		// WSL 项目：把 Windows 项目路径转为 WSL /mnt/ 格式，使 CWD=/mnt/... 的会话能匹配。
		if (projectPath && projectWsl !== undefined) {
			projectPath = projectPath.replace(/^([A-Za-z]):\\/, (_: string, d: string) => `/mnt/${d.toLowerCase()}/`).replace(/\\/g, "/");
		}
		const startedAt = Date.now();
		const scanner = projectWsl !== undefined && resolveWslSessionScanner !== undefined ? await resolveWslSessionScanner(projectWsl) : sessionScanner;
		const sessions = await scanner.list(projectPath);
		if (!firstSessionListMilestoneLogged) {
			firstSessionListMilestoneLogged = true;
			void appLogger.info("app", "Cold start milestone: first session list", {
				scanMs: Date.now() - startedAt,
				sessions: sessions.length,
				projectId: projectId ?? null,
				processUptimeMs: Math.round(process.uptime() * 1000),
			});
		}
		return sessions;
	});
	// 跨会话正文搜索：sidecar 不可用/boot 中/失败一律返回 null，渲染层回退标题过滤
	ipcMain.handle(ipcChannels.sessionsSearchContent, async (_event, query: unknown) => {
		const searcher = deps.sessionContentSearch;
		if (!searcher) return null;
		if (typeof query !== "string") return null;
		const trimmed = query.trim();
		if (!trimmed || trimmed.length > 256) return null;
		try {
			return await searcher(trimmed);
		} catch (error) {
			void appLogger.warn("session", "Content search failed", { error: error instanceof Error ? error.message : String(error) });
			return null;
		}
	});

	/**
	 * DSH 会话内查找：host 历史投影 → 词元匹配，包成跨会话搜索的同形信封——
	 * 渲染层浮层只读 sessions[0].matches / hitCount，形状一致才能共用 hook 与浮层。
	 * filePath 给出 host 会话日志路径（排查用；推不出来时退化成 dsh:<id>）。
	 */
	const searchDshSessionInSession = async (entry: SessionCatalogEntry, query: string): Promise<SessionSearchResult | null> => {
		const searcher = dshBackend?.searchDshSessionMessages;
		const dshSessionId = entry.dshSessionId;
		if (!searcher || !dshSessionId) return null;
		try {
			const found = await searcher(dshSessionId, query);
			if (found.hitCount === 0) return { sessions: [], totalHitSessions: 0, truncated: false };
			let logPath: string | undefined;
			if (resolveDshSessionFilePath) {
				try {
					logPath = await resolveDshSessionFilePath(entry.id);
				} catch {
					logPath = undefined;
				}
			}
			return {
				sessions: [
					{
						filePath: logPath ?? `dsh:${dshSessionId}`,
						updatedAtMs: entry.updatedAt,
						matches: found.matches,
						hitCount: found.hitCount,
					},
				],
				totalHitSessions: 1,
				truncated: found.hitCount > found.matches.length,
			};
		} catch (error) {
			void appLogger.warn("session", "DSH in-session search failed", {
				sessionId: entry.id,
				dshSessionId,
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
	};

	/**
	 * ACP 会话内查找：历史来自运行时投影 + deck 侧归档（readAcpMessages 异步读口），
	 * 匹配复用与 pi/DSH 同一套词元规则（findSessionMatches，见 sessions/sessionFindMatches）。
	 * 信封形状与 DSH 分支一致——浮层只读 sessions[0].matches / hitCount，形状一致才能
	 * 共用 hook 与浮层。filePath 给 `acp:<acpSessionId>`：ACP 没有 pi JSONL，这个标识只
	 * 用于排查，不参与跳转（命中 id 就是投影消息 id，jumpToMessage 直接按 id 定位）。
	 * 无 acpSessionId（草稿还没握过手）或未装配读口返回 null（渲染层显示「暂时读不到」）；
	 * 有会话但归档/投影为空时返回空命中（「没有匹配」）。
	 */
	const searchAcpSessionInSession = async (entry: SessionCatalogEntry, query: string): Promise<SessionSearchResult | null> => {
		const reader = readAcpMessages;
		const acpSessionId = entry.acpSessionId;
		if (!reader || !acpSessionId) return null;
		try {
			const found = findSessionMatches(await reader(acpSessionId), query);
			if (found.hitCount === 0) return { sessions: [], totalHitSessions: 0, truncated: false };
			return {
				sessions: [{ filePath: `acp:${acpSessionId}`, updatedAtMs: entry.updatedAt, matches: found.matches, hitCount: found.hitCount }],
				totalHitSessions: 1,
				truncated: found.hitCount > found.matches.length,
			};
		} catch (error) {
			void appLogger.warn("session", "ACP in-session search failed", { sessionId: entry.id, acpSessionId, error: error instanceof Error ? error.message : String(error) });
			return null;
		}
	};

	// 会话内查找（Ctrl/Cmd+Shift+F）：入参是 **SessionRecord.id**（不是路径）。
	// 路径/后端身份一律由主进程从 catalog 解析，渲染层传什么路径都不生效：
	// - pi：sidecar 只索引会话文件（.jsonl），路径再兜一道 isSessionSearchFilePath；
	// - DSH：没有 pi JSONL，整段 host 历史投影后本地匹配（命中 id = 投影消息 id）；
	// - ACP：没有 pi JSONL，运行时投影/内存快照/deck 侧归档任一可用即可匹配
	//   （命中 id 同样是投影消息 id）。
	// 命中按时间线顺序返回（上一条/下一条导航）；未装配/后端不可用返回 null
	// （渲染层显示「暂时读不到」而不是「没有匹配」）。
	ipcMain.handle(ipcChannels.sessionsSearchInSession, async (_event, sessionId: unknown, query: unknown) => {
		if (typeof sessionId !== "string" || typeof query !== "string") return null;
		const trimmed = query.trim();
		if (!trimmed || trimmed.length > 256) return null;
		const entry = sessionCatalog.get(sessionId.trim());
		if (!entry) return null;
		if (entry.backend === "dsh") return searchDshSessionInSession(entry, trimmed);
		if (entry.backend === "acp") return searchAcpSessionInSession(entry, trimmed);
		const searcher = deps.sessionMessageSearch;
		// 路径必须像会话文件（无歧义绝对路径 + .jsonl）：sidecar 只索引真实会话文件，
		// 这里再兜一道，避免把任意路径透传给子进程。判定收口在 sessionSearchPath，
		// Windows 反斜杠路径与 POSIX 正斜杠路径都放行（旧实现只认 `/`，Windows 全被拒）。
		if (!searcher || !entry.filePath || !isSessionSearchFilePath(entry.filePath)) return null;
		try {
			return await searcher(entry.filePath, trimmed);
		} catch (error) {
			void appLogger.warn("session", "In-session search failed", { error: error instanceof Error ? error.message : String(error) });
			return null;
		}
	});

	ipcMain.handle(ipcChannels.sessionsCatalogList, async (_event, projectId: string, options?: { scan?: boolean }) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(mainCopy("project.notFound"));
		// 已登记的目录元数据是本机 catalog，远端项目也必须能读取：导入后刷新依赖这条通道。
		// 读取这些记录不等于扫描远端文件；远端分支必须在本地 scanner / WSL 转换前返回。
		if (!isLocalProject(project)) {
			// 目录缓存中的现有记录（上次扫描/运行时创建的合并结果，启动时从磁盘加载）。
			// 这里刻意不用下方本地路径的死链过滤与排序：远端会话的 filePath 是远端绝对路径
			// （如 /home/u/.pi/...），宿主 existsSync 恒 false，套用本地过滤会把整组远端会话滤空。
			const remoteCachedRecords = sessionCatalog
				.listEntries()
				.filter((entry) => entry.projectId === projectId)
				.map((entry) => sessionCatalog.getRecord(entry.id))
				.filter((record): record is SessionRecord => Boolean(record));
			// 远端项目只有目录缓存可读，没有本机扫描可调度。渲染层靠「catalog 已刷新」推送揭开 loading，
			// 所以这里必须主动补一次推送，否则空缓存的远端项目会一直停在「正在加载历史会话…」直到看门狗兜底。
			// scan:false 是渲染层收到推送后的静默回拉（见 useProjectSync 的 onCatalogRefreshed），
			// 对它再推送一次就会自激成环。
			if (options?.scan !== false) {
				const window = getMainWindow();
				if (window && !window.isDestroyed()) {
					setImmediate(() => {
						if (!window.isDestroyed()) window.webContents.send(ipcChannels.sessionsCatalogRefreshed, { projectId });
					});
				}
			}
			return remoteCachedRecords;
		}
		let projectPath = project.path;
		const settings = settingsStore.get();
		// 第 12 步：扫描按项目身份解析；缺字段的旧项目回退全局设置。
		const projectWsl = resolveProjectWslIdentity(project, settings);
		if (projectWsl !== undefined) {
			projectPath = projectPath.replace(/^([A-Za-z]):\\/, (_: string, drive: string) => `/mnt/${drive.toLowerCase()}/`).replace(/\\/g, "/");
		}
		// 扫描 + 合并 + 运行时绑定（首次同步路径与后台路径共用）
		const runScanAndMerge = async (): Promise<SessionRecord[]> => {
			const scanner = projectWsl !== undefined && resolveWslSessionScanner !== undefined ? await resolveWslSessionScanner(projectWsl) : sessionScanner;
			const summaries = await scanner.list(projectPath);
			const records = await sessionCatalog.mergeScanned(projectId, summaries, projectWsl !== undefined ? { wslDistro: projectWsl.distro, wslUser: projectWsl.user } : {});
			// 重发/编辑 fork 化替换：被子会话接替的旧记录不出现在列表（文件保留可恢复，
			// 用户要求 fork 后历史会话不重复）
			const visibleRecords = records.filter((record) => !record.supersededBy);
			const bindings = sessionRuntimeCoordinator.attachCatalogRuntimes(visibleRecords);
			for (const binding of bindings) {
				const tab = agentManager.list().find((candidate) => candidate.id === binding.agentId);
				if (tab) emitSessionRuntimeEvent(tab.id, agentEventTags.agentsState, tab);
			}
			return visibleRecords;
		};

		// 目录缓存中的现有记录（上次扫描/运行时创建的合并结果，启动时从磁盘加载）
		const cachedRecords = sessionCatalog
			.listEntries()
			// 与扫描路径同口径：替换标记记录直接跳过（都不必走 getRecord）
			.filter((entry) => entry.projectId === projectId && !entry.supersededBy)
			.map((entry) => sessionCatalog.getRecord(entry.id))
			.filter((record): record is SessionRecord => Boolean(record))
			// 与 mergeScanned 同口径排序：小窗项目选择器直接取 sessions[0]，
			// 乱序会把陈旧记录顶到最前（陈旧子代理记录曾因此在小窗报 ENOENT）。
			.sort((left, right) => right.updatedAt - left.updatedAt)
			// 死链过滤：文件已删但清理闸还没跑到（mergeScanned 在后台异步调度）时，
			// 别让「最近会话」落到一个必然 ENOENT 的记录上。
			// 豁免：无文件记录（imagegen/草稿）、dsh（filePath 由 host 侧解析，
			// 本地路径可能不存在）、UNC/WSL 路径（发行版停机时 existsSync
			// 恒 false，不能误藏整组会话）、活绑定运行时（standby 预分配的
			// sessionPath 在 pi 首条消息前不落盘，existsSync 恒 false；若按死链
			// 隐藏，catalog 刷新会把当前选中的草稿剔出列表 → 渲染层
			// replaceProjectSessionsAtom 清空焦点 → 闪回引导页、输入丢失、
			// 引导页重发另建会话留下孤儿空闲 Agent——2026-10-06 事故，与
			// mergeScanned 的 liveness 豁免同口径）。
			.filter((record) => {
				if (!record.filePath || record.backend === "dsh" || record.backend === "acp" || record.filePath.startsWith("\\\\")) return true;
				// WSL 条目豁免：catalog 存的是 Linux 侧路径（/home/...），宿主 existsSync 恒
				// false，按死链滤掉会把 WSL 用户的全部会话从列表里抹掉（2026-10-07 升级
				// 0.7.9 反馈：58 条会话一条不少躺在 catalog，列表却全空）。
				// 与 mergeScanned 清理闸（environment=wsl 跳过）同口径。
				if (record.environment === "wsl") return true;
				if (sessionRuntimeCoordinator.hasLiveRuntime(record.id)) return true;
				// TTL 缓存（2027-02 性能审计）：几百条记录逐条同步 stat 是每次 5-30ms 的
				// 固定税（切项目/catalog 刷新都会重拉这条 handler）；存在性 2s 陈旧无害，
				// 清理闸（mergeScanned）仍是权威。
				return sessionFileExistsCached(record.filePath);
			});

		// 纯读路径：事件回调/订阅刷新专用，不再触发扫描（防止推送-拉取循环触发）
		if (options?.scan === false) return cachedRecords;

		// 一律先回磁盘 catalog：打包正式 userData 的历史 JSONL 远多于 dev，
		// 首次 await 全量扫描会让侧栏「正在加载历史会话」卡住整窗。
		// 无缓存时回 []，渲染层保持 loading，等 catalog-refreshed 再揭开。
		scannedProjects.add(projectId);
		catalogScanCoordinator.schedule(projectId, async () => {
			try {
				await runScanAndMerge();
			} catch (error) {
				void appLogger.warn("session", "Background catalog scan failed", {
					projectId,
					error: error instanceof Error ? error.message : String(error),
				});
			} finally {
				// 成功/失败都通知渲染层：空项目不能永远转圈，失败也要让 UI 可操作。
				const window = getMainWindow();
				if (window && !window.isDestroyed()) {
					window.webContents.send(ipcChannels.sessionsCatalogRefreshed, { projectId });
				}
			}
		});
		return cachedRecords;
	});
	ipcMain.handle(ipcChannels.sessionsCatalogCreateDraft, async (_event, input: CreateSessionDraftInput) => {
		const project = projectStore.get(input.projectId);
		if (!project) throw new Error(mainCopy("project.notFound"));
		// DSH runtime 门控（AgentRuntimeProvider 阶段 1）：runtime 不可用时拒绝新建
		// dsh 会话——渲染层已按安装态隐藏入口，这里是边界防御（设置残留 dsh /
		// 渲染层旧版本）。既有 dsh 会话不受影响（打开/发送走运行时链路，不在此处）。
		if (input.backend === "dsh" && canCreateDshSession?.() !== true) {
			// outdated（版本不一致）单独给文案：不是「没装」，是装了但不配套，
			// 用户需要的是重装而不是困惑于「明明装了却说未安装」。
			if (getDshRuntimeStatus?.().state === "outdated") {
				throw new Error(mainCopy("session.dshRuntimeOutdated"));
			}
			throw new Error(mainCopy("session.dshRuntimeNotInstalled"));
		}
		// Auto-fill model / thinkingLevel from pi config when the caller hasn't
		// provided them, so the composer bar shows the effective default.
		// DSH 后端不适用 pi 的模型配置（模型路由由 DSH host 自己的 settings 决定）：
		// **显式传入的 model 仍然接受**（issue #253）——引导页在 DSH 态下的点选必须带到会话上，
		// 否则 host 只能用部署默认（settings.yaml 的 agent-default-model），用户表现为
		// 「切到 DSH 后模型换不了」。与侧栏「新建会话后切 DSH 再选模型」走 updateRecord 的
		// 既有链路保持一致：只做形状归一化，不用 models.json 校验（DSH 的 provider 是
		// host route 名，不在 models.json 里，校验会把合法选择全丢掉）。模型是否被 host
		// 接受由激活时的 applyPreferences → DshAgentManager.setModel 裁决（host 拒绝时
		// 降级到部署默认并告警，不让创建失败）。
		// 缺省模型仍不从 pi 配置解析：DSH 没有可读的启动默认解析器（部署默认由 host 自己决定）。
		// 思考档位值域与 DSH 兼容（off/high/max 等），新会话默认档位同样填充——否则 DSH
		// 新会话的思考按钮只显示「思考」而非实际默认档位。
		let model = normalizeSessionModelPreference(input.model);
		let thinkingLevel = input.thinkingLevel;
		const nonPiBackend = input.backend === "dsh" || input.backend === "acp";
		if ((!nonPiBackend && !model) || !thinkingLevel) {
			try {
				const [settingsResult, modelsResult] = await Promise.all([configManager.getSettingsConfig(), configManager.getModelsConfig()]);
				// 引导页/渲染层显式传入的模型（如欢迎页偏好）也可能指向已删除的供应商/模型：
				// 校验其仍存在（models.json ∪ pi 目录，与选择器可选范围一致），不存在则交给
				// 解析器按欢迎页点选 → 配置默认 → enabledModels → lastUsed 的顺序兜底，
				// 避免新会话带着幽灵模型启动。
				if (!nonPiBackend && model) {
					if (
						typeof model.provider !== "string" ||
						typeof model.modelId !== "string" ||
						!isModelInModelsConfig(
							modelsResult.parsed,
							{
								provider: model.provider,
								modelId: model.modelId,
							},
							selectableModels(),
						)
					) {
						model = undefined;
					}
				}
				// 缺省填充与引导页展示共用同一解析器（launchDefaults），
				// 保证「预选的默认」与「创建时真正套用的默认」永远同源。
				// 欢迎页偏好（renderer localStorage）同样经主进程校验存在性后按
				// 「欢迎页点选 > 显式默认 > enabledModels > 上次使用 > 空」参与解析；
				// explicit model（用户主动指名）仍优先于一切（input.model，见上方校验）。
				const defaults = resolveLaunchDefaultOptions({
					backend: input.backend,
					settings: settingsResult.parsed,
					models: modelsResult.parsed,
					// pi 目录（同步读）：lastUsed/welcomeModel 的存在性校验按
					// models.json ∪ capability 快照判定，与选择器可选范围一致。
					catalogModels: selectableModels(),
					// lastUsed 语义：用户最近一次实际发送所用模型；仅无显式默认与偏好时参与。
					lastUsedModel: settingsStore.get().lastUsedModel,
					welcomeModel: input.welcomeModel && typeof input.welcomeModel.provider === "string" && typeof input.welcomeModel.modelId === "string" ? input.welcomeModel : undefined,
				});
				if (!nonPiBackend && !model) {
					model = defaults.model;
				}
				if (!thinkingLevel) {
					// 每模型默认档位优先于全局默认，且必须按**最终生效的模型**查（显式传入的
					// model / welcomeModel 可能不是解析器选出的默认模型）：pi 在新建与切换模型时
					// 都按「显式选择 > 每模型默认 > 全局默认」解析再 clamp，这里同序才能保证
					// 首轮请求用的档位与引导页底栏展示的一致。DSH 无 pi 模型身份，跳过。
					const perModelThinkingLevel = !nonPiBackend && model && typeof model.provider === "string" && typeof model.modelId === "string" ? modelThinkingLevelOf(settingsResult.parsed, model.provider, model.modelId) : undefined;
					thinkingLevel = perModelThinkingLevel ?? defaults.thinkingLevel;
				}
			} catch {
				// Config read is best-effort; draft creation must never block.
			}
		}
		const projectWsl = resolveProjectWslIdentity(project, settingsStore.get());
		const draft = await sessionCatalog.createDraft({
			projectId: input.projectId,
			...(projectWsl !== undefined ? { wslDistro: projectWsl.distro, wslUser: projectWsl.user } : {}),
			title: input.title?.trim() || mainCopy("session.newTitle"),
			// 第 12 步：会话按项目档案记录环境；旧项目回退全局设置。
			environment: projectWsl !== undefined ? "wsl" : "native",
			// 后端透传：仅接受白名单枚举，其余视为 pi（渲染层不可信输入校验在边界）。
			backend: input.backend === "dsh" ? "dsh" : input.backend === "acp" ? "acp" : undefined,
			// ACP 工具预选（AcpToolConfig.id）：backend=acp 草稿期选哪个 CLI。
			acpToolId: input.backend === "acp" && typeof input.acpToolId === "string" ? input.acpToolId : undefined,
			model,
			thinkingLevel,
			// 渲染层输入不可信：侧边任务只认显式 true，其余（含任意真值）按普通会话建。
			sideTask: input.sideTask === true,
		});
		void appLogger.info("session", "Session draft created", {
			sessionId: draft.id,
			projectId: input.projectId,
			title: draft.title,
			model: draft.model,
		});
		// standby 补热：草稿创建是「用户马上要开聊」的最强信号，趁用户阅读/输入的空窗
		// 后台预热一个 pi 进程待命（fire-and-forget；ensure 幂等且受 standbyRuntimeEnabled 闸）。
		if (!nonPiBackend) agentManager.ensureStandbyAgent(input.projectId);
		return draft;
	});
	ipcMain.handle(ipcChannels.sessionsResolveLaunchDefaults, async (_event, input?: ResolveLaunchDefaultsInput): Promise<ResolvedLaunchDefaults> => {
		// 渲染层输入不可信：backend 只认白名单枚举，其余按非 DSH（pi）解析。
		const backend = input?.backend === "dsh" ? "dsh" : input?.backend === "acp" ? "acp" : undefined;
		try {
			const [settingsResult, modelsResult] = await Promise.all([configManager.getSettingsConfig(), configManager.getModelsConfig()]);
			return resolveLaunchDefaultOptions({
				backend,
				settings: settingsResult.parsed,
				models: modelsResult.parsed,
				// 与 createDraft 同源：存在性校验含 capability 快照（auth 渠道模型也在内），
				// 否则引导页预选与创建再次分叉。
				catalogModels: selectableModels(),
				// lastUsed 语义：引导页预选默认 = 用户最后一次实际使用的模型。
				lastUsedModel: settingsStore.get().lastUsedModel,
			});
		} catch {
			// 配置读取失败返回空默认：引导页退回「无预选」形态，不阻塞 UI；
			// 创建会话链路自身仍会 best-effort 重试。
			return {};
		}
	});
	ipcMain.handle(ipcChannels.sessionsCreateAnonymous, async (_event, input: CreateAnonymousSessionInput) => {
		// 与 createDraft 同一 DSH runtime 门控：匿名会话同样不能落在不可用后端上。
		if (input.backend === "dsh" && canCreateDshSession?.() !== true) {
			if (getDshRuntimeStatus?.().state === "outdated") {
				throw new Error(mainCopy("session.dshRuntimeOutdated"));
			}
			throw new Error(mainCopy("session.dshRuntimeNotInstalled"));
		}
		const result = await createAnonymousSession(input);
		void appLogger.info("session", "Anonymous session created", {
			sessionId: result.session.id,
			projectId: input.projectId,
		});
		return result;
	});
	ipcMain.handle(ipcChannels.sessionsCatalogUpdate, async (_event, sessionId: string, patch: UpdateSessionRecordInput) => {
		// 渲染层输入不可信：侧边任务标记只认真值 true 与 null（清除），其余按「本次不改」处理。
		if (patch.sideTask !== undefined && patch.sideTask !== true && patch.sideTask !== null) {
			patch = { ...patch, sideTask: undefined };
		}
		const normalizedModel = patch.model === undefined ? undefined : patch.model === null ? null : normalizeSessionModelPreference(patch.model);
		if (patch.model !== undefined && patch.model !== null && !normalizedModel) {
			throw new Error(mainCopy("session.invalidModel"));
		}
		if (patch.model !== undefined) {
			patch = { ...patch, model: normalizedModel };
		}
		const entry = sessionCatalog.get(sessionId);
		if (!entry) throw new Error(mainCopy("session.notFound"));
		// 后端锁定（草稿期可改，激活后禁止）：pi 会话文件（JSONL）与 DSH 会话
		// （host session log）格式不同，中途切换会导致消息同步渲染不可靠。
		// 已 active 的会话拒绝 backend 变更（渲染层已隐藏入口，这里是边界防御）。
		// 未 active 但在预热激活中的会话**不**拒绝：旧实现在这里用 getTarget 当闸门，而预热期间
		// 绑定尚未建立（ACP 握手在 bind 之前），target 为空→闸门放行，旧激活随后才把旧后端进程
		// 绑到已经切走的会话上。现在改为主动作废旧激活（停进程 + 禁 bind），用户不用等握手。
		if (patch.backend !== undefined && patch.backend !== entry.backend) {
			if (entry.status === "active") throw new Error(mainCopy("session.backendLocked"));
			await sessionRuntimeCoordinator.cancelActivation(sessionId);
		}
		// ACP 换工具同理：激活链按工具表 spawn，旧工具的握手不得绑到已换工具的会话。
		if (patch.acpToolId !== undefined && patch.acpToolId !== entry.acpToolId && entry.status !== "active") {
			await sessionRuntimeCoordinator.cancelActivation(sessionId);
		}
		// 草稿会话切到非 pi 后端时回收本项目的 standby 预热进程：它服务不了这个会话，
		// 不主动丢就只能等 10min TTL 自然到期（用户反馈的「没用到还占着内存」）。
		// 放在锁定判定之后：已锁定的会话会先报错，不改状态也不回收进程。
		if (patch.backend !== undefined && patch.backend !== entry.backend && patch.backend !== "pi") {
			agentManager.releaseStandbyAgent(entry.projectId);
		}
		// DSH agent 预设同样创建即固定：激活会话的 preset 由 host 会话 header 权威持有，
		// 渲染层只读展示，拒绝任何运行时改写（未激活、还没有 host 会话的草稿才放行）。
		// 判据与渲染层胶囊共用 shared/dshAgentPresetLock：两边同源才不会出现
		// 「界面能点、主进程拒绝」的原始 IPC 报错。
		if (
			patch.agentPreset !== undefined &&
			patch.agentPreset !== entry.agentPreset &&
			isDshAgentPresetLocked({
				backend: entry.backend,
				status: entry.status,
				dshSessionId: entry.dshSessionId,
				hasRuntime: Boolean(sessionRuntimeCoordinator.getTarget(sessionId)),
			})
		) {
			throw new Error(mainCopy("session.agentPresetLocked"));
		}
		const title = patch.title?.trim();
		if (title && title !== entry.title) {
			// Reserve the catalog before the asynchronous pi rename. A late automatic-title
			// result must observe manual ownership even while set_session_name is in flight.
			await sessionCatalog.claimTitleOwnership(sessionId);
			const target = sessionRuntimeCoordinator.getTarget(sessionId);
			if (target) {
				const renamed = await sessionRuntimeCoordinator.renameRuntime(target, title);
				if (!renamed.ok) throw sessionCommandIpcError(renamed.error, appLogger, mainCopy);
			} else if (sessionCatalog.getLocator(sessionId)?.kind === "ssh") {
				// 远端会话改名是**纯 catalog 记录操作**：PiDeck 的显示名就是 catalog 标题，上面已经用
				// claimTitleOwnership 占成 manual 终态（登记/自动标题都不会再覆盖它），因此不需要任何文件操作。
				// 这里刻意不走 localSessionFilePath：它对 ssh locator 抛稳定码，会让一次只改记录的改名失败。
				// 代价（已记录）：远端 JSONL 里的 name 行不变，pi 在远端的原生标题仍是旧名——远端文件写入
				// 属尚未交付的远端写面，不能在这里顺手补。有运行实例时改名走上面的 RPC 分支，与本分支无关。
				void appLogger.info("session", "Remote session renamed (catalog title only)", {
					sessionId,
					oldTitle: entry.title,
					newTitle: title,
				});
			} else {
				const sessionFilePath = localSessionFilePath(sessionId);
				if (sessionFilePath) {
					await sessionScanner.rename(sessionFilePath, title);
					void appLogger.info("session", "Session renamed (file)", {
						sessionId,
						oldTitle: entry.title,
						newTitle: title,
					});
				}
			}
		}
		return sessionCatalog.update(sessionId, {
			...patch,
			title: title || undefined,
			// 切到生图/生视频/ACP 后端时甩开 pi 会话文件引用：生图历史独立存 ImageSessionStore，
			// 生视频独立存 VideoSessionStore，ACP 会话由 agent CLI 自持（session/new 在远端）；
			// 残留 filePath 会让历史加载误落到不存在的 pi 文件（ENOENT 根因，imagegen 同款）。
			...(patch.backend === "imagegen" || patch.backend === "videogen" || patch.backend === "acp" ? { filePath: null, piSessionId: null } : {}),
		});
	});
	ipcMain.handle(ipcChannels.sessionsCatalogDelete, async (_event, rawSessionId: unknown) => {
		const sessionId = parseSessionId(rawSessionId);
		const entry = sessionCatalog.get(sessionId);
		if (!entry) return false;
		// 远端会话（ssh locator）没有本机会话文件，删除的语义只能是**纯本机记录操作**：
		// 移出 catalog 记录 + 记墓碑（下次远端扫描不再列为「可导入」）。本机语义是「删文件 + 移出记录」，
		// 这里只保留与它一致的那部分——
		// 1. 不调 `localSessionFilePath`（它对 ssh locator 抛稳定码，会让整个移除失败——就是今天的行为）；
		// 2. 不动本机回收站、不删/改任何本机文件；
		// 3. **零远端数据写入**：不改写远端 JSONL、不 move、不删除；
		// 4. 但“停进程 ≠ 改数据”：有运行实例时照本机「先杀后删」的先例先停掉它（见下）。
		// 真删远端文件是**另一个显式动作**（需二次确认），不在本批（见 docs/archive/remote/remote-write-plan.md §0）。
		const remoteLocator = entry.locator?.kind === "ssh" ? entry.locator : undefined;
		if (remoteLocator) {
			// 先停后摘记录（与本机删除同序）：留一个 `sessionId` 已不存在却仍绑定 runtime 的悬空会话会漏事件、
			// 生成幽灵条目，而且用户再也找不到停它的入口。这条链路是既有的「关闭 Agent」路径
			// （releaseRuntimeForDelete → agents.stop → 远端 runner 的停止信号 / 本地 ssh launcher 收尾），
			// **只终止进程，不做任何远端数据写入**——「停进程」与「改数据」是两件事，前者不碰任何会话文件。
			// 没有绑定/卡在 error 的中间态也走它：它先解绑再停，失败一次卡在 bound 的会话同样能移除。
			await sessionRuntimeCoordinator.releaseRuntimeForDelete(sessionId);
			// 墓碑的键是**扫描侧的会话身份**（remoteSessionId，与 scan 的条目同值域）。G3 早期的远端记录
			// 可能只有 remotePath（同一个相对会话根的身份，见 readSshSessionLocator 的注释），所以按这个
			// 顺序取；两者都没有的历史记录（只有 hostId）本就永远匹配不上一次扫描，无需墓碑。
			const remoteSessionId = remoteLocator.remoteSessionId ?? remoteLocator.remotePath;
			if (typeof remoteSessionId === "string" && remoteSessionId.length > 0) {
				await sessionCatalog.rememberDismissedRemoteSession({ hostId: remoteLocator.hostId, remoteSessionId });
			}
			await sessionCatalog.removeWithDescendants(sessionId);
			// 只记身份（hostId/sessionId），不记路径、不记命令（与读取侧同一股敏纪律）。
			void appLogger.info("session", "Remote session record removed (tombstoned; remote file kept)", {
				sessionId,
				hostId: remoteLocator.hostId,
			});
			return true;
		}
		const sessionFilePath = localSessionFilePath(sessionId);
		// 删除即先杀后删：失败一次/卡在 bound 的会话也能删掉。
		// 仍按路径扫一遍游离 agent，避免只解绑 catalog 却留着进程。
		await sessionRuntimeCoordinator.releaseRuntimeForDelete(sessionId);
		try {
			// DSH 没有 session.delete：host 目录会留在 $DSH_HOME。先记墓碑再删映射，
			// 否则 refreshProjectTree 的自动同步会把同一条再导入。运行中也允许删。
			if (entry.backend === "dsh" && entry.dshSessionId) {
				await sessionCatalog.rememberDismissedDshSession(entry.dshSessionId);
			}
			if (sessionFilePath) {
				const normalizedTarget = canonicalizeSessionPath(sessionFilePath, entry.environment);
				const usingAgent = agentManager
					.list()
					.find((agent) => agent.sessionPath && agent.sessionEnvironment === entry.environment && (entry.environment !== "wsl" || (agent.wslDistro === entry.wslDistro && agent.wslUser === entry.wslUser)) && canonicalizeSessionPath(agent.sessionPath, entry.environment) === normalizedTarget);
				if (usingAgent) {
					await sessionRuntimeCoordinator.stopAgentById(usingAgent.id).catch(() => undefined);
					await agentManager.stop(usingAgent.id).catch(() => undefined);
				}
				await sessionScanner.delete(sessionFilePath);
			}
			// 磁盘会把 sibling `<stem>/` 一并删掉；catalog 必须同步摘掉整棵子树，
			// 否则 mergeScanned 只增改不删，子会话会孤儿提升成顶层行。
			await sessionCatalog.removeWithDescendants(sessionId);
			void appLogger.info("session", "Catalog session deleted", { sessionId, filePath: sessionFilePath });
			return true;
		} catch (error) {
			// 会话删除失败（文件删除失败/记录移除失败/会话使用中拦截）也要留痕，便于事后追踪。
			void appLogger.error("session", "Catalog session delete failed", {
				sessionId,
				filePath: sessionFilePath,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	});
	ipcMain.handle(ipcChannels.sessionsCatalogArchive, async (_event, rawSessionId: unknown) => {
		const sessionId = parseSessionId(rawSessionId);
		const entry = sessionCatalog.get(sessionId);
		// DSH 会话归档（G14）：host 目录移入 .pideck-archive（目录移动 + manifest，不销毁数据）。
		// 运行中的会话不能归档（同 pi：移动文件会破坏 host 对当前写入位置的引用）。
		if (entry?.backend === "dsh" && entry.dshSessionId && archiveDshSession) {
			if (sessionRuntimeCoordinator.getTarget(sessionId) || sessionRuntimeCoordinator.isActivating(sessionId)) {
				throw new Error(mainCopy("session.stopBeforeDelete"));
			}
			const cwd = projectStore.get(entry.projectId)?.path ?? "";
			if (!cwd) throw new Error(mainCopy("project.notFound"));
			// 归档时刻把 catalog 标题写进 manifest：归档区列表与恢复后都靠它显示真实会话名
			// （旧归档缺省时由 DshHost 从日志折叠兜底，见 listArchivedSessions/unarchiveSession）。
			const archivedPath = await archiveDshSession(entry.dshSessionId, cwd, entry.title);
			if (!archivedPath) throw new Error(mainCopy("session.invalidArchivePath"));
			await sessionCatalog.removeWithDescendants(sessionId);
			void appLogger.info("session", "DSH session archived", {
				sessionId,
				dshSessionId: entry.dshSessionId,
				archivedPath,
			});
			return true;
		}
		// 远端会话归档（P4.5b）：远端文件 `mv` 进同目录旁的 `.pideck-archive/` + 本机归档索引 + 移出 catalog。
		// 必须插在 localSessionFilePath() **之前**：那个入口对 ssh locator 抛稳定码，放后面就是死代码
		// （f00977a33 的教训）。
		if (entry?.locator?.kind === "ssh") {
			const remoteLocator = entry.locator;
			if (!archiveRemoteSession) throw new Error(REMOTE_SESSION_ARCHIVE_CODES.unavailable);
			// 先判后发：运行实例绑定存在时**一个远端命令都不发**（移动正被远端 pi 追加写的文件会把历史写坏）。
			// 这里给出的是可执行文案（“先停 Agent”）而不是裸码：同一句拒绝就是用户看到的全文，
			// 稳定码留在日志里（与本机归档的拒绝文案同一机制）。
			if (sessionRuntimeCoordinator.getTarget(sessionId) || sessionRuntimeCoordinator.isActivating(sessionId)) {
				void appLogger.warn("session", "Remote session archive refused: runtime still bound", { sessionId, hostId: remoteLocator.hostId, code: REMOTE_SESSION_ARCHIVE_CODES.busy });
				throw new Error(mainCopy("session.remoteArchiveStopFirst"));
			}
			const { originalPath, archivedPath } = await archiveRemoteSession({ hostId: remoteLocator.hostId, locator: remoteLocator });
			// 顺序固定：**远端移动成功之后**才动本机（先落索引、再移出记录）。
			// 远端失败时抛出，本机状态原样不动——绝不谎报成功（也不会留一条指向不存在归档的索引）。
			await sessionCatalog.rememberArchivedRemoteSession({
				sessionId,
				hostId: remoteLocator.hostId,
				projectId: entry.projectId,
				title: entry.title,
				updatedAt: entry.updatedAt,
				...(remoteLocator.remoteSessionId !== undefined ? { remoteSessionId: remoteLocator.remoteSessionId } : {}),
				...(remoteLocator.remotePath !== undefined ? { remotePath: remoteLocator.remotePath } : {}),
				originalRemotePath: originalPath,
				archivedRemotePath: archivedPath,
				archivedAt: Date.now(),
			});
			await sessionCatalog.removeWithDescendants(sessionId);
			// 只记身份与稳定码，不记远端路径、不记命令（与读取侧同一股敏纪律）。
			void appLogger.info("session", "Remote session archived (remote file moved into .pideck-archive)", { sessionId, hostId: remoteLocator.hostId });
			return true;
		}
		const sessionFilePath = localSessionFilePath(sessionId);
		if (!entry || !sessionFilePath) return false;
		// 运行中的会话不能归档（同删除）：移动文件会破坏 pi 对当前写入位置的引用。
		if (sessionRuntimeCoordinator.getTarget(sessionId) || sessionRuntimeCoordinator.isActivating(sessionId)) {
			throw new Error(mainCopy("session.stopBeforeDelete"));
		}
		const archivedPath = await sessionScanner.archive(sessionFilePath);
		// scanner.archive 会把 sibling `<stem>/` 一并移走；catalog 同步清子树，避免幽灵子会话。
		await sessionCatalog.removeWithDescendants(sessionId);
		void appLogger.info("session", "Session archived", { sessionId, archivedPath });
		return true;
	});
	ipcMain.handle(ipcChannels.sessionsCatalogUnarchive, async (_event, archivedPath: string) => {
		// 校验入参：归档路径必须是 .pideck-archive 目录内的 JSONL，防路径穿越。
		if (typeof archivedPath !== "string" || !archivedPath.endsWith(".jsonl")) {
			throw new Error(mainCopy("session.invalidArchivePath"));
		}
		const restoredPath = await sessionScanner.unarchive(archivedPath);
		void appLogger.info("session", "Session restored from archive", { restoredPath });
		return true;
	});
	/**
	 * 远端会话取消归档（P4.5b）：入参是**本机 catalog 会话 id**，不是路径。
	 *
	 * 为什么不沿用 `sessions:catalog-unarchive`：那条通道的入参是本机归档路径（`scanner.unarchive` 按它查
	 * 本机归档索引并把文件移回原位），而远端会话从来就没有本机路径——硬套进去只能是「远端绝对路径先被
	 * 当成 WSL 本机路径、然后在归档索引里找不到」。所以远端恢复按 id 走：恢复目标（归档前/后的远端
	 * 绝对路径）由本机归档索引给出。
	 */
	ipcMain.handle(ipcChannels.sessionsCatalogUnarchiveRemote, async (_event, rawSessionId: unknown): Promise<boolean> => {
		const sessionId = parseSessionId(rawSessionId);
		const archived = sessionCatalog.getArchivedRemoteSession(sessionId);
		if (!archived) throw new Error(REMOTE_SESSION_ARCHIVE_CODES.entryNotFound);
		if (!unarchiveRemoteSession) throw new Error(REMOTE_SESSION_ARCHIVE_CODES.unavailable);
		// 同归档：绑定存在就不动远端（先判后发）。
		if (sessionRuntimeCoordinator.getTarget(sessionId) || sessionRuntimeCoordinator.isActivating(sessionId)) {
			void appLogger.warn("session", "Remote session unarchive refused: runtime still bound", { sessionId, hostId: archived.hostId, code: REMOTE_SESSION_ARCHIVE_CODES.busy });
			throw new Error(mainCopy("session.remoteUnarchiveStopFirst"));
		}
		await unarchiveRemoteSession({ hostId: archived.hostId, originalPath: archived.originalRemotePath, archivedPath: archived.archivedRemotePath });
		// 远端移回成功后才动本机：先摘索引，再按归档时刻的身份把记录登记回来
		// （稳定身份 = remoteSessionId 优先，与墓碑同口径）。ensureRemoteSession 命中同一身份时不会重复。
		await sessionCatalog.forgetArchivedRemoteSession(sessionId);
		const remoteIdentity = archived.remoteSessionId ?? archived.remotePath;
		if (remoteIdentity) {
			await sessionCatalog.ensureRemoteSession({
				projectId: archived.projectId,
				hostId: archived.hostId,
				remoteSessionId: remoteIdentity,
				remotePath: archived.remotePath ?? remoteIdentity,
				title: archived.title,
				updatedAt: archived.updatedAt,
			});
		}
		void appLogger.info("session", "Remote session restored from archive", { sessionId, hostId: archived.hostId });
		return true;
	});
	ipcMain.handle(ipcChannels.sessionsCatalogListArchived, async (): Promise<ArchivedPiSession[]> => {
		const local = await sessionScanner.listArchived();
		// 远端归档条目：数据源是本机归档索引，**不扫远端归档区**（列一次归档就要一次 ssh 往返 + 会话根探测，
		// 而归档区本来就不在常规扫描口径里；索引就是权威）。
		return [...local, ...sessionCatalog.listArchivedRemoteSessions().map(remoteArchivedRow)];
	});
	ipcMain.handle(ipcChannels.sessionsCatalogDeleteArchived, async (_event, archivedPath: unknown): Promise<boolean> => {
		// 校验入参：归档路径必须是 .pideck-archive 目录内的 JSONL，防路径穿越。
		// 是否真的位于归档目录内由 sessionScanner.deleteArchived 兜底校验。
		// **远端归档没有这条通道**（P4.5b 明确不做）：远端没有回收站，`rm` 是永久删除；本 handler 只接受本机路径，
		// 远端归档行也只带 id（远端路径不过 IPC）⇒ 不存在一条能删掉远端数据的链路。
		if (typeof archivedPath !== "string" || !archivedPath.endsWith(".jsonl")) {
			throw new Error(mainCopy("session.invalidArchivePath"));
		}
		await sessionScanner.deleteArchived(archivedPath);
		void appLogger.info("session", "Archived session deleted", { archivedPath });
		return true;
	});
	/**
	 * 远端归档会话**永久删除**请求（Phase 5）：入参只有本机 catalog 会话 id。
	 *
	 * 为什么先请求再回答：这是不可恢复的远端数据删除，main 必须自己持有一次性确认状态
	 * （PendingConfirmationBroker）。请求阶段只做校验并签发 requestId，不执行任何远端命令；
	 * 只有携带同一 requestId 的 approve 回答才会真正删除——renderer 无法通过任何参数伪造 confirmed。
	 */
	ipcMain.handle(ipcChannels.sessionsCatalogDeleteArchivedRemote, async (event, rawSessionId: unknown): Promise<RemoteArchivedSessionDeleteRequestResult> => {
		const senderId = watchDeleteConfirmationSender(event?.sender);
		if (senderId === undefined) return { ok: false, code: REMOTE_SESSION_DELETE_CODES.confirmationRequired };
		const sessionId = parseSessionId(rawSessionId);
		const result = await remoteArchivedSessionDelete.request({ senderId, sessionId });
		if (result.ok) {
			void appLogger.info("session", "Remote archived session delete confirmation requested", { sessionId });
		} else {
			void appLogger.warn("session", "Remote archived session delete refused", { sessionId, code: result.code });
		}
		return result;
	});
	/**
	 * 回答远端归档会话永久删除的一次性确认：requestId + approve/deny。
	 * 只有 approve 才执行远端删除；成功后由协调器摘索引/清墓碑。回执不可信 ⇒ RESULT_UNCONFIRMED，
	 * 索引保留（UI 不得自动刷新掉，必须让用户刷新核对）。
	 */
	ipcMain.handle(ipcChannels.sessionsCatalogAnswerDeleteArchivedRemote, async (event, rawRequestId: unknown, rawChoice: unknown): Promise<RemoteArchivedSessionDeleteAnswerResult> => {
		const senderId = watchDeleteConfirmationSender(event?.sender);
		if (senderId === undefined || typeof rawRequestId !== "string" || rawRequestId.length === 0 || rawRequestId.length > 128) return { ok: false, code: REMOTE_SESSION_DELETE_CODES.confirmationRequired };
		if (rawChoice !== "approve" && rawChoice !== "deny") return { ok: false, code: REMOTE_SESSION_DELETE_CODES.confirmationRequired };
		const result = await remoteArchivedSessionDelete.answer({ senderId, requestId: rawRequestId, choice: rawChoice });
		if (result.ok && result.deleted) {
			// 只记「哪条会话被删」；不记远端路径/命令（与读/归档同一股敏纪律）。
			void appLogger.info("session", "Remote archived session data permanently deleted", { requestId: rawRequestId });
		} else if (!result.ok) {
			void appLogger.warn("session", "Remote archived session delete failed", { code: result.code });
		}
		return result;
	});
	ipcMain.handle(ipcChannels.sessionsCatalogReadMessages, async (_event, rawSessionId: unknown) => {
		const sessionId = parseSessionId(rawSessionId);
		const entry = sessionCatalog.get(sessionId);
		const sessionFilePath = localSessionFilePath(sessionId);
		// DSH 会话没有 pi 会话文件：全量读走 host 历史事件流（一次拉最大页），
		// 与分页路径同源；未装配 readDshHistoryPage 时返回空数组。
		if (entry?.backend === "dsh" && entry.dshSessionId && readDshHistoryPage) {
			const page = await readDshHistoryPage(entry.dshSessionId, undefined, { maxMessages: 1000 });
			// 与分页路径同源：打开会话顺带补录 host 会话模型（冷读，不激活）。
			void backfillDshSessionModel(sessionId);
			return page.messages;
		}
		// ACP 会话历史:agent 侧 load 重放(权威) + 运行时内存投影 + deck 侧归档(重启/换机后
		// 的唯一来源)。无 runtime 时读归档,仍是空才返回空数组(渲染层显示起始页)。
		if (entry?.backend === "acp") {
			return readAcpMessages ? await readAcpMessages(entry.acpSessionId ?? "") : [];
		}
		if (entry?.backend === "imagegen") {
			// imagegen 后端会话：历史独立存 ImageSessionStore，不走 pi 文件
			return (await readImageSessionMessages?.(sessionId)) ?? [];
		}
		if (entry?.backend === "videogen") {
			// videogen 后端会话：历史独立存 VideoSessionStore（任务占位/终态按消息 id 折叠）
			return (await readVideoSessionMessages?.(sessionId)) ?? [];
		}
		if (!sessionFilePath) return [];
		// 有界「加载窗口」（9 轮 + 条目预算），不是全量历史：整量读出在大会话上
		// 会同时顶爆主进程与渲染层（#213）；需要更早历史走 readRecordMessagePage。
		const window = await agentManager.readSessionLoadWindow(sessionFilePath, sessionId, entry ? { projectId: entry.projectId } : undefined);
		const messages = window.messages;
		const metadata = await agentManager.readSessionDisplayMetadata(sessionFilePath);
		await backfillHistoricalSessionMetadata(sessionId, metadata);
		return messages;
	});
	/** 会话分支树（右侧抽屉「分支」面板）：只读文件索引，无需活 runtime；DSH/imagegen 无 pi 文件返回 null。 */
	ipcMain.handle(ipcChannels.sessionsGetBranchTree, async (_event, sessionId: unknown): Promise<SessionBranchTree | null> => {
		if (typeof sessionId !== "string" || !sessionId.trim()) throw new Error("Invalid branch-tree request");
		const entry = sessionCatalog.get(sessionId);
		// DSH / imagegen / videogen 会话没有 pi JSONL：面板按空态处理，不报错。
		if (!entry?.filePath || entry.backend === "dsh" || entry.backend === "imagegen" || entry.backend === "videogen" || entry.backend === "acp") return null;
		return agentManager.readSessionBranchTree(entry.filePath);
	});
	/** 子代理列表：从会话文件 subagents:record + catalog 子会话回填合成。 */
	ipcMain.handle(ipcChannels.sessionsListSubagents, async (_event, rawSessionId: unknown) => {
		const sessionId = parseSessionId(rawSessionId);
		const entry = sessionCatalog.get(sessionId);
		if (!entry?.filePath) return [];
		// 锚点对账要在读取侧做（liveRuntimeStartedAt）：record 完成时才写，运行中
		// 子代理只剩 start 锚点，不传对账时间会一律合成 stopped，面板在子代理
		// 实际运行期间误显「已停止」（issue #300）。本代派发的锚点 → running。
		const liveTarget = sessionRuntimeCoordinator.getTarget(sessionId);
		const liveTab = liveTarget ? agentManager.list().find((t) => t.id === liveTarget.agentId) : undefined;
		let records = await agentManager.readSessionSubagentRecords(entry.filePath, { liveRuntimeStartedAt: liveTab?.createdAt });
		// acp_delegate 推导条目在会话无活 runtime 时残留的 running 视为已终止：
		// 终态通知没写进文件（进程被杀/崩溃）的委托在历史会话里永远是 running，
		// 会误导为仍在运行；活会话保持 running，由后续通知/桥接覆盖。
		// 与 start 锚点残留合成 stopped 同一语义（见 downgradeStaleRunning）。
		if (!liveTarget) {
			if (!sessionRuntimeCoordinator.isActivating(sessionId)) {
				records = downgradeStaleRunning(records);
			}
		} else {
			// 活 runtime 也要对账：本代 runtime 启动（tab.createdAt）之前派发的
			// running/queued 已随上一代 pi 进程消亡，永远等不到终态写盘。渲染层
			// hook 在绑定出现时会重新拉取本列表，激活完成后即看到降级结果
			//（2026-09-14 用户环境实测：真实活动子代理 0，历史投影仍显示 33 个
			// running；启动之后派发的异步运行不受影响，保持 running）。
			if (liveTab?.createdAt) {
				records = downgradeRunningStartedBefore(records, liveTab.createdAt);
			}
		}
		// 回填 childSessionPath：按 parentSessionPath === 本会话 filePath 收集所有子会话，
		// 再按子会话名 `${type}#${id前8位}` 精确匹配。
		const children = sessionCatalog
			.listEntries()
			.filter((e) => e.parentSessionPath === entry.filePath)
			.map((e) => sessionCatalog.getRecord(e.id))
			.filter((r): r is NonNullable<typeof r> => r != null);
		for (const record of records) {
			const namePrefix = `${record.type}#${record.id.slice(0, 8)}`;
			const child = children.find((s) => (s.title ?? "").startsWith(namePrefix));
			const childSessionPath = child?.locator?.kind === "local" ? child.locator.filePath : undefined;
			if (childSessionPath) record.childSessionPath = childSessionPath;
			if (child) record.childSessionId = child.id;
		}
		// 列举子代理时顺带刷新会话级性能区间（按 id 幂等覆盖，重复列举不会膨胀）；
		// 读接口不推状态事件，避免把「看子代理列表」变成高频 runtime 推送。
		if (liveTarget?.agentId) {
			agentManager.syncSubagentPerfSpans(liveTarget.agentId, records, { emit: false });
		}
		return records;
	});
	/** 会话级 todo 快照：从会话文件 pi-deck-todo custom 条目重建最新计划（历史会话任务 tab）。 */
	ipcMain.handle(ipcChannels.sessionsListSessionTodo, async (_event, rawSessionId: unknown) => {
		const sessionId = parseSessionId(rawSessionId);
		const entry = sessionCatalog.get(sessionId);
		// DSH/生图/生视频会话无 pi 会话文件，无 todo 快照
		if (!entry?.filePath || entry.backend === "dsh" || entry.backend === "imagegen" || entry.backend === "videogen") return undefined;
		return agentManager.readSessionTodo(entry.filePath);
	});

	ipcMain.handle(ipcChannels.sessionsCatalogReadMessagePage, async (_event, rawSessionId: unknown, rawBefore?: unknown, rawPageSize?: unknown, rawOptions?: unknown) => {
		const sessionId = parseSessionId(rawSessionId);
		const before = parseSessionPageCursor(rawBefore);
		const pageSize = parseSessionPageSize(rawPageSize);
		const options = parseSessionPageOptions(rawOptions);
		const entry = sessionCatalog.get(sessionId);
		// 顺序要求（2026-10 修复）：远端分流必须在 `localSessionFilePath(sessionId)` **之前**——那一步对 ssh locator
		// 抛稳定码，放在前面会让整个远端分支变成不可达的死代码（重启后打开远端会话读不到历史的真因；运行中会话走
		// runtime 内存消息，所以真机验收当时没抓到）。
		// 远端会话的 catalog 记录是 ssh locator（`normalizeEntryLocator` 已清空 filePath）：本地路径读取对它
		// 永远不存在，落到下面的「无会话文件」分支会把远端历史读成空页并被 force 写进缓存。这里按 locator
		// 路由到远端有界读取（同一个 SessionMessagePage 契约，渲染层无需分叉）。
		const remoteLocator = entry?.locator?.kind === "ssh" ? entry.locator : undefined;
		if (remoteLocator) {
			// 游标含义：本地页是「活动分支消息下标」，这里是**远端文件字节偏移**（上一个窗口首行的偏移）；
			// 两者都是 number|null 的同一契约字段。`options.beforeEntryId` 是本地缓存路径的锚点，对远端不适用。
			if (!readRemoteSessionHistoryPage) throw new Error("REMOTE_SESSION_HISTORY_UNAVAILABLE");
			try {
				return await readRemoteSessionHistoryPage({ hostId: remoteLocator.hostId, locator: remoteLocator, ...(typeof before === "number" ? { before } : {}) });
			} catch (error) {
				// 失败必须是**可见的结构化失败**：渲染层靠 reject 显示明确错误态，而不是拿到空页
				// 当成「这个会话没有历史」（远端路径/命令行/远端 stderr 都不进日志，只记稳定码与身份）。
				appLogger.warn("session", "Read remote session history page failed", {
					sessionId,
					hostId: remoteLocator.hostId,
					error: error instanceof Error ? error.message : String(error),
				});
				throw error;
			}
		}
		if (entry?.backend === "acp") return acpMessagePage((await readAcpMessages?.(entry.acpSessionId ?? "")) ?? [], before, pageSize);
		// 顺序要求（2026-10 修复）：本机路径解析必须在远端分流之后 —— ssh 条目的 filePath 在规范化时
		// 已被清空，一旦远端分支被挪到它后面就会变成不可达的死代码。合并后本机路径就是 dev 的
		// `entry.filePath`（不再额外调 localSessionFilePath：它对 ssh 抛稳定码，且夹具无需提供该端口）。
		// DSH 会话没有 pi 会话文件：历史浏览走 host 的 session.history 事件流翻页
		// （游标 = 事件 seq），与 pi 的磁盘分页同形状（messages/total/nextBefore）；
		// 第三条参数在 pi 路径是「轮数」，所以 DSH 这里按 turnCount 传（main 侧换算消息预算）。
		if (entry?.backend === "dsh" && entry.dshSessionId && readDshHistoryPage) {
			try {
				const page = await readDshHistoryPage(entry.dshSessionId, before, { turnCount: pageSize });
				// 打开会话（首屏/上翻）顺带把 host 会话模型补录回 catalog：
				// 冷会话真值只在 host 投影里，缺 model 时底栏会错误显示全局部署默认。
				void backfillDshSessionModel(sessionId);
				return page;
			} catch (error) {
				// 手动停止态下历史读取必然失败且不会自愈（预热/按需兜底/崩溃重启全被门控）：
				// 转成带原因的空页，让渲染层出「运行时已停止 + 启动 host」专态，而不是把
				// host 未运行报成「会话文件已删除/路径失效」——DSH 会话没有 pi 会话文件。
				// 其余错误（host 崩溃 / 文件损坏）继续抛，渲染层按普通失败处理。
				// 运行时未安装（#375）与手动停止一样属于「可解释的不可用」，同样不该把原始
				// MODULE_NOT_FOUND 抛给渲染层；其余错误（host 崩溃 / 文件损坏）继续抛。
				const unavailable = dshUnavailablePageFor(error) ?? dshRuntimeMissingPageFor(error);
				if (unavailable) return unavailable;
				throw error;
			}
		}
		if (entry?.backend === "imagegen" || entry?.backend === "videogen" || !entry?.filePath) {
			// imagegen/videogen 后端会话（可能残留无意义 pi filePath）或纯生图草稿：
			// 走独立存储恢复历史（生图 ImageSession / 生视频 VideoSession），避免落到不存在的 pi 文件
			const independentMessages = entry?.backend === "videogen" ? ((await readVideoSessionMessages?.(sessionId)) ?? []) : ((await readImageSessionMessages?.(sessionId)) ?? []);
			if (independentMessages.length > 0) {
				return {
					messages: independentMessages,
					total: independentMessages.length,
					nextBefore: null,
				};
			}
			return { messages: [], total: 0, nextBefore: null };
		}
		// 读盘失败（文件被删/路径失效/解析异常）不能静默：渲染层靠 reject 显示明确错误态，
		// 否则「正在加载历史」骨架无限滞留（2026-08 生图会话文件缺失反馈）。
		try {
			let page: SessionMessagePage;
			// Pi 历史统一按完整轮次分页：磁盘会话首次打开、继续上翻、
			// 以及运行时窗口补历史都共享同一页边界和游标协议。
			// 缓存优先（2026-11）：运行中会话翻历史先在主进程内存缓存切片，命中免文件 IO；
			// 未命中（缓存未覆盖/非活跃会话）回退 SessionHistoryReader 读文件。
			// 注意：缓存按 transient agentId 键控，必须经 coordinator 把稳定 sessionId
			// 解析成当前运行时 agentId；解析不到（非活跃/终端绑定）直接走文件路径。
			if (options?.beforeEntryId || typeof before === "number") {
				const target = sessionRuntimeCoordinator.getTarget(sessionId);
				if (target) {
					const cached = await agentManager
						.tryReadRuntimeTurnPage(entry.filePath, target.agentId, {
							beforeEntryId: options?.beforeEntryId,
							before,
							turnCount: pageSize,
						})
						.catch(() => null);
					if (cached) return cached;
				}
			}
			page = await agentManager.readSessionDisplayTurnPage(entry.filePath, sessionId, before, pageSize, options?.beforeEntryId, { projectId: entry.projectId });
			await backfillHistoricalSessionMetadata(sessionId, page);
			return page;
		} catch (error) {
			// 文件还不存在（新建会话在发出第一条消息前不落盘，微信/飞书桥建的会话尤其常见）：
			// 这是「还没有内容」而不是读取故障，返回带原因的友好空页，
			// 避免把 ENOENT 报成「会话历史加载失败/文件已删除」（2026-10 微信 /new 反馈）。
			const missingFile = missingSessionFilePage(error);
			if (missingFile) {
				appLogger.info("session", "Read message page: session file not written yet", { sessionId, filePath: entry.filePath });
				return missingFile;
			}
			// 文件读取失败（被删/路径失效）先查 ImageSession 兜底，命中则直接恢复历史；
			// 都无记录才按失败处理（渲染层显示明确错误态 + 日志）。
			const imageSessionMessages = (await readImageSessionMessages?.(sessionId)) ?? [];
			if (imageSessionMessages.length > 0) {
				return {
					messages: imageSessionMessages,
					total: imageSessionMessages.length,
					nextBefore: null,
				};
			}
			appLogger.warn("session", "Read message page failed", {
				sessionId,
				filePath: entry.filePath,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	});
	ipcMain.handle(ipcChannels.sessionsCatalogReadProcessEvents, async (_event, sessionId: string): Promise<SessionFactsResult> => {
		const unavailable = (reason: SessionFactsCoverage["reason"]): SessionFactsResult => ({ events: [], version: "", coverage: { fromStart: true, chainComplete: true, readComplete: true, eventsTrimmed: false, ...(reason ? { reason } : {}) } });
		if (typeof sessionId !== "string" || !sessionId.trim()) return unavailable("unavailable");
		const entry = sessionCatalog.get(sessionId);
		const sessionFilePath = localSessionFilePath(sessionId);
		// DSH 会话没有 pi 会话文件：过程事件由运行时会话按 mux/重放收集，
		// 历史（未激活）会话从 host history 事件流推导（轨迹账本的
		// modelChange/permission/plan/goal/compaction 记录）。
		if (entry?.backend === "dsh" && readDshProcessEvents) {
			const target = sessionRuntimeCoordinator.getTarget(sessionId);
			const { events, fromStart, unavailable } = await readDshProcessEvents(target?.agentId, entry.dshSessionId);
			const last = events.at(-1);
			if (events.length === 0) appLogger.debug("trajectory", "DSH process events empty", { sessionId, dshSessionId: entry.dshSessionId, unavailable: unavailable === true });
			return {
				events,
				version: `dsh:${events.length}:${last?.id ?? ""}:${last?.seq ?? ""}`,
				coverage: {
					fromStart,
					chainComplete: true,
					readComplete: true,
					eventsTrimmed: false,
					...(unavailable ? { reason: "unavailable" as const } : fromStart ? {} : { reason: "history-window" as const }),
				},
			};
		}
		if (!entry?.filePath) return unavailable("unavailable");
		if (readSessionFacts) {
			// 索引候选 + 小批读 + 内容版本缓存：文件未变时不读正文（见 trajectoryFactsReader）。
			try {
				const facts = await readSessionFacts(entry.filePath);
				if (facts.events.length === 0) appLogger.debug("trajectory", "pi process events empty", { sessionId, filePath: entry.filePath, reason: facts.coverage.reason ?? null });
				return facts;
			} catch (error) {
				appLogger.warn("trajectory", "Read session facts failed", {
					sessionId,
					filePath: entry.filePath,
					error: error instanceof Error ? error.message : String(error),
				});
				return unavailable("unavailable");
			}
		}
		// 无索引入口时回退流式扫描（有界尾巴，仍受事件保留上限约束）。
		return { events: await parseSessionProcessEventsFromFile(entry.filePath), version: "", coverage: { fromStart: true, chainComplete: true, readComplete: true, eventsTrimmed: false } };
	});
	// 导轨目录：只给用户检查点坐标（entryId + messageIndex + turnOrdinal），不带正文。
	// 入参只有 sessionId 与可选上限（渲染层数据不可信，上限在边界夹紧）。
	ipcMain.handle(ipcChannels.sessionsCatalogReadOutline, async (_event, sessionId: unknown, limit?: unknown): Promise<OutlineSnapshot> => {
		const empty: OutlineSnapshot = { entries: [], total: 0, truncated: false };
		if (typeof sessionId !== "string" || !sessionId.trim()) return empty;
		const entry = sessionCatalog.get(sessionId);
		if (!entry?.filePath || !readSessionOutline) return empty;
		const bounded = typeof limit === "number" && Number.isFinite(limit) ? Math.min(Math.max(Math.floor(limit), 1), 10_000) : undefined;
		return readSessionOutline(entry.filePath, bounded);
	});
	// 边界校验 + 本地会话文件存在性判定：远端/DSH 会话没有本机文件，直接返回空（引用面板不展示）。
	ipcMain.handle(ipcChannels.sessionsCatalogReadReferenceMessages, async (_event, rawSessionId: unknown) => {
		const sessionId = parseSessionId(rawSessionId);
		const filePath = localSessionFilePath(sessionId);
		return filePath ? readCatalogSessionReferenceMessages(sessionId) : [];
	});
	// 按需读取消息完整文本（工具结果截断后的「查看完整输出」）：
	// 入参校验在边界（渲染层数据不可信），agentId/messageId 必须为非空字符串。
	// 运行期路径（agentId 绑定）不可用时（历史会话 _viewer 投影 / agent 已退出）
	// 回退会话文件定位（sessionId → catalog filePath），保证历史浏览同样可展开全文。
	ipcMain.handle(ipcChannels.sessionsCatalogReadMessageFullText, async (_event, sessionId: unknown, agentId: unknown, messageId: unknown, entryId?: unknown) => {
		if (typeof agentId !== "string" || !agentId.trim() || typeof messageId !== "string" || !messageId.trim()) {
			throw new Error("Invalid message full-text request");
		}
		const requestedSessionId = sessionId === undefined ? undefined : parseSessionId(sessionId);
		if (entryId !== undefined && (typeof entryId !== "string" || !entryId.trim() || entryId.length > 256)) {
			throw new Error("Invalid entryId");
		}
		const messageEntryId = typeof entryId === "string" ? entryId : undefined;
		const requestedSessionPath = requestedSessionId ? localSessionFilePath(requestedSessionId) : undefined;
		try {
			// DSH 会话：工具结果全文随投影消息存内存（meta.fullText），
			// 走 DshAgentManager 直接读取；pi 走运行时缓存/会话文件。
			if (isDshAgent(agentId)) {
				if (!readDshMessageFullText) {
					throw new Error("dsh message full-text is not available");
				}
				return await readDshMessageFullText(agentId, messageId);
			}
			return await agentManager.readMessageFullText(agentId, messageId, messageEntryId);
		} catch (error) {
			if (requestedSessionPath) {
				return agentManager.readMessageFullTextFromFile(requestedSessionPath, messageId, messageEntryId);
			}
			throw error;
		}
	});
	// DSH 会话文件路径推导（F5：渲染层右键「复制会话文件路径」，历史会话无运行时 tab 也适用）
	ipcMain.handle(ipcChannels.sessionsGetDshSessionPath, async (_event, sessionId: unknown): Promise<string | undefined> => {
		if (typeof sessionId !== "string" || !sessionId.trim()) return undefined;
		if (!resolveDshSessionFilePath) return undefined;
		return resolveDshSessionFilePath(sessionId);
	});
	// DSH 会话内容搜索（G9：侧栏搜索框全文搜索，结果按 dshSessionId 映射回 catalog）
	ipcMain.handle(ipcChannels.sessionsSearchDsh, async (_event, query: unknown): Promise<Array<{ sessionId: string; snippet: string }>> => {
		if (typeof query !== "string" || !query.trim()) return [];
		if (!searchDshSessions) return [];
		return searchDshSessions(query);
	});
	// DSH 目标创建（G5：goal.create）
	ipcMain.handle(ipcChannels.dshCreateGoal, async (_event, agentId: unknown, objective: unknown, maxGoalRounds?: unknown): Promise<void> => {
		if (typeof agentId !== "string" || typeof objective !== "string") {
			throw new Error("Invalid goal create request");
		}
		if (!createDshGoal) throw new Error("dsh goals are not available");
		await createDshGoal(agentId, objective, typeof maxGoalRounds === "number" ? maxGoalRounds : undefined);
	});
	// DSH 目标操作（G5：pause/resume/complete/clear）
	ipcMain.handle(ipcChannels.dshGoalAction, async (_event, agentId: unknown, action: unknown): Promise<void> => {
		if (typeof agentId !== "string" || (action !== "pause" && action !== "resume" && action !== "complete" && action !== "clear")) {
			throw new Error("Invalid goal action request");
		}
		if (!runDshGoalAction) throw new Error("dsh goals are not available");
		await runDshGoalAction(agentId, action);
	});
	// DSH 子代理列表（G6）
	ipcMain.handle(ipcChannels.dshListSubagents, async (_event, agentId: unknown) => {
		if (typeof agentId !== "string") return [];
		if (!listDshSubagents) return [];
		return listDshSubagents(agentId);
	});
	// DSH 取消 host 侧排队消息（inbox 投影项的撤回）
	ipcMain.handle(ipcChannels.dshCancelQueuedMessage, async (_event, agentId: unknown, itemId: unknown) => {
		if (typeof agentId !== "string" || typeof itemId !== "string" || itemId === "") {
			throw new Error("Invalid agentId or queue item id");
		}
		if (!cancelDshQueuedMessage) throw new Error("dsh queue is not available");
		await cancelDshQueuedMessage(agentId, itemId);
	});
	// DSH 子代理历史（G6）
	ipcMain.handle(ipcChannels.dshSubagentHistory, async (_event, agentId: unknown, childSessionId: unknown, beforeSeq?: unknown, maxMessages?: unknown) => {
		if (typeof agentId !== "string" || typeof childSessionId !== "string") {
			return { messages: [], hasMore: false };
		}
		if (!readDshSubagentHistory) return { messages: [], hasMore: false };
		return readDshSubagentHistory(agentId, childSessionId, typeof beforeSeq === "number" ? beforeSeq : undefined, typeof maxMessages === "number" ? maxMessages : undefined);
	});
	// DSH 技能目录（G7：skill.list 只读；/name 斜杠调用提示由渲染层给）
	// 目标有两种寻址：agentId 字符串（运行中会话，工具面板/Web 端沿用）或
	// { sessionId }（草稿会话，技能选择器在会话启动前读取目录）。
	ipcMain.handle(ipcChannels.dshListSkills, async (_event, target: unknown) => {
		if (typeof target === "string") {
			if (!target.trim() || target.length > 256) return [];
			if (!listDshSkills) return [];
			return listDshSkills(target);
		}
		if (isRecord(target) && typeof target.sessionId === "string") {
			const sessionId = target.sessionId.trim();
			if (!sessionId || sessionId.length > 256) return [];
			if (!listDshSessionSkills) return [];
			return listDshSessionSkills(sessionId);
		}
		return [];
	});
	// DSH 孤儿会话列表（G3/D11：host 有但 catalog 无映射，用于清理提示）
	ipcMain.handle(ipcChannels.dshListOrphans, async (): Promise<string[]> => {
		if (!listDshOrphans) return [];
		return listDshOrphans();
	});
	// DSH 外部会话清单（跨工具兼容，2026-12）：dsh-web 等其他工具创建的 host 根会话，
	// 带标题/cwd，供配置页「导入」把 host 数据映射进 catalog（导入后侧栏可见可加载）。
	// 已映射进 catalog 的会话从清单过滤掉：导入后即从「待导入」列表消失，避免重复导入。
	ipcMain.handle(ipcChannels.dshListForeignSessions, async (): Promise<Array<{ dshSessionId: string; title?: string; cwd?: string; updatedAt?: number }>> => {
		if (!listDshForeignSessions) return [];
		const items = await listDshForeignSessions();
		const known = new Set(
			sessionCatalog
				.listEntries()
				.map((entry) => entry.dshSessionId)
				.filter((id): id is string => Boolean(id)),
		);
		const dismissed = sessionCatalog.listDismissedDshSessionIds();
		// 侧栏删过的 host 会话不要出现在「待导入」：否则看起来像没删掉。
		// 归档恢复仍走独立入口，会带 restoreDismissed 清墓碑。
		return items.filter((item) => !known.has(item.dshSessionId) && !dismissed.has(item.dshSessionId));
	});
	// DSH 外部会话导入：按 host 会话 id 建 catalog 映射（status=active，重启保留；
	// 同 dshSessionId 重复导入幂等吸收，见 SessionCatalog.createDraft）。
	ipcMain.handle(ipcChannels.dshImportForeignSession, async (_event, dshSessionId: unknown): Promise<import("../../shared/types").SessionRecord> => {
		if (typeof dshSessionId !== "string" || !/^session-[A-Za-z0-9-]+$/.test(dshSessionId)) {
			throw new Error(mainCopy("session.invalidArchivePath"));
		}
		if (!importDshForeignSession) throw new Error("DSH session import is not available");
		return importDshForeignSession(dshSessionId);
	});
	// DSH 外部会话全量同步：把 catalog 未映射的磁盘根会话全部导入（不启动 host），
	// 返回 { imported, skipped } 供配置页展示。未装配时返回空统计。
	ipcMain.handle(ipcChannels.dshSyncForeignSessions, async (): Promise<{ imported: number; skipped: number }> => {
		if (!syncDshForeignSessions) return { imported: 0, skipped: 0 };
		return syncDshForeignSessions();
	});
	// DSH 归档区会话清单（G14：目录已移入 .pideck-archive 的 host 会话，恢复入口用；含标题）
	ipcMain.handle(ipcChannels.dshListArchived, async (): Promise<ArchivedDshSession[]> => {
		if (!listArchivedDshSessions) return [];
		return listArchivedDshSessions();
	});
	// DSH 会话恢复（G14）：目录按 manifest 移回 sessions 树，并重建 catalog 记录
	ipcMain.handle(ipcChannels.dshUnarchive, async (_event, dshSessionId: unknown): Promise<boolean> => {
		// 入参校验：host 生成的会话 id 固定 "session-" 前缀（host 侧目录名 = sessionId），
		// 白名单正则挡掉路径穿越类输入（渲染层数据不可信，校验在边界）。
		if (typeof dshSessionId !== "string" || !/^session-[A-Za-z0-9-]+$/.test(dshSessionId)) {
			throw new Error(mainCopy("session.invalidArchivePath"));
		}
		if (!unarchiveDshSession) throw new Error("DSH archive restore is not available");
		const restored = await unarchiveDshSession(dshSessionId);
		if (!restored) throw new Error(mainCopy("session.invalidArchivePath"));
		// 重建 catalog 记录：按会话自己的 cwd 匹配或注册项目；没有 cwd 才兑底。
		// 打开会话时 DshAgentManager 用 project.path 当 cwd，挂错项目会 attach 错 workspace。
		const project = restored.cwd ? (projectStore.findByPath(restored.cwd) ?? (await projectStore.add(restored.cwd))) : await projectStore.ensureExternalSessionsProject(mainCopy("project.externalSessions"));
		const draft = await sessionCatalog.createDraft({
			projectId: project.id,
			// 恢复时优先用 manifest 里的原标题（旧归档由 DshHost 日志折叠补全），
			// 缺省才落「新会话」占位——否则侧栏恢复后显示不了真实会话名。
			title: restored.title ?? mainCopy("session.newTitle"),
			environment: "native",
			backend: "dsh",
		});
		// 归档恢复是用户明确找回：必须 active，并清掉删除墓碑，否则下次自动同步仍会跳过。
		await sessionCatalog.attachRuntime({
			sessionId: draft.id,
			dshSessionId,
			promoteToActive: true,
			restoreDismissed: true,
		});
		const window = getMainWindow();
		if (window && !window.isDestroyed()) {
			window.webContents.send(ipcChannels.sessionsCatalogRefreshed, { projectId: project.id });
		}
		void appLogger.info("session", "DSH session restored from archive", {
			dshSessionId,
			restoredPath: restored.restoredPath,
			projectId: project.id,
		});
		return true;
	});
	// DSH 永久删除已归档会话（G14：归档目录移入系统回收站，区别于恢复）
	ipcMain.handle(ipcChannels.dshDeleteArchived, async (_event, dshSessionId: unknown): Promise<boolean> => {
		// 入参校验：host 生成的会话 id 固定 "session-" 前缀（host 侧目录名 = sessionId），
		// 白名单正则挡掉路径穿越类输入（渲染层数据不可信，校验在边界）。
		if (typeof dshSessionId !== "string" || !/^session-[A-Za-z0-9-]+$/.test(dshSessionId)) {
			throw new Error(mainCopy("session.invalidArchivePath"));
		}
		if (!deleteArchivedDshSession) throw new Error("DSH archive delete is not available");
		const deleted = await deleteArchivedDshSession(dshSessionId);
		if (!deleted) throw new Error(mainCopy("session.invalidArchivePath"));
		void appLogger.info("session", "DSH archived session deleted", { dshSessionId });
		return true;
	});
	// DSH 动态插件管理（G13 深化：进程内临时扩展，define/run/stop/undefine）。
	// 语义校验（idPrefix 规则、源码单侧上限、会话归属）在 host 侧桥插件统一执行；
	// IPC 边界只做第一行类型检查（渲染层数据不可信）。
	ipcMain.handle(ipcChannels.dshPluginList, async (): Promise<import("../../shared/types").DshPluginView[]> => {
		if (!listDshDynamicPlugins) return [];
		return listDshDynamicPlugins();
	});
	ipcMain.handle(ipcChannels.dshPluginStaticList, async (): Promise<import("../../shared/types").DshStaticPluginView[]> => {
		if (!listDshStaticPlugins) return [];
		return listDshStaticPlugins();
	});
	// DSH 用户自装静态插件卸载：从 $DSH_HOME/cordis.patch.yml 移除行（+可选回收插件目录）。
	// 目标校验在 DshHost 侧（行必须真的来自用户补丁层，内置条目拒绝）；这里只做形状检查。
	ipcMain.handle(ipcChannels.dshPluginUserUninstall, async (_event, input: unknown): Promise<import("../../shared/types").DshUserPluginUninstallResult> => {
		if (typeof input !== "object" || input === null) {
			throw new Error("invalid user plugin uninstall payload");
		}
		const record = input as Record<string, unknown>;
		if (typeof record.entryId !== "string" || !record.entryId || typeof record.moduleName !== "string" || !record.moduleName) {
			throw new Error("invalid user plugin uninstall payload");
		}
		if (!uninstallDshUserPlugin) throw new Error("DSH user plugin uninstall is not available");
		return uninstallDshUserPlugin({
			entryId: record.entryId,
			moduleName: record.moduleName,
			deleteFiles: record.deleteFiles === true,
		});
	});
	// DSH 插件市场搜索：关键词 1-80 字符、无控制字符（渲染层输入不可信）。
	ipcMain.handle(ipcChannels.dshPluginMarketSearch, async (_event, keyword: unknown): Promise<import("../../shared/types").DshPluginMarketSearchResult> => {
		if (typeof keyword !== "string") throw new Error("invalid plugin market search payload");
		const validated = validateSearchKeyword(keyword);
		if (!validated.ok) throw new Error(validated.reason);
		if (!searchDshPluginMarket) throw new Error("DSH plugin market search is not available");
		return searchDshPluginMarket(validated.value);
	});
	// DSH 用户插件安装：spec 只接受 npm 包名或 name@精确版本（路径/range/tag 全拒）。
	ipcMain.handle(ipcChannels.dshPluginUserInstall, async (_event, input: unknown): Promise<import("../../shared/types").DshUserPluginInstallResult> => {
		if (typeof input !== "object" || input === null) throw new Error("invalid user plugin install payload");
		const record = input as Record<string, unknown>;
		if (typeof record.spec !== "string" || !record.spec.trim()) throw new Error("invalid user plugin install payload");
		const spec = validateNpmSpec(record.spec);
		if (!spec.ok) throw new Error(spec.reason);
		if (!installDshUserPlugin) throw new Error("DSH user plugin install is not available");
		return installDshUserPlugin(record.spec.trim());
	});
	// DSH 用户补丁层清单（安装服务视角；未装配返回空列表与既有 list 通道语义一致）。
	ipcMain.handle(ipcChannels.dshPluginUserList, async (): Promise<import("../../shared/types").DshUserPluginListEntry[]> => {
		if (!listDshUserPlugins) return [];
		return listDshUserPlugins();
	});
	ipcMain.handle(ipcChannels.dshPluginInstall, async (_event, input: unknown): Promise<unknown> => {
		if (typeof input !== "object" || input === null) {
			throw new Error("invalid plugin install payload");
		}
		const record = input as Record<string, unknown>;
		if (typeof record.sessionId !== "string" || !record.sessionId || typeof record.idPrefix !== "string" || !record.idPrefix || typeof record.name !== "string" || !record.name.trim() || typeof record.purpose !== "string" || !record.purpose.trim()) {
			throw new Error("invalid plugin install payload");
		}
		if (!installDshPlugin) throw new Error("DSH plugin install is not available");
		return installDshPlugin(input as import("../../shared/types").DshPluginInstallInput);
	});
	ipcMain.handle(ipcChannels.dshPluginRun, async (_event, input: unknown): Promise<unknown> => {
		if (typeof input !== "object" || input === null) {
			throw new Error("invalid plugin lifecycle payload");
		}
		const record = input as Record<string, unknown>;
		if (typeof record.sessionId !== "string" || !record.sessionId || typeof record.pluginId !== "string" || !record.pluginId) {
			throw new Error("invalid plugin lifecycle payload");
		}
		if (!runDshPlugin) throw new Error("DSH plugin run is not available");
		return runDshPlugin(input as import("../../shared/types").DshPluginLifecycleInput);
	});
	ipcMain.handle(ipcChannels.dshPluginStop, async (_event, input: unknown): Promise<unknown> => {
		if (typeof input !== "object" || input === null) {
			throw new Error("invalid plugin lifecycle payload");
		}
		const record = input as Record<string, unknown>;
		if (typeof record.sessionId !== "string" || !record.sessionId || typeof record.pluginId !== "string" || !record.pluginId) {
			throw new Error("invalid plugin lifecycle payload");
		}
		if (!stopDshPlugin) throw new Error("DSH plugin stop is not available");
		return stopDshPlugin(input as import("../../shared/types").DshPluginLifecycleInput);
	});
	ipcMain.handle(ipcChannels.dshPluginUninstall, async (_event, input: unknown): Promise<unknown> => {
		if (typeof input !== "object" || input === null) {
			throw new Error("invalid plugin lifecycle payload");
		}
		const record = input as Record<string, unknown>;
		if (typeof record.sessionId !== "string" || !record.sessionId || typeof record.pluginId !== "string" || !record.pluginId) {
			throw new Error("invalid plugin lifecycle payload");
		}
		if (!uninstallDshPlugin) throw new Error("DSH plugin uninstall is not available");
		return uninstallDshPlugin(input as import("../../shared/types").DshPluginLifecycleInput);
	});
	ipcMain.handle(ipcChannels.sessionsCatalogCopy, async (_event, rawSessionId: unknown) => {
		const sessionId = parseSessionId(rawSessionId);
		localSessionFilePath(sessionId);
		const result = await copyCatalogSession(sessionId);
		void appLogger.info("session", "Session copied", {
			sessionId,
			targetSessionId: result.cancelled ? undefined : result.targetSessionId,
		});
		return result;
	});
	ipcMain.handle(ipcChannels.sessionsCatalogExportHtml, async (_event, rawSessionId: unknown) => {
		const sessionId = parseSessionId(rawSessionId);
		// 远端会话是 ssh locator：`localSessionFilePath` 对它抛 UNSUPPORTED_PROJECT_LOCATION，所以**不能**先过
		// 本机守卫再导出。远端导出 = 远端有界窗口分页读（RemoteSessionHistoryReader）+ 本机写文件，HTML 渲染复用
		// DSH 投影式导出的同一个渲染器（不为远端再造模板）；端口未装配（远端实验开关关闭）时只抛稳定码，
		// 不回退成本机导出（那会把远端历史导成一份本机路径读不到的失败，或更糟：导出别人的本机会话）。
		if (sessionCatalog.getLocator(sessionId)?.kind === "ssh") {
			if (!exportRemoteCatalogSessionHtml) throw new Error(REMOTE_SESSION_EXPORT_CODES.unavailable);
			const remoteResult = await exportRemoteCatalogSessionHtml(sessionId);
			void appLogger.info("session", "Session exported (remote catalog HTML)", {
				sessionId,
				path: remoteResult.path,
				truncated: remoteResult.truncated,
			});
			return remoteResult;
		}
		localSessionFilePath(sessionId);
		const result = await exportCatalogSessionHtml(sessionId);
		void appLogger.info("session", "Session exported (catalog HTML)", {
			sessionId,
			path: result.path,
		});
		return result;
	});
	registerSessionImageMutationIpc(ipcMain, sessionRuntimeCoordinator, (error, context) => {
		logSessionCommandFailure(appLogger, error, { operation: "removeCatalogMessageImage", ...context });
	});
	// catalog 级消息改写：按 sessionId 操作 JSONL，不要求 live runtime。
	// 运行中必须先停（coordinator 拒绝 SESSION_RUNTIME_BUSY）；入参在边界校验。
	ipcMain.handle(ipcChannels.sessionsCatalogEditMessage, async (_event, sessionId: unknown, messageId: unknown, newText: unknown, entryId: unknown) => {
		if (typeof sessionId !== "string" || !sessionId.trim()) {
			throw new Error("Invalid catalog edit-message request");
		}
		if (typeof messageId !== "string" || !messageId.trim()) {
			throw new Error("Invalid catalog edit-message request");
		}
		if (typeof newText !== "string") {
			throw new Error("Invalid catalog edit-message request");
		}
		if (entryId !== undefined && typeof entryId !== "string") {
			throw new Error("Invalid catalog edit-message request");
		}
		const result = await sessionRuntimeCoordinator.editCatalogMessage(sessionId, messageId, newText, entryId as string | undefined);
		if (!result.ok) {
			logSessionCommandFailure(appLogger, result.error, {
				operation: "editCatalogMessage",
				sessionId,
				messageId,
			});
		}
		return result;
	});
	ipcMain.handle(ipcChannels.sessionsCatalogDeleteMessage, async (_event, sessionId: unknown, messageId: unknown, entryId: unknown) => {
		if (typeof sessionId !== "string" || !sessionId.trim()) {
			throw new Error("Invalid catalog delete-message request");
		}
		if (typeof messageId !== "string" || !messageId.trim()) {
			throw new Error("Invalid catalog delete-message request");
		}
		if (entryId !== undefined && typeof entryId !== "string") {
			throw new Error("Invalid catalog delete-message request");
		}
		const result = await sessionRuntimeCoordinator.deleteCatalogMessage(sessionId, messageId, entryId as string | undefined);
		if (!result.ok) {
			logSessionCommandFailure(appLogger, result.error, {
				operation: "deleteCatalogMessage",
				sessionId,
				messageId,
			});
		}
		return result;
	});
	ipcMain.handle(ipcChannels.sessionsCatalogPrepareResend, async (_event, sessionId: unknown, messageId: unknown, entryId: unknown) => {
		if (typeof sessionId !== "string" || !sessionId.trim()) {
			throw new Error("Invalid catalog prepare-resend request");
		}
		if (typeof messageId !== "string" || !messageId.trim()) {
			throw new Error("Invalid catalog prepare-resend request");
		}
		if (entryId !== undefined && typeof entryId !== "string") {
			throw new Error("Invalid catalog prepare-resend request");
		}
		const result = await sessionRuntimeCoordinator.prepareCatalogResend(sessionId, messageId, entryId as string | undefined);
		if (!result.ok) {
			logSessionCommandFailure(appLogger, result.error, {
				operation: "prepareCatalogResend",
				sessionId,
				messageId,
			});
		}
		return result;
	});
	ipcMain.handle(ipcChannels.sessionsSendPrompt, async (_event, input: SendSessionPromptInput) => {
		const startedAt = Date.now();
		void appLogger.info("session", "Session prompt IPC received", {
			sessionId: input.sessionId,
			requestId: input.requestId,
			messageLength: input.message.length,
			imageCount: input.images?.length ?? 0,
		});
		try {
			// 绑定了智能体的会话：注入角色设定。注入点是「发送前」的唯一收口，
			// 所有来源（桌面输入框/排队投递/Web）都经过这里，渲染层无需每个入口各拼一次。
			// 只改本轮载荷，不写会话文件：pi 的 agentMessage 对时间线不可见，dsh 退化为可见前缀。
			const persona = resolveSessionAgentInstruction?.(input.sessionId);
			const boundRecord = persona ? sessionCatalog.get(input.sessionId) : undefined;
			let promptInput: SendSessionPromptInput = input;
			if (persona && boundRecord) {
				const composed = composeAgentInstruction({ persona, message: input.message, existingAgentMessage: input.agentMessage, backend: boundRecord.backend });
				promptInput = { ...input, message: composed.message };
				// dsh 分支没有隐藏载荷：必须删掉原有 agentMessage，否则 host 拒收整条 prompt。
				if (composed.agentMessage === undefined) delete promptInput.agentMessage;
				else promptInput.agentMessage = composed.agentMessage;
				// 只记 id/后端/长度，角色设定是用户内容，不进日志。
				void appLogger.debug("session", "Bound agent persona injected", { sessionId: input.sessionId, backend: boundRecord.backend ?? "pi", personaChars: persona.length });
			}
			const result = await sessionRuntimeCoordinator.send(promptInput);
			if (result.agentId) {
				const tab = agentManager.list().find((candidate) => candidate.id === result.agentId);
				if (tab) emitSessionRuntimeEvent(tab.id, agentEventTags.agentsState, tab);
			}
			// 消息被接受才记「最后一次使用」（选而未发不算）：写入 desktop settings.lastUsedModel，
			// 新会话默认解析（launchDefaults）以它优先。fire-and-forget，不阻塞发送响应。
			// DSH 会话跳过：其模型归属 host 设置，不在 models.json 中，记录会污染 pi 侧解析。
			// 同时维护 recentProviders（最新在前，去重截断 8）：模型选择器按此优先排列供应商分组。
			if (result.accepted) {
				const record = sessionCatalog.get(input.sessionId);
				if (record?.backend !== "dsh" && record?.backend !== "acp" && record?.model?.provider && record?.model?.modelId) {
					const provider = record.model.provider;
					const current = settingsStore.get().recentProviders ?? [];
					// 当前供应商提到首位，其余保持原有相对顺序；SettingsStore 会做去重/截断/无变化早退。
					const recentProviders = [provider, ...current.filter((item) => item !== provider)];
					void settingsStore
						.update({
							lastUsedModel: {
								provider,
								modelId: record.model.modelId,
							},
							recentProviders,
						})
						.catch((error) => {
							void appLogger.warn("settings", "Failed to record lastUsedModel", {
								error: error instanceof Error ? error.message : String(error),
							});
						});
				}
			}
			void appLogger.info("session", "Session prompt IPC completed", {
				sessionId: input.sessionId,
				requestId: input.requestId,
				agentId: result.agentId,
				accepted: result.accepted,
				delivery: "delivery" in result ? result.delivery : undefined,
				totalMs: Date.now() - startedAt,
			});
			return result;
		} catch (error) {
			void appLogger.warn("session", "Session prompt IPC failed", {
				sessionId: input.sessionId,
				requestId: input.requestId,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	});
	ipcMain.handle(ipcChannels.sessionsUiResponse, (_event, input: SessionUiResponseInput) => sessionRuntimeCoordinator.respondToUi(input));
	ipcMain.handle(ipcChannels.sessionsRuntimeList, () => sessionRuntimeCoordinator.listRuntimes());
	ipcMain.handle(ipcChannels.sessionsRuntimeActivate, async (_event, sessionId: string) => {
		const startedAt = Date.now();
		void appLogger.info("session-perf", "Runtime activation IPC started", { sessionId });
		// 审计发现 A：coordinator.activate 在 bind() 之前不转发任何状态事件（ACP 握手
		// 可达 ~8.5s）。激活前先发 session 级合成 starting，渲染层立即进入加载动画，
		// 不再静默空窗；已有活 runtime 时（预热复用/快速路径）不发，避免闪状态。
		if (!sessionRuntimeCoordinator.hasLiveRuntime(sessionId)) emitSessionActivating?.(sessionId);
		const result = await sessionRuntimeCoordinator.activateRuntime(sessionId);
		if (result.ok) {
			// 激活完成后立即补发完整 tab 状态 + 消息窗口：deckSessionId/backend 让侧栏
			// ACP 配对即时生效（否则要等首个 agents:state 事件，期间 agent 行与 catalog
			// 行双行并存）；播种快照历史直接进时间线，不等首个回合。
			emitReplacementState(result.value, true);
		} else if (!sessionRuntimeCoordinator.hasLiveRuntime(sessionId)) {
			if (sessionRuntimeCoordinator.isActivationCancelled(sessionId)) {
				// 被换后端/换 ACP 工具作废：这不是失败（用户已经放弃了它，合成 error 会把刚切好的
				// 会话画成「启动失败」），但也不能什么都不发——上面的合成 starting 没人抵消，
				// 侧栏会一直停在「启动中」。发 detach 把加载态收敛回未绑定。
				emitSessionActivationCancelled?.(sessionId);
			} else {
				// 失败且无活 runtime（spawn 失败/握手超时，binding 从未建立）：合成 error
				// 抵消上面的合成 starting，加载态收敛为可重试的静态引导。
				emitSessionActivationFailed?.(sessionId);
			}
		}
		void appLogger.info("session-perf", "Runtime activation IPC completed", {
			sessionId,
			ok: result.ok,
			activationMs: Date.now() - startedAt,
			// 失败时带错误详情（此前只记 ok:false，排障要翻渲染层 toast）
			...(result.ok
				? {}
				: {
						error: result.error?.debugDetails ?? JSON.stringify(result.error),
					}),
		});
		return result;
	});
	// 渲染层切换会话时汇报聚焦会话；主进程据此判断 Ask 类请求是否需要桌面通知
	ipcMain.handle(ipcChannels.sessionsSetFocusedSession, (_event, sessionId: unknown) => {
		sessionRuntimeCoordinator.setFocusedSession(typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : undefined);
	});
	// 可见会话登记：决定哪些会话的 live 正文/思考值得跨进程推送（discussion #446）。
	// 只接受主窗口上报——极简浮窗是独立渲染进程，它显示的会话在主窗口不一定可见；
	// 新可见的会话立即补一帧全量 live，避免切回来先看到半截内容。
	ipcMain.handle(ipcChannels.sessionsSetVisibleSessions, (event, input: unknown) => {
		const window = getMainWindow();
		if (!window || window.isDestroyed() || event.sender !== window.webContents) return;
		for (const sessionId of visibleSessions.update(input)) {
			const target = sessionRuntimeCoordinator.getTarget(sessionId);
			if (target) emitLiveSnapshot(target.agentId);
		}
	});
	ipcMain.handle(ipcChannels.dshListModels, async () => (listDshModels ? listDshModels() : []));
	ipcMain.handle(ipcChannels.dshDiscoverModels, async (_event, input: unknown) => {
		if (!isDshModelDiscoveryInput(input)) {
			throw new Error("Invalid DSH model discovery input");
		}
		if (!discoverDshModels) throw new Error("DSH model discovery is not available");
		return discoverDshModels(input);
	});
	ipcMain.handle(ipcChannels.dshListProviders, async () => (listDshProviders ? listDshProviders() : []));
	ipcMain.handle(ipcChannels.dshAgentPresets, async () => (listDshAgentPresets ? listDshAgentPresets() : []));
	ipcMain.handle(ipcChannels.dshDefaultModel, async () => (getDshDefaultModel ? getDshDefaultModel() : undefined));
	ipcMain.handle(ipcChannels.dshGetStatus, async () => (getDshStatus ? getDshStatus() : { started: false, homeDir: "", bootError: null }));
	// DSH runtime 安装态查询：未装配 dshBackend = 无 DSH 后端，按 notInstalled 返回
	//（渲染层据此隐藏 DSH UI、显示安装引导，不会出现裸报错）。
	ipcMain.handle(ipcChannels.dshRuntimeGetStatus, async () => (getDshRuntimeStatus ? getDshRuntimeStatus() : { state: "notInstalled" as const }));
	// DSH runtime 安装（阶段 2）：进度不走返回值，经 dsh-runtime:install-progress 推送，
	// 因为下载可能持续数十秒——返回 promise 会让渲染层一直空转等待。
	ipcMain.handle(ipcChannels.dshRuntimeInstall, async () => {
		if (!installDshRuntime) throw new Error("DSH runtime installation is not available");
		return installDshRuntime();
	});
	ipcMain.handle(ipcChannels.dshRuntimeInstallLocal, async () => {
		if (!importDshRuntime) throw new Error("DSH runtime installation is not available");
		// 对话框在主进程弹：渲染层不参与路径选择，也就没有「传任意路径读文件」的入口。
		const picked = await dialog.showOpenDialog({
			title: mainCopy("dsh.runtime.pickArchiveTitle"),
			// 只收归档：与目录入口分开弹。Windows 上 openFile + openDirectory 同时给会
			// 退化成只能选目录，.tgz 选不到（见 shared/ipc.ts 的 dshRuntimeInstallLocalDir）。
			filters: [{ name: "DSH runtime", extensions: ["tgz", "gz"] }],
			properties: ["openFile"],
		});
		if (picked.canceled || picked.filePaths.length === 0) return { ok: false, error: "cancelled" };
		const filePath = picked.filePaths[0];
		// 归档文件或已解压目录都允许（目录由 installer 按类型分流处理）。
		if (!filePath || !existsSync(filePath)) {
			throw new Error(mainCopy("dsh.runtime.invalidArchivePath"));
		}
		return importDshRuntime(filePath);
	});
	ipcMain.handle(ipcChannels.dshRuntimeInstallLocalDir, async () => {
		if (!importDshRuntime) throw new Error("DSH runtime installation is not available");
		const picked = await dialog.showOpenDialog({
			title: mainCopy("dsh.runtime.pickDirectoryTitle"),
			properties: ["openDirectory"],
		});
		if (picked.canceled || picked.filePaths.length === 0) return { ok: false, error: "cancelled" };
		const dirPath = picked.filePaths[0];
		if (!dirPath || !existsSync(dirPath)) {
			throw new Error(mainCopy("dsh.runtime.invalidArchivePath"));
		}
		return importDshRuntime(dirPath);
	});
	ipcMain.handle(ipcChannels.dshRuntimeUninstall, async () => {
		if (!uninstallDshRuntime) throw new Error("DSH runtime installation is not available");
		return uninstallDshRuntime();
	});
	ipcMain.handle(ipcChannels.dshConfigDescribe, async () => (describeDshSettings ? describeDshSettings() : { writable: false, hasDocument: false, namespaces: [] }));
	ipcMain.handle(ipcChannels.dshConfigUpdate, async (_event, ns: string, patch: Record<string, unknown>, expectedRevision?: number) => {
		if (!updateDshSettings) throw new Error("DSH settings are not available");
		return updateDshSettings(ns, patch, expectedRevision);
	});
	ipcMain.handle(ipcChannels.dshConfigMutate, async (_event, ns: string, ops: Array<{ op: "set"; path: string[]; value: unknown } | { op: "unset"; path: string[] }>, expectedRevision?: number) => {
		if (!mutateDshSettings) throw new Error("DSH settings are not available");
		return mutateDshSettings(ns, ops, expectedRevision);
	});
	ipcMain.handle(ipcChannels.dshCredentialDescribe, async (_event, refs: string[]) => (describeDshCredentials ? describeDshCredentials(refs) : {}));
	ipcMain.handle(ipcChannels.dshCredentialSet, async (_event, ref: string, value: string) => {
		if (!setDshCredential) throw new Error("DSH credentials are not available");
		await setDshCredential(ref, value);
	});
	ipcMain.handle(ipcChannels.dshCredentialUnset, async (_event, ref: string) => {
		if (!unsetDshCredential) throw new Error("DSH credentials are not available");
		await unsetDshCredential(ref);
	});
	// 凭证明文读取：渲染层点「眼睛」时按 ref 取一次（无值返回 undefined）。
	// ref 格式校验与 DSH credentialRef 同规则，防路径注入。
	ipcMain.handle(ipcChannels.dshCredentialRead, async (_event, ref: unknown) => {
		if (!readDshCredential) throw new Error("DSH credentials are not available");
		if (typeof ref !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) {
			throw new Error(`invalid credential ref: ${String(ref)}`);
		}
		return readDshCredential(ref);
	});
	ipcMain.handle(ipcChannels.dshOpenDocument, async () => {
		if (!openDshDocument) throw new Error("DSH settings document is not available");
		await openDshDocument();
	});
	ipcMain.handle(ipcChannels.dshRestartHost, async () => {
		if (!restartDshHost) throw new Error("DSH host restart is not available");
		return restartDshHost();
	});
	ipcMain.handle(ipcChannels.dshStopHost, async () => {
		if (!stopDshHost) throw new Error("DSH host stop is not available");
		return stopDshHost();
	});
	ipcMain.handle(ipcChannels.dshStartHost, async () => {
		if (!startDshHost) throw new Error("DSH host start is not available");
		return startDshHost();
	});
	ipcMain.handle(ipcChannels.sessionsRuntimeStop, (_event, target: SessionRuntimeTarget) => stopSessionRuntime(target));
	ipcMain.handle(ipcChannels.sessionsRuntimeAbort, (_event, target: SessionRuntimeTarget) => sessionRuntimeCoordinator.abortRuntime(target));
	ipcMain.handle(ipcChannels.sessionsRuntimeRestart, async (_event, target: SessionRuntimeTarget) => {
		terminalManager.closeAgent(target.agentId);
		const result = await sessionRuntimeCoordinator.restartRuntime(target);
		if (result.ok) {
			// A --no-session restart is a binding replacement, not a close. Its
			// higher generation state event clears old runtime UI without deleting
			// the transient SessionRecord from the renderer.
			if (!result.value.session.noSession) emitSessionRuntimeDetach(target);
			// 必须重下发消息窗口（含状态）：新 runtime 加载历史后的首次 flush 发生在
			// 绑定提交之前，emitSessionRuntimeEvent 的 getRuntimeBinding 会把它静默丢弃——
			// 若这里只补状态，渲染层会一直保留旧 runtime 的窗口/live 身份，
			// 重启后编辑/删除/重发会定位失败（MESSAGE_NOT_FOUND，2026-09 用户反馈）。
			// id 稳定性由 loadMessages 的会话级身份延续保证（stabilizeProjectedIdsFromIdentities），
			// 重下发不会触发整窗 remount/动画重放。
			emitReplacementState(result.value.runtime, true);
		}
		return result;
	});
	ipcMain.handle(ipcChannels.sessionsRuntimeCompact, (_event, target: SessionRuntimeTarget, prompt?: string) => sessionRuntimeCoordinator.compactRuntime(target, prompt));
	ipcMain.handle(ipcChannels.sessionsRuntimeState, (_event, target: SessionRuntimeTarget) => sessionRuntimeCoordinator.getRuntimeState(target));
	ipcMain.handle(ipcChannels.sessionsRuntimeCommands, (_event, target: SessionRuntimeTarget) => sessionRuntimeCoordinator.listRuntimeCommands(target));
	// 提示词模板正文：面板/气泡需要 `/<模板名>` 身份，而 pi 的 get_commands 只给路径。
	// 主进程按登记路径读回正文（含包带模板），渲染层据此在发送前本地展开并保留名字。
	// 读取失败/超限/非 prompt 来源一律跳过 → 渲染层退回「交给 pi 展开」（现状行为）。
	ipcMain.handle(ipcChannels.sessionsRuntimePromptTemplates, async (_event, target: SessionRuntimeTarget) => {
		const commands = await sessionRuntimeCoordinator.listRuntimeCommands(target);
		if (!commands.ok) return commands;
		const templates = await readRuntimePromptTemplateBodies(commands.value.value);
		return { ok: true as const, value: { target: commands.value.target, value: templates } };
	});
	ipcMain.handle(ipcChannels.sessionsRuntimeReloadResources, (_event, target: SessionRuntimeTarget) => sessionRuntimeCoordinator.reloadResources(target));
	// 草稿命令预览是只读提示增强：入参只有 projectId，非法值在 coordinator 层自然返回 null。
	ipcMain.handle(ipcChannels.sessionsDraftCommands, (_event, projectId: string) => {
		if (typeof projectId !== "string" || !projectId.trim()) return null;
		return sessionRuntimeCoordinator.draftCommands(projectId);
	});
	// 草稿会话的模板正文（尚无 runtime 时可用的同一份清单来源）。
	// 复用 standby 的命令预览借用：拿命令表 → 按 sourceInfo.path 读正文；离线/无池/失败返回 null，
	// 渲染层退回 prompts:list（旧行为）。这是「打开会话立刻发 /模板名」也能出 chip 的兜底。
	ipcMain.handle(ipcChannels.sessionsDraftPromptTemplates, async (_event, projectId: string) => {
		if (typeof projectId !== "string" || !projectId.trim()) return null;
		const commands = await sessionRuntimeCoordinator.draftCommands(projectId);
		if (!Array.isArray(commands) || commands.length === 0) return null;
		const templates = await readRuntimePromptTemplateBodies(commands);
		return templates.length > 0 ? templates : null;
	});
	ipcMain.handle(ipcChannels.sessionsRuntimeListModels, (_event, target: SessionRuntimeTarget) => sessionRuntimeCoordinator.listRuntimeModels(target));
	ipcMain.handle(ipcChannels.sessionsRuntimeThinkingLevels, (_event, target: SessionRuntimeTarget) => sessionRuntimeCoordinator.listRuntimeThinkingLevels(target));
	ipcMain.handle(ipcChannels.sessionsRuntimeExportHtml, async (_event, target: SessionRuntimeTarget) => {
		const result = await sessionRuntimeCoordinator.exportRuntimeHtml(target);
		void appLogger.info("session", "Session exported (runtime HTML)", {
			sessionId: target.sessionId,
			ok: result.ok,
		});
		return result;
	});
	ipcMain.handle(ipcChannels.sessionsRuntimeEditMessage, (_event, target: SessionRuntimeTarget, messageId: string, newText: string) => handleSessionCommandResult(appLogger, "editRuntimeMessage", target, { messageId }, () => sessionRuntimeCoordinator.editRuntimeMessage(target, messageId, newText)));
	ipcMain.handle(ipcChannels.sessionsRuntimeDeleteMessage, (_event, target: SessionRuntimeTarget, messageId: string) => handleSessionCommandResult(appLogger, "deleteRuntimeMessage", target, { messageId }, () => sessionRuntimeCoordinator.deleteRuntimeMessage(target, messageId)));
	// rewind checkpoint：list/diff 是只读命令（同 sessionsRuntimeCommands 风格），
	// restore 是变更操作，走 handleSessionCommandResult 留日志。
	ipcMain.handle(ipcChannels.sessionsRewindList, (_event, target: SessionRuntimeTarget, params?: RewindCheckpointPageParams) => sessionRuntimeCoordinator.listRewindCheckpoints(target, params));
	ipcMain.handle(ipcChannels.sessionsRewindDiff, (_event, target: SessionRuntimeTarget, checkpointId: string) => sessionRuntimeCoordinator.getRewindCheckpointDiff(target, checkpointId));
	ipcMain.handle(ipcChannels.sessionsRewindRestore, (_event, target: SessionRuntimeTarget, checkpointId: string, scope: unknown) => {
		// 渲染层入参不可信：scope 必须在契约枚举内（校验前置到 coordinator 之外再挡一层）。
		if (!isRewindRestoreScope(scope)) {
			return handleSessionCommandResult(appLogger, "restoreRewindCheckpoint", target, { checkpointId, scope: String(scope) }, () =>
				Promise.resolve({
					ok: false,
					error: {
						code: "SESSION_COMMAND_FAILED",
						debugDetails: `Invalid rewind restore scope: ${String(scope)}`,
					},
				}),
			);
		}
		return handleSessionCommandResult(appLogger, "restoreRewindCheckpoint", target, { checkpointId, scope }, async () => {
			const result = await sessionRuntimeCoordinator.restoreRewindCheckpoint(target, checkpointId, scope);
			// conversation/all 会在检查点 fork 出新会话（runtime 已换绑新文件）：
			// 趁运行态拿到新 sessionPath，同步给 catalog 打 fork 标记（列表 (fork) 后缀），
			// 不依赖后续扫描才识别。fork 锚点解析失败时不会走到这一步。
			if (result.ok && scope !== "files") {
				const tab = agentManager.list().find((candidate) => candidate.id === target.agentId);
				if (tab?.sessionPath) {
					const environment = tab.sessionEnvironment ?? "native";
					const entry = sessionCatalog.findByFilePath(tab.sessionPath, environment);
					if (entry) {
						await sessionCatalog.update(entry.id, { forked: true });
						// (fork) 物理写进会话名（与 fork/clone 一致，见 appendSessionForkSuffix）：
						// 走 pi set_session_name RPC。注意 rewind 恢复不重建 runtime 绑定
						// （绑定仍指向原会话），rename 触发的标题回写会落到原条目标题上，
						// 因此记录原条目标题并在完成后恢复，避免「原会话被改名成 xxx (fork)」。
						const forkedTitle = appendSessionForkSuffix(entry.title, mainCopy("session.forkedSuffix"));
						if (forkedTitle !== entry.title) {
							const originBinding = sessionRuntimeCoordinator.getRuntimeBinding(target.agentId);
							const originSessionId = originBinding?.sessionId;
							const originTitle = originSessionId && originSessionId !== entry.id ? sessionCatalog.get(originSessionId)?.title : undefined;
							try {
								await agentManager.rename(target.agentId, forkedTitle);
								await sessionCatalog.update(entry.id, { title: forkedTitle });
								if (originSessionId && originTitle !== undefined) {
									await sessionCatalog.update(originSessionId, { title: originTitle });
								}
							} catch (error) {
								void appLogger.warn("session", "Rewind fork suffix rename failed", {
									sessionId: entry.id,
									agentId: target.agentId,
									title: entry.title,
									error: error instanceof Error ? error.message : String(error),
								});
							}
						}
					}
				}
			}
			return result;
		});
	});
	ipcMain.handle(ipcChannels.sessionsRuntimePrepareResend, (_event, target: SessionRuntimeTarget, messageId: string) => handleSessionCommandResult(appLogger, "prepareRuntimeResend", target, { messageId }, () => sessionRuntimeCoordinator.prepareRuntimeResend(target, messageId)));
	ipcMain.handle(ipcChannels.sessionsRuntimeSetModel, (_event, target: SessionRuntimeTarget, provider: unknown, modelId: unknown, modelName?: unknown) => {
		if (typeof provider !== "string" || typeof modelId !== "string" || (modelName !== undefined && typeof modelName !== "string") || !provider.trim() || !modelId.trim() || provider.length > 128 || modelId.length > 256 || (typeof modelName === "string" && modelName.length > 256)) {
			return Promise.resolve({
				ok: false as const,
				error: {
					code: "SESSION_COMMAND_FAILED" as const,
					debugDetails: "Invalid model selection",
				},
			});
		}
		return sessionRuntimeCoordinator.setRuntimeModel(target, provider.trim(), modelId.trim(), modelName);
	});
	ipcMain.handle(ipcChannels.sessionsRuntimeSetThinking, (_event, target: SessionRuntimeTarget, level: string) => sessionRuntimeCoordinator.setRuntimeThinking(target, level));
	ipcMain.handle(ipcChannels.sessionsRuntimeSetPermission, (_event, target: SessionRuntimeTarget, preset: string) => {
		// Renderer input is untrusted: reject values outside DSH's finite preset
		// set before they can reach the backend or be persisted in the catalog.
		if (!isDshPermissionPreset(preset)) {
			return Promise.resolve({
				ok: false as const,
				error: {
					code: "SESSION_COMMAND_FAILED" as const,
					debugDetails: `Unsupported DSH permission preset: ${String(preset)}`,
				},
			});
		}
		return sessionRuntimeCoordinator.setRuntimePermission(target, preset);
	});
	// fork/clone 命令链已收口到 sessionForkCommands（与 Web HTTP 同源）：重发/编辑
	// fork 化（mutationFork/branchMode）、supersededBy 隐藏、DSH 分流、catalog 刷新广播
	// 都在那一层维护，两端行为必须一致（Web 重发后出现两个重复会话的教训）。
	// 命令失败一律经 handleSessionCommandResult 落 session-command 日志。fork 尤其不能静默：
	// 它前面可能刚花十几秒激活 runtime，失败后渲染层只弹一条 5s 就消失的 toast，
	// 现场（2026-10 真机）表现为「点了没反应 + 主进程零日志」。
	ipcMain.handle(ipcChannels.sessionsRuntimeClone, (_event, target: SessionRuntimeTarget) => handleSessionCommandResult(appLogger, "cloneRuntimeSession", target, {}, () => deps.sessionForkCommands.cloneRuntimeSession(target)));
	ipcMain.handle(ipcChannels.sessionsRuntimeGetForkMessages, (_event, target: SessionRuntimeTarget) => handleSessionCommandResult(appLogger, "getRuntimeForkMessages", target, {}, () => sessionRuntimeCoordinator.getRuntimeForkMessages(target)));
	ipcMain.handle(ipcChannels.sessionsRuntimeFork, (_event, target: SessionRuntimeTarget, entryId: string, options?: { mutationFork?: boolean; branchMode?: boolean }) =>
		handleSessionCommandResult(appLogger, "forkRuntimeSession", target, { entryId, mutationFork: options?.mutationFork === true, branchMode: options?.branchMode === true }, () => deps.sessionForkCommands.forkRuntimeSession(target, entryId, options)),
	);
	ipcMain.handle(ipcChannels.codexSessionsScan, async (_event, projectId: string) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		if (!isLocalProject(project)) throw new Error("UNSUPPORTED_PROJECT_LOCATION");
		const result = await codexSessionImporter.scan(project.path);
		void appLogger.debug("session", "Codex sessions scanned", { projectId });
		return result;
	});
	ipcMain.handle(ipcChannels.codexSessionsImport, async (_event, projectId: string, sourcePaths: string[]) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		if (!isLocalProject(project)) throw new Error("UNSUPPORTED_PROJECT_LOCATION");
		const result = await codexSessionImporter.import(project.path, sourcePaths);
		void appLogger.info("session", "Codex sessions imported", {
			projectId,
			sourceCount: sourcePaths.length,
		});
		return result;
	});
	ipcMain.handle(ipcChannels.claudeSessionsScan, async (_event, projectId: string) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		if (!isLocalProject(project)) throw new Error("UNSUPPORTED_PROJECT_LOCATION");
		const result = await claudeSessionImporter.scan(project.path);
		void appLogger.debug("session", "Claude sessions scanned", { projectId });
		return result;
	});
	ipcMain.handle(ipcChannels.claudeSessionsImport, async (_event, projectId: string, sourcePaths: string[]) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		if (!isLocalProject(project)) throw new Error("UNSUPPORTED_PROJECT_LOCATION");
		const result = await claudeSessionImporter.import(project.path, sourcePaths);
		void appLogger.info("session", "Claude sessions imported", {
			projectId,
			sourceCount: sourcePaths.length,
		});
		return result;
	});
	ipcMain.handle(ipcChannels.qoderSessionsScan, async (_event, projectId: string) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		// Qoder 导入只对本地目录成立：远端项目没有本机 path（与上面 Claude/OpenCode 同口径）。
		if (!isLocalProject(project)) throw new Error("UNSUPPORTED_PROJECT_LOCATION");
		const result = await qoderSessionImporter.scan(project.path);
		void appLogger.debug("session", "Qoder sessions scanned", { projectId });
		return result;
	});
	ipcMain.handle(ipcChannels.qoderSessionsImport, async (_event, projectId: string, sourcePaths: string[]) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		if (!isLocalProject(project)) throw new Error("UNSUPPORTED_PROJECT_LOCATION");
		const result = await qoderSessionImporter.import(project.path, sourcePaths);
		void appLogger.info("session", "Qoder sessions imported", {
			projectId,
			sourceCount: sourcePaths.length,
		});
		return result;
	});
	ipcMain.handle(ipcChannels.openCodeSessionsScan, async (_event, projectId: string) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		if (!isLocalProject(project)) throw new Error("UNSUPPORTED_PROJECT_LOCATION");
		const result = await openCodeSessionImporter.scan(project.path);
		void appLogger.debug("session", "OpenCode sessions scanned", { projectId });
		return result;
	});
	ipcMain.handle(ipcChannels.openCodeSessionsImport, async (_event, projectId: string, sourcePaths: string[]) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		if (!isLocalProject(project)) throw new Error("UNSUPPORTED_PROJECT_LOCATION");
		const result = await openCodeSessionImporter.import(project.path, sourcePaths);
		void appLogger.info("session", "OpenCode sessions imported", {
			projectId,
			sourceCount: sourcePaths.length,
		});
		return result;
	});
	ipcMain.handle(ipcChannels.zcodeSessionsScan, async (_event, projectId: string) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		if (!isLocalProject(project)) throw new Error("UNSUPPORTED_PROJECT_LOCATION");
		const result = await zcodeSessionImporter.scan(project.path);
		void appLogger.debug("session", "ZCode sessions scanned", { projectId });
		return result;
	});
	ipcMain.handle(ipcChannels.zcodeSessionsImport, async (_event, projectId: string, sourcePaths: string[]) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		if (!isLocalProject(project)) throw new Error("UNSUPPORTED_PROJECT_LOCATION");
		const result = await zcodeSessionImporter.import(project.path, sourcePaths);
		void appLogger.info("session", "ZCode sessions imported", {
			projectId,
			sourceCount: sourcePaths.length,
		});
		return result;
	});
	ipcMain.handle(ipcChannels.workbuddySessionsScan, async (_event, projectId: string) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		if (!isLocalProject(project)) throw new Error("UNSUPPORTED_PROJECT_LOCATION");
		const result = await workbuddySessionImporter.scan(project.path);
		void appLogger.debug("session", "WorkBuddy sessions scanned", { projectId });
		return result;
	});
	ipcMain.handle(ipcChannels.workbuddySessionsImport, async (_event, projectId: string, sourcePaths: string[]) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		if (!isLocalProject(project)) throw new Error("UNSUPPORTED_PROJECT_LOCATION");
		const result = await workbuddySessionImporter.import(project.path, sourcePaths);
		void appLogger.info("session", "WorkBuddy sessions imported", {
			projectId,
			sourceCount: sourcePaths.length,
		});
		return result;
	});
	ipcMain.handle(ipcChannels.codebuddySessionsScan, async (_event, projectId: string) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		if (!isLocalProject(project)) throw new Error("UNSUPPORTED_PROJECT_LOCATION");
		const result = await codebuddySessionImporter.scan(project.path);
		void appLogger.debug("session", "CodeBuddy sessions scanned", { projectId });
		return result;
	});
	ipcMain.handle(ipcChannels.codebuddySessionsImport, async (_event, projectId: string, sourcePaths: string[]) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		if (!isLocalProject(project)) throw new Error("UNSUPPORTED_PROJECT_LOCATION");
		const result = await codebuddySessionImporter.import(project.path, sourcePaths);
		void appLogger.info("session", "CodeBuddy sessions imported", {
			projectId,
			sourceCount: sourcePaths.length,
		});
		return result;
	});
	ipcMain.handle(ipcChannels.cursorSessionsScan, async (_event, projectId: string) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		if (!isLocalProject(project)) throw new Error("UNSUPPORTED_PROJECT_LOCATION");
		const result = await cursorSessionImporter.scan(project.path);
		void appLogger.debug("session", "Cursor sessions scanned", { projectId });
		return result;
	});
	ipcMain.handle(ipcChannels.cursorSessionsImport, async (_event, projectId: string, sourcePaths: string[]) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		if (!isLocalProject(project)) throw new Error("UNSUPPORTED_PROJECT_LOCATION");
		const result = await cursorSessionImporter.import(project.path, sourcePaths);
		void appLogger.info("session", "Cursor sessions imported", {
			projectId,
			sourceCount: sourcePaths.length,
		});
		return result;
	});
	ipcMain.handle(ipcChannels.kimiSessionsScan, async (_event, projectId: string) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		if (!isLocalProject(project)) throw new Error("UNSUPPORTED_PROJECT_LOCATION");
		const result = await kimiSessionImporter.scan(project.path);
		void appLogger.debug("session", "Kimi sessions scanned", { projectId });
		return result;
	});
	ipcMain.handle(ipcChannels.kimiSessionsImport, async (_event, projectId: string, sourcePaths: string[]) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		if (!isLocalProject(project)) throw new Error("UNSUPPORTED_PROJECT_LOCATION");
		const result = await kimiSessionImporter.import(project.path, sourcePaths);
		void appLogger.info("session", "Kimi sessions imported", {
			projectId,
			sourceCount: sourcePaths.length,
		});
		return result;
	});
	// ── Kimi Work（kimi-desktop 桌面版）会话导入 ─────────────────────────────
	// 与 CLI 版（上方）的差异：数据目录不固定——先 describe 探测（settings 手动指定 >
	// daimon-storage.json 记录的自定义位置 > 默认安装位置），弹窗把探测结果展示给用户。
	// scan/import 全部走探测链，用户改 Kimi Work 数据位置后 PiDeck 无需改设置。
	ipcMain.handle(ipcChannels.kimiWorkSessionsDescribe, async () => {
		const customRoot = settingsStore.get().kimiWorkShareRoot;
		const result = await kimiWorkSessionImporter.describeShareRoot(customRoot);
		void appLogger.debug("session", "Kimi Work share root described", { origin: result.origin });
		return result;
	});
	ipcMain.handle(ipcChannels.kimiWorkSessionsScan, async (_event, projectId: string) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		if (!isLocalProject(project)) throw new Error("UNSUPPORTED_PROJECT_LOCATION");
		const customRoot = settingsStore.get().kimiWorkShareRoot;
		const result = await kimiWorkSessionImporter.scan(project.path, customRoot);
		void appLogger.debug("session", "Kimi Work sessions scanned", { projectId, count: result.length });
		return result;
	});
	ipcMain.handle(ipcChannels.kimiWorkSessionsImport, async (_event, projectId: string, sourcePaths: string[]) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		if (!isLocalProject(project)) throw new Error("UNSUPPORTED_PROJECT_LOCATION");
		const customRoot = settingsStore.get().kimiWorkShareRoot;
		const result = await kimiWorkSessionImporter.import(project.path, sourcePaths, customRoot);
		void appLogger.info("session", "Kimi Work sessions imported", {
			projectId,
			sourceCount: sourcePaths.length,
			imported: result.imported,
		});
		return result;
	});
	// ── MinimaxCode（CLI）会话导入 ─────────────────────────────────────
	// 数据目录固定 ~/.minimax/v2/sessions（无 describe/探测链）；cwd 取自每个会话
	// 目录 llm-call.json 的 systemPrompt（working directory 行），与项目路径匹配才列出。
	ipcMain.handle(ipcChannels.minimaxSessionsScan, async (_event, projectId: string) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		if (!isLocalProject(project)) throw new Error("UNSUPPORTED_PROJECT_LOCATION");
		const result = await minimaxSessionImporter.scan(project.path);
		void appLogger.debug("session", "MinimaxCode sessions scanned", { projectId, count: result.length });
		return result;
	});
	ipcMain.handle(ipcChannels.minimaxSessionsImport, async (_event, projectId: string, sourcePaths: string[]) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		if (!isLocalProject(project)) throw new Error("UNSUPPORTED_PROJECT_LOCATION");
		const result = await minimaxSessionImporter.import(project.path, sourcePaths);
		void appLogger.info("session", "MinimaxCode sessions imported", {
			projectId,
			sourceCount: sourcePaths.length,
			imported: result.imported,
		});
		return result;
	});
	// ── 外置目录会话导入（项目目录移动/改名后找回历史）──────────────────────
	// 与其它导入源的区别：源目录由用户现选，且不复制文件——只把 catalog 记录的项目归属
	// 改成当前项目（原文件原地不动），所以导入后要广播 catalog 刷新让侧栏立即出现这批历史。
	// 「现有会话目录」列表（弹窗首屏默认内容）：只列真的有会话的分组目录，选中即必有结果。
	ipcMain.handle(ipcChannels.directorySessionsListSources, async () => {
		const sources = await directorySessionImporter.listSourceDirectories();
		void appLogger.debug("session", "Directory session sources listed", { count: sources.length });
		return sources;
	});
	ipcMain.handle(ipcChannels.directorySessionsScan, async (_event, projectId: string, dir: unknown) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		if (!isLocalProject(project)) throw new Error("UNSUPPORTED_PROJECT_LOCATION");
		const result = await directorySessionImporter.scan(requireImportDirectory(dir));
		void appLogger.debug("session", "Directory sessions scanned", {
			projectId,
			count: result.sessions.length,
			// kind=ancestor 说明用户选到了会话树的祖先目录（~/.pi 等），弹窗会提示改选。
			kind: result.kind,
		});
		return result;
	});
	ipcMain.handle(ipcChannels.directorySessionsImport, async (_event, projectId: string, dir: unknown, sourcePaths: unknown) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		const report = await directorySessionImporter.import(projectId, requireImportDirectory(dir), requireImportSourcePaths(sourcePaths));
		void appLogger.info("session", "Directory sessions imported", {
			projectId,
			imported: report.imported,
			failed: report.failed,
		});
		if (report.imported > 0) {
			const window = getMainWindow();
			if (window && !window.isDestroyed()) {
				window.webContents.send(ipcChannels.sessionsCatalogRefreshed, { projectId });
			}
		}
		return report;
	});
}

/** 目录导入的目录入参校验（渲染层数据不可信）：非空、绝对路径、长度上限。 */
function requireImportDirectory(raw: unknown): string {
	if (typeof raw !== "string") throw new Error("Invalid directory path");
	const dir = raw.trim();
	if (!dir || dir.length > 32_768) throw new Error("Invalid directory path");
	// 兼容 Windows 盘符路径与 WSL/Linux 绝对路径；相对路径一律拒绝。
	if (!isAbsolute(dir) && !/^[A-Za-z]:[\\/]/.test(dir)) throw new Error("Invalid directory path");
	return dir;
}

/** 目录导入的选中路径校验：字符串数组 + 条数上限（单次扫描上限内）。 */
function requireImportSourcePaths(raw: unknown): string[] {
	if (!Array.isArray(raw)) throw new Error("Invalid source paths");
	if (raw.length > DIRECTORY_IMPORT_MAX_SUMMARIES * 2) throw new Error("Too many source paths");
	return raw.filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
}
