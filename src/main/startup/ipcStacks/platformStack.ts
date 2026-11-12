import { net, session, webContents } from "electron";
import type { BrowserWindow } from "electron";
import type { stat } from "node:fs/promises";
import type { SettingsStore } from "../../settings/SettingsStore";
import { refreshShortcutBindings } from "../../appShortcuts";
import type { SessionCommandError } from "../../../shared/types";
import { applyWindowLogoStyle } from "../../appWindowLogo";
import { syncTaskbarShortcutIcon } from "../../appTaskbarIdentity";
import { ipcChannels } from "../../../shared/ipc";
import type { MainProcessTranslationKey } from "../../../shared/i18n/mainProcessCopy";
import type { ProjectStore } from "../../projects/ProjectStore";
import type { FileSystemService } from "../../fs/FileSystemService";
import type { PiModelCapabilityCache } from "../../pi/PiModelCapabilityCache";
import type { SessionCatalog } from "../../sessions/SessionCatalog";
import type { SessionRuntimeCoordinator } from "../../sessions/SessionRuntimeCoordinator";
import type { SessionCommandIpcError } from "../../sessions/SessionCommandIpcError";
import type { GitService } from "../../git/GitService";
import type { ConfigManager } from "../../config/ConfigManager";
import type { ConfigBackupManager } from "../../config/ConfigBackupManager";
import type { PiResourceManagerPool } from "../../config/PiResourceManagerPool";
import { createRemoteTerminalManager } from "../../terminal/createRemoteTerminalManager";
import type { RemoteProjectTextPort } from "../../ipc/remoteProjectFileIpc";
import type { RemoteTerminalSessionManager } from "../../terminal/RemoteTerminalSessionManager";
import type { TerminalSessionManager } from "../../terminal/TerminalSessionManager";
import type { PromptManager } from "../../prompts/PromptManager";
import type { XuePromptManager } from "../../prompts/XuePromptManager";
import type { SkillManager } from "../../skills/SkillManager";
import { buildSkillInstallProxyEnv } from "../../skills/skillHubInstallProxy";
import type { ExtensionManager } from "../../extensions/ExtensionManager";
import type { ProjectResourceManager } from "../../projects/ProjectResourceManager";
import { toWslLinuxPath } from "../../wsl/WslPaths";
import { createWslHelperSessionPool } from "../../wsl/WslHelperSession";
import type { RemoteHostConnectionService } from "../../remote/RemoteHostConnectionService";
import { registerStoreIpc } from "../../ipc/storeIpc";
import { registerTerminalIpc } from "../../ipc/terminalIpc";
import { registerCloudSyncIpc } from "../../ipc/cloudSyncIpc";
import type { CloudSyncManager } from "../../cloudSync/CloudSyncManager";
import { registerWebRemoteAccessIpc } from "../../ipc/webRemoteAccessIpc";
import type { RemoteAccessManager } from "../../web/remoteAccess/RemoteAccessManager";
import { registerBackupIpc } from "../../ipc/backupIpc";
import { registerFilesIpc } from "../../ipc/filesIpc";
import type { FileIndexService } from "../../files/FileIndexService";
import { registerClipboardIpc } from "../../ipc/clipboardIpc";
import { registerShellMenuIpc } from "../../ipc/shellMenuIpc";
import type { AppLogger } from "../../logging/AppLogger";
import type { QuitCleanupRegistry } from "../../lifecycle/QuitCleanupRegistry";
import type { RemoteEntryStat } from "../../../shared/types/remoteFiles";
import type { RemoteEntryKind } from "../../../shared/types/remoteFiles";
import type { RemoteTrashEntry } from "../../../shared/types/remoteFiles";
import type { RemoteProjectIpcHandle } from "../../ipc/remoteProjectIpc";

/**
 * platform 域 IPC 装配（自 index.ts 的 registerIpc 逐段外移，行为零变化）。
 *
 * ctx 只承载该段真正用到的实例与闭包：模块级单例按值传入（均在 registerIpc 之前完成单次赋值，
 * 读的是同一实例）；少数会在启动后续被替换的绑定（mainWindow / petSystem / tray）走 getter，
 * 保证闭包里读到的是当前值。调用顺序与搬迁前完全一致。
 */
