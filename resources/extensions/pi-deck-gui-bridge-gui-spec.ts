/**
 * pi-deck-gui-bridge —— `ctx.gui` 的**规格层**：白名单、上限、校验与状态容器。
 *
 * 从 `pi-deck-gui-bridge-gui.ts` 拆出，理由：这一层是**纯规格**（常量 + 纯函数 +
 * 状态容器），不含任何「怎么渲染/怎么推送」的实现细节，与命名空间装配是两件事。
 * 拆出后 `gui.ts` 只留装配与落点逻辑，单文件回到可读规模。
 *
 * 纪律（§7.5）：**不合法就跳过 + 记日志，绝不崩溃**。
 * 校验失败只让「该贡献隐藏」，不牵连其他贡献，也不影响 pi 与 PiDeck。
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GuiNode, OverlayOptions } from "./pi-deck-gui-bridge-types";
import type { BridgeRuntime } from "./pi-deck-gui-bridge-runtime";
import type { GuiComponent, GuiFactory, GuiSlotOptions } from "./pi-deck-gui-bridge-gui-types";

/**
 * GUI 专属位置 setter 白名单（§7.1-B）。
 *
 * 方法名 → 落点 id 前缀。校验时方法不在白名单内即视为非法
 * （`ctx.gui` 上不存在别的方法）。
 */
export const GUI_SLOT_METHODS = {
	setSidebarPanel: "sidebar.panel",
	setSidebarSection: "sidebar.section",
	setContentView: "content.view",
	setComposerToolbar: "composer.toolbar",
	setTitlebarAction: "titlebar.action",
	setBanner: "banner",
	setToolExtra: "tool.extra",
	setMessageExtra: "message.extra",
	setThinkingExtra: "thinking.extra",
	setDialogAction: "dialog.action",
	setDialogBody: "dialog.body",
	setSettingsSection: "settings.section",
	setSessionItemExtra: "session.item",
	setContextMenuItem: "context.menu",
} as const;

export type GuiSlotMethod = keyof typeof GUI_SLOT_METHODS;

/** 单次序列化的节点数上限（§7.5）。 */
export const MAX_NODES = 2000;
/** 节点树深度上限（§7.5）。 */
export const MAX_DEPTH = 32;
/** 默认 order（§7.1-B）。 */
export const DEFAULT_ORDER = 1000;

/**
 * 判断值是否为合法 `GuiNode`。
 *
 * 拒绝四类：
 * - 非对象 / `null`
 * - 无 `kind` 字符串
 * - **React 元素**（有 `$$typeof`）—— 零构建约束（§14.2）
 * - **cyclic**（同一对象在自身子树里再次出现）—— 会让序列化与渲染双双爆栈
 *
 * `children` 非数组同样拒绝（形状不对的树渲染层接不住）。
 */
export function isValidGuiNode(value: unknown, depth = 0, seen = new Set<unknown>()): value is GuiNode {
	if (depth > MAX_DEPTH) return false;
	if (value === null || typeof value !== "object") return false;
	if (seen.has(value)) return false; // cyclic
	seen.add(value);
	const node = value as { kind?: unknown; children?: unknown };
	if (typeof node.kind !== "string") return false;
	// React 元素有 $$typeof —— 明确拒绝（扩展不允许写 JSX）
	if ("$$typeof" in (value as object)) return false;
	if (node.children !== undefined) {
		if (!Array.isArray(node.children)) return false;
		for (const child of node.children) {
			if (!isValidGuiNode(child, depth + 1, seen)) return false;
		}
	}
	seen.delete(value);
	return true;
}

/** 判断返回值是否为合法 `GuiComponent`（有 `render()`）。 */
export function isGuiComponent(value: unknown): value is GuiComponent {
	return Boolean(value) && typeof value === "object" && typeof (value as GuiComponent).render === "function";
}

/** 节点计数（配合数量上限，防扩展画出巨树）。 */
export function countNodes(node: GuiNode): number {
	let count = 1;
	const children = (node as { children?: GuiNode[] }).children;
	if (Array.isArray(children)) {
		for (const child of children) count += countNodes(child);
	}
	return count;
}

/** 一个 GUI 落点贡献。 */
export type GuiContribution = {
	method: GuiSlotMethod;
	key: string;
	factory: GuiFactory;
	options: GuiSlotOptions;
	/** 已求值的组件（缓存：避免每 tick 重造实例）。 */
	component?: GuiComponent;
	/** 上次推送的哈希（变更检测）。 */
	lastHash?: string;
	/** 是否有效（校验失败即 false，贡献隐藏）。 */
	valid: boolean;
	/** 归属扩展名（卸载即清，§7.7）。 */
	owner: string;
};

/** GUI 命名空间的全部状态。 */
export type GuiNamespaceState = {
	contributions: Map<string, GuiContribution>;
	overlays: Map<string, { node: GuiNode; options?: OverlayOptions; onDismiss?: () => void }>;
	/** 已注册图标。 */
	icons: Map<string, string>;
	/** 已注册命令。 */
	commands: Map<string, () => void>;
	/** 当前扩展上下文（factory 第三参数）。 */
	ctx: ExtensionContext | null;
	/** 覆盖层 id 计数。 */
	overlaySeq: number;
};

/** 状态按 runtime 存（随 runtime 生命周期一起回收，不新开持久化）。 */
const guiStateByRuntime = new WeakMap<BridgeRuntime, GuiNamespaceState>();

/** 取（或初始化）某 runtime 的 GUI 状态。 */
export function guiState(runtime: BridgeRuntime): GuiNamespaceState {
	let state = guiStateByRuntime.get(runtime);
	if (!state) {
		state = { contributions: new Map(), overlays: new Map(), icons: new Map(), commands: new Map(), ctx: null, overlaySeq: 1 };
		guiStateByRuntime.set(runtime, state);
	}
	return state;
}

/** 落点 id：`gui:<slot>:<key>`（PiDeck 侧按前缀路由到对应插槽）。 */
export function slotTargetId(method: GuiSlotMethod, key: string): string {
	return `gui:${GUI_SLOT_METHODS[method]}:${key}`;
}

/** 仅测试用：清空某 runtime 的 GUI 状态。 */
export function resetGuiStateForTests(runtime: BridgeRuntime): void {
	guiStateByRuntime.delete(runtime);
}