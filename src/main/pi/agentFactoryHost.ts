import type { MainProcessTranslationKey } from "../../shared/i18n/mainProcessCopy";
import type { AgentTab, AppSettings, ChatMessage, CreateAgentInput, I18nParams, Project, RemoteProject, SessionEnvironment } from "../../shared/types";
import type { AppLogger } from "../logging/AppLogger";
import type { SecurityStore } from "../security/SecurityStore";
import type { RemoteSessionRegistration } from "../sessions/SessionCatalog";
import type { SettingsStore } from "../settings/SettingsStore";
import type { AgentSessionIdentityDefaults } from "./agentSessionIdentity";
import type { PiProcess, WhitelistSkip } from "./PiProcess";
import type { RpcResponse } from "./PiRpcClient";
import type { PiRuntimeLauncher, RemoteSshPiRuntimeLaunchPlan } from "./PiSpawnHandle";
import type { ProjectTrustGate } from "./projectTrustGate";
import type { RemoteRuntimePort } from "./remoteRuntimePort";
import type { StartupDiagnosticsQueue } from "./startupDiagnosticsQueue";

/** 创建域读到的运行时切片（宿主 agents map 的值类型 `AgentRuntime`）。 */
export type CreateRuntime = { tab: AgentTab; process: PiProcess };

/** 进程退出载荷（PiProcess `exit` 事件形状）。 */
export type ProcessExitPayload = { code: number | null; signal: string | null };

/** 握手产物：本域只消费进程、会话状态与扩展回退标记（RPC client 仍归宿主使用）。 */
export type CreateHandshake = {
	process: PiProcess;
	state: RpcResponse;
	fallbackFromExtensions: boolean;
	fallbackDebug?: string;
};

/**
 * 创建域的窄接口：只列实现真正用到的读取器与回调，不新增状态。
 *
 * `agents` / `messages` / `remoteLaunchByAgent` 是宿主拥有的运行时集合，按引用传入；
 * `create`、standby 认领与 `clearAgentState` 留在宿主（它们是公开入口/生命周期收尾，
 * 且 `createUnlocked` 在宿主保留同名薄包装，测试按实例属性替换它）。
 */
export interface AgentFactoryHost {
	readonly agents: Map<string, CreateRuntime>;
	readonly messages: Map<string, ChatMessage[]>;
	readonly remoteLaunchByAgent: Map<string, { plan: RemoteSshPiRuntimeLaunchPlan; launcher: PiRuntimeLauncher }>;
	getProject(id: string): Project | undefined;
	readonly appLogger?: AppLogger;
	/** 远端创建要用当前装配的端口：缺省 = 正式包/测试替身没有远端能力（分支内 fail-closed）。 */
	readonly remoteRuntime?: RemoteRuntimePort;
	readonly securityStore?: SecurityStore;
	readonly settingsStore: SettingsStore;
	readonly projectTrust: ProjectTrustGate;
	readonly startupDiagnostics: StartupDiagnosticsQueue;
	readonly onBeforeAgentSpawn?: () => void;
	readonly translate: (key: MainProcessTranslationKey, params?: Record<string, string | number>) => string;
	/** 大会话尾部读取的轮数上限（宿主 `MAX_HISTORY_LOAD_TURNS`）。 */
	readonly maxHistoryLoadTurns: number;
	/**
	 * spawn 前的资源配置迁移门（index.ts 注入；缺省 = 不迁移）。
	 * 宿主按调用时读取该字段：门可能在本实例构造之后才注入。
	 */
	resourceMigrationGate(): ((projectId?: string) => Promise<void>) | undefined;
	createPiProcess(
		cwd: string,
		sessionPath?: string,
		securitySessionKey?: string,
		settingsOverride?: Partial<Pick<AppSettings, "piRpcNoExtensions" | "piRpcNoSkills" | "removedBuiltInExtensions" | "wslEnabled" | "wslDistro" | "wslUser">>,
		agentId?: string,
		remoteLaunch?: { plan: RemoteSshPiRuntimeLaunchPlan; launcher: PiRuntimeLauncher },
	): PiProcess;
	handshakePiProcess(
		agentId: string,
		options: {
			projectPath: string;
			sessionPath?: string;
			deckSessionId?: string;
			trustOverride?: "approve" | "no-approve";
			noSession?: boolean;
			onExit: (payload: ProcessExitPayload) => void;
		},
	): Promise<CreateHandshake>;
	handleCreateProcessExit(agentId: string, tab: AgentTab, payload: ProcessExitPayload): void;
	reportSessionPathFromPi(reported: string | undefined, projectId: string, environment: SessionEnvironment, fallbackBase: string): string | undefined;
	findRuntimeBySessionKey(sessionKey: string): CreateRuntime | undefined;
	getAgentSessionIdentityDefaults(): AgentSessionIdentityDefaults;
	sessionKeyFor(input: CreateAgentInput, defaults: AgentSessionIdentityDefaults): string | undefined;
	registerRemoteSessionIdentity(project: RemoteProject, remotePath: string): Promise<RemoteSessionRegistration>;
	getHistoryAutoLoadDecision(sessionPath?: string): { shouldLoad: boolean; sizeBytes?: number };
	readRecentMessagesFromSessionFile(sessionPath: string, maxTurns: number): Promise<RpcResponse>;
	buildStartupFailureMessage(rawMessage: string, diag: ReturnType<PiProcess["getDiagnostics"]>): string;
	notifyWhitelistSkipped(agentId: string, entries: readonly WhitelistSkip[]): void;
	notifyMcpThirdPartyTakeover(agentId: string, piVersion: string | null): Promise<void>;
	recordTiming(name: string, startedAt: number, detail?: Record<string, string | number | boolean | null>): void;
	loadMessages(agentId: string, skipEntries?: boolean, earlyMessagesPromise?: Promise<RpcResponse>, options?: { preserveMessagesAfter?: number }): Promise<unknown>;
	addLocalizedMessage(agentId: string, role: ChatMessage["role"], i18nKey: string, fallbackText: string, options?: { params?: I18nParams; debugDetails?: string; meta?: Record<string, unknown> }): void;
	scheduleMessageEmit(agentId: string, immediate?: boolean): void;
	emitState(): void;
}