export interface PlatformStackContext {
	readonly appLogger: AppLogger;
	readonly broadcastCloudSyncStateChanged: () => void;
	readonly cloudSyncManager: CloudSyncManager;
	readonly configBackupManager: ConfigBackupManager | undefined;
	readonly configManager: ConfigManager;
	readonly extensionManager: ExtensionManager;
	readonly fileIndexService: FileIndexService | null;
	readonly fileSystemService: FileSystemService;
	readonly gitService: GitService;
	readonly mainCopy: (key: MainProcessTranslationKey, params?: Record<string, string | number>) => string;
	readonly getMainWindow: () => BrowserWindow | null;
	readonly openExternalUrl: (url: string, forceSystem?: boolean) => Promise<void>;
	readonly piModelCapabilityCache: PiModelCapabilityCache | undefined;
	readonly piResourcePool: PiResourceManagerPool | undefined;
	readonly projectResourceManager: ProjectResourceManager;
	readonly projectStore: ProjectStore;
	readonly promptManager: PromptManager;
	readonly quitCleanup: QuitCleanupRegistry;
	readonly remoteAccessManager: RemoteAccessManager;
	readonly getRemoteTerminalManager: () => RemoteTerminalSessionManager | undefined;
	readonly setRemoteTerminalManager: (value: RemoteTerminalSessionManager | undefined) => void;
	readonly sessionCatalog: SessionCatalog;
	readonly sessionCommandIpcError: (error: SessionCommandError) => SessionCommandIpcError;
	readonly sessionRuntimeCoordinator: SessionRuntimeCoordinator;
	readonly settingsStore: SettingsStore;
	readonly skillManager: SkillManager;
	readonly terminalManager: TerminalSessionManager;
	readonly xuePromptManager: XuePromptManager;
	readonly remoteHostServiceIfEnabled: () => Promise<import("../../remote/RemoteHostConnectionService").RemoteHostConnectionService> | undefined;
	readonly remoteProjectEntries: {
		create(sender: Electron.CrossProcessExports.IpcMainInvokeEvent["sender"], projectId: string, parent: string, name: string, type: "file" | "directory"): Promise<{ relativePath: string; kind: "file" | "directory" | "other" }>;
		rename(sender: Electron.CrossProcessExports.IpcMainInvokeEvent["sender"], projectId: string, source: string, targetPath: string): Promise<{ relativePath: string }>;
		moveTo(sender: Electron.CrossProcessExports.IpcMainInvokeEvent["sender"], projectId: string, source: string, targetPath: string): Promise<{ relativePath: string }>;
		move(sender: Electron.CrossProcessExports.IpcMainInvokeEvent["sender"], projectId: string, source: string, targetDir: string): Promise<{ relativePath: string }>;
		delete(sender: Electron.CrossProcessExports.IpcMainInvokeEvent["sender"], projectId: string, relativePath: string): Promise<{ trashId: string }>;
		dispose(): void;
		service: {
			stat(sender: number, projectId: string, relative: string): Promise<{ stat: RemoteEntryStat; version: string }>;
			createFile(sender: number, projectId: string, parentRelativePath: string, name: string): Promise<{ relativePath: string; kind: RemoteEntryKind }>;
			createDirectory(sender: number, projectId: string, parentRelativePath: string, name: string): Promise<{ relativePath: string; kind: RemoteEntryKind }>;
			rename(sender: number, projectId: string, sourceRelativePath: string, targetRelativePath: string, token: string): Promise<{ relativePath: string }>;
			deleteEntry(sender: number, projectId: string, relative: string, token: string): Promise<{ trashId: string }>;
			listTrash(sender: number, projectId: string): Promise<{ entries: RemoteTrashEntry[]; truncated: boolean }>;
			restoreTrash(sender: number, projectId: string, trashId: string): Promise<{ relativePath: string }>;
			pruneTrash(sender: number, projectId: string, trashIds: string[]): Promise<{ removed: string[]; kept: Array<{ id: string; code: string }> }>;
			releaseSender(sender: number): void;
			tokenCount(): number;
		};
	};
	readonly remoteProjectIpc: RemoteProjectIpcHandle;
	readonly remoteProjectTextPort: RemoteProjectTextPort;
}

