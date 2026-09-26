/**
 * pi-deck-gui-bridge —— 翻译层：pi-tui `Component` 树 → `UINode` JSON（§6）。
 *
 * 三条纪律：
 * 1. **`instanceof` 优先，形状兜底**（§6.3 对策 2）—— pi-tui 加载失败或版本漂移时
 *    仍能按 `constructor.name` + 关键属性识别；
 * 2. **未知即降级** —— 认不出的组件渲染成剥了 ANSI 的等宽文本块（`ansi` 节点），
 *    **永不抛错**（§14.6）；
 * 3. **每个节点带稳定 nodeId** —— `WeakMap<Component, string>` 分配，
 *    组件实例不变则 id 不变。这是事件回灌的主键（§6.1）。
 */

import type { StyleToken, UINode } from "./pi-deck-gui-bridge-types";
import { loadPiTui, type PiTuiComponent, type PiTuiModule } from "./pi-deck-gui-bridge-tui";
import { parseStyledText, stripStyledText, type StyledRun } from "./pi-deck-gui-bridge-theme";

// ── nodeId 分配（稳定：同实例同 id）──────────────────────────────

const idByComponent = new WeakMap<object, string>();
const componentById = new Map<string, PiTuiComponent>();
let nextNodeId = 1;

/** 取组件的稳定 nodeId；首次调用时分配。 */
export function nodeIdOf(component: PiTuiComponent): string {
	const key = component as unknown as object;
	const existing = idByComponent.get(key);
	if (existing) return existing;
	const id = `n${nextNodeId++}`;
	idByComponent.set(key, id);
	componentById.set(id, component);
	return id;
}

/** 由 nodeId 反查组件（事件回灌用，§8.3）。 */
export function componentOf(nodeId: string): PiTuiComponent | undefined {
	return componentById.get(nodeId);
}

/** 为 ctx.gui 的交互节点分配 actionId → 回调（§7.2）。 */
const actionHandlers = new Map<string, (payload?: unknown) => void>();
let nextActionId = 1;

export function registerAction(handler: (payload?: unknown) => void): string {
	const id = `a${nextActionId++}`;
	actionHandlers.set(id, handler);
	return id;
}

export function invokeAction(actionId: string, payload?: unknown): boolean {
	const handler = actionHandlers.get(actionId);
	if (!handler) return false;
	try {
		handler(payload);
	} catch {
		// 扩展回调抛错不能影响桥（§14.5）
	}
	return true;
}

/** 释放某个组件相关的 action（组件被替换/卸载时调用）。 */
export function clearActions(): void {
	actionHandlers.clear();
}

// ── 序列化上下文 ────────────────────────────────────────────────

export type SerCtx = {
	/** 渲染宽度（pi-tui 组件 render 需要它；GUI 侧自适应）。 */
	width: number;
	/** 递归深度（> MAX_DEPTH 即停止展开，防环）。 */
	depth: number;
	/** 本次序列化已产出的节点数（> MAX_NODES 即截断）。 */
	count: { value: number };
};

const MAX_DEPTH = 32;
const MAX_NODES = 2000;
const DEFAULT_WIDTH = 80;

function newCtx(width = DEFAULT_WIDTH): SerCtx {
	return { width, depth: 0, count: { value: 0 } };
}

// ── 形状判定工具（instanceof 失效时的兜底）──────────────────────

/** 读组件的 constructor.name（跨模块实例也稳定）。 */
function ctorName(c: unknown): string {
	try {
		return (c as { constructor?: { name?: string } })?.constructor?.name ?? "";
	} catch {
		return "";
	}
}

/** 安全读属性（私有字段在运行时存在，但类型上不可见）。 */
function read<T>(c: unknown, key: string): T | undefined {
	try {
		return (c as Record<string, T>)[key];
	} catch {
		return undefined;
	}
}

/** 双轨匹配：instanceof 优先，失败退回 constructor.name。 */
function isA(c: PiTuiComponent, mod: PiTuiModule | null, ctor: keyof PiTuiModule, name: string): boolean {
	if (mod) {
		const klass = mod[ctor] as unknown as (new (...a: unknown[]) => unknown) | undefined;
		if (typeof klass === "function" && c instanceof (klass as new (...a: unknown[]) => object)) return true;
	}
	return ctorName(c) === name;
}

