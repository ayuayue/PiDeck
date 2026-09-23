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

/** PiDeck 回灌给桥的交互事件。 */
export type BridgeEvent =
	| { type: "select"; nodeId: string; index: number }
	| { type: "navigate"; nodeId: string; index: number }
	| { type: "input"; nodeId: string; value: string }
	| { type: "key"; nodeId: string; key: string }
	| { type: "filter"; nodeId: string; filter: string }
	| { type: "action"; actionId: string; payload?: unknown };

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

/** GUI 专属落点（§7.1-B 的 14 个位置）。 */
export const BRIDGE_GUI_SLOTS = [
	"sidebar.panel",
	"sidebar.section",
	"content.view",
	"composer.toolbar",
	"titlebar.action",
	"banner",
	"tool.extra",
	"message.extra",
	"thinking.extra",
	"dialog.action",
	"dialog.body",
	"settings.section",
	"session.item",
	"context.menu",
] as const;

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