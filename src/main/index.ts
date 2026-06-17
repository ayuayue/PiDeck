import {
	app,
	BrowserWindow,
	ipcMain,
	Menu,
	nativeImage,
	net,
	shell,
	Tray,
} from "electron";
import { join } from "node:path";
import { is } from "@electron-toolkit/utils";
// 使用 ?asset 后缀导入图标，electron-vite 会在构建时将其复制到输出目录并提供正确的运行时路径
// 这解决了打包后 build/ 目录不在 asar 中导致托盘图标丢失的问题
import iconPath from "../../build/icon.png?asset";

// 开发模式下 stdout 管道可能断开导致 EPIPE 崩溃，全局静默处理
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
	if (err.code === "EPIPE") return;
	throw err;
});
process.stderr.on("error", (err: NodeJS.ErrnoException) => {
	if (err.code === "EPIPE") return;
	throw err;
});
import { ipcChannels } from "../shared/ipc";
import type {
	AppSettings,
	AppUpdateAsset,
	AppUpdateInfo,
	CreateAgentInput,
	FeishuBotConfig,
	FeishuBridgeStatus,
	FeishuConnectInput,
	FeishuTestResult,
	SendPromptInput,
	CreatePiSkillInput,
} from "../shared/types";
import { ProjectStore } from "./projects/ProjectStore";
import { FileSystemService } from "./fs/FileSystemService";
import { AgentManager } from "./pi/AgentManager";
import { PiLocator } from "./pi/PiLocator";
import { testPiProxy } from "./pi/PiProxyTester";
import { SessionScanner } from "./sessions/SessionScanner";
import { CodexSessionImporter } from "./sessions/CodexSessionImporter";
import { ClaudeSessionImporter } from "./sessions/ClaudeSessionImporter";
import { SettingsStore } from "./settings/SettingsStore";
import { applyDesktopProxy } from "./settings/DesktopProxy";
import { GitService } from "./git/GitService";
import { ConfigManager } from "./config/ConfigManager";
import { TerminalSessionManager } from "./terminal/TerminalSessionManager";
import { TelemetryService } from "./telemetry/TelemetryService";
import { SkillManager } from "./skills/SkillManager";
import { ExtensionManager } from "./extensions/ExtensionManager";
import { WebServiceManager } from "./web/WebServiceManager";
import { FeishuBridge } from "./feishu/FeishuBridge";
import {
	listBots,
	getBot,
	addBot as addFeishuBot,
	removeBot as removeFeishuBot,
	updateBot as updateFeishuBot,
	getDecryptedBotAppSecret,
} from "./feishu/FeishuConfig";
import type { FeishuChatBinding } from "../shared/types";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
/** 标记是否由用户主动退出（托盘菜单「退出」），区别于窗口关闭隐藏到托盘 */
let isQuitting = false;
let projectStore: ProjectStore;
let fileSystemService: FileSystemService;
let sessionScanner: SessionScanner;
let codexSessionImporter: CodexSessionImporter;
let claudeSessionImporter: ClaudeSessionImporter;
let settingsStore: SettingsStore;
let gitService: GitService;
let piLocator: PiLocator;
let agentManager: AgentManager;
let configManager: ConfigManager;
let skillManager: SkillManager;
let extensionManager: ExtensionManager;
let webServiceManager: WebServiceManager;
let terminalManager: TerminalSessionManager;
let feishuBridge: FeishuBridge | null = null;

const RELEASES_URL = "https://github.com/ayuayue/pi-desktop/releases";
const LATEST_RELEASE_API =
	"https://api.github.com/repos/ayuayue/pi-desktop/releases/latest";
const POSTHOG_PROJECT_KEY =
	process.env.POSTHOG_PROJECT_KEY ??
	"phc_xgJ8gFUMgExZEEPzZ7VRa7698ENcaDRquWZVGYb2dCFK";
const POSTHOG_HOST = process.env.POSTHOG_HOST ?? "https://us.i.posthog.com";

type GitHubReleaseAsset = {
	name: string;
	browser_download_url: string;
	size: number;
};

type GitHubRelease = {
	tag_name?: string;
	name?: string;
	body?: string;
	html_url?: string;
	published_at?: string;
	assets?: GitHubReleaseAsset[];
};

function normalizeVersion(version: string) {
	return version.trim().replace(/^v/i, "");
}

