import type { MainProcessTranslationKey } from "../../shared/i18n/mainProcessCopy";
import type { Project, SessionCommandError, SessionSearchResult } from "../../shared/types";
import type { AcpAgentManager } from "../acp/AcpAgentManager";
import type { AgentProfileStore } from "../agents/AgentProfileStore";
import type { ConfigManager } from "../config/ConfigManager";
import type { DshAgentManager } from "../dsh/DshAgentManager";
import type { DshHost } from "../dsh/DshHost";
import type { ExtensionManager } from "../extensions/ExtensionManager";
import type { FileSystemService } from "../fs/FileSystemService";
import type { GitService } from "../git/GitService";
import type { AppLogger } from "../logging/AppLogger";
import type { AgentManager } from "../pi/AgentManager";
import type { PiLocator } from "../pi/PiLocator";
import type { PiModelCapabilityCache } from "../pi/PiModelCapabilityCache";
import type { ProjectStore } from "../projects/ProjectStore";
import type { PromptManager } from "../prompts/PromptManager";
import type { XuePromptManager } from "../prompts/XuePromptManager";
import type { SecurityStore } from "../security/SecurityStore";
import type { SessionCommandIpcError } from "../sessions/SessionCommandIpcError";
import type { SessionCatalog } from "../sessions/SessionCatalog";
import type { SessionRuntimeBinding, SessionRuntimeCoordinator } from "../sessions/SessionRuntimeCoordinator";
import type { SessionScanner } from "../sessions/SessionScanner";
import type { SettingsStore } from "../settings/SettingsStore";
import type { SkillManager } from "../skills/SkillManager";
import type { TerminalSessionManager } from "../terminal/TerminalSessionManager";
import type { WeChatService } from "../wechat/WeChatService";
import type { RemoteAccessManager } from "../web/remoteAccess/RemoteAccessManager";
import type { WebServiceDependencies, WebServiceManager } from "../web/WebServiceManager";

/**
 * Web 服务装配上下文（自 index.ts 的 `app.whenReady()` 装配体就地外移，行为零变化）。
 *
 * 按值传的是「装配点之前已定型、此后不再替换」的实例；晚装配 / 会被替换的单例
 * （catalog、运行时协调器、ACP、模型能力缓存、终端、聚合网关、外网编排器、Web 服务本体）
 * 一律走 getter——它们在本块之后才 `new`，或由重启路径替换，闭包里必须读到调用时的当前实例。
 * 那些仍是 index.ts 局部 helper 的函数（catalog/会话命令/事件广播）按值传入，index.ts 不复制第二份。
 */
export interface WebServiceContext {
	readonly appLogger: AppLogger;
	readonly settingsStore: SettingsStore;
	readonly securityStore: SecurityStore;
	readonly agentManager: AgentManager;
	readonly projectStore: ProjectStore;
	readonly sessionScanner: SessionScanner;
	readonly configManager: ConfigManager;
	readonly piLocator: PiLocator;
	readonly dshAgentManager: DshAgentManager;
	readonly dshHost: DshHost;
	readonly promptManager: PromptManager;
	readonly xuePromptManager: XuePromptManager;
	readonly skillManager: SkillManager;
	readonly extensionManager: ExtensionManager;
	readonly gitService: GitService;
	readonly fileSystemService: FileSystemService;
	/** 微信桥槽位（index.ts 退出清理与删除会话解绑都读同一对象）。 */
	readonly wechatServiceRef: { current: WeChatService | null };
	/** fork/clone 命令层（index.ts 惰性实例的同一个包装对象，调用时机不变）。 */
	readonly sessionForkCommands: {
		cloneRuntimeSession: NonNullable<WebServiceDependencies["cloneSessionRuntime"]>;
		forkRuntimeSession: NonNullable<WebServiceDependencies["forkRuntimeSession"]>;
	};

	readonly getSessionCatalog: () => SessionCatalog;
	readonly getSessionRuntimeCoordinator: () => SessionRuntimeCoordinator;
	readonly getAcpAgentManager: () => AcpAgentManager;
	readonly getAgentProfileStore: () => AgentProfileStore | null;
	readonly getPiModelCapabilityCache: () => PiModelCapabilityCache | undefined;
	readonly getTerminalManager: () => TerminalSessionManager;
	readonly getRemoteAccessManager: () => RemoteAccessManager;
	readonly getWebServiceManager: () => WebServiceManager;

	/** index.ts 的主进程文案入口（每次现求值，不做启动期快照）。 */
	readonly mainCopy: (key: MainProcessTranslationKey, params?: Record<string, string | number>) => string;
	readonly shouldUseDevRendererUrl: () => boolean;
	readonly sessionScannerForProject: (project: Project | undefined) => Promise<SessionScanner>;
	readonly wslSessionScannerFor: (identity: { distro: string; user: string }) => Promise<SessionScanner>;
	readonly emitSessionRuntimeEvent: (agentId: string, sourceChannel: string, payload: unknown) => boolean;
	readonly emitSessionRuntimeDetach: (binding: SessionRuntimeBinding) => void;
	readonly emitReplacementState: (binding: SessionRuntimeBinding, includeMessages: boolean) => void;
	readonly notifyCatalogRefreshed: (projectIds: Iterable<string>) => void;
	readonly createAnonymousSession: NonNullable<WebServiceDependencies["createAnonymousSession"]>;
	readonly copyCatalogSession: (sessionId: string) => ReturnType<NonNullable<WebServiceDependencies["copySessionRecord"]>>;
	readonly exportCatalogSessionHtml: (sessionId: string) => Promise<{ path: string; truncated?: boolean }>;
	readonly readCatalogSessionReferenceMessages: NonNullable<WebServiceDependencies["readSessionReferenceMessages"]>;
	readonly sessionMessageSearchInFile: (sessionPath: string, query: string) => Promise<SessionSearchResult | null>;
	readonly sessionCommandIpcError: (error: SessionCommandError) => SessionCommandIpcError;
	readonly stopSessionRuntime: NonNullable<WebServiceDependencies["stopSessionRuntime"]>;

	/** 回填 Web 服务单例（index.ts 的 webServiceManager；重启路径会替换它）。 */
	assign(patch: { webServiceManager: WebServiceManager }): void;
}
