/**
 * pi-deck-ext-points —— 扩展点面板（pi 扩展，内置到 PiDeck）。
 *
 * ## 它解决什么问题
 *
 * 写 pi 扩展最难的一步不是写代码，而是**说清自己要挂在哪**：「挂载点」「事件名」
 * 这些标识符散在运行时里，靠记靠猜都容易写错。这个扩展把 pi + PiDeck 的
 * 可挂载点摆出来，标好桥接状态，勾完生成一份可以直接交给 agent 的草稿。
 *
 * ## 数据全部**运行时推导**，零同步
 *
 * 这是刻意的设计选择 —— 之前那版把清单做成构建期快照 + 一份手写文档，
 * 结果 pi / PiDeck 一升级就要手动同步两处，还漏过一次。
 *
 * | 类别 | 来源 | 为什么不用快照 |
 * |---|---|---|
 * | `ctx.ui.*` 方法 | 运行时读 pi 的 `types.d.ts` | 永远与当前 pi 一致 |
 * | pi 扩展事件 | 同上（扫 `ExtensionAPI.on()` 签名） | 同上 |
 * | `ctx.gui.*` 落点 | **import 桥的 spec 模块** | 同一个源文件，天然不漂 |
 *
 * 读 `.d.ts` 失败时**降级为只列桥的落点**，不报错、不影响会话。
 *
 * ## 为什么能读 .d.ts
 *
 * 扩展跑在 pi 的 Node 进程里，`fs` 可用。pi 的安装位置由桥的
 * `piTuiResolvedPath()` 反推（它已经解析过 pi-tui 的绝对路径）。
 *
 * ## 状态归属
 *
 * 勾选与「主要用来」是**这个扩展自己的 UI 状态**，存在 pi 进程的闭包里 ——
 * 既不写 pi 配置（那会让顶部「保存」按钮变脏），也不写 localStorage
 * （扩展跑在 pi 进程，碰不到渲染层的存储）。
 * 代价：pi 进程重启后勾选清空。可接受 —— 它本来就是「构思草稿」的临时状态。
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GUI_SLOT_METHODS } from "./pi-deck-gui-bridge-gui-spec";
import { piTuiResolvedPath } from "./pi-deck-gui-bridge-tui";

const SECTION_KEY = "ext-points";
const DRAFT_NAME_MAX = 60;

/** 一个可挂载点。 */
type ExtPoint = {
	/** 稳定 id：草稿里用它，也是勾选状态的键。 */
	id: string;
	/** 分组：ui 方法 / 事件 / GUI 落点。 */
	group: "ui" | "event" | "gui";
	/** 展示用标识符（`ctx.ui.setStatus` / `tool_call` / `ctx.gui.setBanner`）。 */
	label: string;
	/** 调用形态（草稿里带上，agent 不用猜参数）。 */
	signature?: string;
	/** 在 PiDeck 里的桥接状态。 */
	status?: "wired" | "passthrough" | "not-bridged";
	/** 一句话说明。 */
	note?: string;
};

// ── 1. 定位 pi 的 types.d.ts ────────────────────────────────────

/**
 * 由 pi-tui 的解析结果反推 pi 包目录，再拼出 `types.d.ts`。
 *
 * 桥已经解决过「pi 装在哪」这个问题（含 Windows 的 `%APPDATA%\npm` 兜底、
 * ESM-only 包不能用 createRequire 等坑），这里直接复用它的结论。
 */