function compareVersions(left: string, right: string) {
	const leftParts = normalizeVersion(left)
		.split(/[.-]/)
		.map((part) => Number(part) || 0);
	const rightParts = normalizeVersion(right)
		.split(/[.-]/)
		.map((part) => Number(part) || 0);
	const length = Math.max(leftParts.length, rightParts.length);
	for (let index = 0; index < length; index += 1) {
		const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

function selectRecommendedAsset(assets: AppUpdateAsset[]) {
	const platform = process.platform;
	const arch = process.arch;
	// 第一版只负责把用户带到最合适的下载项；不同安装形态仍由用户决定如何安装，避免误覆盖便携版/包管理器安装。
	const candidates = assets.map((asset) => ({
		...asset,
		lowerName: asset.name.toLowerCase(),
	}));
	const archKeywords =
		arch === "arm64" ? ["arm64", "aarch64"] : ["x64", "amd64", "x86_64"];
	const matchesArch = (name: string) =>
		archKeywords.some((keyword) => name.includes(keyword));
	if (platform === "win32") {
		return (
			candidates.find(
				(asset) => asset.lowerName.endsWith(".exe") && matchesArch(asset.lowerName),
			) ??
			candidates.find((asset) => asset.lowerName.endsWith(".exe")) ??
			candidates.find(
				(asset) => asset.lowerName.endsWith(".zip") && matchesArch(asset.lowerName),
			)
		);
	}
	if (platform === "darwin") {
		return (
			candidates.find(
				(asset) => asset.lowerName.endsWith(".dmg") && matchesArch(asset.lowerName),
			) ??
			candidates.find((asset) => asset.lowerName.endsWith(".dmg")) ??
			candidates.find(
				(asset) => asset.lowerName.endsWith(".zip") && matchesArch(asset.lowerName),
			)
		);
	}
	if (platform === "linux") {
		return (
			candidates.find(
				(asset) => asset.lowerName.includes("appimage") && matchesArch(asset.lowerName),
			) ??
			candidates.find(
				(asset) => asset.lowerName.endsWith(".deb") && matchesArch(asset.lowerName),
			) ??
			candidates.find(
				(asset) => asset.lowerName.endsWith(".tar.gz") && matchesArch(asset.lowerName),
			) ??
			candidates.find((asset) => asset.lowerName.includes("appimage"))
		);
	}
	return candidates[0];
}

async function checkForAppUpdate(): Promise<AppUpdateInfo> {
	const currentVersion = app.getVersion();
	const response = await fetch(LATEST_RELEASE_API, {
		headers: {
			Accept: "application/vnd.github+json",
			"User-Agent": `pi-desktop/${currentVersion}`,
		},
	});
	if (!response.ok) {
		throw new Error(`GitHub Release 检查失败：HTTP ${response.status}`);
	}
	const release = (await response.json()) as GitHubRelease;
	const latestVersion = normalizeVersion(release.tag_name || currentVersion);
	const assets = (release.assets ?? []).map((asset) => ({
		name: asset.name,
		url: asset.browser_download_url,
		size: asset.size,
	}));
	return {
		currentVersion,
		latestVersion,
		hasUpdate: compareVersions(latestVersion, currentVersion) > 0,
		releaseName: release.name || `v${latestVersion}`,
		releaseNotes: release.body || "",
		releaseUrl: release.html_url || RELEASES_URL,
		publishedAt: release.published_at,
		assets,
		recommendedAsset: selectRecommendedAsset(assets),
	};
}

function setupTray() {
	// iconPath 由 electron-vite 的 ?asset 后缀自动解析，打包后也能正确定位
	const icon = nativeImage.createFromPath(iconPath);
	tray = new Tray(icon.resize({ width: 16, height: 16 }));
	tray.setToolTip("PiDeck");

	// 双击托盘图标恢复窗口（Windows 常见交互）
	tray.on("double-click", () => {
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.show();
			mainWindow.focus();
		}
	});

	const contextMenu = Menu.buildFromTemplate([
		{
			label: "显示窗口",
			click: () => {
				if (mainWindow && !mainWindow.isDestroyed()) {
					mainWindow.show();
					mainWindow.focus();
				}
			},
		},
		{ type: "separator" },
		{
			label: "退出 PiDeck",
			click: () => {
				isQuitting = true;
				app.quit();
			},
		},
	]);
	tray.setContextMenu(contextMenu);
}

function createWindow() {
	const windowOptions = settingsStore.createWindowOptions();

	mainWindow = new BrowserWindow({
		show: false,
		backgroundColor: "#eef0f3",
		width: 1480,
		height: 960,
		minWidth: 1180,
		minHeight: 840,
		title: "",
		icon: iconPath,
		frame: windowOptions.frame,
		titleBarStyle: windowOptions.titleBarStyle,
		trafficLightPosition: windowOptions.trafficLightPosition,
		webPreferences: {
			preload: join(__dirname, "../preload/index.js"),
			sandbox: false,
			contextIsolation: true,
			nodeIntegration: false,
		},
	});

	// 所有 target="_blank" 或 window.open 的链接统一用系统浏览器打开，
	// 避免在 Electron 窗口内弹出新 BrowserWindow。
	mainWindow.webContents.setWindowOpenHandler(({ url }) => {
		if (url.startsWith("http:") || url.startsWith("https:")) {
			void shell.openExternal(url);
		}
		return { action: "deny" };
	});

	mainWindow.once("ready-to-show", () => {
		mainWindow?.show();
		// 窗口显示后立即最大化，提供更好的默认工作空间
		mainWindow?.maximize();
	});

	// 关闭窗口时根据设置决定：隐藏到托盘还是正常退出
	mainWindow.on("close", (event) => {
		if (!isQuitting && settingsStore.get().closeToTray) {
			event.preventDefault();
			mainWindow?.hide();
		} else if (!isQuitting) {
			// 如果没有启用托盘，关闭窗口时直接退出应用
			isQuitting = true;
			app.quit();
		}
	});

	if (is.dev && process.env.ELECTRON_RENDERER_URL) {
		mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
	} else {
		mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
	}
}

// ===== 飞书桥接 IPC =====

/** 自动连接：启动时检查已保存的 Bot 配置，自动连接 */
async function autoConnectFeishu() {
	const bots = listBots();
	if (bots.length === 0) return;
	// 取第一个启用的 Bot
	const bot = bots.find((b) => b.enabled);
	if (!bot) return;

	console.log("[飞书] 检测到已保存的 Bot 配置，自动连接:", bot.name);
	try {
		feishuBridge = new FeishuBridge(bot, agentManager, () => mainWindow, () => projectStore.list());
		await feishuBridge.start();
		console.log("[飞书] 自动连接成功");
	} catch (error) {
		console.error("[飞书] 自动连接失败:", error);
		feishuBridge = null;
		// 失败不阻塞启动，用户可手动连接
	}
}

function registerFeishuIpc() {
	// 连接飞书
	ipcMain.handle(ipcChannels.feishuConnect, async (_event, input: FeishuConnectInput) => {
		try {
			// 如果已有连接，先断开
			if (feishuBridge) {
				feishuBridge.stop();
			}

			const botConfig = addFeishuBot({
				name: input.name || "飞书机器人",
				appId: input.appId,
				appSecret: input.appSecret,
				defaultUserOpenId: input.defaultUserOpenId,
			});

			feishuBridge = new FeishuBridge(botConfig, agentManager, () => mainWindow, () => projectStore.list());
			await feishuBridge.start();
			return { success: true, message: "连接成功" };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { success: false, message };
		}
	});

	// 断开连接
	ipcMain.handle(ipcChannels.feishuDisconnect, async () => {
		if (feishuBridge) {
			feishuBridge.stop();
			feishuBridge = null;
		}
		return { success: true };
	});

	// 查询状态
	ipcMain.handle(ipcChannels.feishuStatusRequest, async () => {
		if (feishuBridge) {
			return feishuBridge.getStatus();
		}
		return { status: "disconnected", activeBindings: 0 } as FeishuBridgeStatus;
	});

	// Bot 列表
	ipcMain.handle(ipcChannels.feishuBotsList, async () => {
		return listBots();
	});

	// 添加 Bot
	ipcMain.handle(ipcChannels.feishuBotAdd, async (_event, input: FeishuConnectInput) => {
		// 同 feishuConnect，但可以添加多个 Bot
		try {
			const botConfig = addFeishuBot({
				name: input.name || "飞书机器人",
				appId: input.appId,
				appSecret: input.appSecret,
				defaultUserOpenId: input.defaultUserOpenId,
			});
			return { success: true, bot: botConfig };
		} catch (error) {
			return { success: false, error: error instanceof Error ? error.message : String(error) };
		}
	});

	// 删除 Bot
	ipcMain.handle(ipcChannels.feishuBotRemove, async (_event, botId: string) => {
		if (feishuBridge) {
			feishuBridge.stop();
			feishuBridge = null;
		}
		return removeFeishuBot(botId);
	});

	// 更新 Bot 配置
	ipcMain.handle(ipcChannels.feishuBotConfig, async (_event, botId: string, patch: Partial<FeishuBotConfig>) => {
		const updated = updateFeishuBot(botId, patch);
		// 热更新到运行中的 bridge，无需重连
		if (feishuBridge && feishuBridge.getStatus().status === "connected") {
			feishuBridge.updateBotConfig(patch);
			console.log("[飞书] 配置已热更新:", Object.keys(patch).join(", "));
		}
		return updated;
	});

	// 测试连接
	ipcMain.handle(ipcChannels.feishuTestConnection, async (_event, appId: string, appSecret: string) => {
		// 创建临时 bridge 实例来测试连接
		const testBridge = new FeishuBridge(
			{
				id: "test",
				name: "测试",
				enabled: true,
				appId,
				appSecret: "", // 将在 testConnection 中传入
			},
			agentManager,
			() => mainWindow,
			() => projectStore.list(),
		);
		return testBridge.testConnection(appId, appSecret);
	});

	// 绑定列表
	ipcMain.handle(ipcChannels.feishuBindingsList, async () => {
		if (feishuBridge) {
			return feishuBridge.listBindings();
		}
		return [];
	});

	// 移除绑定
	ipcMain.handle(ipcChannels.feishuBindingRemove, async (_event, chatId: string) => {
		if (feishuBridge) {
			return feishuBridge.removeBinding(chatId);
		}
		return false;
	});

	// 更新绑定
	ipcMain.handle(ipcChannels.feishuBindingUpdate, async (_event, chatId: string, patch: Partial<FeishuChatBinding>) => {
		if (feishuBridge) {
			return feishuBridge.updateBinding(chatId, patch);
		}
		return undefined;
	});

	// 通过已保存的 Bot ID 连接（自动解密 Secret）
	ipcMain.handle(ipcChannels.feishuConnectByBot, async (_event, botId: string) => {
		try {
			if (feishuBridge) {
				feishuBridge.stop();
			}
			const botConfig = getBot(botId);
			if (!botConfig) {
				return { success: false, message: "Bot 配置不存在" };
			}
			feishuBridge = new FeishuBridge(botConfig, agentManager, () => mainWindow, () => projectStore.list());
			await feishuBridge.start();
			return { success: true, message: "连接成功" };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { success: false, message };
		}
	});
}

function registerIpc() {
	ipcMain.handle(ipcChannels.projectsList, () => projectStore.list());
	ipcMain.handle(ipcChannels.projectsAdd, async () =>
		projectStore.chooseAndAdd(),
	);
	ipcMain.handle(ipcChannels.projectsRemove, async (_event, id: string) => {
		await projectStore.remove(id);
		return projectStore.list();
	});
	ipcMain.handle(
		ipcChannels.projectsReorder,
		(_event, projectIds: string[]) => projectStore.reorder(projectIds),
	);

	ipcMain.handle(ipcChannels.filesList, async (_event, projectId: string) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		return fileSystemService.listTree(project.path);
	});

	ipcMain.handle(ipcChannels.filesOpen, async (_event, path: string) => {
		await shell.openPath(path);
	});

	ipcMain.handle(
		ipcChannels.filesShowInFolder,
		async (_event, path: string) => {
			shell.showItemInFolder(path);
		},
	);

	ipcMain.handle(
		ipcChannels.sessionsList,
		async (_event, projectId?: string) => {
			const project = projectId ? projectStore.get(projectId) : undefined;
			return sessionScanner.list(project?.path);
		},
	);
	ipcMain.handle(
		ipcChannels.sessionsRename,
		async (_event, filePath: string, newName: string) => {
			await sessionScanner.rename(filePath, newName);
		},
	);
	ipcMain.handle(
		ipcChannels.sessionsCopy,
		(_event, projectId: string, filePath: string) =>
			agentManager.cloneSessionFile(projectId, filePath),
	);
	ipcMain.handle(
		ipcChannels.sessionsExportHtml,
		(_event, projectId: string, filePath: string) =>
			agentManager.exportSessionHtml(projectId, filePath),
	);
	ipcMain.handle(ipcChannels.sessionsDelete, (_event, filePath: string) =>
		sessionScanner.delete(filePath),
	);
	ipcMain.handle(
		ipcChannels.codexSessionsScan,
		async (_event, projectId: string) => {
			const project = projectStore.get(projectId);
			if (!project) throw new Error(`Project not found: ${projectId}`);
			return codexSessionImporter.scan(project.path);
		},
	);
	ipcMain.handle(
		ipcChannels.codexSessionsImport,
		async (_event, projectId: string, sourcePaths: string[]) => {
			const project = projectStore.get(projectId);
			if (!project) throw new Error(`Project not found: ${projectId}`);
			return codexSessionImporter.import(project.path, sourcePaths);
		},
	);
	ipcMain.handle(
		ipcChannels.claudeSessionsScan,
		async (_event, projectId: string) => {
			const project = projectStore.get(projectId);
			if (!project) throw new Error(`Project not found: ${projectId}`);
			return claudeSessionImporter.scan(project.path);
		},
	);
	ipcMain.handle(
		ipcChannels.claudeSessionsImport,
		async (_event, projectId: string, sourcePaths: string[]) => {
			const project = projectStore.get(projectId);
			if (!project) throw new Error(`Project not found: ${projectId}`);
			return claudeSessionImporter.import(project.path, sourcePaths);
		},
	);

	ipcMain.handle(ipcChannels.gitBranches, async (_event, projectId: string) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		return gitService.getBranches(project.path);
	});

	ipcMain.handle(
		ipcChannels.gitCheckout,
		async (_event, projectId: string, branch: string) => {
			const project = projectStore.get(projectId);
			if (!project) throw new Error(`Project not found: ${projectId}`);
			return gitService.checkout(project.path, branch);
		},
	);

	ipcMain.handle(
		ipcChannels.gitCreateBranch,
		async (_event, projectId: string, branchName: string) => {
			const project = projectStore.get(projectId);
			if (!project) throw new Error(`Project not found: ${projectId}`);
			return gitService.createBranch(project.path, branchName);
		},
	);

	ipcMain.handle(ipcChannels.piCheck, () => {
		// 用户手动指定的路径优先于自动检测
		const settings = settingsStore.get();
		return piLocator.check(settings.customPiPath);
	});
	ipcMain.handle(
		ipcChannels.piCheckCustom,
		async (_event, customPath: string) => {
			const status = await piLocator.validateCustomPath(customPath);
			// 校验通过后持久化归一化后的路径，后续启动 agent 时 PiProcess 会从 settings 读取。
			// 例如用户粘贴 "D:\\foo\\pi" 时，PiLocator 会返回可执行的 D:\foo\pi.cmd。
			if (status.installed && status.command) {
				await settingsStore.update({ customPiPath: status.command });
			}
			return status;
		},
	);
	ipcMain.handle(ipcChannels.appInfo, () => ({
		version: app.getVersion(),
		releasesUrl: RELEASES_URL,
	}));
	ipcMain.handle(ipcChannels.appCheckUpdate, () => checkForAppUpdate());
	ipcMain.handle(ipcChannels.appFeedbackEnvironment, async () => {
		// 反馈报告只包含诊断必需的运行时版本与 pi 检测结果，不读取配置密钥或会话内容。
		const pi = await piLocator.check();
		return {
			appVersion: app.getVersion(),
			platform: process.platform,
			arch: process.arch,
			electronVersion: process.versions.electron ?? "",
			chromeVersion: process.versions.chrome ?? "",
			nodeVersion: process.versions.node,
			pi,
		};
	});
	ipcMain.handle(ipcChannels.appOpenExternal, async (_event, url: string) => {
		// 外部链接统一经主进程打开，避免 renderer 直接依赖 shell 权限，也便于后续做白名单校验。
		await shell.openExternal(url);
	});
	ipcMain.handle(ipcChannels.appRestart, () => {
		isQuitting = true;
		app.relaunch();
		app.quit();
	});
	ipcMain.handle(ipcChannels.appWindowMinimize, () => {
		if (!mainWindow || mainWindow.isDestroyed()) return;
		mainWindow.minimize();
	});
	ipcMain.handle(ipcChannels.appWindowToggleMaximize, () => {
		if (!mainWindow || mainWindow.isDestroyed()) return;
		if (mainWindow.isMaximized()) mainWindow.unmaximize();
		else mainWindow.maximize();
	});
	ipcMain.handle(ipcChannels.appWindowToggleAlwaysOnTop, () => {
		if (!mainWindow || mainWindow.isDestroyed()) return false;
		const next = !mainWindow.isAlwaysOnTop();
		// floating 适合工具型桌面窗口；跨平台由 Electron 映射到各系统的置顶层级。
		mainWindow.setAlwaysOnTop(next, "floating");
		return next;
	});
	ipcMain.handle(ipcChannels.appWindowClose, () => {
		if (!mainWindow || mainWindow.isDestroyed()) return;
		mainWindow.close();
	});

	ipcMain.handle(ipcChannels.settingsGet, () => settingsStore.get());
	ipcMain.handle(
		ipcChannels.settingsUpdate,
		async (_event, patch: Partial<AppSettings>) => {
			const settings = await settingsStore.update(patch);
			if (
				"desktopProxyEnabled" in patch ||
				"desktopProxyUrl" in patch ||
				"desktopProxyBypass" in patch
			) {
				await applyDesktopProxy(settings);
			}
			if ("useNativeTitleBar" in patch) {
				settingsStore.notifyTitleBarChange(mainWindow);
			}
			if (
				"webServiceEnabled" in patch ||
				"webServiceHost" in patch ||
				"webServicePort" in patch
			) {
				try {
					await webServiceManager.applySettings(settings);
				} catch (error) {
					if (settings.webServiceEnabled) {
						await settingsStore.update({ webServiceEnabled: false });
					}
					throw error;
				}
			}
			return settings;
		},
	);
	ipcMain.handle(
		ipcChannels.settingsTestPiProxy,
		() => testPiProxy(settingsStore.get()),
	);

	ipcMain.handle(ipcChannels.skillsList, () => skillManager.list());
	ipcMain.handle(ipcChannels.skillsCreate, (_event, input: CreatePiSkillInput) =>
		skillManager.create(input),
	);
	ipcMain.handle(ipcChannels.skillsToggle, (_event, path: string, enabled: boolean) =>
		skillManager.toggle(path, enabled),
	);
	ipcMain.handle(ipcChannels.skillsDelete, (_event, path: string) =>
		skillManager.delete(path),
	);
	ipcMain.handle(ipcChannels.skillsOpenFolder, (_event, path?: string) =>
		skillManager.openFolder(path),
	);
	ipcMain.handle(ipcChannels.extensionsList, () => extensionManager.list());
	ipcMain.handle(ipcChannels.extensionsUninstall, (_event, source: string, scope?: "user" | "project" | "unknown") =>
		extensionManager.uninstall(source, scope),
	);

	ipcMain.handle(ipcChannels.agentsList, () => agentManager.list());
	ipcMain.handle(ipcChannels.agentsCreate, async (_event, input: CreateAgentInput) => {
		const tab = await agentManager.create(input);
		// Session Mirror: Pi 中创建会话时，飞书自动拉群（1会话=1群）
		if (feishuBridge && feishuBridge.getStatus().status === "connected") {
			void feishuBridge.ensureSessionMirror(tab.id, tab.title).catch((e) => {
				console.error("[飞书] 自动拉群失败:", e);
			});
		}
		return tab;
	});
	ipcMain.handle(
		ipcChannels.agentsRename,
		(_event, agentId: string, name: string) =>
			agentManager.rename(agentId, name),
	);
	ipcMain.handle(ipcChannels.agentsStop, async (_event, agentId: string) => {
		terminalManager.closeAgent(agentId);
		await agentManager.stop(agentId);
	});
	ipcMain.handle(ipcChannels.agentsPrompt, async (_event, input: SendPromptInput) => {
		// Session Mirror: Pi 中发消息时，为飞书群开启流式卡片 + 转发用户消息
		if (feishuBridge && feishuBridge.getStatus().status === "connected") {
			const tab = agentManager.list().find(t => t.id === input.agentId);
			if (tab) {
				// 1. 确保有飞书群绑定（如果还没有，自动拉群）
				void feishuBridge.ensureSessionMirror(tab.id, tab.title).catch((e) => {
					console.error("[飞书] ensureSessionMirror 失败:", e);
				});
				// 2. 开启流式卡片
				void feishuBridge.startSessionMirrorRun(tab.id, tab.title).catch((e) => {
					console.error("[飞书] SessionMirror 流式卡片初始化失败:", e);
				});
				// 3. 转发用户消息到飞书（双向同步）
				if (input.message.trim()) {
					void feishuBridge.forwardUserMessageToFeishu(tab.id, input.message).catch((e) => {
						console.error("[飞书] 转发 PiDeck 消息失败:", e);
					});
				}
			}
		}
		return agentManager.sendPrompt(input);
	});
	ipcMain.handle(ipcChannels.agentsAbort, async (_event, agentId: string) => {
		// Session Mirror: 停止飞书流式卡片
		if (feishuBridge) {
			feishuBridge.stopSessionMirrorRun(agentId);
		}
		return agentManager.abort(agentId);
	});
	ipcMain.handle(ipcChannels.agentsExportHtml, (_event, agentId: string) =>
		agentManager.exportHtml(agentId),
	);
	ipcMain.handle(ipcChannels.agentsForkMessages, (_event, agentId: string) =>
		agentManager.getForkMessages(agentId),
	);
	ipcMain.handle(
		ipcChannels.agentsForkSession,
		(_event, agentId: string, entryId: string) =>
			agentManager.forkSession(agentId, entryId),
	);
	ipcMain.handle(ipcChannels.agentsCloneSession, (_event, agentId: string) =>
		agentManager.cloneSession(agentId),
	);
	ipcMain.handle(
		ipcChannels.agentsSwitchSession,
		(_event, agentId: string, sessionPath: string) =>
			agentManager.switchSession(agentId, sessionPath),
	);
	ipcMain.handle(ipcChannels.agentsReload, (_event, agentId: string) =>
		agentManager.reload(agentId),
	);
	ipcMain.handle(ipcChannels.agentsRestart, async (_event, agentId: string) => {
		terminalManager.closeAgent(agentId);
		return agentManager.restart(agentId);
	});
	ipcMain.handle(ipcChannels.agentsCompact, (_event, agentId: string) =>
		agentManager.compact(agentId),
	);
	ipcMain.handle(ipcChannels.agentsRuntimeState, (_event, agentId: string) =>
		agentManager.getRuntimeState(agentId),
	);
	ipcMain.handle(ipcChannels.agentsCycleModel, (_event, agentId: string) =>
		agentManager.cycleModel(agentId),
	);
	ipcMain.handle(ipcChannels.agentsAvailableModels, (_event, agentId: string) =>
		agentManager.getAvailableModels(agentId),
	);
	ipcMain.handle(
		ipcChannels.agentsSetModel,
		(_event, agentId: string, provider: string, modelId: string) =>
			agentManager.setModel(agentId, provider, modelId),
	);
	ipcMain.handle(ipcChannels.agentsCycleThinking, (_event, agentId: string) =>
		agentManager.cycleThinking(agentId),
	);
	ipcMain.handle(
		ipcChannels.agentsSetThinking,
		(_event, agentId: string, level: string) =>
			agentManager.setThinking(agentId, level),
	);
	ipcMain.handle("agents:commands", async (_event, agentId: string) => {
		try {
			return await agentManager.getCommands(agentId);
		} catch {
			// agent 不存在或 RPC 超时时返回空列表，避免控制台报未处理异常
			return [];
		}
	});

	ipcMain.handle(ipcChannels.terminalList, (_event, agentId: string) =>
		terminalManager.list(agentId),
	);
	ipcMain.handle(ipcChannels.terminalEnsure, (_event, agentId: string) =>
		terminalManager.ensure(agentId),
	);
	ipcMain.handle(ipcChannels.terminalCreate, (_event, agentId: string) =>
		terminalManager.create(agentId),
	);
	ipcMain.handle(
		ipcChannels.terminalInput,
		(_event, tabId: string, data: string) => {
			terminalManager.input(tabId, data);
		},
	);
	ipcMain.handle(
		ipcChannels.terminalResize,
		(_event, tabId: string, cols: number, rows: number) => {
			terminalManager.resize(tabId, cols, rows);
		},
	);
	ipcMain.handle(ipcChannels.terminalClose, (_event, tabId: string) => {
		terminalManager.close(tabId);
	});

	// ── 配置管理 ──────────────────────────────────────
	ipcMain.handle(ipcChannels.configGetModels, () =>
		configManager.getModelsConfig(),
	);
	ipcMain.handle(ipcChannels.configGetAuth, () =>
		configManager.getAuthConfig(),
	);
	ipcMain.handle(ipcChannels.configGetSettings, () =>
		configManager.getSettingsConfig(),
	);
	ipcMain.handle(ipcChannels.configSaveModels, (_event, data) =>
		configManager.saveModelsConfig(data),
	);
	ipcMain.handle(ipcChannels.configSaveAuth, (_event, data) =>
		configManager.saveAuthConfig(data),
	);
	ipcMain.handle(ipcChannels.configSaveSettings, (_event, settings) =>
		configManager.saveSettingsConfig(settings),
	);
	ipcMain.handle(ipcChannels.configSaveRaw, (_event, fileName, rawJson) =>
		configManager.saveRawConfig(fileName, rawJson),
	);
	ipcMain.handle(ipcChannels.configExport, () =>
		configManager.exportConfig(),
	);
	ipcMain.handle(ipcChannels.configImport, (_event, packageJson: string) =>
		configManager.importConfig(packageJson),
	);
	// 远程拉取 provider 模型列表
	ipcMain.handle(
		ipcChannels.configFetchModels,
		(
			_event,
			payload: { baseUrl: string; apiKey: string; apiType?: string },
		) =>
			configManager.fetchProviderModels(
				payload.baseUrl,
				payload.apiKey,
				payload.apiType,
			),
	);
	// 快速测试 provider 连接
	ipcMain.handle(
		ipcChannels.configTestProvider,
		(
			_event,
			payload: {
				baseUrl: string;
				apiKey: string;
				modelId: string;
				apiType?: string;
				headers?: Record<string, string>;
			},
		) =>
			configManager.testProviderConnection(
				payload.baseUrl,
				payload.apiKey,
				payload.modelId,
				payload.apiType,
				payload.headers,
			),
	);

	// 切换开发者控制台
	ipcMain.handle(ipcChannels.appToggleDevTools, () => {
		if (!mainWindow || mainWindow.isDestroyed()) return false;
		if (mainWindow.webContents.isDevToolsOpened()) {
			mainWindow.webContents.closeDevTools();
			return false;
		}
		mainWindow.webContents.openDevTools({ mode: "detach" });
		return true;
	});
}

