/**
 * pi-deck-gui-bridge —— 共享类型定义（UINode / GuiNode / 事件 / 更新载荷）。
 *
 * 本文件是桥的**纯类型层**，不含任何运行时逻辑，供其余模块 import。
 *
 * 两条路（pi-tui 语义化翻译 + ctx.gui 原生作画）**汇到同一套渲染词汇表**：
 * `GuiNode` 是 `UINode` 的超集，桥内部只维护一种节点类型与一个序列化器
 * （实现纪律 §14.11）。
 */

/** 语义色档 —— 扩展**不能**指定色值，只能选档位，真实色值由 PiDeck 主题决定。 */
export type Tone = "default" | "muted" | "accent" | "success" | "warning" | "danger";

/** 视觉变体档（按钮/卡片类控件用）。 */
export type Variant = "solid" | "outline" | "ghost";

/**
 * 文本样式 token。
 *
 * 由两条来源产生：
 * 1. 桥给扩展的 theme 哨兵（`{§accent§}text{§/§}`）解析而来（§6.5）；
 * 2. 真 ANSI SGR 的降级解析（解析不了就剥掉）。
 */
export type StyleToken = Tone | "bold" | "italic" | "underline" | "strikethrough" | "dim" | "code";

/** 单个节点的公共字段：`id` 是事件回灌的主键（§6.1）。 */
type NodeBase = {
	id: string;
	/**
	 * 落点元信息（仅顶层节点由宿主附加）。
	 *
	 * 桥推送落点时把 `order` / `title` / `placement` 挂在节点上，
	 * 宿主据此排序与渲染分组标题（§7.1-B）。**不改节点 kind**。
	 */
	slot?: { order: number; title?: string; placement?: "above" | "below" };
};

/**
 * 可序列化 UI 节点。
 *
 * `kind` 归属两类：
 * - **pi-tui 可翻译子集**（text/markdown/box/vstack/hstack/spacer/input/editor/
 *   select/settings/loader/scroll/image/ansi）—— 由 §6 的适配器产出；
 * - **GUI 原生超集**（button/table/tabs/tree/modal/toast/…）—— 由 ctx.gui 产出（§7.3）。
 */
export type UINode =
	// ── pi-tui 可翻译子集 ──────────────────────────────────────
	| ({ kind: "text"; text: string; style?: StyleToken[] } & NodeBase)
	| ({ kind: "markdown"; md: string } & NodeBase)
	| ({ kind: "box"; padding?: [number, number]; bg?: string; children: UINode[] } & NodeBase)
	| ({ kind: "vstack"; children: UINode[]; gap?: number } & NodeBase)
	| ({ kind: "hstack"; children: UINode[]; gap?: number } & NodeBase)
	| ({ kind: "spacer"; size?: number } & NodeBase)
	| ({ kind: "input"; value: string; placeholder?: string } & NodeBase)
	| ({ kind: "editor"; value: string; title?: string } & NodeBase)
	| ({ kind: "select"; items: SelectItemShape[]; selected: number; filter?: string } & NodeBase)
	| ({ kind: "settings"; items: SettingItemShape[] } & NodeBase)
	| ({ kind: "loader"; label?: string; frames?: string[]; cancellable?: boolean } & NodeBase)
	| ({ kind: "scroll"; children: UINode[] } & NodeBase)
	| ({ kind: "image"; src: string; alt?: string } & NodeBase)
	/** ★ 降级保命：认不出的组件渲染成剥了 ANSI 的等宽文本块，绝不抛错。 */
	| ({ kind: "ansi"; lines: string[] } & NodeBase)
	// ── GUI 原生超集（§7.3 控件库）────────────────────────────
	| ({ kind: "stack"; direction: "column" | "row"; gap?: number; align?: StackAlign; children: UINode[] } & NodeBase)
	| ({ kind: "grid"; columns?: number; children: UINode[] } & NodeBase)
	| ({ kind: "split"; direction: "column" | "row"; ratio?: number; children: UINode[] } & NodeBase)
	| ({ kind: "card"; title?: string; children: UINode[] } & NodeBase)
	| ({ kind: "scrollarea"; children: UINode[] } & NodeBase)
	| ({ kind: "badge"; label: string; tone?: Tone } & NodeBase)
	| ({ kind: "divider"; label?: string } & NodeBase)
	| ({ kind: "icon"; name: string; tone?: Tone } & NodeBase)
	| ({ kind: "button"; label: string; tone?: Tone; variant?: Variant; actionId?: string; disabled?: boolean } & NodeBase)
	| ({ kind: "textarea"; value: string; placeholder?: string; rows?: number } & NodeBase)
	| ({ kind: "selectinput"; value: string; options: { label: string; value: string }[]; placeholder?: string } & NodeBase)
	| ({ kind: "checkbox"; label: string; checked: boolean; actionId?: string } & NodeBase)
	| ({ kind: "switch"; label: string; checked: boolean; actionId?: string } & NodeBase)
	| ({ kind: "slider"; label?: string; value: number; min?: number; max?: number; step?: number; actionId?: string } & NodeBase)
	| ({ kind: "list"; items: { label: string; value: string; description?: string }[]; selected: number } & NodeBase)
	| ({ kind: "table"; columns: string[]; rows: string[][] } & NodeBase)
	| ({ kind: "tree"; nodes: TreeNodeShape[] } & NodeBase)
	| ({ kind: "keyvalue"; entries: { key: string; value: string }[] } & NodeBase)
	| ({ kind: "codeblock"; code: string; language?: string } & NodeBase)
	| ({ kind: "progress"; value?: number; max?: number; label?: string } & NodeBase)
	| ({ kind: "spinner"; label?: string } & NodeBase)
	| ({ kind: "tabs"; tabs: { label: string; content: UINode }[]; active: number; actionId?: string } & NodeBase)
	| ({ kind: "modal"; title?: string; children: UINode[]; actions?: UINode[] } & NodeBase)
	| ({ kind: "toast"; message: string; tone?: Tone; actions?: { label: string; actionId: string }[] } & NodeBase)
	| ({ kind: "banner"; message: string; tone?: Tone } & NodeBase);