// ── 适配器 ──────────────────────────────────────────────────────

type Adapter = {
	/** 适配器名（诊断日志用）。 */
	name: string;
	match: (c: PiTuiComponent, mod: PiTuiModule | null) => boolean;
	serialize: (c: PiTuiComponent, ctx: SerCtx, mod: PiTuiModule | null) => UINode;
};

/** 读容器的 children（`Container.children` / `Box.children` 都是 public）。 */
function childrenOf(c: PiTuiComponent): PiTuiComponent[] {
	const kids = read<PiTuiComponent[]>(c, "children");
	return Array.isArray(kids) ? kids : [];
}

/** 递归序列化 children（带深度/数量上限）。 */
function serializeChildren(c: PiTuiComponent, ctx: SerCtx, mod: PiTuiModule | null): UINode[] {
	const out: UINode[] = [];
	for (const child of childrenOf(c)) {
		if (ctx.depth >= MAX_DEPTH || ctx.count.value >= MAX_NODES) break;
		ctx.depth += 1;
		ctx.count.value += 1;
		const node = serializeComponent(child, ctx, mod);
		ctx.depth -= 1;
		if (node) out.push(node);
	}
	return out;
}

/** 安全渲染：任何异常都返回空数组（保命，§14.6）。 */
function safeRender(c: PiTuiComponent, width: number): string[] {
	try {
		const lines = c.render(width);
		return Array.isArray(lines) ? lines : [];
	} catch {
		return [];
	}
}

/** 去掉 pi-tui `Text` 默认的上下留白（paddingY），间距交给 GUI 布局控制。 */
function trimBlankEdges(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && stripStyledText(lines[start]).trim() === "") start += 1;
	while (end > start && stripStyledText(lines[end - 1]).trim() === "") end -= 1;
	return lines.slice(start, end);
}

/**
 * 把带样式的多行文本转成节点数组。
 *
 * pi-tui 的 `Text` 支持多行；语义化后**每行一个 text 节点**，
 * 由外层 vstack 负责纵向排列（比塞 `\n` 更利于 GUI 换行与样式分段）。
 */
function textNodes(id: string, lines: string[]): UINode[] {
	const out: UINode[] = [];
	lines.forEach((line, index) => {
		const runs: StyledRun[] = parseStyledText(line);
		if (runs.length === 0) return;
		// 单 run 且无样式 → 最简节点
		if (runs.length === 1) {
			out.push({ kind: "text", id: index === 0 ? id : `${id}:${index}`, text: runs[0].text, style: runs[0].styles.length ? runs[0].styles : undefined });
			return;
		}
		// 多 run → 用 hstack 承载行内分段（GUI 侧不换行）
		out.push({
			kind: "hstack",
			id: index === 0 ? id : `${id}:${index}`,
			children: runs.map((run, runIndex) => ({
				kind: "text" as const,
				id: `${id}:${index}:${runIndex}`,
				text: run.text,
				style: run.styles.length ? run.styles : undefined,
			})),
		});
	});
	return out;
}

/** 把若干节点折成「单个则直出，多个则 vstack」的形态。 */
function wrapNodes(id: string, nodes: UINode[]): UINode {
	if (nodes.length === 1) return nodes[0];
	return { kind: "vstack", id, children: nodes };
}

