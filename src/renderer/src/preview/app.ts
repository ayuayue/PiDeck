import type { PiDesktopApi } from "../../../preload";
import { now, noop } from "./fixtures";

/**
 * 应用外壳域桩：版本信息与更新、提示音、公告与内置目录。
 */
export function createAppPreview(): Pick<PiDesktopApi, "app" | "sounds" | "announcements" | "catalog"> {
	return {
		app: {
			info: async () => ({
				version: "preview",
				releasesUrl: "https://github.com/ayuayue/PiDeck/releases",
				platform: "win32" as NodeJS.Platform,
				homeDir: "C:/Users/preview",
				userDataDir: "C:/Users/preview/AppData/Roaming/PiDeck",
			}),
			preferredSystemLanguages: async () => (navigator.languages?.length ? [...navigator.languages] : [navigator.language]),
			networkAddresses: async () => [{ address: "192.168.1.100", interfaceName: "Wi-Fi", cidr: "192.168.1.100/24", isPrivate: true, family: "IPv4" }],
			checkUpdate: async () => undefined,
			// 浏览器预览不是真实构建：按 release 呈现，不显示「本地构建」徽章。
			// remoteAvailable=true 是**有意的预览口径**：让「设置 → 连接」与远端入口在静态预览里可渲染；
			// 预览没有主进程/SSH，所有远端写面返回 REMOTE_FEATURE_DISABLED（见 remoteHosts 段注释），
			// 两者成对出现，由 tests/remoteChannelGate.test.mjs 钉住。改这里必须同步改那组写面。
			getChannel: async () => ({ channel: "stable" as const, currentVersion: "preview", devBuild: false, remoteAvailable: true, buildOrigin: "release" as const }),
			onUpdateStatus: () => () => undefined,
			onOpenSettings: () => () => undefined,
			// 预览/浏览器模式没有全局快捷键，订阅退化为空操作
			onShortcutTriggered: () => () => undefined,
			getUpdateStatus: async () => null,
			notifyUpdateSeen: async () => undefined,
			skipUpdateVersion: async () => undefined,
			downloadUpdate: async () => undefined,
			installUpdate: async () => undefined,
			checkUpdateMirrors: async () => [{ id: "atomgit", status: "ok", latencyMs: 320, speedKBps: 2560, checkedAt: Date.now() }],
			onOpenInBrowser: () => () => undefined,
			feedbackEnvironment: async () => ({
				appVersion: "preview",
				platform: "win32",
				arch: "x64",
				electronVersion: "preview",
				chromeVersion: "preview",
				nodeVersion: "preview",
				pi: {
					installed: true,
					command: "pi",
					version: "preview",
					searchedDirs: [],
				},
			}),
			getFeedbackProjectContext: async (_projectId: string) => ({
				projectId: _projectId,
				projectName: "preview",
				agentsMd: "",
				agentsMdTruncated: false,
				skills: [],
			}),
			openExternal: async () => undefined,
			// 浏览器预览态无主进程：直接返回失败载荷，UI 自动走「在浏览器打开」降级。
			getChangelog: async () => ({
				markdown: null,
				source: null,
				versionCount: 0,
				pageUrl: "https://atomgit.com/ayuayue/PiDeck/blob/main/CHANGELOG.zh-CN.md",
				fetchedAt: null,
				fromCache: false,
				stale: false,
			}),
			restart: async () => undefined,
			quit: async () => undefined,
			openDataDir: async () => ({ ok: true }),
			rendererLog: async (level, scope, message, detail) => {
				console[level === "error" ? "error" : level === "warn" ? "warn" : "debug"](`[${scope}] ${message}`, detail);
			},
			minimizeWindow: async () => undefined,
			toggleMaximizeWindow: async () => false,
			isWindowMaximized: async () => false,
			onWindowMaximizedChange: () => () => undefined,
			// 预览环境无主进程快捷键，返回空订阅以保持 API 形状
			onZoomFactorChange: () => () => undefined,
			toggleAlwaysOnTopWindow: async () => false,
			isWindowAlwaysOnTop: async () => false,
			closeWindow: async () => undefined,
			toggleDevTools: async () => false,
		},

		sounds: {
			// 预览模式：不真实播放，事件订阅空操作（保持 PiDesktopApi 形状完整）
			onPlay: noop,
			listCustom: async () => [],
			importCustom: async () => ({ ok: false, error: "canceled" as const }),
			removeCustom: async () => false,
		},
		announcements: {
			// 预览模式：无公告数据，返回空快照保持 PiDesktopApi 形状完整（订阅空操作）
			list: async () => ({ items: [], fetchedAt: null, source: "cache" as const, readIds: [], notifiedIds: [] }),
			refresh: async () => ({ items: [], fetchedAt: null, source: "cache" as const, readIds: [], notifiedIds: [] }),
			markRead: async () => true,
			markAllRead: async () => true,
			markNotified: async () => true,
			onChanged: () => () => {},
		},

		// 模型目录预览桩：无内置目录可读，返回「不可用」空态，仅供预览不崩溃
		catalog: {
			status: async () => ({ builtin: null, overlay: null, hasOverlayFiles: false, hasBackup: false }),
			check: async () => ({ ok: false, code: "network", message: "preview stub" }),
			updateFromGithub: async () => ({ ok: false, code: "network", message: "preview stub" }),
			restore: async () => ({ ok: true, updated: false }),
			restorePrevious: async () => ({ ok: false, code: "no-backup", message: "preview stub" }),
			openFile: async () => undefined,
		},
	};
}
