/**
 * pi-deck-gui-bridge —— `ctx.gui` 的**类型层**（§7.1 / §7.2）。
 *
 * 从 `pi-deck-gui-bridge-gui.ts` 拆出，理由：类型是扩展作者看到的**公开契约**，
 * 与命名空间装配（怎么挂 getter、怎么推落点）是两件事。
 * 拆出后作者只需看这一个文件就知道 `ctx.gui` 的形状。
 *
 * 这些类型同时被 `gui-spec.ts`（规格/校验）与 `gui.ts`（装配）引用，
 * 放在独立文件也消除了两者之间的循环依赖。
 */

import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { GuiNode, OverlayOptions, Tone, Variant } from "./pi-deck-gui-bridge-types";
import type { BridgeTheme } from "./pi-deck-gui-bridge-theme";

/** GUI 组件：与 pi-tui `Component` 同形，只把「画出来是什么」换掉。 */
export type GuiComponent = {
	/** 画成 GUI 视图树（不用 width，GUI 自适应）。 */
	render(): GuiNode;
	/** 收语义化交互（GUI 已把按键语义化成 action）。 */
	handleAction?(actionId: string, payload?: unknown): void;
	invalidate?(): void;
	dispose?(): void;
};

/** GUI 主题：语义 token，**不能**指定颜色值（§7.3 配色铁律）。 */
export type GuiTheme = BridgeTheme & {
	/** 语义色档名列表（扩展可用于校验）。 */
	readonly tones: readonly Tone[];
	readonly variants: readonly Variant[];
};

/** GUI 键位语义（与 TUI 同名，便于移植，§13.10）。 */
export type GuiKeybindings = {
	matches(action: string, key: string): boolean;
	readonly keys: Readonly<Record<string, string>>;
};

/** 画布 / GUI 能力对象（对应 TUI 的 `tui: TUI`）。 */
export type GuiSurface = {
	/** 宿主主题。 */
	readonly hostTheme: GuiTheme;
	/** 宿主尺寸（GUI 自适应，这里只作提示）。 */
	readonly hostSize: { width: number; height: number };
	/** 请求重画（等价 TUI 的 `requestRender()`）。 */
	requestRender(): void;
	/** 关闭当前覆盖层（等价 done()）。 */
	close(result?: unknown): void;
};

/** 落点选项（§7.1-B）。 */
export type GuiSlotOptions = {
	title?: string;
	/** 升序，缺省 1000；同 order 按 key 字母序。 */
	order?: number;
	placement?: "above" | "below";
};

/** 统一签名（§7.1-B）。 */
export type GuiFactory = (gui: GuiSurface, theme: GuiTheme, ctx: ExtensionContext) => GuiComponent | GuiNode;

/** 覆盖层句柄（§7.2）。 */
export type GuiHandle = {
	/** 局部重画。 */
	update(next: GuiNode): void;
	/** 等价于 done(result)。 */
	close(result?: unknown): void;
	/** 覆盖层 id。 */
	readonly element: string;
};

/** `ctx.gui.custom` 的工厂签名（四参数与 TUI 一一对应，§7.2）。 */
export type GuiCustomFactory<T> = (gui: GuiSurface, theme: GuiTheme, keybindings: GuiKeybindings, done: (result: T) => void) => GuiComponent | GuiNode | Promise<GuiComponent | GuiNode>;

/** `ctx.gui.custom` 的选项（对照 TUI `custom` 的 options）。 */
export type GuiCustomOptions = {
	overlay?: boolean;
	modal?: boolean;
	position?: "center" | "right" | "bottom" | "fullscreen";
	size?: { width?: number | string; height?: number | string };
	onHandle?: (handle: GuiHandle) => void;
	onDismiss?: () => void;
};

