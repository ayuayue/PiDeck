/**
 * preload integrations 域：集成：飞书 / 微信 / 内置浏览器、便签、生图生视频、增强与建议、语音转写、划词浮窗、CUA 审批。
 *
 * 组装口 `src/preload/index.ts` 只做 spread；方法体 / 参数名 / 通道引用与拆分前逐字一致。
 */
import { ipcRenderer } from "electron";
import { ipcChannels } from "../../shared/ipc";
import { subscribe } from "./ipcHelpers";
import type { LocalImageBytes } from "../../shared/localImage";
import type { DraftMeta, FeishuBotConfig, FeishuBridgeStatus, FeishuChatBinding, FeishuChatMessage, FeishuConnectInput, FeishuSessionBotResult, FeishuTestResult, ScratchPadData, ScratchPadScope, WeChatBindingView, WeChatBridgeStatus, WeChatIpcResult, WeChatLoginState, WeChatSettings, WeChatSettingsSnapshot } from "../../shared/types";
import type { EnhanceEventPayload, EnhanceRunInput, EnhanceRunResult } from "../../shared/types/enhance";
import type { ImageBlobPayload, ImageGenConfigFile, ImageGenRequest, ImageGenResult, ImageGenSaveResult } from "../../shared/types/imagegen";
import type { PromptSuggestionRunInput, PromptSuggestionRunResult } from "../../shared/types/promptSuggestion";
import type { SelectionToolInsertInput, SelectionToolResizeInput, SelectionToolShowPayload, SelectionToolWindowState } from "../../shared/types/selectionTool";
import type { VideoGenConfigFile, VideoGenJobSnapshot, VideoGenRequest, VideoGenSaveResult, VideoGenSubmitResult } from "../../shared/types/videogen";
import type { VoiceTranscriptionPublicConfig, VoiceTranscriptionRequest, VoiceTranscriptionResult, VoiceTranscriptionSaveInput, VoiceTranscriptionSaveResult, VoiceTranscriptionSecretField, VoiceTranscriptionStreamFrame, VoiceTranscriptionStreamPartial, VoiceTranscriptionStreamStartInput, VoiceTranscriptionStreamStartResult, VoiceTranscriptionTestResult } from "../../shared/types/voiceTranscription";
import type { WhisperInstallProgress, WhisperInstallResult, WhisperRuntimeStatus } from "../../shared/types/whisperRuntime";

