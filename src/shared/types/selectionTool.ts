/**
 * 系统级划词（全局快捷键 + 独立浮窗）的跨进程契约。
 *
 * 触发链路：全局快捷键 → 主进程模拟复制取选区 → 在光标附近弹出 selection-tool.html 浮窗
 * → 浮窗复用 agentProfiles.invoke 的一次性补全通道翻译（与页面内划词同一协议）。
 * 浮窗是独立 BrowserWindow，使用同一份 preload（desktopApi）。
 */

/** 浮窗尺寸（主进程建窗与渲染层折叠/展开共用；避免两处魔法数字漂移）。 */
export const SELECTION_TOOL_WINDOW_WIDTH = 440;
/** 折叠态宽度：只放智能体 + 翻译/问答 + 关闭，避免 Magpie 式浮条被工具栏撑成一条长表单。 */
export const SELECTION_TOOL_WINDOW_COLLAPSED_WIDTH = 360;
/** 折叠态：只露出顶部操作栏，Magpie 式浮条。 */
export const SELECTION_TOOL_WINDOW_COLLAPSED_HEIGHT = 46;
/** 展开态：操作栏 + 原文 + 结果面板。 */
export const SELECTION_TOOL_WINDOW_EXPANDED_HEIGHT = 280;

/**
 * 系统级划词暂时下线开关：代码与 IPC 保留，但默认不启动（复制监听、原生捕获、
 * 全局快捷键、浮窗预热全部跳过），设置页与快捷键页也不展示入口。
 * 恢复时改回 true，并同步 DEFAULT_AGENT_MARKET_SETTINGS.systemSelectionEnabled。
 */
export const SYSTEM_SELECTION_TOOL_ENABLED = false;

/** 浮窗渲染层请求调整窗口尺寸（折叠条 ↔ 结果面板）。 */
export type SelectionToolResizeInput = { width: number; height: number };

/** 浮窗可见性 + 全局快捷键注册状态（主进程 → 渲染层）。 */
export type SelectionToolWindowState = {
	visible: boolean;
	/**
	 * 系统级快捷键当前是否注册成功。undefined = 旧窗口状态/未装配服务（渲染层按「未知」处理）。
	 * 失败常见于 accelerator 被其他应用或另一个 PiDeck 实例占用。
	 */
	shortcutRegistered?: boolean;
	/** 当前已注册的 accelerator；null = 未注册。 */
	shortcut?: string | null;
};

/** 主进程捕获到选区后推给浮窗的载荷；text 为空时浮窗显示输入框让用户手动输入。 */
export type SelectionToolShowPayload = {
	text: string;
	/** capture-failed = 模拟复制没拿到文本；unsupported = 平台不支持（如 Wayland 无 xdotool）。 */
	reason?: "capture-failed" | "unsupported";
};

/** 浮窗「发送到 PiDeck」入参：文本插入主窗口当前会话输入框。 */
export type SelectionToolInsertInput = { text: string };

/** 选区长上限：系统级捕获的是任意应用文本，与一次性调用上限对齐即可。 */
export const SELECTION_TOOL_TEXT_MAX_CHARS = 16_000;