export function registerPlatformStack(ctx: PlatformStackContext): void {
	const {
		appLogger,
		broadcastCloudSyncStateChanged,
		cloudSyncManager,
		configBackupManager,
		configManager,
		extensionManager,
		fileIndexService,
		fileSystemService,
		gitService,
		mainCopy,
		openExternalUrl,
		piModelCapabilityCache,
		piResourcePool,
		projectResourceManager,
		projectStore,
		promptManager,
		quitCleanup,
		remoteAccessManager,
		sessionCatalog,
		sessionCommandIpcError,
		sessionRuntimeCoordinator,
		settingsStore,
		skillManager,
		terminalManager,
		xuePromptManager,
		remoteHostServiceIfEnabled,
		remoteProjectEntries,
		remoteProjectIpc,
		remoteProjectTextPort,
	} = ctx;

	registerStoreIpc({
		promptManager,
		skillManager,
		xuePromptManager,
		extensionManager,
		piResourcePool,
		projectResourceManager,
		configManager,
		projectTrustPath: (projectRoot, projectId) => {
			const project = projectStore.get(projectId);
			const settings = settingsStore.get();
			const trustWslDistro = project?.environment === "wsl" ? (project?.wslDistro ?? settings.wslDistro) : undefined;
			if (process.platform === "win32" && trustWslDistro !== undefined) {
				try {
					return toWslLinuxPath(projectRoot, { distro: trustWslDistro });
				} catch {
					return projectRoot;
				}
			}
			return projectRoot;
		},
		// 商店搜索必须走 Electron net（跟随桌面代理/系统代理）；裸 fetch 在需要代理的网络上会挂到超时。
		netFetch: (url, init) => net.fetch(url, init),
		resolveInstallProxyEnv: async () => {
			const settings = settingsStore.get();
			const desktop = { enabled: settings.desktopProxyEnabled, url: settings.desktopProxyUrl, bypass: settings.desktopProxyBypass };
			// 与 DesktopProxy 同一套语义：开关关闭/地址非法 = 交还系统，因此这里解析系统代理补上。
			// 解决 git clone（安装链路的关键步骤）不认 Chromium 代理的问题。
			let systemRules: string | null = null;
			if (!desktop.enabled || !desktop.url.trim()) {
				try {
					systemRules = await session.defaultSession.resolveProxy("https://github.com");
				} catch (error) {
					// 解析失败不阻断安装：无 PAC/直连环境本就没有代理可注入，返回 undefined 即可
					void appLogger.warn("skill-hub", "Resolve system proxy failed", { error: error instanceof Error ? error.message : String(error) });
				}
			}
			return buildSkillInstallProxyEnv(desktop, systemRules);
		},
		sendSkillHubInstallProgress: (progress) => {
			// 取一次当前主窗口（ctx 侧是 getter，读的是活绑定），保持与原实现的判空窄化一致。
			const mainWindow = ctx.getMainWindow();
			if (!mainWindow || mainWindow.isDestroyed()) return;
			mainWindow.webContents.send(ipcChannels.skillHubInstallProgress, progress);
		},
		appLogger,
		mainCopy: mainCopy as (key: string, params?: Record<string, string | number>) => string,
	});

	// 外网访问（web:remote-access-*）：cloudflare 隧道 / tailscale serve 启停 + EasyTier 只读状态
	registerWebRemoteAccessIpc({ remoteAccessManager });

	// 配置备份（config-backup:*）：恢复成功后重载 pideck 设置 + 刷新 pi 模型目录。
	registerBackupIpc({
		configBackupManager: configBackupManager!,
		appLogger,
		// 备份/pre-restore 前落盘在途的设置写盘合并窗口（见 backupIpc 注释）
		flushSettings: () => settingsStore.flushPendingSave(),
		afterRestore: async () => {
			// 恢复写回的是磁盘文件：pideck 设置需重新 load 进内存（其它 store 仍持旧值，
			// UI 会提示重启生效）；pi 模型目录缓存刷新，避免恢复后仍用旧模型列表。
			await settingsStore.load();
			// 快捷键覆盖可能随备份一起被恢复：同步刷新主进程生效绑定，无需重启
			refreshShortcutBindings(settingsStore.get());
			// Logo 风格也可能随备份恢复：同步刷新窗口/Dock 图标
			applyWindowLogoStyle(settingsStore.get().logoStyle, () => ctx.getMainWindow(), settingsStore.get().logoCustomImage);
			// 任务栏按钮读的是开始菜单快捷方式的图标，恢复后同样要按磁盘设置重写一次
			syncTaskbarShortcutIcon({ style: settingsStore.get().logoStyle, customLogoDataUrl: settingsStore.get().logoCustomImage });
			void piModelCapabilityCache?.refresh().catch(() => undefined);
		},
	});

	ctx.setRemoteTerminalManager(
		createRemoteTerminalManager({
			project: (id) => projectStore.get(id),
			service: remoteHostServiceIfEnabled,
			emit: (senderId, channel, payload) => {
				const sender = webContents.fromId(senderId);
				if (sender && !sender.isDestroyed()) sender.send(channel, payload);
			},
		}),
	);
	quitCleanup.register("remote-terminal", () => ctx.getRemoteTerminalManager()?.closeAll());
	registerTerminalIpc({
		appLogger,
		projectStore,
		sessionRuntimeCoordinator,
		terminalManager,
		remoteTerminalManager: ctx.getRemoteTerminalManager(),
		projectIdForSession: (sessionId) => sessionCatalog.get(sessionId)?.projectId,
		toSessionCommandIpcError: sessionCommandIpcError,
	});

	// ── 配置管理 ──────────────────────────────────────

	// WSL 项目的文件读面在发行版内以档案用户身份执行（Wave 1a）：会话按项目身份懒建立、
	// 跨调用复用，退出时与其它常驻资源一起回收。
	const wslHelperPool = createWslHelperSessionPool();
	quitCleanup.register("wsl-helper-session", () => wslHelperPool.closeAll());
	registerFilesIpc({
		fileSystemService,
		projectStore,
		settingsStore,
		// 文件索引 sidecar 在下方 sidecar 装配区创建，这里用 getter 取（注册时序不受影响）
		getFileIndexService: () => fileIndexService,
		appLogger,
		openExternalUrl,
		wslHelperPool,
		// 本机目录页的 Git ignore 修饰（T6 收尾）：与远端 probeIgnore 同一份契约（只加修饰、失败即不填）。
		checkIgnore: (cwd, relativePaths) => gitService.checkIgnore(cwd, relativePaths),
		// 位置分派收口第二片：files:create / files:rename 的 ssh 分支复用 entry 写面（令牌留在 main）。
		remoteEntries: {
			create: (sender, projectId, parent, name, type) => remoteProjectEntries.create(sender, projectId, parent, name, type),
			rename: (sender, projectId, source, targetPath) => remoteProjectEntries.rename(sender, projectId, source, targetPath),
			move: (sender, projectId, source, targetDir) => remoteProjectEntries.move(sender, projectId, source, targetDir),
			moveTo: (sender, projectId, source, targetPath) => remoteProjectEntries.moveTo(sender, projectId, source, targetPath),
			delete: (sender, projectId, relativePath) => remoteProjectEntries.delete(sender, projectId, relativePath),
		},
		// 公共文件读（T6）：ssh 项目的目录页与批量 stat 走只读 fs 面，不经过 entry 令牌。
		remoteFiles: {
			// 中央编辑器读写远端文件：与抽屉编辑器共用同一份远端文本服务与令牌表。
			...remoteProjectTextPort,
			directoryPage: (projectId, path, force) => remoteProjectIpc.directoryPage(projectId, path, force),
			// 位置分派收口第一片：`files:search-page` 的 ssh 分支走项目域同一份搜索实现。
			searchProject: (projectId, path, query) => remoteProjectIpc.searchProject(projectId, path, query),
			pathsExist: (projectId, paths) => remoteProjectIpc.pathsExist(projectId, paths),
			// 远端内容搜索按 hello capabilities 门控：旧 helper 返回 null（渲染层回退“仅文件名”），不发无效请求。
			searchContent: (projectId, query) => remoteProjectIpc.searchContent(projectId, query),
		},
	});
	registerClipboardIpc({ appLogger });
	// 云同步：主进程业务在 CloudSyncManager，handler 薄层只校验入参/适配返回值
	registerCloudSyncIpc({
		manager: cloudSyncManager,
		notifyStateChanged: () => broadcastCloudSyncStateChanged(),
		listProjects: () => projectStore.list(),
	});
	// 资源管理器右键菜单（HKCU）：菜单显示名跟随主进程 locale（可能随设置语言切换）
	registerShellMenuIpc({
		appLogger,
		menuTitle: mainCopy("shellMenu.openWithPiDeck"),
		quickTaskTitle: mainCopy("shellMenu.quickTask"),
	});
}
