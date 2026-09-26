/**
 * GUI 扩展桥（pi-deck-gui-bridge）的跨进程契约。
 *
 * 桥扩展跑在 **pi 的 Node 进程**里，通过 `PIDECK_BRIDGE_URL` 指向的本机端点
 * 把 UI 树推给 PiDeck；PiDeck 渲染后把交互事件回灌给桥。
 * 本文件是这条链路上**唯一的类型来源**（主进程 / preload / 渲染进程共用）。
 *
 * 与桥扩展侧 `resources/extensions/pi-deck-gui-bridge-types.ts` 的对应关系：
 * 两侧必须保持一致的**线格式**。桥侧是独立 .ts（不能 import 仓库 TS），
 * 因此这里是「契约的宿主侧镜像」；改动线格式时两侧都要改。
 * 一致性由 `tests/guiBridge.test.mjs` 的字段断言兜底。
 */

/** 语义色档 —— 扩展只能选档位，真实色值由主题决定。 */
export type BridgeTone = "default" | "muted" | "accent" | "success" | "warning" | "danger";

/** 视觉变体档。 */
export type BridgeVariant = "solid" | "outline" | "ghost";

/** 文本样式 token。 */
export type BridgeStyleToken = BridgeTone | "bold" | "italic" | "underline" | "strikethrough" | "dim" | "code";

/** 列表/选择项。 */
export type BridgeSelectItem = { label: string; value: string; description?: string };

/** 设置项。 */
export type BridgeSettingItem = {
	id: string;
	label: string;
	currentValue: string;
	description?: string;
	values?: string[];
};

/** 树节点。 */
export type BridgeTreeNode = { label: string; children?: BridgeTreeNode[]; expanded?: boolean };

/** 落点元信息（order / title / placement）。 */
export type BridgeSlotMeta = {
	order: number;
	title?: string;
	placement?: "above" | "below";
};

/**
 * 可序列化 UI 节点。
 *
 * 与桥侧 `UINode` 逐字段对应。`slot` 是宿主侧附加的落点元信息（桥推送时带上）。
 */
export type BridgeUINode = {
	kind: string;
	id: string;
	/** 落点元信息（仅顶层节点有）。 */
	slot?: BridgeSlotMeta;
	// 文本类
	text?: string;
	style?: BridgeStyleToken[];
	md?: string;
	// 容器类
	children?: BridgeUINode[];
	padding?: [number, number];
	bg?: string;
	gap?: number;
	size?: number;
	align?: string;
	direction?: string;
	columns?: number;
	ratio?: number;
	title?: string;
	// 输入类
	value?: string;
	placeholder?: string;
	rows?: number;
	// 选择类
	items?: BridgeSelectItem[];
	selected?: number;
	filter?: string;
	// 设置类
	settingsItems?: BridgeSettingItem[];
	// 加载类
	label?: string;
	frames?: string[];
	cancellable?: boolean;
	// 图片 / 降级
	src?: string;
	alt?: string;
	/** icon 类节点的图标名（非 lucide 稳定契约，宿主降级为文本标记渲染）。 */
	name?: string;
	lines?: string[];
	// GUI 原生控件
	variant?: BridgeVariant;
	tone?: BridgeTone;
	actionId?: string;
	disabled?: boolean;
	checked?: boolean;
	min?: number;
	max?: number;
	step?: number;
	code?: string;
	language?: string;
	options?: { label: string; value: string }[];
	entries?: { key: string; value: string }[];
	rowsData?: string[][];
	tableColumns?: string[];
	nodes?: BridgeTreeNode[];
	tabs?: { label: string; content: BridgeUINode }[];
	active?: number;
	message?: string;
	actions?: { label: string; actionId: string }[];
	// GUI 扩展点词汇（v1.1.1）：折叠 / 本地态 / 滚动高度
	/** collapse 节点的折叠态；card 上给标题加可折叠标题栏。 */
	collapsed?: boolean;
	/** 初始折叠态（扩展侧声明，渲染器不自行改）。 */
	defaultCollapsed?: boolean;
	/** 折叠标题栏右侧的计数徽标。 */
	count?: number;
	/** scroll / scrollarea 的最大高度（px，缺省沿用宿主默认）。 */
	maxHeight?: number;
	/**
	 * 本地态标记：渲染器立即更新自己的显示值，不等扩展重推。
	 * 声明了 actionId 的控件照常上报；未声明的本地态控件不打扰扩展。
	 */
	local?: boolean;
	// ── 宿主原生设置行词汇（桥 v1.3.0）──────────────────────────
	// setting-box / setting-row 把扩展贡献投影到设置页真实的
	// SettingBox / SettingRow，排版权完全交回宿主。
	/** setting-row 的左列小字说明。 */
	description?: string;
	/** 1=分区标题行（加粗加大）；2=普通行（缺省）。 */
	level?: 1 | 2;
	/** 单列堆叠：标题在上、控件占满整行（文本输入 / 文本域）。 */
	stacked?: boolean;
	/** 控件右对齐（缺省 true）；select 类传 false 撑满控件列。 */
	alignEnd?: boolean;
	/** 宿主命令面板的深链锚点 slug。 */
	anchor?: string;
};

