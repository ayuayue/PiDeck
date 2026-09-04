export type ChatRole = "user" | "assistant" | "tool" | "system" | "error";

export type I18nParams = Record<string, string | number | boolean | null | undefined>;

/** Structured copy crosses process boundaries without forcing main to choose a locale. */
export type I18nDescriptor = {
	i18nKey?: string;
	i18nParams?: I18nParams;
	/** Raw provider/process diagnostics. Renderers may expose this separately from localized copy. */
	debugDetails?: string;
};

export type ChatMessage = {
	id: string;
	agentId: string;
	role: ChatRole;
	text: string;
	timestamp: number;
	meta?: Record<string, unknown> & I18nDescriptor;
	images?: ImageContent[]; // 用户消息中附加的图片
	/** 思考内容：来自 thinking 内容块，用于展示模型推理过程 */
	thinking?: string;
	/** 思考段开始时间（可选；缺省回退 message.timestamp） */
	thinkingStartedAt?: number;
	/** 思考段结束时间（可选；缺省回退 message.timestamp） */
	thinkingEndedAt?: number;
	/**
	 * pi RPC message_end 的 stopReason（provider 归一化枚举）：
	 * stop=最终回复 / toolUse=中间回复（工具调用回合）/ aborted=被打断 /
	 * error|length=异常截断 / pending=message_start 占位（结束时更新为真实值）。
	 * 历史会话/旧版本数据可能缺失，渲染层需回退启发式判定。
	 */
	stopReason?: string;
};

/** A bounded historical timeline slice. `nextBefore` is the exclusive index for an older page. */
export type SessionMessagePage = {
	messages: ChatMessage[];
	total: number;
	nextBefore: number | null;
	/** 当前活动分支最后使用的模型；由历史索引读取时顺手提取。 */
	model?: { provider: string; modelId: string };
	/** 当前活动分支最后记录的思考档位；无显式记录但有模型时回退为 off。 */
	thinkingLevel?: string;
	/**
	 * 下一页锚点（entryId，2026-11 缓存优先）：页最旧条目的 entryId。
	 * 主进程缓存命中路径用它做续页游标（跨下标空间稳定）；文件路径同义于 nextBefore 指向的条目。
	 * 到顶（nextBefore === null）时缺省。
	 */
	nextBeforeEntryId?: string;
	/** 会话文件版本（mtime:size）：渲染层比对检测压缩/外部改写，变化即丢弃已缓存的历史前缀。 */
	indexVersion?: string;
};

export type FileTreeNode = {
	name: string;
	path: string;
	relativePath: string;
	type: "file" | "directory";
	children?: FileTreeNode[];
	/**
	 * 目录是否可能有可见子项。懒加载时未展开的目录 children 为空，
	 * 靠这个字段决定是否显示展开箭头；已加载则与 children.length 对齐。
	 */
	hasChildren?: boolean;
	/** 文件元数据（文件树排序用；缺失时回退按名称）。目录 size 无意义恒为 0。 */
	mtimeMs?: number;
	ctimeMs?: number;
	size?: number;
};

export type SessionSource = "pi" | "codex" | "claude" | "opencode";
export type SessionEnvironment = "native" | "wsl";

/**
 * 会话级代理覆盖模式（单会话开关，复用全局代理 URL，不存每会话 URL）：
 * - follow：跟随全局代理设置（缺省值，旧数据自然兼容）；
 * - on：强制启用代理（即使全局开关关闭，URL 仍取自全局 piProxyUrl）；
 * - off：强制直连（即使全局开着代理，本会话也不走任何代理）。
 */
export type SessionProxyMode = "follow" | "on" | "off";

/** 会话级代理覆盖；对象结构便于未来按会话扩展 url/bypass 字段而不破坏兼容。 */
export type SessionProxyOverride = {
	mode: SessionProxyMode;
};