const ADAPTERS: Adapter[] = [
	// ★ Loader extends Text —— 必须排在 Text 之前，否则永远命中 Text
	{
		name: "Loader",
		match: (c, m) => isA(c, m, "Loader", "Loader") || isA(c, m, "CancellableLoader", "CancellableLoader"),
		serialize: (c) => {
			const frames = read<string[]>(c, "frames");
			const message = read<string>(c, "message");
			return {
				kind: "loader",
				id: nodeIdOf(c),
				label: message ? stripStyledText(message) : undefined,
				frames: Array.isArray(frames) ? frames.map((f) => stripStyledText(f)) : undefined,
				cancellable: ctorName(c) === "CancellableLoader",
			};
		},
	},
	{
		name: "SelectList",
		match: (c, m) => isA(c, m, "SelectList", "SelectList"),
		serialize: (c) => {
			// 优先公开方法，私有字段兜底（Phase 0 S4 实测两者都可用）
			// 两个候选都用同一形状，避免 `??` 合并出交叉类型导致 description 不可见。
			type RawItem = { value?: string; label?: string; description?: string };
			const itemsRaw: RawItem[] = read<RawItem[]>(c, "filteredItems") ?? read<RawItem[]>(c, "items") ?? [];
			const items = itemsRaw.map((item) => ({
				label: stripStyledText(String(item.label ?? item.value ?? "")),
				value: String(item.value ?? ""),
				description: item.description ? stripStyledText(item.description) : undefined,
			}));
			const selectedIndex = read<number>(c, "selectedIndex") ?? 0;
			const filter = read<string>(c, "_filter") ?? undefined;
			return {
				kind: "select",
				id: nodeIdOf(c),
				items,
				selected: Number.isFinite(selectedIndex) ? selectedIndex : 0,
				filter: filter ? stripStyledText(filter) : undefined,
			};
		},
	},
	{
		name: "SettingsList",
		match: (c, m) => isA(c, m, "SettingsList", "SettingsList"),
		serialize: (c) => {
			const itemsRaw = read<{ id?: string; label?: string; currentValue?: string; description?: string; values?: string[] }[]>(c, "items") ?? [];
			return {
				kind: "settings",
				id: nodeIdOf(c),
				items: itemsRaw.map((item, index) => ({
					id: String(item.id ?? `item-${index}`),
					label: stripStyledText(String(item.label ?? "")),
					currentValue: stripStyledText(String(item.currentValue ?? "")),
					description: item.description ? stripStyledText(item.description) : undefined,
					values: Array.isArray(item.values) ? item.values.map((v) => stripStyledText(v)) : undefined,
				})),
			};
		},
	},
	{
		name: "Input",
		match: (c, m) => isA(c, m, "Input", "Input"),
		serialize: (c) => {
			// Input 有公开 getValue()（Phase 0 S4 实测）——优先公开方法
			const getValue = read<() => string>(c, "getValue");
			let value = "";
			try {
				value = typeof getValue === "function" ? getValue.call(c) : String(read<string>(c, "value") ?? "");
			} catch {
				value = "";
			}
			const placeholder = read<string>(c, "placeholder");
			return {
				kind: "input",
				id: nodeIdOf(c),
				value: stripStyledText(value ?? ""),
				placeholder: placeholder ? stripStyledText(String(placeholder)) : undefined,
			};
		},
	},
	{
		name: "Editor",
		match: (c, m) => isA(c, m, "Editor", "Editor"),
		serialize: (c) => {
			const state = read<{ text?: string }>(c, "state");
			const value = state?.text ?? read<string>(c, "value") ?? "";
			return { kind: "editor", id: nodeIdOf(c), value: stripStyledText(String(value)) };
		},
	},
	{
		name: "Markdown",
		match: (c, m) => isA(c, m, "Markdown", "Markdown"),
		serialize: (c) => {
			const md = read<string>(c, "text") ?? read<string>(c, "markdown") ?? "";
			return { kind: "markdown", id: nodeIdOf(c), md: stripStyledText(String(md)) };
		},
	},
	{
		name: "Box",
		match: (c, m) => isA(c, m, "Box", "Box"),
		serialize: (c, ctx, m) => {
			const paddingX = read<number>(c, "paddingX");
			const paddingY = read<number>(c, "paddingY");
			const children = serializeChildren(c, ctx, m);
			return {
				kind: "box",
				id: nodeIdOf(c),
				padding: typeof paddingX === "number" || typeof paddingY === "number" ? [Number(paddingX ?? 0), Number(paddingY ?? 0)] : undefined,
				children,
			};
		},
	},
	{
		name: "VStack",
		match: (c, m) => isA(c, m, "VStack", "VStack"),
		serialize: (c, ctx, m) => {
			const gap = read<number>(c, "gap");
			return { kind: "vstack", id: nodeIdOf(c), children: serializeChildren(c, ctx, m), gap: typeof gap === "number" ? gap : undefined };
		},
	},
	{
		name: "HStack",
		match: (c, m) => isA(c, m, "HStack", "HStack"),
		serialize: (c, ctx, m) => {
			const gap = read<number>(c, "gap");
			return { kind: "hstack", id: nodeIdOf(c), children: serializeChildren(c, ctx, m), gap: typeof gap === "number" ? gap : undefined };
		},
	},
	{
		name: "ScrollView",
		match: (c, m) => isA(c, m, "ScrollView", "ScrollView"),
		serialize: (c, ctx, m) => ({ kind: "scroll", id: nodeIdOf(c), children: serializeChildren(c, ctx, m) }),
	},
	{
		name: "Spacer",
		match: (c, m) => isA(c, m, "Spacer", "Spacer"),
		serialize: (c) => {
			const lines = read<number>(c, "lines");
			return { kind: "spacer", id: nodeIdOf(c), size: typeof lines === "number" ? lines : undefined };
		},
	},
	{
		name: "Image",
		match: (c, m) => isA(c, m, "Image", "Image"),
		serialize: (c) => {
			const data = read<string>(c, "base64Data");
			const mime = read<string>(c, "mimeType") ?? "image/png";
			return { kind: "image", id: nodeIdOf(c), src: data ? `data:${mime};base64,${data}` : "", alt: read<string>(c, "filename") };
		},
	},
	{
		name: "TruncatedText",
		match: (c, m) => isA(c, m, "TruncatedText", "TruncatedText"),
		serialize: (c) => {
			const text = read<string>(c, "text") ?? "";
			const runs = parseStyledText(String(text));
			return { kind: "text", id: nodeIdOf(c), text: runs.map((r) => r.text).join(""), style: runs[0]?.styles.length ? runs[0].styles : undefined };
		},
	},
	// ★ Text 放最后：它是若干组件的父类
	{
		name: "Text",
		match: (c, m) => isA(c, m, "Text", "Text"),
		serialize: (c, ctx) => {
			const text = read<string>(c, "text") ?? "";
			const lines = trimBlankEdges(String(text).split("\n"));
			const nodes = textNodes(nodeIdOf(c), lines);
			if (nodes.length === 0) return { kind: "text", id: nodeIdOf(c), text: "" };
			return wrapNodes(nodeIdOf(c), nodes);
		},
	},
];