/** 覆盖层选项。 */
export type BridgeOverlayOptions = {
	modal?: boolean;
	position?: "center" | "right" | "bottom" | "fullscreen";
	size?: { width?: number | string; height?: number | string };
};

/** 桥推给 PiDeck 的一帧更新。 */
export type BridgeUpdate =
	| { type: "ui-update"; targetId: string; node: BridgeUINode | null }
	| { type: "status"; key: string; text: string | undefined }
	| { type: "working"; message?: string; visible?: boolean; frames?: string[] }
	| { type: "title"; title: string }
	| { type: "thinking-label"; label: string | undefined }
	| { type: "resync" }
	| { type: "overlay"; elementId: string; node: BridgeUINode | null; options?: BridgeOverlayOptions }
	| { type: "overlay-update"; elementId: string; node: BridgeUINode };

/**
 * PiDeck 回灌给桥的交互事件。
 *
 * `targetId` 是事件来源落点（`gui:<slot>:<owner>@<key>`）—— 桥侧靠它把事件投给
 * **正确的那个扩展**：两个扩展用同一个 key 时，它们贡献的节点 id 可能相撞，
 * 只靠 `nodeId` 会投错人。不填也兼容（桥退回按 nodeId 全表扫描）。
 */
export type BridgeEvent = { targetId?: string } & (
	| { type: "select"; nodeId: string; index: number }
	| { type: "navigate"; nodeId: string; index: number }
	| { type: "input"; nodeId: string; value: string }
	| { type: "key"; nodeId: string; key: string }
	| { type: "filter"; nodeId: string; filter: string }
	| { type: "action"; actionId: string; payload?: unknown }
);

/** 桥某个会话的落点集合（渲染层状态）。 */
export type BridgeSessionUi = {
	/** 落点 id → 节点树（null 表示该落点无内容）。 */
	targets: Record<string, BridgeUINode | null>;
	/** 状态栏条目（多 key 共存）。 */
	status: Record<string, string>;
	/** 流式状态行。 */
	working?: { message?: string; visible?: boolean; frames?: string[] };
	/** 会话标题（setTitle）。 */
	title?: string;
	/** 折叠思考块标签。 */
	thinkingLabel?: string;
	/** 覆盖层。 */
	overlays: Record<string, { node: BridgeUINode; options?: BridgeOverlayOptions }>;
	/** 单调递增修订号（渲染层据此判断是否需要重渲）。 */
	revision: number;
};

/** 落点 id 前缀约定（桥与宿主共同遵守）。 */
export const BRIDGE_TARGET = {
	header: "header",
	footer: "footer",
	editor: "editor",
	widgetPrefix: "widget:",
	guiPrefix: "gui:",
} as const;

/** GUI 专属落点（§7.1-B 的 15 个位置）。 */
export const BRIDGE_GUI_SLOTS = ["sidebar.panel", "sidebar.section", "content.view", "composer.toolbar", "titlebar.action", "banner", "tool.extra", "message.extra", "thinking.extra", "dialog.action", "dialog.body", "settings.section", "config.page", "session.item", "context.menu"] as const;

export type BridgeGuiSlot = (typeof BRIDGE_GUI_SLOTS)[number];

/**
 * 渲染进程 → 主进程：回灌一次桥交互事件。
 *
 * 带 `sessionId + agentId + runtimeGeneration`，与仓库既有 runtime 命令同构：
 * 主进程据此拒绝旧 runtime 的迟到事件（AGENTS.md「所有 runtime 命令和事件都必须带」）。
 */
export type BridgeEventInput = {
	sessionId: string;
	agentId: string;
	runtimeGeneration: number;
	event: BridgeEvent;
};

/**
 * 渲染进程 → 主进程：请求桥**全量重推一次**（规格书 §9.4）。
 *
 * 为什么需要：桥的落点是**一次性推送** —— 推过了就不再推。渲染层一旦丢了
 * 桥状态（换 agent 绑定 / 切换聚焦会话 / 重开设置弹窗 / 重启应用），贡献就永远不回来。
 * 主进程把这个请求转成一次「下一次轮询响应里带 `resync: true`」。
 *
 * 身份字段与 `BridgeEventInput` 同构：主进程据此拒绝旧 runtime 的迟到请求。
 */
export type BridgeResyncInput = {
	sessionId: string;
	agentId: string;
	runtimeGeneration: number;
};