export type SessionSummary = {
	id: string;
	filePath: string;
	/** 会话归属项目 id（渲染层 worktree 家族区分用；扫描摘要恒缺省，catalog 记录回填）。 */
	projectId?: string;
	projectPath?: string;
	name?: string;
	/** 子会话：关联的父会话文件路径。有该字段时不在会话列表顶层显示，而是嵌套在父会话下。 */
	parentSessionPath?: string;
	/**
	 * fork 会话标记（pi fork/clone 的文件头带 parentSession）：有父关系但形态为
	 * 「用户 fork/分支」而非子代理/嵌套子会话。仅作 fork 身份元数据——
	 * (fork) 标题后缀已由主进程物理写入会话名（见 main/sessions/sessionForkTitle.ts），
	 * 展示层不再按该标记拼装，重命名删除后缀即为删除。
	 */
	forked?: boolean;
	preview: string;
	updatedAt: number;
	messageCount: number;
	/** 会话来源：pi 原生、Codex 导入、Claude 导入、OpenCode 导入 */
	source?: SessionSource;
	/** 运行时后端；缺省 "pi"。草稿/历史行用来区分 DSH 会话。 */
	backend?: import("./agent").AgentBackend;
	/** 标记此会话文件来自 WSL，rename/delete/copy 等操作需走 wsl.exe */
	wsl?: boolean;
	/** 从 JSONL 中的 model_change / thinking_level_change 提取的最后值 */
	model?: { provider: string; modelId: string };
	thinkingLevel?: string;
	/** 会话里存在生图消息（openai-images / imageGen 标记）；侧栏显示图片角标便于查找 */
	hasImageGen?: boolean;
	/** DSH 会话身份（DSH host 的 sessionId）；backend=dsh 的会话用来重启后 attach 旧会话。 */
	dshSessionId?: string;
	codexSessionId?: string;
	codexThreadSource?: "user" | "subagent";
	codexParentThreadId?: string;
	codexAgentRole?: string;
	codexAgentNickname?: string;
};

/**
 * DSH 归档区会话清单行（G14）：host 目录已移入 .pideck-archive 的会话。
 * title 可选：归档 manifest 自 G14+ 起携带，旧归档缺省时由主进程
 * 从归档目录的会话日志前缀只读折叠补全；仍缺省则 UI 回退 cwd 末段/id。
 */
export type ArchivedDshSession = {
	dshSessionId: string;
	cwd: string;
	archivedAt: number;
	title?: string;
};

/**
 * pi 归档区会话清单行：会话摘要 + 归档前的原始路径（index.json 反查）。
 * originalPath 用于把归档会话按项目归属过滤（弹窗归档视图不再全量）；
 * 索引缺失/损坏的极旧归档为 undefined，弹窗不展示（配置页仍全局可恢复）。
 */
export type ArchivedPiSession = {
	summary: SessionSummary;
	originalPath?: string;
};

/** PiDeck-owned session identity, independent from a running Pi process. */
export type SessionRecord = {
	id: string;
	projectId: string;
	title: string;
	/**
	 * Runtime-only anonymous conversations are deliberately kept out of the
	 * persisted catalog and disappear when their process is closed.
	 */
	noSession?: boolean;
	source: SessionSource;
	environment: SessionEnvironment;
	/** 运行时后端（pi/dsh）；缺省 "pi"，旧 catalog 数据无需迁移。 */
	backend?: import("./agent").AgentBackend;
	filePath?: string;
	wslDistro?: string;
	wslUser?: string;
	importedSourceId?: string;
	parentSessionId?: string;
	parentSessionPath?: string;
	/**
	 * fork 会话标记（pi fork/clone 产物）：fork 身份元数据；(fork) 标题后缀已由主进程
	 * 物理写入会话名（见 main/sessions/sessionForkTitle.ts），展示层不再按标记拼装。
	 * 与「子代理/嵌套子会话」（parentSessionPath 会被侧栏折叠到父行下）语义不同，两者独立存储。
	 */
	forked?: boolean;
	projectPath?: string;
	preview: string;
	messageCount: number;
	status: "draft" | "active";
	model?: { provider: string; modelId: string };
	thinkingLevel?: string;
	/** DSH 会话权限预设（read-only / workspace-write / danger-full-access）；
	 *  草稿期预选，激活时经 /permission 命令应用到 host 会话。 */
	permissionPreset?: string;
	/**
	 * DSH agent 预设（会话「模式」：standard/code/minimal/cordis 或用户预设）。
	 * 草稿期预选，激活新建 host 会话时随 sessions.create 应用（host 持久化到会话 header）；
	 * attach 已存在会话时从 host 读回实际值回写。会话创建后固定，不可运行时切换。
	 */
	agentPreset?: string;
	/** DSH 会话身份（DSH host 的 sessionId）；backend=dsh 的会话用来重启后 attach 旧会话。 */
	dshSessionId?: string;
	/** 会话级代理覆盖（缺省 = 跟随全局）；沿用全局代理 URL，仅生效于下次 spawn。 */
	proxy?: SessionProxyOverride;
	createdAt: number;
	updatedAt: number;
	wsl?: boolean;
	codexSessionId?: string;
	codexThreadSource?: "user" | "subagent";
	codexParentThreadId?: string;
	codexAgentRole?: string;
	codexAgentNickname?: string;
};