export type StackAlign = "stretch" | "start" | "center" | "end";

export type SelectItemShape = { label: string; value: string; description?: string };

export type SettingItemShape = {
	id: string;
	label: string;
	currentValue: string;
	description?: string;
	values?: string[];
};

export type TreeNodeShape = {
	label: string;
	children?: TreeNodeShape[];
	expanded?: boolean;
};

/** `ctx.gui.custom()` 等 GUI 原生作画产出的节点（UINode 的别名，语义上强调来源）。 */
export type GuiNode = UINode;

// ── 交互事件（PiDeck → 桥，§9.3）────────────────────────────────

/** pi-tui 组件回灌事件（按 nodeId 找到活组件再调公开方法）。 */
export type UIBridgeEvent =
	| { type: "select"; nodeId: string; index: number }
	| { type: "navigate"; nodeId: string; index: number }
	| { type: "input"; nodeId: string; value: string }
	| { type: "key"; nodeId: string; key: string }
	| { type: "filter"; nodeId: string; filter: string }
	/** ctx.gui.custom 的交互节点：只回传 actionId，回调留在 pi 进程内（§14.14）。 */
	| { type: "action"; actionId: string; payload?: unknown };

// ── 更新载荷（桥 → PiDeck，§9.3）───────────────────────────────

/** 桥推给 PiDeck 的一帧更新。 */
export type UIBridgeUpdate =
	/** 某个落点（header/footer/widget/侧边栏…）的新节点树；null 表示清空该落点。 */
	| { type: "ui-update"; targetId: string; node: UINode | null }
	/** 状态栏条目（多 key 共存）。 */
	| { type: "status"; key: string; text: string | undefined }
	/** 流式状态行：文案 / 显隐 / 指示器帧。 */
	| { type: "working"; message?: string; visible?: boolean; frames?: string[] }
	/** 会话标题。 */
	| { type: "title"; title: string }
	/** 折叠思考块标签。 */
	| { type: "thinking-label"; label: string | undefined }
	/** 全量重推（PiDeck 侧重连 / 会话切换时用）。 */
	| { type: "resync" }
	/** 覆盖层（ctx.gui.custom 的 overlay/modal）开关。 */
	| { type: "overlay"; elementId: string; node: UINode | null; options?: OverlayOptions }
	/** 覆盖层局部重画（handle.update）。 */
	| { type: "overlay-update"; elementId: string; node: UINode };

export type OverlayOptions = {
	modal?: boolean;
	position?: "center" | "right" | "bottom" | "fullscreen";
	size?: { width?: number | string; height?: number | string };
};

/** 桥本次上报的完整快照（resync 时重建 PiDeck 侧状态用）。 */
export type UIBridgeSnapshot = {
	updates: UIBridgeUpdate[];
};

/** 一次 HTTP 往返的响应体：PiDeck 把待处理事件带回给桥。 */
export type UIBridgeResponse = {
	events?: UIBridgeEvent[];
};