function sendTelemetryHeartbeat() {
	const telemetry = new TelemetryService({
		settingsStore,
		config: {
			projectKey: POSTHOG_PROJECT_KEY,
			host: POSTHOG_HOST,
		},
		metadata: {
			appVersion: app.getVersion(),
			platform: process.platform,
			arch: process.arch,
			packaged: app.isPackaged,
		},
		capture: async (request) => {
			const response = await net.fetch(request.url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(request.body),
			});
			if (!response.ok) {
				throw new Error(`Telemetry request failed: ${response.status}`);
			}
		},
	});

	void telemetry.sendHeartbeat().catch(() => undefined);
}

app.whenReady().then(async () => {
	projectStore = new ProjectStore();
	fileSystemService = new FileSystemService();
	sessionScanner = new SessionScanner();
	codexSessionImporter = new CodexSessionImporter();
	claudeSessionImporter = new ClaudeSessionImporter();
	settingsStore = new SettingsStore();
	gitService = new GitService();
	piLocator = new PiLocator();
	configManager = new ConfigManager();
	skillManager = new SkillManager();
	extensionManager = new ExtensionManager(piLocator, () => settingsStore.get());
	agentManager = new AgentManager(
		(id) => projectStore.get(id),
		() => mainWindow,
		settingsStore,
	);
	webServiceManager = new WebServiceManager({
		listProjects: () => projectStore.list(),
		listAgents: () => agentManager.list(),
		listSessions: (projectId) => {
			const project = projectStore.get(projectId);
			return sessionScanner.list(project?.path);
		},
		getMessages: (agentId) => agentManager.getMessages(agentId),
		createAgent: (input) => agentManager.create(input),
		sendPrompt: (input) => agentManager.sendPrompt(input),
		stopAgent: (agentId) => agentManager.stop(agentId),
		runtimeState: (agentId) => agentManager.getRuntimeState(agentId),
		cycleModel: (agentId) => agentManager.cycleModel(agentId),
		availableModels: (agentId) => agentManager.getAvailableModels(agentId),
		setModel: (agentId, provider, modelId) => agentManager.setModel(agentId, provider, modelId),
		cycleThinking: (agentId) => agentManager.cycleThinking(agentId),
		setThinking: (agentId, level) => agentManager.setThinking(agentId, level),
	});
	terminalManager = new TerminalSessionManager(
		(agentId) => agentManager.getCwd(agentId),
		(channel, payload) => mainWindow?.webContents.send(channel, payload),
	);

	await settingsStore.load();
	await applyDesktopProxy(settingsStore.get());
	await webServiceManager.applySettings(settingsStore.get()).catch((error) => {
		console.error("Failed to start web service:", error);
		void settingsStore.update({ webServiceEnabled: false });
	});
	registerIpc();
	registerFeishuIpc();

	// 🆕 自动连接：如果已有 Bot 配置，自动启动飞书连接
	autoConnectFeishu();

	sendTelemetryHeartbeat();
	createWindow();
	setupTray();

	// 项目列表可能位于杀软/同步盘较慢的 userData；窗口先显示，随后异步加载，避免 packaged app 打开时白屏等待。
	void projectStore
		.load()
		.then(() =>
			mainWindow?.webContents.send("projects:changed", projectStore.list()),
		)
		.catch(() => undefined);

	// macOS dock 点击或任务栏点击时恢复窗口
	app.on("activate", () => {
		if (mainWindow) {
			mainWindow.show();
			mainWindow.focus();
		} else {
			createWindow();
		}
	});
});

app.on("before-quit", () => {
	isQuitting = true;
	tray?.destroy();
	tray = null;
	void webServiceManager?.stop();
	terminalManager?.closeAll();
	agentManager?.stopAll();
});

app.on("window-all-closed", () => {
	// macOS 关闭所有窗口不退出；其他平台如果启用 closeToTray 也不退出
	if (process.platform === "darwin") return;
	if (!isQuitting) return;
	app.quit();
});