/**
 * 「桥最先可用」暴露声明（PROMPT §四.A / §五，2026-02-23 选定命名：`ui.gui`）。
 *
 * 桥把 `GuiNamespace` 同时挂在两处，且两者是**同一个对象**（`ctx.gui === ctx.ui.gui`）：
 * 1. `ctx.gui` —— 当前 emit 的 ctx 上（桥挂载后的所有事件可用，向后兼容内置消费者）；
 * 2. `ctx.ui.gui` —— `ctx.ui` **共享单例**上（**推荐**：与 `wrapUI` 同机制，
 *    不依赖扩展加载顺序；桥的 session_start 挂载之后的任何事件 / 命令 handler
 *    里 `ctx.ui.gui` 都可靠可用。先于桥注册的扩展在自己的 session_start
 *    同步段里取不到，从 agent_start 起必然可用）。
 *
 * pi 原生 `ExtensionUIContext` 现无 `gui` 字段；为作者侧取用提供交集类型，
 * 桥未加载（纯终端）时运行时不存在，取用前请判空。
 */
export type GuiUiContext = ExtensionUIContext & {
	/** 桥挂在共享 ui 单例上的 GUI 扩展点（纯终端模式下为 undefined）。 */
	readonly gui?: GuiNamespace;
};

/** `ctx.gui` 的形状（§7.1）。 */
export type GuiNamespace = {
	// B 组：GUI 专属位置（15 个，与 §7.1-B 表一一对应）
	setSidebarPanel: (key: string, factory: GuiFactory | undefined, options?: GuiSlotOptions) => void;
	setSidebarSection: (key: string, factory: GuiFactory | undefined, options?: GuiSlotOptions) => void;
	setContentView: (key: string, factory: GuiFactory | undefined, options?: GuiSlotOptions) => void;
	setComposerToolbar: (key: string, factory: GuiFactory | undefined, options?: GuiSlotOptions) => void;
	setTitlebarAction: (key: string, factory: GuiFactory | undefined, options?: GuiSlotOptions) => void;
	setBanner: (key: string, factory: GuiFactory | undefined, options?: GuiSlotOptions) => void;
	setToolExtra: (key: string, factory: GuiFactory | undefined, options?: GuiSlotOptions) => void;
	setMessageExtra: (key: string, factory: GuiFactory | undefined, options?: GuiSlotOptions) => void;
	setThinkingExtra: (key: string, factory: GuiFactory | undefined, options?: GuiSlotOptions) => void;
	setDialogAction: (key: string, factory: GuiFactory | undefined, options?: GuiSlotOptions) => void;
	setDialogBody: (key: string, factory: GuiFactory | undefined, options?: GuiSlotOptions) => void;
	setSettingsSection: (key: string, factory: GuiFactory | undefined, options?: GuiSlotOptions) => void;
	/**
	 * 在 PiDeck「Pi 管理」侧栏的「Agent 能力」组里新增一个整页。
	 * `options.title` 就是导航项的文字；缺省用 key。同 `order` 按 key 字母序。
	 */
	setConfigPage: (key: string, factory: GuiFactory | undefined, options?: GuiSlotOptions) => void;
	setSessionItemExtra: (key: string, factory: GuiFactory | undefined, options?: GuiSlotOptions) => void;
	setContextMenuItem: (key: string, factory: GuiFactory | undefined, options?: GuiSlotOptions) => void;
	// C 组：交互与服务
	custom: <T = unknown>(factory: GuiCustomFactory<T>, options?: GuiCustomOptions) => Promise<T>;
	command: (id: string, handler: () => void) => void;
	toast: (message: string, options?: { tone?: Tone; actions?: { label: string; onPress: () => void }[] }) => void;
	confirm: (title: string, body: GuiNode, options?: { confirmLabel?: string; cancelLabel?: string }) => Promise<boolean>;
	overlay: (node: GuiNode, options?: OverlayOptions & { onDismiss?: () => void }) => GuiHandle;
	icon: (name: string, svgPath: string) => void;
	/** 主题（与 ctx.ui.theme 同形的语义版）。 */
	readonly theme: GuiTheme;
};