/**
 * Session IPC 装配入口：SessionIpcDeps 契约 + 按通道域调用各 registrar。
 * Phase 3.7: extracted from src/main/index.ts registerIpc().
 *
 * 各通道域的 handler 在同目录的 sessionXxxIpc.ts（列表与查找 / catalog 写入 / 消息读取 /
 * 消息改写 / 运行与运行时命令 / DSH / 导入器 / 归档 / 历史读取）。注册顺序与拆分前逐条一致：
 * 契约测试按源码顺序断言，挪动任一 registrar 调用位置都会改变 135 个通道的注册次序。
 */

import { type BrowserWindow } from "electron";
import type { VisibleSessionRegistry } from "../sessions/visibleSessionRegistry";
import type { AvailableModel, CreateAnonymousSessionInput, CreateAnonymousSessionResult, SessionRuntimeTarget, SessionRuntimeInfo, DshModelDiscoveryInput, FetchedModel, ArchivedDshSession, SessionSearchMatch, SessionSearchResult } from "../../shared/types";
import type { SessionForkCommands } from "../sessions/sessionForkCommands";
import { getCachedModelList } from "../pi/modelListCache";
import type { DirectorySessionImporter } from "../sessions/DirectorySessionImporter";
import type { SshSessionLocator } from "../../shared/projectLocation";
import { registerSessionDshIpc } from "./sessionDshIpc";
import { registerSessionDshRuntimeIpc } from "./sessionDshRuntimeIpc";
import { registerSessionImportersIpc } from "./sessionImportersIpc";
import { registerSessionCatalogArchiveIpc } from "./sessionCatalogArchiveIpc";
import { registerSessionHistoryReadIpc } from "./sessionHistoryReadIpc";
import type { ProjectStore } from "../projects/ProjectStore";
import type { SettingsStore } from "../settings/SettingsStore";
import type { SessionScanner } from "../sessions/SessionScanner";
import type { SessionCatalog } from "../sessions/SessionCatalog";
import type { SessionRuntimeCoordinator } from "../sessions/SessionRuntimeCoordinator";
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
import { registerSessionListIpc } from "./sessionListIpc";
import { registerSessionCatalogWriteIpc } from "./sessionCatalogWriteIpc";
import { registerSessionMessageReadIpc } from "./sessionMessageReadIpc";
import { registerSessionMessageMutationIpc } from "./sessionMessageMutationIpc";
import { registerSessionRunIpc, registerSessionRuntimeCommandIpc } from "./sessionRunIpc";

