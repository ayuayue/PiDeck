import { app, BrowserWindow, ipcMain, Menu, nativeImage, shell, Tray } from "electron";
import { join } from "node:path";
import { is } from "@electron-toolkit/utils";
import { ipcChannels } from "../shared/ipc";
import type { CreateAgentInput, SendPromptInput } from "../shared/types";
import { ProjectStore } from "./projects/ProjectStore";
import { FileSystemService } from "./fs/FileSystemService";
import { AgentManager } from "./pi/AgentManager";
import { PiLocator } from "./pi/PiLocator";
import { SessionScanner } from "./sessions/SessionScanner";
import { SettingsStore } from "./settings/SettingsStore";
import { GitService } from "./git/GitService";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
/** 标记是否由用户主动退出（托盘菜单「退出」），区别于窗口关闭隐藏到托盘 */
let isQuitting = false;
let projectStore: ProjectStore;
let fileSystemService: FileSystemService;
let sessionScanner: SessionScanner;
let settingsStore: SettingsStore;
let gitService: GitService;
let piLocator: PiLocator;
let agentManager: AgentManager;

function setupTray() {
	// 跨平台托盘图标：优先用打包后的 icon.png，Electron 会按平台自动适配尺寸
	const iconPath = join(__dirname, "../../build/icon.png");
	const icon = nativeImage.createFromPath(iconPath);
	tray = new Tray(icon.resize({ width: 16, height: 16 }));
	tray.setToolTip("pi desktop");

	// 双击托盘图标恢复窗口（Windows 常见交互）
	tray.on("double-click", () => {
		if (mainWindow) {
			mainWindow.show();
			mainWindow.focus();
		}
	});

	const contextMenu = Menu.buildFromTemplate([
		{
			label: "显示窗口",
			click: () => {
				mainWindow?.show();
				mainWindow?.focus();
			},
		},
		{ type: "separator" },
		{
			label: "退出 pi desktop",
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
	// Linux 窗口管理器不会总是读取打包元数据里的图标；运行时显式传入
	// PNG 可以保证任务栏、窗口标题和未安装直接运行 AppImage 时都显示应用图标。
	const iconPath = join(__dirname, "../../build/icon.png");

	mainWindow = new BrowserWindow({
		show: false,
		backgroundColor: "#eef0f3",
		width: 1320,
		height: 860,
		minWidth: 980,
		minHeight: 660,
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

	mainWindow.once("ready-to-show", () => mainWindow?.show());

	// 关闭窗口时根据设置决定：隐藏到托盘还是正常退出
	mainWindow.on("close", (event) => {
		if (!isQuitting && settingsStore.get().closeToTray) {
			event.preventDefault();
			mainWindow?.hide();
		}
	});

	if (is.dev && process.env.ELECTRON_RENDERER_URL) {
		mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
	} else {
		mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
	}
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

	ipcMain.handle(ipcChannels.piCheck, () => piLocator.check());
	ipcMain.handle(ipcChannels.appInfo, () => ({
		version: app.getVersion(),
		releasesUrl: "https://github.com/ayuayue/pi-desktop/releases",
	}));
	ipcMain.handle(ipcChannels.appOpenExternal, async (_event, url: string) => {
		// 外部链接统一经主进程打开，避免 renderer 直接依赖 shell 权限，也便于后续做白名单校验。
		await shell.openExternal(url);
	});

	ipcMain.handle(ipcChannels.settingsGet, () => settingsStore.get());
	ipcMain.handle(ipcChannels.settingsUpdate, async (_event, patch) => {
		const settings = await settingsStore.update(patch);
		settingsStore.notifyTitleBarChange(mainWindow);
		return settings;
	});

	ipcMain.handle(ipcChannels.agentsList, () => agentManager.list());
	ipcMain.handle(ipcChannels.agentsCreate, (_event, input: CreateAgentInput) =>
		agentManager.create(input),
	);
	ipcMain.handle(ipcChannels.agentsStop, (_event, agentId: string) =>
		agentManager.stop(agentId),
	);
	ipcMain.handle(ipcChannels.agentsPrompt, (_event, input: SendPromptInput) =>
		agentManager.sendPrompt(input),
	);
	ipcMain.handle(ipcChannels.agentsAbort, (_event, agentId: string) =>
		agentManager.abort(agentId),
	);
	ipcMain.handle(ipcChannels.agentsExportHtml, (_event, agentId: string) =>
		agentManager.exportHtml(agentId),
	);
	ipcMain.handle(ipcChannels.agentsReload, (_event, agentId: string) =>
		agentManager.reload(agentId),
	);
	ipcMain.handle(ipcChannels.agentsRestart, (_event, agentId: string) =>
		agentManager.restart(agentId),
	);
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
	ipcMain.handle("agents:commands", (_event, agentId: string) =>
		agentManager.getCommands(agentId),
	);
}

app.whenReady().then(async () => {
	projectStore = new ProjectStore();
	fileSystemService = new FileSystemService();
	sessionScanner = new SessionScanner();
	settingsStore = new SettingsStore();
	gitService = new GitService();
	piLocator = new PiLocator();
	agentManager = new AgentManager(
		(id) => projectStore.get(id),
		() => mainWindow,
	);

	await settingsStore.load();
	registerIpc();
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
	agentManager?.stopAll();
});

app.on("window-all-closed", () => {
	// macOS 关闭所有窗口不退出；其他平台如果启用 closeToTray 也不退出
	if (process.platform === "darwin") return;
	if (!isQuitting) return;
	app.quit();
});
