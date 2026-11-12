import type { PiDesktopApi } from "../../../preload";
import { createDefaultExternalEditorSettings, createDefaultSecurityConfig, createDefaultSoundAlertSettings, DEFAULT_PET_SCALE, DEFAULT_TOAST_DURATION_MS, emptyRemoteAccessState } from "../../../shared/types";
import { SESSION_TAB_MAX_WIDTH_DEFAULT } from "../../../shared/sessionTabWidth";
import type { AppSettings } from "../../../shared/types";
import { t } from "../i18n";
import { now, noop } from "./fixtures";

/**
 * 预览模式的设置副本与安全配置桩：settings.update 只改这份实例内副本。
 */
export function createSettingsPreview(): Pick<PiDesktopApi, "editors" | "settings" | "security"> {
	let previewSettings: AppSettings = {
		useNativeTitleBar: true,
		showNativeMenu: false,
		sendShortcut: "enter-send",
		defaultAgentBackend: "pi",
		agentMemoryEnabled: false,
		agentMemoryAutoLearnEnabled: false,
		floatingBallShowRunningBadge: true,
		theme: "system",
		themeScheduleLightStart: "07:00",
		themeScheduleDarkStart: "19:00",
		accent: "default",
		themeStyle: "classic",
		themePalette: "classic-green",
		customThemeOverrides: {},
		backgroundImage: "",
		backgroundImageOpacity: 0.8,
		weWorkshopDir: "",
		weWallpaperId: "",
		language: "system",
		startupWindowMode: "last",
		piEnvironmentChecked: true,
		/** 扩展禁用白名单：与 SettingsStore 默认一致，预览壳不启用白名单 */
		/** 扩展禁用白名单：与 SettingsStore 默认一致，预览壳不启用白名单 */
		disabledExtensions: [],
		/** 技能禁用列表：与 SettingsStore 默认一致，预览壳不启用技能白名单 */
		disabledSkills: [],
		/** 提示词模板禁用列表：与 SettingsStore 默认一致，预览壳不启用模板白名单 */
		disabledPrompts: [],
		sessionTabOpenMode: "preview",
		scratchPadScope: "project", // 与 SettingsStore 默认一致：草稿本按项目隔离
		busySendDelivery: "steer",
		tpsDisplayMode: "streaming",
		// 遗留字段：快捷消息已改存独立配置文件（预览模式没有真实文件，见下方 quickMessages 预览桩）
		quickMessages: [],
		enableGitManagement: true,
		gitCommitMessagePrompt: "",
		gitCommitMessageProvider: "",
		gitCommitMessageModel: "",
		gitExecutablePath: "",
		dshRunnerNodePath: "",
		closeToTray: true,
		singleInstance: true,
		enableNotifications: true,
		// 与主进程 SettingsStore 默认一致：标题生成默认开启，预览壳与真实设置保持一致
		autoSessionTitle: true,
		// Ask 提问系统通知默认关闭：与主进程 SettingsStore 默认一致
		askNotificationEnabled: false,
		// 仅失焦提醒开关：与主进程 SettingsStore 默认一致（预览 mock 需覆盖 AppSettings 全部必填字段）
		alertOnlyWhenUnfocused: false,
		// 人文关怀提醒开关：与主进程 SettingsStore 默认值保持一致（预览 mock 需覆盖 AppSettings 全部必填字段）
		agentCountReminderEnabled: true,
		// 公告通知开关：与主进程 SettingsStore 默认一致（预览 mock 需覆盖 AppSettings 全部必填字段）
		announcementNotificationEnabled: true,
		// toast 展示时长：与主进程 defaultSettings 一致
		toastDurationMs: DEFAULT_TOAST_DURATION_MS,
		// showThinking 由 pi agent 的 hideThinkingBlock 控制，运行时从主进程加载
		showThinking: true,
		// 流式对话行为：与主进程 SettingsStore 默认一致（预览窗口保持相同观感）
		expandInterimDuringStream: true,
		// 过程组显示默认开启：与主进程 SettingsStore 默认一致（预览窗口按过程组渲染）
		processGroupDisplay: true,
		showDevTools: false,
		developerDiagnostics: false,
		electronChromiumSandbox: false,
		piProxyEnabled: false,
		piProxyUrl: "http://127.0.0.1:7890",
		piProxyBypass: "localhost,127.0.0.1,::1",
		piProxyProviders: [],
		piProxyModels: [],
		acpProxyEnabled: false,
		acpProxyUrl: "http://127.0.0.1:7890",
		acpProxyBypass: "localhost,127.0.0.1,::1",
		desktopProxyEnabled: false,
		desktopProxyUrl: "http://127.0.0.1:7890",
		desktopProxyBypass: "localhost,127.0.0.1,::1",
		customPiPath: "",
		piCustomPaths: [],
		wslEnabled: false,
		wslDistro: "Ubuntu",
		wslUser: "root",
		telemetryEnabled: true,
		webServiceEnabled: false,
		webServiceHost: "0.0.0.0",
		webServicePort: 8765,
		webServiceRequiresAuth: true,
		rpcTimeout: 600_000,
		linkOpenMode: "external",
		workspaceContentOpenMode: "split",
		contentMaxWidth: 1800,
		chatContentWidthPct: 80,
		sessionStatusPlacement: "composer",
		navigationMode: "tabs",
		sessionTabMaxWidth: SESSION_TAB_MAX_WIDTH_DEFAULT,
		maxEditorFileSizeMB: 5,
		externalEditors: createDefaultExternalEditorSettings(),

		// 桌面宠物默认关闭
		petEnabled: false,
		petId: "clawd",
		petAlwaysOnTop: true,
		petScale: DEFAULT_PET_SCALE,
		petPatrolEnabled: true,
		petPatrolPauseMin: 5,
		// 悬浮球默认关闭
		floatingBallEnabled: false,
		floatingBallExpandTarget: "mini",
		floatingBallAlwaysOnTop: true,
		floatingBallSnapToEdge: true,
		// 闲置 agent 自动释放（预览模式不真实释放，仅保持设置项可用）
		idleAgentAutoRelease: true,
		idleAgentKeepCount: 5,
		idleAgentTimeoutMin: 60,
		// CUA 默认关闭：预览壳与主进程 SettingsStore 默认保持一致
		cuaEnabled: false,
		cuaAutoApprove: true,
		// 浏览器 Agent 默认关闭 + 写动作默认免审批（与 SettingsStore 默认一致）
		browserAgentEnabled: false,
		browserAgentAutoApprove: true,
		favoriteModels: [],
		// 提供商与模型显示开关：与 SettingsStore 默认一致，预览壳默认全显示
		hiddenProviders: [],
		hiddenModels: [],
		hiddenModules: [],
		hiddenComposerFeatures: [],

		fontSize: "medium",
		uiFontSize: null,
		tabBarFontSize: null,
		chatFontSize: null,
		inputFontSize: null,
		zoomFactor: 1,
		fontFamilyBase: "system",
		fontFamilyBaseCustom: "",
		fontFamilyMono: "system-mono",
		fontFamilyMonoCustom: "",
		removedBuiltInExtensions: [],
		// 与主进程 defaultSettings 保持一致（预览壳不真实播放，仅保持设置项形状完整）
		soundAlert: createDefaultSoundAlertSettings(),
		imageGenSize: "unset",
		imageGenWatermark: false,
		imageGenOutputFormat: "png",
		autoDownloadUpdates: true,
		catalogAutoUpdate: true,
		// 与主进程 defaultSettings 保持一致：更新源默认 GitHub 官方，自定义镜像前缀留空
		updateSource: "github",
		customUpdateSourceUrl: "",
		// 与主进程 defaultSettings 保持一致：offline 默认关，让模型目录随启动刷新
		piRpcOffline: false,
		piRpcNoExtensions: false,
		piRpcNoSkills: false,
		// 终端：与主进程 defaultSettings 保持一致（预览壳不真实枚举字体，仅保持设置项形状完整）
		terminalTheme: "inherit",
		terminalFontSize: null,
		terminalFontFamily: "",
		terminalScrollback: 5000,
		terminalCursorStyle: "block",
		terminalCursorBlink: true,
		terminalCopyOnSelect: false,
		terminalPaddingY: 8,
		terminalConfirmClose: "running",
		terminalStartupCommand: "",
	};

	return {
		editors: {
			list: async () => [],
			redetect: async () => ({ ...previewSettings }),
			update: async (_editorId, patch) => {
				previewSettings = {
					...previewSettings,
					externalEditors: {
						...previewSettings.externalEditors,
						[_editorId]: {
							...previewSettings.externalEditors[_editorId],
							...patch,
							updatedAt: Date.now(),
						},
					},
				};
				return { ...previewSettings };
			},
			chooseExecutable: async () => null,
			openProject: async () => undefined,
		},

		settings: {
			get: async (): Promise<AppSettings> => ({ ...previewSettings }),
			update: async (patch): Promise<AppSettings> => {
				previewSettings = { ...previewSettings, ...patch };
				return { ...previewSettings };
			},
			restartWebService: async () => undefined,
			webServiceStatus: async () => ({
				running: false,
				host: "",
				port: 0,
				token: "",
				requiresAuth: false,
				tokenExpiresAt: null,
			}),
			rotateWebToken: async () => ({
				running: false,
				host: "",
				port: 0,
				token: "",
				requiresAuth: false,
				tokenExpiresAt: null,
			}),
			setWebToken: async () => ({
				running: false,
				host: "",
				port: 0,
				token: "",
				requiresAuth: false,
				tokenExpiresAt: null,
			}),
			webRemoteAccessState: async () => emptyRemoteAccessState(),
			webRemoteAccessStart: async () => ({ ok: false as const, error: "preview" }),
			webRemoteAccessStop: async () => ({ ok: false as const, error: "preview" }),
			webRemoteAccessRefresh: async () => emptyRemoteAccessState(),
			onWebRemoteAccessChanged: noop,
			testPiProxy: async () => ({
				success: true,
				url: "https://api.openai.com/v1/models",
				elapsedMs: 120,
				statusCode: 401,
				message: t("preview.proxyOk"),
			}),
			onApplyWindow: noop,
		},
		security: {
			getConfig: async () => createDefaultSecurityConfig(),
			updateConfig: async () => ({
				ok: true,
				config: createDefaultSecurityConfig(),
			}),
			setSessionLevel: async () => ({
				ok: true,
				config: createDefaultSecurityConfig(),
			}),
			onConfigChanged: noop,
		},
	};
}
