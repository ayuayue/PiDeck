import type { PiDesktopApi } from "../../../preload";
import { DEFAULT_VOICE_TRANSCRIPTION_CONFIG } from "../../../shared/voiceTranscriptionConfig";
import { EMPTY_VIDEO_GEN_CONFIG } from "../../../shared/videoGenConfig";

/**
 * 外围集成桩：飞书/微信桥、内置浏览器、划词浮窗、CUA 与生成式媒体（图片/视频/语音）。
 */
export function createIntegrationsPreview(): Pick<PiDesktopApi, "feishu" | "browser" | "wechat" | "scratchPad" | "imagegen" | "localImage" | "videogen" | "enhance" | "suggestion" | "voiceTranscription" | "selectionTool" | "cua"> {
	return {
		feishu: {
			connect: async () => ({ success: true, message: "预览模式" }),
			connectTemp: async () => ({ success: false, message: "预览模式不支持" }),
			disconnect: async () => ({ success: true }),
			connectByBot: async () => ({ success: false, message: "预览模式不支持" }),
			statusRequest: async () => ({ status: "disconnected" as const, activeBindings: 0 }),
			onStatus: () => () => {},
			botsList: async () => [],
			botAdd: async () => ({ success: false, error: "预览模式不支持" }),
			botRemove: async () => false,
			botConfig: async () => undefined,
			botSecret: async () => "",
			testConnection: async () => ({ success: false, message: "预览模式不支持" }),
			bindingsList: async () => [],
			bindingRemove: async () => false,
			bindingUpdate: async () => undefined,
			onMessages: () => () => {},
			onBindingsChanged: () => () => {},
			onBotsChanged: () => () => {},
			onWhoamiResult: () => () => {},
			sessionBotGet: async () => null,
			sessionBotSet: async () => ({ success: true }),
		},
		browser: {
			openExternal: async () => {},
		},
		wechat: {
			snapshot: async () => ({ ok: false, message: "预览模式不支持" }),
			setEnabled: async () => ({ ok: false, message: "预览模式不支持" }),
			updateSettings: async () => ({ ok: false, message: "预览模式不支持" }),
			renameAccount: async () => ({ ok: false, message: "预览模式不支持" }),
			logout: async () => ({ ok: false, message: "预览模式不支持" }),
			beginLogin: async () => ({ ok: false, message: "预览模式不支持" }),
			cancelLogin: async () => ({ ok: false, message: "预览模式不支持" }),
			submitVerifyCode: async () => ({ ok: false, message: "预览模式不支持" }),
			getLoginState: async () => ({ phase: "idle" as const }),
			getStatus: async () => ({ status: "disconnected" as const, account: null, activeBindings: 0 }),
			getBindings: async () => [],
			unbindChat: async () => ({ ok: false, message: "预览模式不支持" }),
			onStatus: () => () => {},
			onLoginState: () => () => {},
			onBindingsChanged: () => () => {},
		},
		scratchPad: {
			list: async () => [],
			create: async (scope) => ({ id: "", name: "", path: "", createdAt: 0, updatedAt: 0, scope: scope?.kind === "project" ? "project" : "global" }),
			delete: async () => {},
			load: async () => ({ content: "", lastEditedAt: 0, cursorPosition: 0 }),
			save: async () => {},
			export: async () => false,
		},

		// 生图预览桩：预览模式不联网、无落盘图片，直接返回未配置 / 空图
		imagegen: {
			generate: async (_request) => ({ ok: false, error: "notConfigured" }),
			getConfig: async () => ({ providers: [], activeProviderId: "", activeModel: "" }),
			saveConfig: async (config) => ({ ok: true, config }),
			readImageBlob: async () => null,
		},
		// 本地图片预览桩：没有主进程白名单，取不到字节（保存/复制降级为失败提示）
		localImage: {
			readBytes: async () => null,
		},
		// 生视频预览桩：与生图同策略（LAN web 模式继承此桩，远程暂不支持生视频任务）
		videogen: {
			submit: async () => ({ ok: false, error: "notConfigured" }),
			cancel: async () => ({ ok: false }),
			getConfig: async () => ({ ...EMPTY_VIDEO_GEN_CONFIG, providers: [] }),
			saveConfig: async (config) => ({ ok: true, config }),
			listJobs: async () => [],
			onEvent: () => () => {},
		},
		enhance: {
			run: async () => ({ ok: false, errorKind: "sdk-unavailable", message: "preview mode" }),
			cancel: async () => ({ ok: true }),
			onEvent: () => () => {},
		},

		// 输入预测在预览态没有主进程，直接按「不支持」返回：composer 会静默不显示 ghost。
		suggestion: {
			run: async () => ({ ok: false, errorKind: "sdk-unavailable", message: "preview mode" }),
			cancel: async () => ({ ok: true }),
			onEvent: () => () => {},
		},

		voiceTranscription: {
			getConfig: async () => ({ ...DEFAULT_VOICE_TRANSCRIPTION_CONFIG, hasApiKey: false, hasVolcAppId: false, hasVolcAccessToken: false, apiKeyHint: null, volcAppIdHint: null, volcAccessTokenHint: null, runtimeReady: false }),
			saveConfig: async (config) => ({
				ok: true,
				config: {
					enabled: config.enabled,
					engine: config.engine,
					cloudProvider: config.cloudProvider,
					baseUrl: config.baseUrl,
					model: config.model,
					language: config.language,
					inputDeviceId: config.inputDeviceId,
					localModelId: config.localModelId,
					cliPath: config.cliPath,
					cloudResourceId: config.cloudResourceId,
					hasApiKey: false,
					hasVolcAppId: false,
					hasVolcAccessToken: false,
					apiKeyHint: null,
					volcAppIdHint: null,
					volcAccessTokenHint: null,
					runtimeReady: false,
				},
			}),
			transcribe: async () => ({ ok: false, error: "notConfigured" }),
			test: async () => ({ ok: false, error: "notConfigured" }),
			revealSecret: async () => null,
			cancel: async () => {},
			// 预览环境没有 WebSocket 服务：开流直接回 notConfigured，录音链路会照直落在整段转写的桩上。
			startStream: async () => ({ ok: false, error: "notConfigured" }),
			sendStreamFrame: () => {},
			finishStream: async () => ({ ok: false, error: "notConfigured" }),
			onStreamPartial: () => () => undefined,
			runtimeStatus: async () => ({ autoRuntimeSupported: false, cliReady: false, cliSource: "none", cliPath: null, runtimeVersion: null, models: [] }),
			installRuntime: async () => ({ ok: false, error: "preview stub" }),
			installModel: async () => ({ ok: false, error: "preview stub" }),
			deleteModel: async () => ({ ok: false, error: "preview stub" }),
			onRuntimeProgress: () => () => undefined,
			abortInstall: async () => false,
		},

		// 系统级划词浮窗：预览/Web 端没有独立窗口，全部 inert。
		selectionTool: {
			getState: async () => ({ visible: false }),
			hide: async () => {},
			resize: async () => {},
			insertToMain: async () => false,
			onCaptured: () => () => {},
			onStateChanged: () => () => {},
			onInserted: () => () => {},
		},
		cua: {
			onApprovalRequest: () => () => {},
			sendApprovalResponse: async () => {},
			getState: async () => ({ enabled: false, sessionOverrides: {} }),
			setState: async () => ({ enabled: false, sessionOverrides: {} }),
		},
	};
}
