import type {
	AgentBackend,
	AgentGatewayCapability,
	AgentRuntimeState,
	AgentTab,
	AgentUiBatchQuestion,
	AvailableModel,
	ChatMessage,
	CreateAgentInput,
	ImageContent,
	PiCommand,
	ProjectLocator,
	RewindCheckpointPage,
	RewindCheckpointPageParams,
	RewindRestoreResult,
	RewindRestoreScope,
	SendPromptInput,
	SendPromptResult,
	SessionLocator,
	SessionMessageImageTarget,
	SessionModelPreference,
	SessionRecord,
	SessionRuntimeModelSelection,
	SessionUiResponseInput,
} from "../../../shared/types";
// ssh locator 的窄类型只从 shared 取（与 catalog/项目域/引用审计同一份定义，不再抄一遍结构）。
import type { SshSessionLocator } from "../../../shared/projectLocation";
import type { RemoteSessionMessageMutationPort } from "../../remote/RemoteSessionHistoryWriter";
import type { SessionCatalogEntry } from "../SessionCatalog";

/**
 * 会话链路的两个注入网关契约 + 运行时业务日志接口（`SessionRuntimeCoordinator` 的依赖面）。
 *
 * 为什么独立成文件：协调器只经这两个接口同 catalog 与 agent 域通信，接口本身是跨域的**公共契约**
 * （`AgentManager` / `DshAgentManager` / `AcpAgentManager` / `CompositeAgentGateway` 都实现
 * `SessionAgentGateway`）。契约与协调器状态机放在同一文件里，会让「改契约」和「改协调逻辑」
 * 变成同一份 diff；搬出去后协调器文件只剩行为。宿主原样 re-export，调用方无需改动。
 */
export interface SessionCatalogGateway {
	get(sessionId: string): SessionCatalogEntry | undefined;
	getRecord(sessionId: string): SessionRecord | undefined;
	getLocator(sessionId: string): SessionLocator | undefined;
	getLocalFilePath(sessionId: string): string | undefined;
	/**
	 * #354：把已被身份归并掉的**历史**会话 ID 归一化为现存 ID。
	 * 可选：测试里的极简网关可以缺它，缺失时按原 ID 处理。
	 */
	resolveSessionId?(sessionId: string): string;
	update(
		sessionId: string,
		patch: {
			title?: string;
			model?: SessionModelPreference | null;
			thinkingLevel?: string | null;
			permissionPreset?: string | null;
			backend?: AgentBackend;
			updatedAt?: number;
		},
	): Promise<SessionCatalogEntry>;
	attachRuntime(input: {
		sessionId: string;
		filePath?: string;
		piSessionId?: string;
		dshSessionId?: string;
		acpSessionId?: string;
		agentPreset?: string;
		promoteToActive?: boolean;
		/** 远端会话身份（ssh locator）：远端路径只以这个形状回写，绝不进本机 `filePath`（见 buildAttachPatch）。 */
		remoteLocator?: SshSessionLocator;
	}): Promise<unknown>;
}

/**
 * 装配注入：项目位置（远端会话路由的唯一判据来源）。
 *
 * 为什么会话链路需要项目位置：远端会话在**新建阶段还没有 ssh 身份** —— 远端 pi 的会话文件由 pi 自己
 * 选好并在握手时上报（`AgentManager.registerRemoteSessionIdentity`），而 catalog 里的 draft 只有
 * projectId。要把这条 draft 收敛成 ssh locator（远端路径绝不进本机 filePath），就必须知道
 * 「这个项目的 runtime 在哪台机器上」——这也是 `AgentManager` 路由 runtime 的判据（按项目 locator）。
 *
 * 缺省未注入 ⇒ 一律按本机语义处理，本地行为逐字不变。
 */
export type SessionProjectLocatorResolver = (projectId: string) => ProjectLocator | undefined;

/**
 * 装配注入：远端会话文件改写端口（P4.5c 的编辑 / 删除 / 重发三条链路共用一个写面）。
 *
 * 为什么是「解析器」而不是端口本身：写面依赖 pinned SSH 短命令，而那条通道只在 `registerIpc()` 的
 * 装配期才存在（协调器在更早的启动阶段构造）。解析器在**调用时**取端口，于是「实验开关关闭」与
 * 「端口尚未装配」都自然表示成 undefined ⇒ fail-closed，不需要可变字段或 setter。
 */
