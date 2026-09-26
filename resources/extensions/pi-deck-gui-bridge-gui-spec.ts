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
	// 配置页：在 PiDeck「Pi 管理」侧栏的「Agent 能力」组里多出一个整页。
	// 与 settings.section 的区别：那个是设置弹窗底部追加的一块，这个是货真价实的一级导航项。
	setConfigPage: "config.page",
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
	/**
	 * 最近一次推送给 PiDeck 的树（含 slot 元信息）。
	 *
	 * 事件回落时按 `nodeId` 在各自的树里反查归属（§8.3）—— 扩展自己决定节点 id，
	 * 不在桥侧另建索引，避免两份真相。
	 */
	lastNode?: GuiNode;
	/** 是否有效（校验失败即 false，贡献隐藏）。 */
	valid: boolean;
	/**
	 * 归属扩展 id（`encodeOwnerId` 的产物）。
	 *
	 * 双重职责：① 卸载即清（§7.7）；② 落点命名空间隔离 —— 两个扩展用同一个 key
	 * 也不会互相顶掉（见 `contributionKey` / `slotTargetId`）。
	 */
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

/** 归属未知的占位符（取不到调用栈时的退路：行为等同旧版「单一命名空间」）。 */
export const OWNER_UNKNOWN = "unknown";

/** FNV-1a 32 位（跨进程稳定，不依赖 V8 的字符串哈希实现）。 */
function fnv1a32(input: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < input.length; i += 1) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(36).padStart(7, "0");
}

/**
 * 归属扩展 id：扩展根目录全路径 → 可读 slug + 32 位短哈希。
 *
 * 为什么是「路径 + 哈希」而不是只用 basename：basename 会把两个都叫 `index.ts` 的扩展
 * 归成同一个（真踩过：全局 `~/.pi/agent/extensions/pi-ext-points/index.ts`）。
 * 为什么留 slug 而不是纯哈希：targetId 会出现在日志、`data-bridge-slot` 与测试断言里，
 * 纯哈希没法人肉对账。
 * 哈希只为让编码**单射**（slug 会把 `-` / `_` / 空格 归一，理论上可撞），不承担安全职责。
 *
 * 形态保证：只含 `[A-Za-z0-9._-]`，**不含 `@`**（落点 id 靠 `@` 切分，见 `slotTargetId`）。
 */
export function encodeOwnerId(rootPath: string): string {
	const slug = rootPath.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(-72) || "unknown";
	return `${slug}.${fnv1a32(rootPath)}`;
}

/**
 * 上溯到扩展根目录：`.../extensions/<name>/...` → `.../extensions/<name>`。
 *
 * 为什么要上溯而不是直接用「注册那一刻的文件」：注册与注销可能写在扩展的不同文件里
 * （`register.ts` / `dispose.ts`），不归一就会出现「注销时找不到自己注册的贡献」。
 * 单文件扩展（`.../extensions/foo.ts`）保持文件自身，不切成目录。
 */
export function extensionRootOf(filePath: string): string {
	const normalized = filePath.replace(/\\/g, "/");
	const marker = "/extensions/";
	const markerAt = normalized.lastIndexOf(marker);
	if (markerAt < 0) return normalized;
	const head = normalized.slice(0, markerAt + marker.length);
	const first = normalized.slice(markerAt + marker.length).split("/")[0];
	return `${head}${first}`;
}

/**
 * 落点 id：`gui:<slot>:<owner>@<key>`。
 *
 * **owner 必须进 id**：PiDeck 的 `bridgeTargets` 是 `Record<targetId, node>` ——
 * 两个扩展用同一个 key 时只有一个槽位，后注册的把先注册的挤掉（树还在，但事件再也投不到它）。
 * 渲染层本来就支持「一个插槽渲染多个贡献」（按 order 排序），补上 owner 就自然共存。
 *
 * **owner 在前、key 在后**：解析靠**第一个** `@`，这样自由形态的 `key` 里带 `@`
 * （工具名/包名里完全可能出现）也不受影响，而被约束的 owner 由 `encodeOwnerId` 保证不含 `@`。
 * 无 `@` 是旧桥的形态 —— PiDeck 侧按「整段都是 key」兜底，不炸字段。
 */
export function slotTargetId(method: GuiSlotMethod, key: string, owner?: string): string {
	return `gui:${GUI_SLOT_METHODS[method]}:${owner && owner.trim() ? owner : OWNER_UNKNOWN}@${key}`;
}

/** slot id → 方法名（事件从 targetId 反解归属时用）。 */
const METHOD_BY_SLOT: Record<string, GuiSlotMethod> = Object.fromEntries(
	(Object.entries(GUI_SLOT_METHODS) as [GuiSlotMethod, string][]).map(([method, slotId]) => [slotId, method]),
);

/**
 * 贡献表键：`<owner>::<method>:<key>`。
 *
 * owner 进键 —— 否则两个扩展用同一个 key 会互相顶掉（落点共存的实现基础）。
 */
export function contributionKey(owner: string, method: GuiSlotMethod, key: string): string {
	return `${owner}::${method}:${key}`;
}

/**
 * 从落点 id 反解出贡献表键（事件硬化：PiDeck 回灌事件时带上 `targetId`，桥按它精确定位）。
 *
 * 解析不出（旧 PiDeck 不带 owner 段）返回 `undefined`，调用方退回「按 nodeId 全表扫描」。
 */
export function contributionKeyFromTargetId(targetId: string): string | undefined {
	if (typeof targetId !== "string" || !targetId.startsWith("gui:")) return undefined;
	const rest = targetId.slice(4);
	const sep = rest.indexOf(":");
	if (sep < 0) return undefined;
	const method = METHOD_BY_SLOT[rest.slice(0, sep)];
	const tail = rest.slice(sep + 1);
	const at = tail.indexOf("@");
	if (!method || at <= 0) return undefined;
	const owner = tail.slice(0, at);
	const key = tail.slice(at + 1);
	if (!key) return undefined;
	return contributionKey(owner, method, key);
}

/**
 * 找「本次调用该动的那条贡献」的键。
 *
 * 先按 owner 精确匹配；owner 退化为 `unknown`（取不到调用栈）时再退回「仅 method:key」的旧语义 ——
 * 那种情况下整个进程只有一份命名空间，与旧版行为一致，不会比旧版更糟。
 */
export function findContributionKey(state: GuiNamespaceState, owner: string, method: GuiSlotMethod, key: string): string | undefined {
	const exact = contributionKey(owner, method, key);
	if (state.contributions.has(exact)) return exact;
	if (owner !== OWNER_UNKNOWN) return undefined;
	const suffix = `::${method}:${key}`;
	for (const candidate of state.contributions.keys()) {
		if (candidate.endsWith(suffix)) return candidate;
	}
	return undefined;
}

/** 仅测试用：清空某 runtime 的 GUI 状态。 */
export function resetGuiStateForTests(runtime: BridgeRuntime): void {
	guiStateByRuntime.delete(runtime);
}