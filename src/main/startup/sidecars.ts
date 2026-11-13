import { existsSync } from "node:fs";
import { join } from "node:path";
import { app, type BrowserWindow } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { QuitCleanupRegistry } from "../lifecycle/QuitCleanupRegistry";
import type { AppLogger } from "../logging/AppLogger";
import { FileIndexService } from "../files/FileIndexService";
import type { PromptStoreUpdater } from "../prompts/promptStoreUpdater";
import { XueIndexService } from "../prompts/XueIndexService";
import { XuePromptDbStore } from "../prompts/XuePromptDbStore";
import { XuePromptManager } from "../prompts/XuePromptManager";
import { SessionIndexService } from "../sessions/SessionIndexService";
import type { SessionScanner } from "../sessions/SessionScanner";
import { SessionStoreService } from "../sessions/SessionStoreService";
import type { SettingsStore } from "../settings/SettingsStore";

/**
 * 本块真正用到的装配输入。sidecar 实例本身是 index.ts 的模块级 `let`（多处 IPC 读它们），
 * 所以这里不持有第二份：构造与退出清理置空都经 `assign` 回填 owner。
 */
export interface SidecarsContext {
	readonly appLogger: AppLogger;
	readonly getMainWindow: () => BrowserWindow | null;
	/** 提示词商店覆盖层解析器（startResourceStores 的产物，查询侧与本块共用同一实例）。 */
	readonly promptStoreUpdater: PromptStoreUpdater;
	/** 后台预热要扫的项目目录（index.ts 的注册项目路径派生）。 */
	readonly projectPathsForContentSearch: () => string[];
	readonly quitCleanup: QuitCleanupRegistry;
	readonly sessionScanner: SessionScanner;
	readonly settingsStore: SettingsStore;
	readonly assign: (patch: SidecarServicePatch) => void;
}

/** sidecar 写点：装配时给初值，退出清理置 null（index.ts 侧同名变量的类型本就含 null）。 */
export interface SidecarServicePatch {
	readonly xuePromptDbStore?: XuePromptDbStore | null;
	readonly xueIndexService?: XueIndexService | null;
	readonly xuePromptManager?: XuePromptManager;
	readonly sessionIndexService?: SessionIndexService | null;
	readonly fileIndexService?: FileIndexService | null;
	readonly sessionStoreService?: SessionStoreService | null;
}

/**
 * 启动装配（自 index.ts 的 `app.whenReady()` 装配体就地外移，语句顺序与搬迁前一致）：
 * 提示词库双通道（db 远程拉取 + Go xue-index 检索）与三个 Go 数据面 sidecar
 * （session-index 正文搜索 / file-index 文件检索 / session-store 会话数据面）。
 * 每个 sidecar 都是「缺失即降级、失败即回退」的 fail-open 装配，退出清理在同处登记。
 */
