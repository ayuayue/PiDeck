import { app, BrowserWindow, clipboard } from "electron";
import { AgentInvokeService } from "../agents/AgentInvokeService";
import type { AgentProfileStore } from "../agents/AgentProfileStore";
import type { QuitCleanupRegistry } from "../lifecycle/QuitCleanupRegistry";
import type { AppLogger } from "../logging/AppLogger";
import type { EnhancePromptService } from "../pi/enhance/EnhancePromptService";
import { ClipboardSelectionWatcher } from "../selection/clipboardSelectionWatcher";
import { SelectionToolService } from "../selection/SelectionToolService";
import { SelectionToolWindow } from "../selection/SelectionToolWindow";
import { WindowsSelectionCapture } from "../selection/windowsSelectionCapture";

/**
 * 系统级划词与智能体一次性调用装配（自 index.ts 的 whenReady 装配体就地外移，行为零变化）：
 * agent-invoke 侧车 + 划词浮窗/服务/剪贴板监听/UIA 采集 + 退出清理 + 快捷键实时刷新接线。
 *
 * 全部实例都是 index.ts 的模块级槽位，经 `assign` 回填（后续 IPC 与快捷键路径读同一份）。
 */
export interface SelectionToolsContext {
	readonly agentProfileStore: AgentProfileStore;
	readonly appLogger: AppLogger;
	readonly createCompletionHelperService: (namespace: "enhance" | "agent-invoke" | "suggest" | "agent-memory") => EnhancePromptService;
	readonly flushSelectionShortcutConflictNotice: () => void;
	readonly prepareMainPreloadPath: () => Promise<string>;
	readonly quitCleanup: QuitCleanupRegistry;
	readonly syncSelectionToolShortcut: () => void;
	readonly assign: (patch: {
		agentInvokeCompletionService?: EnhancePromptService | null;
		agentInvokeService?: AgentInvokeService | null;
		selectionToolWindow?: SelectionToolWindow | null;
		selectionToolService?: SelectionToolService | null;
		selectionClipboardWatcher?: ClipboardSelectionWatcher | null;
		windowsSelectionCapture?: WindowsSelectionCapture | null;
	}) => void;
}

export async function startSelectionTools(ctx: SelectionToolsContext): Promise<void> {
	const { agentProfileStore, appLogger, createCompletionHelperService, flushSelectionShortcutConflictNotice, prepareMainPreloadPath, quitCleanup, syncSelectionToolShortcut, assign } = ctx;

	// 智能体一次性调用（划词工具 / 市场面板）：复用提示词增强侧车协议，但**独立实例**。
	// 侧车进程常驻、首次调用才拉起（EnhancePromptService 的现有语义），启动期只做装配。
	const agentInvokeCompletionService = createCompletionHelperService("agent-invoke");
	// C12：常驻子进程，退出时必须回收（与 enhance-prompt 同一清理登记表）。
	quitCleanup.register("agent-invoke", () => agentInvokeCompletionService?.dispose());
	const agentInvokeService = new AgentInvokeService({
		profiles: agentProfileStore,
		completion: agentInvokeCompletionService,
		logger: {
			warn: (message) => void appLogger.warn("agent-invoke", message),
			error: (message) => void appLogger.error("agent-invoke", message),
		},
	});
	assign({ agentInvokeCompletionService, agentInvokeService });

	// 系统级划词：独立浮窗（复用主 preload，渲染层与主窗口同一份 desktopApi）+ 服务 + 全局快捷键。
	// 浮窗只在首次触发时创建；warmUp 预加载可把首次弹出延迟降到只剩 show。
	const selectionToolPreloadPath = await prepareMainPreloadPath();
	const selectionToolWindow = new SelectionToolWindow({
		preloadPath: selectionToolPreloadPath,
		logger: appLogger,
		devRendererUrl: process.env.ELECTRON_RENDERER_URL ?? null,
	});
	const selectionToolService = new SelectionToolService({
		window: selectionToolWindow,
		logger: {
			info: (scope, message, detail) => void appLogger.info(scope, message, detail),
			warn: (scope, message, detail) => void appLogger.warn(scope, message, detail),
			error: (scope, message, detail) => void appLogger.error(scope, message, detail),
		},
		suppressClipboardWatcher: (durationMs) => selectionClipboardWatcher?.suppressFor(durationMs),
	});
	// 复制即触发：外部应用复制文字 → 光标附近自动弹翻译浮窗（Magpie 式交互）。
	// 自己的窗口有焦点时不触发：应用内复制由应用内划词处理，浮窗自己的复制也不会再弹一个。
	let selectionClipboardWatcher: ClipboardSelectionWatcher | null = new ClipboardSelectionWatcher({
		readText: () => clipboard.readText(),
		isOwnWindowFocused: () => BrowserWindow.getAllWindows().some((win) => !win.isDestroyed() && win.isFocused()),
		onCaptured: (text) => {
			void selectionToolService?.showText(text);
		},
		logger: { warn: (message, detail) => void appLogger.warn("selection-tool", message, detail) },
	});
	// Windows 原生划词：拖选/双击后直接 UIA 读选区；读不到时才靠上面的剪贴板兜底。
	let windowsSelectionCapture: WindowsSelectionCapture | null = new WindowsSelectionCapture({
		onSelection: ({ text }) => {
			selectionClipboardWatcher?.suppressFor(2500);
			void selectionToolService?.showText(text);
		},
		logger: {
			info: (message, detail) => void appLogger.info("selection-tool", message, detail),
			warn: (message, detail) => void appLogger.warn("selection-tool", message, detail),
		},
	});
	assign({ selectionToolWindow, selectionToolService, selectionClipboardWatcher, windowsSelectionCapture });
	// 预热放在 registerIpc 之后（见下方 assemble 段）：浮窗加载即会 settings.get / agentProfiles.getSnapshot，
	// 提前 warmUp 会让首帧拿到「服务未就绪」的拒绝（只是闪一下默认主题，但没必要）。
	quitCleanup.register("selection-tool", () => {
		selectionClipboardWatcher?.dispose();
		selectionClipboardWatcher = null;
		windowsSelectionCapture?.dispose();
		windowsSelectionCapture = null;
		selectionToolService?.dispose();
		assign({ selectionClipboardWatcher: null, windowsSelectionCapture: null });
	});
	// 市场设置的「系统级划词」开关保存后即时生效（不必重启应用）。
	agentProfileStore.onChanged(() => syncSelectionToolShortcut());
	syncSelectionToolShortcut();
	// 同一台机器可能同时跑 dev 与安装版：后启动的实例会因 globalShortcut 被前者占用而注册失败。
	// 用户切回窗口/关掉另一个实例时重试一次，不必重启；仍失败则补发一次可执行提示。
	app.on("browser-window-focus", () => {
		syncSelectionToolShortcut();
		flushSelectionShortcutConflictNotice();
	});
}