export type CreateSessionDraftInput = {
	projectId: string;
	title?: string;
	model?: { provider: string; modelId: string };
	/** 欢迎页（引导页）偏好模型：仅作回退来源（解析器优先级：显式默认 > 欢迎偏好 > 上次使用 > 空），
	 *  显式默认模型存在时被忽略——与 model 字段（用户主动指名）语义不同。 */
	welcomeModel?: { provider: string; modelId: string };
	thinkingLevel?: string;
	/** 运行时后端；缺省 "pi"（旧调用方无需改动）。 */
	backend?: import("./agent").AgentBackend;
	/** DSH agent 预设（会话「模式」）草稿期预选；激活时随 sessions.create 应用。 */
	agentPreset?: string;
};

/** 启动前选择的模型与思考级别；显式值优先于 pi 配置默认值。 */
export type SessionLaunchPreferences = {
	model?: { provider: string; modelId: string };
	thinkingLevel?: string;
};

/**
 * 主进程按当前 pi 配置实时解析出的「默认启动偏好」。与 createDraft 的缺省填充同源：
 * 引导页（无 record 虚拟会话）用它预先高亮真正会生效的模型/思考档位。
 */
export type ResolvedLaunchDefaults = {
	model?: { provider: string; modelId: string };
	thinkingLevel?: string;
	/** 解析结果是否来自用户显式配置的默认模型（settings.defaultProvider+defaultModel 且有效）。
	 *  渲染层据此决定欢迎页偏好是否参与展示回退：显式默认存在时偏好被覆盖
	 *  （用户规则：默认模型 > 偏好 > 上次使用 > 空）。 */
	defaultModelConfigured?: boolean;
};

/** sessions.resolve-launch-defaults 入参：只需声明后端；缺省按非 DSH 解析。 */
export type ResolveLaunchDefaultsInput = {
	backend?: import("./agent").AgentBackend;
};

/** Creates a live `--no-session` runtime without writing a session file. */
export type CreateAnonymousSessionInput = {
	projectId: string;
	title?: string;
	/** 运行时后端；缺省 "pi"。 */
	backend?: import("./agent").AgentBackend;
} & SessionLaunchPreferences;

export type CreateAnonymousSessionResult = {
	session: SessionRecord;
	/** Runtime creation continues in the background so the composer can open immediately. */
	runtime?: SessionRuntimeInfo;
};