export const integrationsApi = {

	// ===== 飞书桥接 =====
	feishu: {
		connect: (input: FeishuConnectInput) =>
			ipcRenderer.invoke(ipcChannels.feishuConnect, input) as Promise<{
				success: boolean;
				message: string;
				detail?: string;
			}>,
		connectTemp: (input: FeishuConnectInput) =>
			ipcRenderer.invoke(ipcChannels.feishuConnectTemp, input) as Promise<{
				success: boolean;
				message: string;
				detail?: string;
				botInfo?: { id: string; name: string };
			}>,
		disconnect: () => ipcRenderer.invoke(ipcChannels.feishuDisconnect) as Promise<{ success: boolean }>,
		connectByBot: (botId: string) =>
			ipcRenderer.invoke(ipcChannels.feishuConnectByBot, botId) as Promise<{
				success: boolean;
				message: string;
				detail?: string;
			}>,
		statusRequest: () => ipcRenderer.invoke(ipcChannels.feishuStatusRequest) as Promise<FeishuBridgeStatus>,
		onStatus: (callback: (status: FeishuBridgeStatus) => void) => subscribe(ipcChannels.feishuStatus, callback),
		botsList: () => ipcRenderer.invoke(ipcChannels.feishuBotsList) as Promise<FeishuBotConfig[]>,
		botAdd: (input: FeishuConnectInput) =>
			ipcRenderer.invoke(ipcChannels.feishuBotAdd, input) as Promise<{
				success: boolean;
				bot?: FeishuBotConfig;
				error?: string;
			}>,
		botRemove: (botId: string) => ipcRenderer.invoke(ipcChannels.feishuBotRemove, botId) as Promise<boolean>,
		botConfig: (botId: string, patch: Partial<FeishuBotConfig>) => ipcRenderer.invoke(ipcChannels.feishuBotConfig, botId, patch) as Promise<FeishuBotConfig | undefined>,
		botSecret: (botId: string) => ipcRenderer.invoke(ipcChannels.feishuBotSecret, botId) as Promise<string>,
		testConnection: (appId: string, appSecret: string) => ipcRenderer.invoke(ipcChannels.feishuTestConnection, appId, appSecret) as Promise<FeishuTestResult>,
		bindingsList: () => ipcRenderer.invoke(ipcChannels.feishuBindingsList) as Promise<FeishuChatBinding[]>,
		bindingRemove: (chatId: string) => ipcRenderer.invoke(ipcChannels.feishuBindingRemove, chatId) as Promise<boolean>,
		bindingUpdate: (chatId: string, patch: Partial<FeishuChatBinding>) => ipcRenderer.invoke(ipcChannels.feishuBindingUpdate, chatId, patch) as Promise<FeishuChatBinding | undefined>,
		onMessages: (callback: (message: FeishuChatMessage) => void) => subscribe(ipcChannels.feishuMessages, callback),
		onBindingsChanged: (callback: (bindings: FeishuChatBinding[]) => void) => subscribe(ipcChannels.feishuBindingsChanged, callback),
		onWhoamiResult: (callback: (openId: string) => void) => subscribe(ipcChannels.feishuWhoamiResult, callback),
		onBotsChanged: (callback: (bots: FeishuBotConfig[]) => void) => subscribe(ipcChannels.feishuBotsChanged, callback),
		sessionBotGet: (sessionId: string) => ipcRenderer.invoke(ipcChannels.feishuSessionBotGet, sessionId) as Promise<string | null>,
		sessionBotSet: (sessionId: string, botId: string | null) => ipcRenderer.invoke(ipcChannels.feishuSessionBotSet, sessionId, botId) as Promise<FeishuSessionBotResult>,
	},

	// ===== 内置浏览器 =====
	browser: {
		/** 在系统默认浏览器中打开外部链接。
		 *  用于 webview 不支持或需要另开浏览器查看的场景。 */
		openExternal: (url: string, forceSystem?: boolean) => ipcRenderer.invoke(ipcChannels.browserOpenExternal, url) as Promise<void>,
	},

	// ===== 微信 iLink 桥接 =====
	wechat: {
		/** 设置页一次拉齐：设置 + 状态 + 绑定 + 可选工作区。 */
		snapshot: () => ipcRenderer.invoke(ipcChannels.wechatGetSettings) as Promise<WeChatIpcResult<WeChatSettingsSnapshot>>,
		setEnabled: (enabled: boolean) => ipcRenderer.invoke(ipcChannels.wechatSetEnabled, enabled) as Promise<WeChatIpcResult<{ settings: WeChatSettings }>>,
		updateSettings: (patch: { defaultWorkspaceId?: string; defaultModelId?: string; backend?: "pi" | "dsh"; modelChain?: { provider: string; modelId: string; modelName?: string }[] }) => ipcRenderer.invoke(ipcChannels.wechatUpdateSettings, patch) as Promise<WeChatIpcResult<{ settings: WeChatSettings }>>,
		renameAccount: (displayName: string) => ipcRenderer.invoke(ipcChannels.wechatRenameAccount, displayName) as Promise<WeChatIpcResult<{ settings: WeChatSettings }>>,
		logout: () => ipcRenderer.invoke(ipcChannels.wechatLogout) as Promise<WeChatIpcResult<{ settings: WeChatSettings }>>,
		/** 取二维码并开始轮询；返回的状态已带 qrcodeContent，界面可直接渲染。 */
		beginLogin: () => ipcRenderer.invoke(ipcChannels.wechatBeginLogin) as Promise<WeChatIpcResult<{ state: WeChatLoginState }>>,
		cancelLogin: () => ipcRenderer.invoke(ipcChannels.wechatCancelLogin) as Promise<WeChatIpcResult<{ state: WeChatLoginState }>>,
		submitVerifyCode: (code: string) => ipcRenderer.invoke(ipcChannels.wechatSubmitVerifyCode, code) as Promise<WeChatIpcResult<{ state: WeChatLoginState }>>,
		getLoginState: () => ipcRenderer.invoke(ipcChannels.wechatGetLoginState) as Promise<WeChatLoginState>,
		getStatus: () => ipcRenderer.invoke(ipcChannels.wechatGetStatus) as Promise<WeChatBridgeStatus>,
		getBindings: () => ipcRenderer.invoke(ipcChannels.wechatGetBindings) as Promise<WeChatBindingView[]>,
		unbindChat: (chatId: string) => ipcRenderer.invoke(ipcChannels.wechatUnbindChat, chatId) as Promise<WeChatIpcResult<{ removed: boolean; bindings: WeChatBindingView[] }>>,
		onStatus: (callback: (status: WeChatBridgeStatus) => void) => subscribe(ipcChannels.wechatStatus, callback),
		onLoginState: (callback: (state: WeChatLoginState) => void) => subscribe(ipcChannels.wechatLoginState, callback),
		onBindingsChanged: (callback: (bindings: WeChatBindingView[]) => void) => subscribe(ipcChannels.wechatBindingsChanged, callback),
	},
	scratchPad: {
		/** 作用域缺省 = global（与旧调用方兼容）；project 会合并返回本项目 + 全局草稿。 */
		list: (scope?: ScratchPadScope) => ipcRenderer.invoke(ipcChannels.scratchPadList, scope) as Promise<DraftMeta[]>,
		create: (scope?: ScratchPadScope) => ipcRenderer.invoke(ipcChannels.scratchPadCreate, scope) as Promise<DraftMeta>,
		delete: (draftPath: string) => ipcRenderer.invoke(ipcChannels.scratchPadDelete, draftPath) as Promise<void>,
		load: (draftPath?: string) => ipcRenderer.invoke(ipcChannels.scratchPadLoad, draftPath) as Promise<ScratchPadData>,
		save: (draftPath: string, content: string, cursorPosition: number) => ipcRenderer.invoke(ipcChannels.scratchPadSave, draftPath, content, cursorPosition) as Promise<void>,
		export: (draftPath: string) => ipcRenderer.invoke(ipcChannels.scratchPadExport, draftPath) as Promise<boolean>,
	},

	// ── 生图：独立 imagegen.json 凭据 + OpenAI 兼容 /images/generations ──
	imagegen: {
		generate: (request: ImageGenRequest) => ipcRenderer.invoke(ipcChannels.imagegenGenerate, request) as Promise<ImageGenResult>,
		getConfig: () => ipcRenderer.invoke(ipcChannels.imagegenGetConfig) as Promise<ImageGenConfigFile>,
		saveConfig: (config: ImageGenConfigFile) => ipcRenderer.invoke(ipcChannels.imagegenSaveConfig, config) as Promise<ImageGenSaveResult>,
		/** 按 blob 引用名取回落盘图片 base64（历史消息只带 ref，展示走 pideck-img://） */
		readImageBlob: (ref: string) => ipcRenderer.invoke(ipcChannels.imagegenReadImageBlob, ref) as Promise<ImageBlobPayload | null>,
	},

	// ── 对话内本地图片：保存/复制按需取字节（展示走 pideck-file://，不经这里） ──
	localImage: {
		/** 按绝对路径读取白名单内的图片字节；主进程拒绝（越界/超限/非图片）时返回 null */
		readBytes: (path: string) => ipcRenderer.invoke(ipcChannels.localImageReadBytes, path) as Promise<LocalImageBytes | null>,
	},

	// ── 生视频：独立 videogen.json 凭据 + 提交/轮询异步协议（与生图同域不同生命周期） ──
	videogen: {
		submit: (request: VideoGenRequest) => ipcRenderer.invoke(ipcChannels.videogenSubmit, request) as Promise<VideoGenSubmitResult>,
		cancel: (jobId: string) => ipcRenderer.invoke(ipcChannels.videogenCancel, jobId) as Promise<{ ok: boolean }>,
		getConfig: () => ipcRenderer.invoke(ipcChannels.videogenGetConfig) as Promise<VideoGenConfigFile>,
		saveConfig: (config: VideoGenConfigFile) => ipcRenderer.invoke(ipcChannels.videogenSaveConfig, config) as Promise<VideoGenSaveResult>,
		/** 重启后恢复：某会话全部任务快照（渲染层重建进行中占位） */
		listJobs: (sessionId: string) => ipcRenderer.invoke(ipcChannels.videogenListJobs, sessionId) as Promise<VideoGenJobSnapshot[]>,
		/** 任务状态推送（主进程 → 渲染层；组件卸载必须退订） */
		onEvent: (callback: (snapshot: VideoGenJobSnapshot) => void) => subscribe(ipcChannels.videogenEvent, callback),
	},

	// ── 提示词增强：独立 sidecar 复用用户那套 pi 的 ModelRuntime，流式事件按 runId 推送 ──
	enhance: {
		run: (input: EnhanceRunInput) => ipcRenderer.invoke(ipcChannels.enhanceRun, input) as Promise<EnhanceRunResult>,
		cancel: () => ipcRenderer.invoke(ipcChannels.enhanceCancel) as Promise<{ ok: boolean }>,
		onEvent: (callback: (payload: EnhanceEventPayload) => void) => subscribe(ipcChannels.enhanceEvent, callback),
	},

	// ── 输入预测：回合结束后预测下一句输入（与提示词增强同一条侧车协议、独立实例）──
	suggestion: {
		run: (input: PromptSuggestionRunInput) => ipcRenderer.invoke(ipcChannels.suggestRun, input) as Promise<PromptSuggestionRunResult>,
		cancel: () => ipcRenderer.invoke(ipcChannels.suggestCancel) as Promise<{ ok: boolean }>,
		onEvent: (callback: (payload: EnhanceEventPayload) => void) => subscribe(ipcChannels.suggestEvent, callback),
	},
	voiceTranscription: {
		getConfig: () => ipcRenderer.invoke(ipcChannels.voiceTranscriptionGetConfig) as Promise<VoiceTranscriptionPublicConfig>,
		saveConfig: (config: VoiceTranscriptionSaveInput) => ipcRenderer.invoke(ipcChannels.voiceTranscriptionSaveConfig, config) as Promise<VoiceTranscriptionSaveResult>,
		transcribe: (request: VoiceTranscriptionRequest) => ipcRenderer.invoke(ipcChannels.voiceTranscriptionTranscribe, request) as Promise<VoiceTranscriptionResult>,
		cancel: (requestId: string) => ipcRenderer.invoke(ipcChannels.voiceTranscriptionCancel, requestId) as Promise<void>,
		/**
		 * 流式识别（豆包流式 2.0）：开流 → 逐帧 send → 收尾拿终值，中间结果走 onStreamPartial 订阅。
		 * 帧刻意用 `send` 而非 `invoke`：200ms 一帧的单向数据不该每条都等一次往返。
		 */
		startStream: (input: VoiceTranscriptionStreamStartInput) => ipcRenderer.invoke(ipcChannels.voiceTranscriptionStreamStart, input) as Promise<VoiceTranscriptionStreamStartResult>,
		sendStreamFrame: (frame: VoiceTranscriptionStreamFrame) => ipcRenderer.send(ipcChannels.voiceTranscriptionStreamFrame, frame),
		finishStream: (requestId: string) => ipcRenderer.invoke(ipcChannels.voiceTranscriptionStreamFinish, requestId) as Promise<VoiceTranscriptionResult>,
		onStreamPartial: (callback: (partial: VoiceTranscriptionStreamPartial) => void) => subscribe(ipcChannels.voiceTranscriptionStreamPartial, callback),
		/** 用静音探针检测当前配置是否真的能转写（密钥留在主进程，渲染层只拿结论）。 */
		test: () => ipcRenderer.invoke(ipcChannels.voiceTranscriptionTest) as Promise<VoiceTranscriptionTestResult>,
		/** 点「显示」时按需取回某一格明文；null = 该格没配置或系统安全存储不可用。 */
		revealSecret: (field: VoiceTranscriptionSecretField) => ipcRenderer.invoke(ipcChannels.voiceTranscriptionRevealSecret, field) as Promise<string | null>,
		/** 本地 whisper 运行时/模型安装状态（含自定义 CLI 路径生效判定）。 */
		runtimeStatus: () => ipcRenderer.invoke(ipcChannels.voiceTranscriptionRuntimeStatus) as Promise<WhisperRuntimeStatus>,
		/** 按需下载 whisper-cli 二进制（进度走 onRuntimeProgress）。 */
		installRuntime: () => ipcRenderer.invoke(ipcChannels.voiceTranscriptionRuntimeInstall) as Promise<WhisperInstallResult>,
		/** 按需下载指定 ggml 模型（入参为共享目录里的 modelId）。 */
		installModel: (modelId: string) => ipcRenderer.invoke(ipcChannels.voiceTranscriptionModelInstall, modelId) as Promise<WhisperInstallResult>,
		deleteModel: (modelId: string) => ipcRenderer.invoke(ipcChannels.voiceTranscriptionModelDelete, modelId) as Promise<WhisperInstallResult>,
		/** 安装进度推送；返回退订函数。 */
		onRuntimeProgress: (callback: (progress: WhisperInstallProgress) => void) => subscribe(ipcChannels.voiceTranscriptionRuntimeProgress, callback),
		/** 取消进行中的下载（运行时与模型同一时刻只有一个任务）；false = 当前没有在跑的任务。 */
		abortInstall: () => ipcRenderer.invoke(ipcChannels.voiceTranscriptionInstallCancel) as Promise<boolean>,
	},

	// ── 系统级划词浮窗（全局快捷键触发的独立窗口；与主窗口共用同一份 preload） ──
	selectionTool: {
		getState: () => ipcRenderer.invoke(ipcChannels.selectionToolGetState) as Promise<SelectionToolWindowState>,
		hide: () => ipcRenderer.invoke(ipcChannels.selectionToolHide) as Promise<void>,
		/** 折叠浮条 ↔ 展开结果面板：渲染层按内容请求窗口尺寸。 */
		resize: (input: SelectionToolResizeInput) => ipcRenderer.invoke(ipcChannels.selectionToolResize, input) as Promise<void>,
		/** 浮窗「发送到 PiDeck」：把文本插入主窗口当前会话输入框。 */
		insertToMain: (input: SelectionToolInsertInput) => ipcRenderer.invoke(ipcChannels.selectionToolInsertToMain, input) as Promise<boolean>,
		/** 浮窗显示时主进程推送的捕获文本（空串 = 没读到，让用户手输）。 */
		onCaptured: (callback: (payload: SelectionToolShowPayload) => void) => subscribe<SelectionToolShowPayload>(ipcChannels.selectionToolCaptured, callback),
		onStateChanged: (callback: (state: SelectionToolWindowState) => void) => subscribe<SelectionToolWindowState>(ipcChannels.selectionToolStateChanged, callback),
		/** 主窗口侧：系统浮窗点「发送到 PiDeck」时收到文本（插入当前会话输入框）。 */
		onInserted: (callback: (payload: SelectionToolInsertInput) => void) => subscribe<SelectionToolInsertInput>(ipcChannels.selectionToolInserted, callback),
	},

	// ── CUA 审批门 ──
	cua: {
		/** 监听审批请求（主进程 → 渲染层）。 */
		onApprovalRequest: (callback: (request: { requestId: string; action: string; sessionId: string; detail: unknown; timestampMs: number }) => void) => subscribe(ipcChannels.cuaApprovalRequest, callback),
		/** 回传审批结果（渲染层 → 主进程）。 */
		sendApprovalResponse: (requestId: string, response: { allowed: boolean; reason?: string }) => ipcRenderer.invoke(ipcChannels.cuaApprovalResponse, requestId, response) as Promise<void>,
		/** 拉取 CUA 开关状态。 */
		getState: () => ipcRenderer.invoke(ipcChannels.cuaGetState) as Promise<{ enabled: boolean; sessionOverrides: Record<string, boolean> }>,
		/** 设置 CUA 开关。 */
		setState: (patch: { enabled?: boolean; sessionOverride?: { sessionId: string; enabled: boolean | null } }) => ipcRenderer.invoke(ipcChannels.cuaSetState, patch) as Promise<{ enabled: boolean; sessionOverrides: Record<string, boolean> }>,
	},
};