function resolvePiTypesDts(): string | null {
	const tuiPath = piTuiResolvedPath();
	if (!tuiPath) return null;
	// <pi>/node_modules/@earendil-works/pi-tui/dist/index.js
	//   → 向上找到 <pi>（含 package.json 且名为 @earendil-works/pi-coding-agent）
	let dir = dirname(tuiPath);
	for (let depth = 0; depth < 8; depth += 1) {
		const candidate = join(dir, "dist", "core", "extensions", "types.d.ts");
		if (existsSync(candidate)) return candidate;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

// ── 2. 从 .d.ts 抽 ui 方法与事件 ────────────────────────────────

/** 抽 `ExtensionUIContext` 的成员（方法签名 + 只读属性）。 */
function parseUiPoints(source: string): ExtPoint[] {
	const block = source.match(/export interface ExtensionUIContext \{([\s\S]*?)\n\}/);
	if (!block) return [];
	const body = block[1];
	const points: ExtPoint[] = [];
	// 泛型参数要容忍 —— `custom<T>(...)` 就是这种，漏了它会少一个点
	for (const m of body.matchAll(/^\s{4}(\w+)\s*(<[^>]*>)?\s*\(([\s\S]*?)\)\s*:\s*([^;]+);/gm)) {
		const params = m[3].replace(/\s+/g, " ").trim();
		points.push({
			id: `ui:${m[1]}`,
			group: "ui",
			label: `ctx.ui.${m[1]}`,
			signature: `${m[1]}(${params}): ${m[4].replace(/\s+/g, " ").trim()}`,
		});
	}
	for (const m of body.matchAll(/^\s{4}readonly\s+(\w+)\s*:\s*([^;]+);/gm)) {
		points.push({ id: `ui:${m[1]}`, group: "ui", label: `ctx.ui.${m[1]}`, signature: `readonly ${m[1]}: ${m[2].trim()}` });
	}
	return points;
}

/**
 * 抽 pi 的扩展事件名。
 *
 * 扫 `ExtensionAPI` 的 `on(event: "...")` 签名，**不扫**各 `XxxEvent` 接口的
 * `type` 字面量 —— 后者会漏掉没有简单字面量的那几个（实测漏 3 个）。
 */
function parseEvents(source: string): ExtPoint[] {
	const api = source.match(/export interface ExtensionAPI \{([\s\S]*?)\n\}/);
	if (!api) return [];
	const names = new Set<string>();
	for (const m of api[1].matchAll(/on\(event:\s*"([^"]+)"/g)) names.add(m[1]);
	return [...names].sort().map((name) => ({ id: `event:${name}`, group: "event", label: name, signature: `pi.on("${name}", handler)` }));
}

// ── 3. 桥的 GUI 落点（同源，不漂）──────────────────────────────

/** 每个落点的桥接状态与一句话说明（策展，人工维护但**只有这一处**）。 */
const GUI_SLOT_META: Record<string, { note: string }> = {
	"sidebar.panel": { note: "侧边栏面板列表" },
	"sidebar.section": { note: "侧边栏内分区" },
	"content.view": { note: "主内容区" },
	"composer.toolbar": { note: "输入框工具栏" },
	"titlebar.action": { note: "窗口/标签栏动作按钮" },
	banner: { note: "顶部横幅通知区" },
	"tool.extra": { note: "工具结果卡内部（key = toolName）" },
	"message.extra": { note: "消息气泡内部下方（key = role）" },
	"thinking.extra": { note: "折叠思考块内" },
	"dialog.action": { note: "交互对话框按钮区" },
	"dialog.body": { note: "交互对话框主体下方" },
	"settings.section": { note: "设置弹窗内" },
	"session.item": { note: "会话列表条目" },
	"context.menu": { note: "右键菜单" },
};

function buildGuiPoints(): ExtPoint[] {
	return Object.entries(GUI_SLOT_METHODS).map(([method, slot]) => ({
		id: `gui:${slot}`,
		group: "gui" as const,
		label: `ctx.gui.${method}`,
		signature: `${method}(key, factory, opts?)  →  落点 "${slot}"`,
		status: "wired" as const,
		note: GUI_SLOT_META[slot]?.note,
	}));
}

/**
 * pi 原生扩展点在 PiDeck 里的处理方式。
 *
 * 这份表**必须人工维护** —— 「桥对某个 pi 方法做了什么」是实现事实，推不出来。
 * 但它是**唯一一处**：面板、草稿都读它，不再另存文档。
 */
const UI_HANDLING: Record<string, { status: ExtPoint["status"]; note: string }> = {
	setStatus: { status: "wired", note: "全量接管为状态栏条目（多 key 共存）" },
	setWidget: { status: "wired", note: "字符串形式保持原路；组件形式由桥接" },
	setFooter: { status: "wired", note: "底部状态区" },
	setHeader: { status: "wired", note: "聊天区顶部" },
	setWorkingMessage: { status: "wired", note: "流式状态行文案" },
	setWorkingVisible: { status: "wired", note: "流式状态行显隐" },
	setWorkingIndicator: { status: "wired", note: "流式状态行指示器" },
	setHiddenThinkingLabel: { status: "wired", note: "折叠思考块标签" },
	setTitle: { status: "wired", note: "会话标题（document.title）" },
	select: { status: "passthrough", note: "PiDeck 已有时间线卡片" },
	confirm: { status: "passthrough", note: "PiDeck 已有确认卡片" },
	input: { status: "passthrough", note: "PiDeck 已有输入卡片" },
	notify: { status: "passthrough", note: "PiDeck 已有 toast" },
	editor: { status: "passthrough", note: "PiDeck 已有多行编辑器弹框" },
	pasteToEditor: { status: "passthrough", note: "走 setEditorText 原路" },
	setEditorText: { status: "passthrough", note: "已有落点" },
	getEditorText: { status: "passthrough", note: "同步读，RPC 下返回空串" },
	getEditorComponent: { status: "passthrough", note: "RPC 下恒返回 undefined" },
	getToolsExpanded: { status: "passthrough", note: "已有落点" },
	setToolsExpanded: { status: "passthrough", note: "已有落点" },
	theme: { status: "passthrough", note: "桥另供一份哨兵 theme" },
	getAllThemes: { status: "passthrough", note: "RPC 下返回空数组" },
	getTheme: { status: "passthrough", note: "RPC 下返回 undefined" },
	setTheme: { status: "passthrough", note: "RPC 下返回失败" },
	custom: { status: "not-bridged", note: "画的是字符行；GUI 对应物是 ctx.gui.custom()" },
	onTerminalInput: { status: "not-bridged", note: "GUI 里没有终端" },
	addAutocompleteProvider: { status: "not-bridged", note: "GUI 输入框有自己的补全机制" },
	setEditorComponent: { status: "not-bridged", note: "拦截但不替换：草稿状态在 PiDeck 侧，替换会做出死控件" },
};

// ── 4. 汇总 ─────────────────────────────────────────────────────

type Catalog = { points: ExtPoint[]; piVersion: string | null; typesPath: string | null };

/** 读一次 pi 的 .d.ts 并组装清单；失败则降级为只列桥的落点。 */
function loadCatalog(): Catalog {
	const typesPath = resolvePiTypesDts();
	const guiPoints = buildGuiPoints();
	if (!typesPath) {
		return { points: guiPoints, piVersion: null, typesPath: null };
	}
	try {
		const source = readFileSync(typesPath, "utf8");
		const uiPoints = parseUiPoints(source).map((point) => {
			const name = point.id.slice("ui:".length);
			const handling = UI_HANDLING[name];
			return { ...point, status: handling?.status ?? ("passthrough" as const), note: handling?.note };
		});
		return { points: [...uiPoints, ...parseEvents(source), ...guiPoints], piVersion: readPiVersion(typesPath), typesPath };
	} catch {
		return { points: guiPoints, piVersion: null, typesPath: null };
	}
}

/** 从 pi 包目录读版本号（诊断用）。 */
function readPiVersion(typesPath: string): string | null {
	let dir = dirname(typesPath);
	for (let depth = 0; depth < 8; depth += 1) {
		const pkg = join(dir, "package.json");
		if (existsSync(pkg)) {
			try {
				const parsed = JSON.parse(readFileSync(pkg, "utf8"));
				if (parsed?.name === "@earendil-works/pi-coding-agent" && typeof parsed.version === "string") return parsed.version;
			} catch {
				// 继续向上找
			}
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

// ── 5. 草稿生成 ─────────────────────────────────────────────────

/** 勾选顺序 = 草稿编号顺序（不是列表顺序）。 */
function buildDraft(selectedIds: string[], purposes: Map<string, string>, name: string, catalog: Catalog): string {
	const byId = new Map(catalog.points.map((p) => [p.id, p]));
	const lines: string[] = [];
	lines.push(`扩展名称和大概功能：${name.trim() || "（未命名，请先问我）"}`);
	lines.push("");
	lines.push("本次扩展需要依赖的扩展点：");
	let index = 0;
	for (const id of selectedIds) {
		const point = byId.get(id);
		if (!point) continue; // 已下线的点跳过，不渲染成 undefined
		index += 1;
		lines.push(`${index}. ${point.label}`);
		if (point.signature) lines.push(`   - 签名：${point.signature}`);
		if (point.note) lines.push(`   - 说明：${point.note}`);
		lines.push(`   - 主要用来：${purposes.get(id)?.trim() || "（未填写，请先问我这块具体想做什么）"}`);
	}
	if (index === 0) lines.push("（还没勾选任何扩展点）");
	lines.push("");
	lines.push("约束提示：这些只是我的初步构想，如果你开发过程中有依赖需要增删，可以先询问。");
	lines.push("");
	lines.push("## 参考文档");
	lines.push("- docs/gui-extension-bridge.md（ctx.ui / ctx.gui 完整 API、移植指南与不映射点）");
	return lines.join("\n");
}

// ── 6. 面板渲染 ─────────────────────────────────────────────────

const GROUP_TITLE: Record<ExtPoint["group"], string> = { ui: "pi 原生 UI 扩展点", event: "pi 扩展事件", gui: "PiDeck 专属落点" };
const STATUS_TONE: Record<string, "success" | "muted" | "danger"> = { wired: "success", passthrough: "muted", "not-bridged": "danger" };
const STATUS_LABEL: Record<string, string> = { wired: "已桥接", passthrough: "走原路", "not-bridged": "GUI 里没反应" };

/**
 * 渲染面板。
 *
 * 勾选状态与「主要用来」存在闭包里（pi 进程内存），点击通过 actionId 回灌到
 * `handleAction` —— 与桥的 `ctx.gui.custom` 是同一套机制。
 */
function renderPanel(catalog: Catalog, selected: Set<string>, purposes: Map<string, string>, name: string): unknown {
	const children: unknown[] = [];
	let seq = 0;
	const nextId = (prefix: string) => `${prefix}-${(seq += 1)}`;

	children.push({ kind: "text", id: nextId("hint"), text: `共 ${catalog.points.length} 个可挂载点。勾选要用的，写一句用途，再生成草稿。`, tone: "muted" });
	if (!catalog.typesPath) {
		children.push({ kind: "banner", id: nextId("warn"), tone: "warning", message: "读不到 pi 的类型定义，只列出 PiDeck 专属落点。pi 升级后重开会话即可。" });
	} else if (catalog.piVersion) {
		children.push({ kind: "text", id: nextId("ver"), text: `快照来源：pi ${catalog.piVersion}（运行时读取，无构建期快照）`, tone: "muted" });
	}

	for (const group of ["ui", "event", "gui"] as const) {
		const points = catalog.points.filter((p) => p.group === group);
		if (points.length === 0) continue; // 空分组不产生空标题
		children.push({ kind: "divider", id: nextId("div"), label: `${GROUP_TITLE[group]}（${points.length}）` });
		for (const point of points) {
			const row: unknown[] = [{ kind: "checkbox", id: nextId("cb"), label: point.label, checked: selected.has(point.id), actionId: `toggle:${point.id}` }];
			if (point.status) row.push({ kind: "badge", id: nextId("bd"), label: STATUS_LABEL[point.status] ?? point.status, tone: STATUS_TONE[point.status] ?? "muted" });
			children.push({ kind: "hstack", id: nextId("row"), gap: 2, children: row });
			if (point.note) children.push({ kind: "text", id: nextId("note"), text: `　${point.note}`, tone: "muted" });
			if (selected.has(point.id)) {
				children.push({ kind: "input", id: `purpose:${point.id}`, value: purposes.get(point.id) ?? "", placeholder: "主要用来（一句话）" });
			}
		}
	}

	children.push({ kind: "divider", id: nextId("div2") });
	children.push({ kind: "input", id: "draft-name", value: name, placeholder: "扩展名称（可选）" });
	children.push({
		kind: "hstack",
		id: nextId("actions"),
		gap: 2,
		children: [
			{ kind: "button", id: nextId("btn"), label: `生成草稿（已选 ${selected.size} 个）`, variant: "solid", actionId: "draft", disabled: selected.size === 0 },
			{ kind: "button", id: nextId("btn"), label: "清空勾选", variant: "ghost", actionId: "clear", disabled: selected.size === 0 },
		],
	});

	return { kind: "card", id: "ext-points-card", title: "扩展点", children };
}

// ── 7. 扩展入口 ─────────────────────────────────────────────────

export default function piDeckExtPoints(pi: ExtensionAPI): void {
	// 勾选顺序即草稿编号顺序 —— 用数组保序，Set 只用于 O(1) 查
	let selectedOrder: string[] = [];
	const selected = new Set<string>();
	const purposes = new Map<string, string>();
	let draftName = "";
	let catalog: Catalog | null = null;

	const log = (message: string): void => {
		process.stderr.write(`[pi-deck-ext-points] ${message}\n`);
	};

	function ensureCatalog(): Catalog {
		if (!catalog) {
			catalog = loadCatalog();
			log(`清单已加载：${catalog.points.length} 个点${catalog.piVersion ? `（pi ${catalog.piVersion}）` : "（读不到 pi 类型定义，已降级）"}`);
		}
		return catalog;
	}

	function mount(ctx: ExtensionContext): void {
		const gui = (ctx as unknown as { gui?: Record<string, unknown> }).gui;
		if (!gui || typeof gui.setSettingsSection !== "function") {
			// 桥没挂上（未装 / 被禁用）→ 静默不工作，pi 行为不变
			return;
		}
		const setSettingsSection = gui.setSettingsSection as (key: string, factory: unknown, opts?: unknown) => void;

		const catalogNow = ensureCatalog();
		const handleAction = (actionId: string, payload?: unknown): void => {
			if (actionId.startsWith("toggle:")) {
				const id = actionId.slice("toggle:".length);
				if (selected.has(id)) {
					selected.delete(id);
					selectedOrder = selectedOrder.filter((x) => x !== id);
				} else {
					selected.add(id);
					selectedOrder.push(id);
				}
				refresh();
				return;
			}
			if (actionId === "clear") {
				selected.clear();
				selectedOrder = [];
				purposes.clear();
				refresh();
				return;
			}
			if (actionId === "draft") {
				const draft = buildDraft(selectedOrder, purposes, draftName, catalogNow);
				log(`草稿已生成（${selectedOrder.length} 个点，${draft.length} 字符）`);
				// 把草稿塞进输入框：作者可以直接编辑后发给 agent
				(gui.setEditorText as ((text: string) => void) | undefined)?.(draft);
				void payload;
			}
		};

		function refresh(): void {
			// 每次重设会替换旧贡献；勾选/用途变化都走这里
			setSettingsSection(
				SECTION_KEY,
				() => ({
					render: () => renderPanel(catalogNow, selected, purposes, draftName),
					handleAction,
				}),
				{ title: "扩展点", order: 900 },
			);
		}

		refresh();
		log("扩展点面板已挂到设置弹窗");
	}

	pi.on("session_start", async (_event, ctx) => {
		try {
			mount(ctx);
		} catch (error) {
			log(`挂载失败（已吞，pi 不受影响）: ${error instanceof Error ? error.message : String(error)}`);
		}
	});

	// 会话结束：清掉贡献，避免残留
	pi.on("session_shutdown", async (_event, ctx) => {
		try {
			const gui = (ctx as unknown as { gui?: Record<string, unknown> }).gui;
			(gui?.setSettingsSection as ((key: string, factory: undefined) => void) | undefined)?.(SECTION_KEY, undefined);
		} catch {
			// 清理失败无副作用
		}
	});
}

/** 供测试直接调用（不经 pi 运行时）。 */
export const __test__ = { parseUiPoints, parseEvents, buildGuiPoints, buildDraft, loadCatalog };