export type UpdateSessionRecordInput = {
	title?: string;
	/** null = 清空（切后端时丢掉另一套目录里的模型）。 */
	model?: { provider: string; modelId: string } | null;
	thinkingLevel?: string | null;
	/** DSH 会话权限预设（草稿期预选；激活会话经 /permission 命令应用后回写同步）。 */
	permissionPreset?: string | null;
	/** DSH agent 预设（会话「模式」）：仅草稿期可改；激活后由 host 会话 header 回写为准。 */
	agentPreset?: string | null;
	/** 后端（pi/dsh）：仅草稿期可变更；会话激活（active/有 runtime）后锁定——pi 会话文件
	 *  与 DSH session log 格式不同，中途切换会导致消息同步渲染不可靠。 */
	backend?: import("./agent").AgentBackend;
	/** 会话级代理覆盖；null = 恢复跟随全局（清除已保存覆盖）。 */
	proxy?: SessionProxyOverride | null;
};

export type ForkMessage = {
	entryId: string;
	text: string;
};

/** 图片内容格式，与 pi RPC 的 ImageContent 一致 */
export type ImageContent = {
	type: "image";
	data: string; // base64 编码的图片数据
	mimeType: string; // 如 "image/png", "image/jpeg", "image/gif", "image/webp"
};

export type SendPromptInput = {
	agentId: string;
	message: string;
	images?: ImageContent[]; // 可选的图片列表
	streamingBehavior?: "steer" | "followUp";
	/** 仅发给 Agent 的内部提示，不显示在聊天 UI 中。 */
	agentMessage?: string;
	/** 提示的简短描述/摘要，发给 pi agent 用于标识本次 prompt 的意图。
	 *  从模板 description、用户输入首行自动提取；飞书/WebService 等外部来源可不传。 */
	description?: string;
	/** 发送请求的上层 requestId，用于跨 Session/runtime/AgentManager 对齐性能日志。 */
	requestId?: string;
};

/** 主进程完成 pi prompt 预检后的明确接收结果。 */
export type SendPromptResult =
	| { accepted: true }
	| ({ accepted: false; error: string; delivery?: "rejected" } & I18nDescriptor)
	| ({ accepted: false; error: string; delivery: "unknown" } & I18nDescriptor);

export type SendSessionPromptInput = Omit<SendPromptInput, "agentId"> & {
	sessionId: string;
	requestId: string;
};

export type SendSessionPromptResult = SendPromptResult & {
	sessionId: string;
	requestId: string;
	agentId?: string;
	sessionPath?: string;
	runtimeGeneration?: number;
};

import type { AgentStatus, AgentUiResponse } from "./agent";

export type SessionRuntimeEvent = {
	kind?: "event" | "detach";
	sessionId: string;
	agentId: string;
	runtimeGeneration: number;
	sourceChannel: string;
	payload: unknown;
};

export type SessionRuntimeTarget = {
	sessionId: string;
	agentId: string;
	runtimeGeneration: number;
};

export type SessionRuntimeInfo = SessionRuntimeTarget & {
	projectId: string;
	cwd: string;
	status: AgentStatus;
	sessionPath?: string;
	createdAt: number;
	compactionCount?: number;
	noSession?: boolean;
};

export type SessionCommandErrorCode =
	| "SESSION_NOT_FOUND"
	| "MESSAGE_NOT_FOUND"
	| "SESSION_RUNTIME_UNAVAILABLE"
	| "SESSION_RUNTIME_CHANGED"
	| "SESSION_RUNTIME_BUSY"
	| "SESSION_COMMAND_FAILED"
	| "SESSION_MODEL_NOT_FOUND";

export type SessionCommandError = {
	code: SessionCommandErrorCode;
	params?: Record<string, string | number>;
	debugDetails?: string;
	/** 模型在本地 models.json 存在但运行中 Agent 的快照未加载：需重启 Agent 生效。 */
	needsRestart?: boolean;
};

export type SessionCommandResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: SessionCommandError };

export type SessionTargetedValue<T> = {
	target: SessionRuntimeTarget;
	value: T;
};

export type SessionRuntimeReplacement = {
	previousTarget: SessionRuntimeTarget;
	runtime: SessionRuntimeInfo;
	session: SessionRecord;
};

export type SessionUiResponseInput = {
	sessionId: string;
	requestId: string;
	agentId: string;
	runtimeGeneration: number;
	response: AgentUiResponse;
};