/** catalog 后台扫描调度入口的归属随 catalogList 一起迁移（装配层从这里引用）。 */
export { scheduleCatalogBackgroundScan } from "./sessionListIpc";

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
	 * 返回非空字符串时，sessionsSendPrompt 会在会话首轮把角色设定拼进 prompt
	 * （pi/acp 走隐藏 agentMessage，dsh 退化为可见前缀，见 composeAgentInstruction）。
	 * 未装配（单测 / 旧宿主）时不做任何注入，发送行为与此前完全一致。
	 */
	resolveSessionAgentInstruction?: (sessionId: string) => string | undefined;
	/** DSH 后端专用 IPC 依赖（C1 分组；未装配 = 无 DSH 后端）。 */
	dshBackend?: DshBackendIpcDeps;
};

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
	 * 创建草稿 / 匿名会话 / 引导页默认解析共用的模型存在性校验数据源。
	 * 必须与模型选择器同源：选择器展示的是 capability 快照，只用 CLI 缓存会把
	 * auth 渠道模型判为不存在，首发的点选被静默换成配置默认模型（issue #340）。
	 */
	const selectableModels = validationCatalogModels ?? getCachedModelList;

	// 会话列表与查找域（sessions:list / 跨会话与会话内查找 / catalog 缓存回显 + 后台扫描）在独立模块注册，位置保持原位。
	registerSessionListIpc({
		projectStore,
		settingsStore,
		sessionScanner,
		resolveWslSessionScanner,
		sessionCatalog,
		sessionRuntimeCoordinator,
		agentManager,
		appLogger,
		mainCopy,
		getMainWindow,
		emitSessionRuntimeEvent,
		sessionContentSearch: deps.sessionContentSearch,
		sessionMessageSearch: deps.sessionMessageSearch,
		dshBackend,
	});
	// 会话 catalog 写入域（草稿创建 / 引导页默认解析 / 匿名会话 / 记录更新 / 删除）在独立模块注册，位置保持原位。
	registerSessionCatalogWriteIpc({
		projectStore,
		settingsStore,
		sessionScanner,
		sessionCatalog,
		sessionRuntimeCoordinator,
		agentManager,
		configManager,
		appLogger,
		mainCopy,
		createAnonymousSession,
		selectableModels,
		dshBackend,
	});
	/** 归档 / 远端归档删除（含一步式确认 broker）在独立模块注册，位置保持原位。 */
	registerSessionCatalogArchiveIpc({
		sessionCatalog,
		sessionRuntimeCoordinator,
		projectStore,
		sessionScanner,
		mainCopy,
		appLogger,
		archiveRemoteSession,
		unarchiveRemoteSession,
		deleteArchivedRemoteSession,
		...dshBackend,
	});
	// 会话消息读取域（全量消息 / 分支树 / 子代理 / 任务快照 / 分页）在独立模块注册，位置保持原位。
	registerSessionMessageReadIpc({
		sessionCatalog,
		sessionRuntimeCoordinator,
		agentManager,
		appLogger,
		getMainWindow,
		readImageSessionMessages,
		readRemoteSessionHistoryPage,
		readVideoSessionMessages,
		dshBackend,
	});
	// 历史详情读取（过程事件 / 导轨 / 引用 / 全文 / DSH 路径与搜索）在独立模块注册，位置保持原位。
	registerSessionHistoryReadIpc({
		sessionCatalog,
		sessionRuntimeCoordinator,
		agentManager,
		appLogger,
		readCatalogSessionReferenceMessages,
		...dshBackend,
	});
	// DSH 会话域（目标 / 子代理 / 技能 / 外部会话 / 归档 / 插件）在独立模块注册，位置保持原位。
	registerSessionDshIpc({ sessionCatalog, projectStore, mainCopy, getMainWindow, appLogger, ...dshBackend });
	// 会话消息改写域（复制 / HTML 导出 / 图片移除 / 编辑、删除、重发准备）在独立模块注册，位置保持原位。
	registerSessionMessageMutationIpc({
		sessionCatalog,
		sessionRuntimeCoordinator,
		appLogger,
		copyCatalogSession,
		exportCatalogSessionHtml,
		exportRemoteCatalogSessionHtml,
	});
	// 会话运行域（发送 / UI 应答 / 运行时列表与激活 / 聚焦与可见登记）在独立模块注册，位置保持原位。
	registerSessionRunIpc({
		settingsStore,
		sessionCatalog,
		sessionRuntimeCoordinator,
		agentManager,
		appLogger,
		getMainWindow,
		visibleSessions,
		emitLiveSnapshot,
		emitSessionRuntimeEvent,
		emitSessionActivating,
		emitSessionActivationFailed,
		emitSessionActivationCancelled,
		emitReplacementState,
		resolveSessionAgentInstruction,
	});
	// DSH 后端模型 / 配置 / 凭据 / host 控制同属 dshBackend 分组，注册位置保持原位。
	registerSessionDshRuntimeIpc({ mainCopy, ...dshBackend });
	// 运行时命令面（停止/重启/压缩/状态/模板/模型权限/编辑删除重发/rewind/fork）在独立模块注册，位置保持原位。
	registerSessionRuntimeCommandIpc({
		sessionCatalog,
		sessionRuntimeCoordinator,
		agentManager,
		appLogger,
		terminalManager,
		mainCopy,
		emitSessionRuntimeEvent,
		emitSessionRuntimeDetach,
		stopSessionRuntime,
		emitReplacementState,
		sessionForkCommands: deps.sessionForkCommands,
	});
	// 导入器域：本模块只做转发（项目/设置/日志/窗口四个公共依赖直接从解构取）。
	registerSessionImportersIpc({
		projectStore,
		settingsStore,
		appLogger,
		getMainWindow,
		codexSessionImporter: deps.codexSessionImporter,
		claudeSessionImporter: deps.claudeSessionImporter,
		qoderSessionImporter: deps.qoderSessionImporter,
		openCodeSessionImporter: deps.openCodeSessionImporter,
		zcodeSessionImporter: deps.zcodeSessionImporter,
		workbuddySessionImporter: deps.workbuddySessionImporter,
		codebuddySessionImporter: deps.codebuddySessionImporter,
		cursorSessionImporter: deps.cursorSessionImporter,
		kimiSessionImporter: deps.kimiSessionImporter,
		kimiWorkSessionImporter: deps.kimiWorkSessionImporter,
		minimaxSessionImporter: deps.minimaxSessionImporter,
		directorySessionImporter: deps.directorySessionImporter,
	});
}
