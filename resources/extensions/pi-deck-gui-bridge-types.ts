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
 * 「本地态」标记（`local: true`）——**渲染器持有该控件的 UI 态**。
 *
 * 为什么需要：落点贡献是「推一帧是一帧」的 JSON 树，一次交互要走
 * 渲染器 → 主进程 → 轮询 → pi 进程 → 重推 一整个来回（活跃 ~100ms、空闲 ~500ms）。
 * 输入框若等回灌才显示字符，快速输入会丢字；折叠/勾选若等回灌，手感发黏。
 *
 * 语义（四条，宿主与扩展共同遵守）：
 * 1. 渲染器**立即**更新该控件的本地态（0ms 反馈）；
 * 2. 若节点声明了 `actionId`，事件**照常上报**（扩展据此做后续动作，如按关键词重新过滤）；
 * 3. 扩展重推时**不覆盖**用户已改过的本地态 —— 除非扩展推来的值相对上次确实变了；
 * 4. 本地态活在渲染器组件里，**贡献卸载即消失**（扩展卸载后不留痕迹，§7.7）。
 *
 * 不带 `local` 的控件保持原语义：远端受控，等回灌。
 */
export type LocalFlag = { local?: boolean };

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
	| ({ kind: "input"; value: string; placeholder?: string; actionId?: string } & LocalFlag & NodeBase)
	| ({ kind: "editor"; value: string; title?: string; actionId?: string } & LocalFlag & NodeBase)
	| ({ kind: "select"; items: SelectItemShape[]; selected: number; filter?: string } & NodeBase)
	| ({ kind: "settings"; items: SettingItemShape[] } & NodeBase)
	| ({ kind: "loader"; label?: string; frames?: string[]; cancellable?: boolean } & NodeBase)
	| ({ kind: "scroll"; children: UINode[]; maxHeight?: number } & NodeBase)
	| ({ kind: "image"; src: string; alt?: string } & NodeBase)
	/** ★ 降级保命：认不出的组件渲染成剥了 ANSI 的等宽文本块，绝不抛错。 */
	| ({ kind: "ansi"; lines: string[] } & NodeBase)
	// ── GUI 原生超集（§7.3 控件库）────────────────────────────
	| ({ kind: "stack"; direction: "column" | "row"; gap?: number; align?: StackAlign; children: UINode[] } & NodeBase)
	| ({ kind: "grid"; columns?: number; children: UINode[] } & NodeBase)
	| ({ kind: "split"; direction: "column" | "row"; ratio?: number; children: UINode[] } & NodeBase)
	| ({ kind: "card"; title?: string; children: UINode[] } & NodeBase)
	/**
	 * **原生设置块**：映射宿主设置页的「淡色框」（PiDeck 侧为 `SettingBox`）。
	 *
	 * 为什么需要：扩展自己拼卡片/文字/间距做出来的设置区，字号行高分隔线与
	 * 宿主设置页不一致，一眼就看得出是「外挂」；而调参永远调不出同源观感 ——
	 * 唯一可靠的办法是**把排版权交回宿主**（§2「直接复用 PiDeck UI」）。
	 *
	 * `setting-box` + `setting-row` 就是把贡献投影到宿主**真实**的设置页组件上，
	 * 宿主主题/字号/行高/控件列宽一变，贡献跟着变。
	 */
	| ({ kind: "setting-box"; children: UINode[] } & NodeBase)
	/**
	 * **原生设置行**：映射宿主设置页的行式布局（PiDeck 侧为 `SettingRow`）。
	 *
	 * - `title` 左列标题；`description` 左列小字说明；
	 * - `level: 1` 分区标题行（加粗加大）；缺省 `2` 是普通行；
	 * - `stacked: true` 降为单列：标题在上、控件占满整行（文本输入/文本域用）；
	 * - `alignEnd` 缺省 `true`（控件右对齐）；`select` 类传 `false` 撑满控件列；
	 * - `anchor` 是宿主命令面板的深链锚点（宿主自行决定用不用）；
	 * - `children` 是右侧控件，通常 1 个。
	 *
	 * 宿主不认这两个 kind 时按 §7.5 降级渲染，**绝不抛错**。
	 */
	| ({ kind: "setting-row"; title: string; description?: string; level?: 1 | 2; stacked?: boolean; alignEnd?: boolean; anchor?: string; children: UINode[] } & NodeBase)
	/**
	 * 可折叠分组（折叠态由**渲染器**持有，见 `LocalFlag`）。
	 *
	 * `label` 是分组标题，`count` 是标题右侧的计数（可选），
	 * 声明 `actionId` 时展开/收起也会上报一次（扩展可据此懒加载子项）。
	 */
	| ({ kind: "collapse"; label: string; collapsed?: boolean; count?: number; actionId?: string; children: UINode[] } & NodeBase)
	| ({ kind: "scrollarea"; children: UINode[]; maxHeight?: number } & NodeBase)
	| ({ kind: "badge"; label: string; tone?: Tone } & NodeBase)
	| ({ kind: "divider"; label?: string } & NodeBase)
	| ({ kind: "icon"; name: string; tone?: Tone } & NodeBase)
	| ({ kind: "button"; label: string; tone?: Tone; variant?: Variant; actionId?: string; disabled?: boolean } & NodeBase)
	| ({ kind: "textarea"; value: string; placeholder?: string; rows?: number; actionId?: string } & LocalFlag & NodeBase)
	| ({ kind: "selectinput"; value: string; options: { label: string; value: string }[]; placeholder?: string; actionId?: string } & LocalFlag & NodeBase)
	| ({ kind: "checkbox"; label: string; checked: boolean; actionId?: string } & LocalFlag & NodeBase)
	| ({ kind: "switch"; label: string; checked: boolean; actionId?: string } & LocalFlag & NodeBase)
	| ({ kind: "slider"; label?: string; value: number; min?: number; max?: number; step?: number; actionId?: string } & LocalFlag & NodeBase)
	| ({ kind: "list"; items: { label: string; value: string; description?: string }[]; selected: number } & LocalFlag & NodeBase)
	| ({ kind: "table"; columns: string[]; rows: string[][] } & NodeBase)
	| ({ kind: "tree"; nodes: TreeNodeShape[] } & NodeBase)
	| ({ kind: "keyvalue"; entries: { key: string; value: string }[] } & NodeBase)
	| ({ kind: "codeblock"; code: string; language?: string } & NodeBase)
	| ({ kind: "progress"; value?: number; max?: number; label?: string } & NodeBase)
	| ({ kind: "spinner"; label?: string } & NodeBase)
	| ({ kind: "tabs"; tabs: { label: string; content: UINode }[]; active: number; actionId?: string } & LocalFlag & NodeBase)
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
	/**
	 * PiDeck 要求桥**全量重推一次**（§9.4）。
	 *
	 * 用于渲染层丢失了桥状态（换 agent 绑定、会话切换、设置弹窗重开、应用重启）
	 * 的场景：桥的落点是「一次性推送」，丢了不会自己回来，只能靠 PiDeck 主动要一次快照。
	 * 搭在既有的轮询响应上，不新开路由 —— 纯终端/老 PiDeck 不认这个字段，桥行为不变。
	 */
	resync?: boolean;
};