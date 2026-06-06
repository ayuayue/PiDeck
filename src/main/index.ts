import {
	app,
	BrowserWindow,
	ipcMain,
	Menu,
	nativeImage,
	shell,
	Tray,
} from "electron";
import { join } from "node:path";
import { is } from "@electron-toolkit/utils";
// 使用 ?asset 后缀导入图标，electron-vite 会在构建时将其复制到输出目录并提供正确的运行时路径
// 这解决了打包后 build/ 目录不在 asar 中导致托盘图标丢失的问题
import iconPath from "../../build/icon.png?asset";
import { ipcChannels } from "../shared/ipc";
import type { CreateAgentInput, SendPromptInput } from "../shared/types";
import { ProjectStore } from "./projects/ProjectStore";
import { FileSystemService } from "./fs/FileSystemService";
import { AgentManager } from "./pi/AgentManager";
import { PiLocator } from "./pi/PiLocator";
import { SessionScanner } from "./sessions/SessionScanner";
import { SettingsStore } from "./settings/SettingsStore";
import { GitService } from "./git/GitService";
import { ConfigManager } from "./config/ConfigManager";

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
let configManager: ConfigManager;

function setupTray() {
	// iconPath 由 electron-vite 的 ?asset 后缀自动解析，打包后也能正确定位
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

/**
 * 清洗 Codex exec 输出，去掉系统前导、工具调用日志等噪音，只保留实际回复内容。
 * Codex 输出结构大致为：
 *   1. 系统信息行（model/provider/approval/sandbox/reasoning/session id）
 *   2. workdir / 版本行
 *   3. "user" + 用户问题回显
 *   4. "codex" + 工具调用链（exec/read/write...）
 *   5. 最终文本回复
 *   6. "tokens used" + token 数 + 回复重复
 */
function cleanCodexOutput(raw: string): string {
	const lines = raw.split("\n");
	const result: string[] = [];
	let inToolOutput = false;
	let sawCodexHeader = false;

	for (const line of lines) {
		// 跳过系统前导行
		if (
			/^(model|provider|approval|sandbox|reasoning effort|reasoning summaries|session id):/.test(line) ||
			/^OpenAI Codex v/.test(line) ||
			/^workdir:/.test(line) ||
			/^Reading additional input/.test(line) ||
			/^[0-9]{4}-[0-9]{2}-[0-9]{2}T.*ERROR/.test(line) ||
			line === "--------"
		) {
			continue;
		}

		// 标记进入/退出工具调用区域
		if (line === "user" || line === "codex") {
			sawCodexHeader = true;
			inToolOutput = line === "codex";
			continue;
		}

		// 工具调用内容（exec/shell 命令及其输出）
		if (inToolOutput) {
			// 工具调用完成标记：空行后跟新内容，或者 tokensused 行
			if (/^(exec|read|write|bash|shell|grep|ls|cat|git) /.test(line.trim()) ||
				/^"[^"]+" (started|succeeded|failed)/.test(line.trim()) ||
				/^(stdout|stderr|exit code)/.test(line.trim()) ||
				line.trim() === "" ||
				line.startsWith("<SUBAGENT") ||
				line.startsWith("</SUBAGENT") ||
				line.startsWith("<EXTREMELY") ||
				line.startsWith("</EXTREMELY") ||
				line.startsWith("## ") ||
				line.startsWith("# ") && sawCodexHeader ||
				line.startsWith("Instructions ") ||
				line.startsWith("| ") ||
				line.startsWith("```")
			) {
				continue;
			}
			// 如果不是已知工具输出格式，说明工具调用结束了
			inToolOutput = false;
		}

		// 跳过 token 统计行
		if (line.trim() === "tokens used" || /^[\d,]+$/.test(line.trim())) {
			continue;
		}

		// 去重：跳过与已有内容完全相同的行（Codex 有时会重复回答）
		const lastLine = result.length > 0 ? result[result.length - 1] : "";
		if (line.trim() && line.trim() === lastLine.trim()) {
			continue;
		}

		result.push(line);
	}

	return result.join("\n").trim();
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
	ipcMain.handle("agents:commands", async (_event, agentId: string) => {
		try {
			return await agentManager.getCommands(agentId);
		} catch {
			// agent 不存在或 RPC 超时时返回空列表，避免控制台报未处理异常
			return [];
		}
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

	// /codex 命令：调用 Codex CLI 执行问答
	ipcMain.handle(
		ipcChannels.agentsCodexExec,
		async (
			_event,
			payload: { cwd: string; prompt: string },
		): Promise<{ text: string; error?: string }> => {
			const { spawn } = await import("node:child_process");
			return new Promise((resolve) => {
				const args = ["exec", "--ephemeral", "--skip-git-repo-check"];
				// 用 --cd 告诉 Codex 工作目录
				if (payload.cwd) {
					args.push("--cd", payload.cwd);
				}
				args.push(payload.prompt);

				// Windows 上 codex 可能是 mise shim（.cmd），需要 shell:true
				const child = spawn(
					"codex",
					args,
					{
						cwd: payload.cwd,
						timeout: 120_000,
						env: { ...process.env },
						shell: process.platform === "win32",
					},
				);

				let stdout = "";
				let stderr = "";

				child.stdout?.on("data", (chunk: Buffer) => {
					stdout += chunk.toString();
				});

				child.stderr?.on("data", (chunk: Buffer) => {
					stderr += chunk.toString();
				});

				child.on("close", (code) => {
					if (code !== 0 && !stdout.trim()) {
						resolve({
							text: "",
							error: stderr.trim() || `codex 退出码 ${code}`,
						});
						return;
					}

					// 清洗 Codex 输出：去掉系统前导、工具调用日志等噪音
					const cleaned = cleanCodexOutput(stdout);
					resolve({ text: cleaned });
				});

				child.on("error", (err) => {
					resolve({
						text: "",
						error: err.message,
					});
				});
			});
		},
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

app.whenReady().then(async () => {
	projectStore = new ProjectStore();
	fileSystemService = new FileSystemService();
	sessionScanner = new SessionScanner();
	settingsStore = new SettingsStore();
	gitService = new GitService();
	piLocator = new PiLocator();
	configManager = new ConfigManager();
	agentManager = new AgentManager(
		(id) => projectStore.get(id),
		() => mainWindow,
		settingsStore,
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