export type RemoteSessionMessageMutationResolver = () => RemoteSessionMessageMutationPort | undefined;

export interface SessionAgentGateway {
	/** 本网关的运行时后端身份（pi/dsh）；CompositeAgentGateway 按它路由。 */
	readonly backend: AgentBackend;
	/** 本网关持有的可选能力；缺失项由 UI 按能力禁用，禁止硬造等价物。 */
	readonly capabilities: ReadonlySet<AgentGatewayCapability>;
	list(): AgentTab[];
	/** 发送提示词到 agent（pi: stdio RPC；dsh: session.prompt）。 */
	sendPrompt(input: SendPromptInput): Promise<SendPromptResult>;
	getMessages(agentId: string): ChatMessage[];
	create(input: CreateAgentInput): Promise<AgentTab>;
	/** 可选能力：standby 池认领（pi 提供；dsh 无进程池概念不实现）。命中返回已握手 idle tab。 */
	claimStandbyAgent?(input: { projectId: string; sessionId: string; noSession?: boolean }): Promise<AgentTab | null>;
	/** 可选能力：standby 池补热（fire-and-forget，幂等）。 */
	ensureStandbyAgent?(projectId: string): void;
	/** 可选能力：草稿斜杠命令预览（只读查询 pi standby 进程的 get_commands；不可用返回 null，调用方回退本地发现）。 */
	draftCommands?(projectId: string): Promise<PiCommand[] | null>;
	restart(agentId: string): Promise<AgentTab>;
	stop(agentId: string): Promise<void>;
	/**
	 * 可选能力：停止并等待进程退出（返回是否在超时内退出）。
	 *
	 * 删除会话必须先等 pi 释放会话文件句柄，否则 Windows 上 shell.trashItem 只会报通用的
	 * 「Failed to perform delete operation」（issue #364）；未实现该能力的老网关退回只发 stop。
	 */
	stopAndWaitForExit?(agentId: string, timeoutMs?: number): Promise<boolean>;
	rename(agentId: string, name: string): Promise<AgentTab>;
	abort(agentId: string): Promise<void>;
	compact(agentId: string, prompt?: string): Promise<AgentRuntimeState>;
	getRuntimeState(agentId: string): Promise<AgentRuntimeState>;
	/**
	 * 可选能力：error 终态但进程仍存活时的原进程复活（error → idle，Issue #218）。
	 * 回复级错误（API 400/模型报错/投递未知）不会杀死 pi 进程，此前被标成终态后，
	 * 下一次激活要么抛「启动失败」、要么停掉活进程重建（扩展有问题时还会触发无插件回退）。
	 * pi 网关实现进程存活探测；dsh 未实现则保持原终态语义。
	 */
	reviveIfProcessAlive?(agentId: string): boolean;
	/** 可选能力：会话内命令列表（pi 经 get_commands RPC；dsh 经 host 命令注册表枚举桥 D15）。 */
	getCommands?(agentId: string): Promise<unknown[]>;
	/**
	 * 可选能力：热重载 pi 的扩展/技能/提示词/主题/上下文文件（内部 `reload` 扩展命令）。
	 * 只对 live idle 进程开放；返回重载后的命令表，供渲染层刷新 `/` 菜单。
	 */
	reloadResources?(agentId: string): Promise<PiCommand[]>;
	getAvailableModels(agentId: string): Promise<AvailableModel[]>;
	/** 可选能力：Pi 按当前模型返回可用 thinking levels；旧 Pi 返回 undefined 走 UI 兼容回退。 */
	getAvailableThinkingLevels?(agentId: string): Promise<string[] | undefined>;
	/** 可选能力：导出 HTML（pi 经 export_html RPC；dsh 投影式导出 G10）。 */
	exportHtml?(agentId: string): Promise<unknown>;
	/** 可选能力：checkpoint 列表（refs/pi-checkpoints；纯 git，pi 提供，dsh 暂缺）。支持分页。 */
	listCheckpoints?(agentId: string, params?: RewindCheckpointPageParams): Promise<RewindCheckpointPage>;
	/** 可选能力：checkpoint 与当前 index 树的 diff 摘要（回退预览）。 */
	getCheckpointDiff?(agentId: string, checkpointId: string): Promise<string>;
	/** 可选能力：回退到 checkpoint（scope 决定回退范围；当前仅 files 实现）。 */
	restoreCheckpoint?(agentId: string, checkpointId: string, scope: RewindRestoreScope): Promise<RewindRestoreResult>;
	/** 可选能力：编辑历史消息（pi 提供；dsh 缺失，capabilities 不含 editMessage）。 */
	editMessage?(agentId: string, messageId: string, newText: string): Promise<void>;
	/** 可选能力：删除历史消息（pi 提供；dsh 缺失，capabilities 不含 deleteMessage）。 */
	deleteMessage?(agentId: string, messageId: string): Promise<void>;
	/**
	 * 可选能力：无 runtime 时直接改 pi 会话 JSONL（编辑/删除/重发截断）。
	 * DSH 无会话文件，不得实现；运行中不得调用（先 stopRuntime）。
	 */
	mutatePersistedSessionMessage?(
		sessionPath: string,
		messageId: string,
		operation: "edit" | "delete" | "resend" | "remove-image",
		options?: {
			newText?: string;
			environment?: SessionRecord["environment"];
			wslDistro?: string;
			/** 渲染层消息的文件条目 id（meta.entryId），live randomUUID 的文件定位锚点。 */
			entryId?: string;
			imageTarget?: SessionMessageImageTarget;
		},
	): Promise<{ text: string; images?: ImageContent[] } | undefined>;
	prepareResendFromMessage(agentId: string, messageId: string): Promise<{ text: string; images?: ImageContent[] }>;
	getRuntimeModelThinkingState?(agentId: string): Promise<SessionRuntimeModelSelection | undefined>;
	setModel(agentId: string, provider: string, modelId: string): Promise<unknown>;
	setThinking(agentId: string, level: string): Promise<unknown>;
	/** 可选能力：DSH 会话权限预设（/permission 命令）；pi 后端不持有。 */
	setPermission?(agentId: string, preset: string): Promise<unknown>;
	/**
	 * 可选能力：会话内系统提示——catalog 保存的模型偏好已失效（模型被重命名/删除）
	 * 被跳过，本次沿用 runtime 当前模型。DSH 后端不需要（降级无提示）。
	 */
	notifyModelPreferenceIgnored?(agentId: string, provider: string, modelId: string): void;
	/** 主动推送一次完整 runtime state（get_state）给渲染层：懒启动/重启链路在偏好应用后调用。 */
	publishRuntimeState(agentId: string): Promise<void>;
	getForkMessages(agentId: string): Promise<Array<{ entryId: string; text: string }>>;
	forkSession(agentId: string, entryId: string): Promise<unknown>;
	sendUIResponse(agentId: string, requestId: string, response: SessionUiResponseInput["response"]): Promise<unknown> | unknown;
	/** 会话收到 Ask 类 UI 请求时触发桌面通知（由 AgentManager 实现，不再区分会话是否聚焦）
	 * 参数：agentId（去重/日志）、sessionId（点击跳转目标）、sessionTitle、question（提问内容，可空） */
	notifyAskPending(agentId: string, sessionId: string, sessionTitle: string, question: string): void;
	/**
	 * 可选能力：本轮成功收口（用户停止 / 失败 / 压缩不算）。
	 * 桌宠完成气泡与 ACP/DSH 的会话完成通知都订阅它；pi 早在 AgentManager 内部实现。
	 */
	onAgentSettled?(listener: (info: { agentId: string; title: string }) => void): () => void;
	/** 统一的事件出口（agents:* 通道推送），主进程桥接进 sessions:runtime-event 用。 */
	onOutput(listener: (channel: string, payload: unknown) => void): () => void;
}

/**
 * 会话运行时业务日志接口（AppLogger 满足该签名）。
 * 会话全周期事件（激活/停止/重启/模型切换等）经此留痕，与性能日志（session-perf scope）区分；
 * 无实例时静默跳过（启动早期/测试环境）。
 */
export interface SessionRuntimeLogger {
	info(scope: string, message: string, detail?: unknown): unknown;
	warn(scope: string, message: string, detail?: unknown): unknown;
	error(scope: string, message: string, detail?: unknown): unknown;
}