export function startSidecars(ctx: SidecarsContext): void {
	const { appLogger, projectPathsForContentSearch, quitCleanup, settingsStore, sessionScanner } = ctx;

	// 提示词库双通道装配：db 远程拉取（安装包不内置 db，首次使用从 Release 资产下载缓存）
	// + Go sidecar 检索（常驻内存，中文搜索可用；缺失/失败自动降级 sql.js，商店始终可用）。
	const xuePromptDbStore = new XuePromptDbStore({
		userDataDir: app.getPath("userData"),
		repoResourceDir: () => (app.isPackaged ? null : join(app.getAppPath(), "resources")),
		log: (domain, message, details) => void appLogger.info(domain, message, details),
		onStateChange: (state) => {
			// 推送前判 isDestroyed（窗口销毁后 send 会抛）；下载完成/失败时渲染层据此刷新空态
			const win = ctx.getMainWindow();
			if (win && !win.isDestroyed()) win.webContents.send(ipcChannels.yaoPromptsDbState, state);
		},
	});
	ctx.assign({ xuePromptDbStore });
	const xueIndexService = new XueIndexService({
		resolveBinaryPath: () => {
			// 打包后：resourcesPath/xue-index/xue-index(.exe)（extraResources）；
			// dev：仓库构建产物 resources/xue-index/bin/（scripts/dev.js 自动 fail-open 构建）
			const dir = app.isPackaged ? join(process.resourcesPath, "xue-index") : join(app.getAppPath(), "resources", "xue-index", "bin");
			const name = process.platform === "win32" ? "xue-index.exe" : "xue-index";
			const path = join(dir, name);
			return existsSync(path) ? path : null;
		},
		logger: {
			debug: (m) => appLogger.debug("xue-index", m),
			info: (m) => void appLogger.info("xue-index", m),
			warn: (m) => void appLogger.warn("xue-index", m),
			error: (m) => void appLogger.error("xue-index", m),
		},
	});
	ctx.assign({ xueIndexService });
	const xuePromptManager = new XuePromptManager(
		undefined,
		// 官方模板覆盖层叠加：热更新后商店列表/详情立即显示覆盖层版本
		() => ctx.promptStoreUpdater.resolveEffectiveOverlayDir(),
		{ dbStore: xuePromptDbStore, xueIndex: xueIndexService },
	);
	ctx.assign({ xuePromptManager });
	// 退出清理：结算在途请求并停掉 sidecar，避免退出阶段仍拉起进程
	quitCleanup.register("xue-index", () => {
		xueIndexService.dispose();
		xuePromptDbStore.dispose();
		ctx.assign({ xueIndexService: null, xuePromptDbStore: null });
	});
	// 跨会话正文搜索 sidecar（Go session-index）：预提取正文语料+分片扫描，
	// 补齐「全部历史会话正文搜词」能力；缺失/失败自动降级侧栏标题过滤。
	// 语料落 <userData>/session-index/（与设置/缓存同生命周期，卸载重装可重建）。
	const sessionIndexService = new SessionIndexService({
		corpusDir: join(app.getPath("userData"), "session-index"),
		resolveBinaryPath: () => {
			// 打包后：resourcesPath/session-index/session-index(.exe)（extraResources）；
			// dev：仓库构建产物 resources/session-index/bin/（build 链自动 fail-open 构建）
			const dir = app.isPackaged ? join(process.resourcesPath, "session-index") : join(app.getAppPath(), "resources", "session-index", "bin");
			const name = process.platform === "win32" ? "session-index.exe" : "session-index";
			const path = join(dir, name);
			return existsSync(path) ? path : null;
		},
		logger: {
			debug: (m) => appLogger.debug("session-index", m),
			info: (m) => void appLogger.info("session-index", m),
			warn: (m) => void appLogger.warn("session-index", m),
			error: (m) => void appLogger.error("session-index", m),
		},
	});
	ctx.assign({ sessionIndexService });
	quitCleanup.register("session-index", () => {
		sessionIndexService.dispose();
		ctx.assign({ sessionIndexService: null });
	});
	// 工作区文件索引 sidecar（Go file-index）：名字检索从实时 BFS 扫盘换成内存索引打分，
	// 并补上文件内容检索；索引在内存里不落盘（进程重启重建由 Go 侧毫秒级完成），
	// 缺失/失败/超时自动回退现有 BFS（fail-open）。
	const fileIndexService = new FileIndexService({
		resolveBinaryPath: () => {
			// 打包后：resourcesPath/file-index/file-index(.exe)（extraResources）；
			// dev：仓库构建产物 resources/file-index/bin/（build 链自动 fail-open 构建）
			const dir = app.isPackaged ? join(process.resourcesPath, "file-index") : join(app.getAppPath(), "resources", "file-index", "bin");
			const name = process.platform === "win32" ? "file-index.exe" : "file-index";
			const path = join(dir, name);
			return existsSync(path) ? path : null;
		},
		logger: {
			debug: (m) => appLogger.debug("file-index", m),
			info: (m) => void appLogger.info("file-index", m),
			warn: (m) => void appLogger.warn("file-index", m),
			error: (m) => void appLogger.error("file-index", m),
		},
	});
	ctx.assign({ fileIndexService });
	quitCleanup.register("file-index", () => {
		fileIndexService.dispose();
		ctx.assign({ fileIndexService: null });
	});
	// 会话数据面 sidecar（Go session-store）：快照持久化 + 行边界增量扫描，Wave 2 起提供行级
	// 条目表（get-index）。收益门禁未过（见计划 §8.10），默认不预热、由开关控制。
	const sessionStoreService = new SessionStoreService({
		statePath: join(app.getPath("userData"), "session-store", "state.bin"),
		// Wave 2b：条目表落盘（重启后首次打开大会话直接读表，不再重扫源文件）。
		tablesDir: join(app.getPath("userData"), "session-store", "tables"),
		resolveBinaryPath: () => {
			// dev：仓库构建产物 resources/session-store/bin/（build 链自动 fail-open 构建）；
			// 打包后需补 extraResources 才会命中 resourcesPath 分支（Wave 2 接线时加）。
			const dir = app.isPackaged ? join(process.resourcesPath, "session-store") : join(app.getAppPath(), "resources", "session-store", "bin");
			const name = process.platform === "win32" ? "session-store.exe" : "session-store";
			const path = join(dir, name);
			return existsSync(path) ? path : null;
		},
		logger: {
			debug: (m) => appLogger.debug("session-store", m),
			info: (m) => void appLogger.info("session-store", m),
			warn: (m) => void appLogger.warn("session-store", m),
			error: (m) => void appLogger.error("session-store", m),
		},
	});
	ctx.assign({ sessionStoreService });
	quitCleanup.register("session-store", () => {
		sessionStoreService.dispose();
		ctx.assign({ sessionStoreService: null });
	});
	// Wave 2 读取路径默认关（收益门禁未过，见 docs/archive/plans/session-data-plane-plan.md §8.10）。
	// 开关打开时才预热：读者侧只在 sidecar 已就绪时问，不预热的话这条路径永远不会生效；
	// 预热本身只拉进程 + 载入快照（毫秒级），真正的条目解析由 get-index 触发。
	if (settingsStore.get().sessionStoreEnabled) sessionStoreService.warmup();
	// 后台预热：首次全量建索引可达十余秒，启动后稍等即预热，避免用户首搜撞上
	// 冷启动（预热失败静默——运行时搜索会再试）
	setTimeout(() => {
		void sessionScanner
			.resolveContentSearchRoots(projectPathsForContentSearch())
			.then((roots) => sessionIndexService?.warmup(roots))
			.catch(() => {});
	}, 5_000);
}