/** 认不出的组件 → `ansi` 块（保命路径）。 */
function degradeToAnsi(c: PiTuiComponent, ctx: SerCtx): UINode {
	const lines = safeRender(c, ctx.width).map((line) => stripStyledText(line));
	// 去掉尾部空行，避免 GUI 里出现大片空白
	while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
	while (lines.length > 0 && lines[0].trim() === "") lines.shift();
	return { kind: "ansi", id: nodeIdOf(c), lines };
}

/**
 * 序列化单个组件。
 *
 * 适配器内部抛错 → 降级 `ansi`（不牵连其他节点，§14.6）。
 */
export function serializeComponent(c: PiTuiComponent | undefined | null, ctx: SerCtx, mod: PiTuiModule | null): UINode | null {
	if (!c || typeof c.render !== "function") return null;
	if (ctx.depth >= MAX_DEPTH || ctx.count.value >= MAX_NODES) return null;
	for (const adapter of ADAPTERS) {
		let matched = false;
		try {
			matched = adapter.match(c, mod);
		} catch {
			matched = false;
		}
		if (!matched) continue;
		try {
			return adapter.serialize(c, ctx, mod);
		} catch {
			// 适配器炸了 → 该组件降级，不影响其他
			return degradeToAnsi(c, ctx);
		}
	}
	return degradeToAnsi(c, ctx);
}

/**
 * 序列化入口（桥对外只用这一个）。
 *
 * `width` 缺省 80：GUI 侧自适应，宽度只影响 ANSI 降级块的换行。
 */
export function serialize(c: PiTuiComponent | undefined | null, width = DEFAULT_WIDTH): UINode | null {
	const mod = loadPiTui();
	return serializeComponent(c, newCtx(width), mod.module);
}

/** 供 ticker 做变更检测：把节点树压成稳定字符串。 */
export function hashUINode(node: UINode | null): string {
	if (!node) return "null";
	return stableStringify(node);
}

/** 稳定序列化（对象键排序，避免键序抖动导致假变更）。 */
function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/** 诊断：当前已跟踪的组件数。 */
export function trackedComponentCount(): number {
	return componentById.size;
}

export type { StyleToken };