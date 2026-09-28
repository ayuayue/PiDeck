/**
 * pi-deck-ext-points —— 清单层：pi 原生扩展点（运行时读 .d.ts）+ PiDeck GUI 落点（运行时枚举桥）。
 *
 * 本文件是 **PiDeck 内置扩展**的一部分：随应用 `resources/extensions/` 分发，
 * 但它**不是**被 `-e` 注入的扩展入口（入口是 `pi-deck-ext-points.ts`）。
 * 仍然必须进 `extensions-manifest.json` —— 热更新覆盖层按完整快照复制，
 * 少一个被 import 的模块就是 pi 侧 MODULE_NOT_FOUND。
 *
 * ## 数据全部**运行时推导**，零快照
 *
 * | 类别 | 来源 | 为什么不用快照 |
 * |---|---|---|
 * | `ctx.ui.*` 方法 | 运行时读 pi 的 `types.d.ts` | 永远与当前 pi 一致 |
 * | pi 扩展事件 | 同上（扫 `ExtensionAPI.on()` 签名） | 同上 |
 * | `ctx.gui.*` 落点 | **桥的 spec 表 `GUI_SLOT_METHODS`（同源 import）+ 运行时枚举 `ctx.gui` 取交集** | spec 表是桥与渲染层之间的契约（落点 id 与顺序的唯一真相），枚举确认桥实例**真的**挂出了这些方法 |
 *
 * 一张**人工策展**表（唯一一处，面板与草稿都读它，不再另存文档）：
 * - `UI_HANDLING`：「桥对某个 pi 原生方法做了什么」是实现事实，推不出来。
 *   （GUI 落点说明在 `GUI_SLOT_META`，slot id 直接取桥的 `GUI_SLOT_METHODS`，不另立表。）
 *
 * 枚举出 spec 表里没有的新 setXxx 时（桥升级加了新落点），照列不漏：
 * 落点 id 显示方法名、说明降级为「待登记」，绝不静默丢弃。
 *
 * 读 `.d.ts` 失败时**降级为只列桥的落点**，不报错、不影响会话。
 *
 * ## 为什么能读 .d.ts
 *
 * 扩展跑在 pi 的 Node 进程里，`fs` 可用。pi 的安装位置用锚点法定位
 * （与桥解析 pi-tui 同思路：npm 全局布局 + 环境变量 + 自身位置向上找）。
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { GUI_SLOT_METHODS } from "./pi-deck-gui-bridge-gui-spec";

/** 一个可挂载点。 */
export type ExtPoint = {
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

export type Catalog = {
	points: ExtPoint[];
	/** pi 版本号（诊断用；读不到为 null）。 */
	piVersion: string | null;
	/** types.d.ts 路径（诊断用；null = 已降级为只列 GUI 落点）。 */
	typesPath: string | null;
	/** GUI 落点的枚举来源描述（诊断用）。 */
	guiSource: string | null;
	/** 枚举到但策展表未登记的方法名（桥升级后新增的落点）。 */
	guiUnknown: string[];
};

// ── 1. 定位 pi 的 types.d.ts ────────────────────────────────────

/**
 * 本文件自身的绝对路径（jiti 以 CommonJS 包装加载扩展，`__filename` 可用）。
 *
 * **刻意不用 `import.meta.url`**：pi 用 jiti 以 CommonJS 语义加载扩展
 * （桥 `pi-deck-gui-bridge-tui.ts` 的同一处结论），`import.meta` 在那种包装下
 * 直接是语法错误，而 `__filename` 在 jiti 与测试沙箱里都成立。
 * 判断按运行时存在性做，不依赖 `typeof __filename` 之外的东西。
 */
function currentFilePath(): string | null {
	try {
		return typeof __filename === "string" && __filename.length > 0 ? __filename : null;
	} catch {
		return null;
	}
}

/**
 * 锚点法定位 pi 包目录（复刻桥解析 pi-tui 的思路，但只做路径存在性检查，
 * 不依赖任何 resolve 语义——ESM-only 包的 resolve 常因 exports 收紧而失败）。
 */
function candidateRoots(): string[] {
	const roots: string[] = [];
	// process.execPath 同级的 npm 全局布局：
	// Windows: <node>/../npm/node_modules；Unix: <node>/../lib/node_modules
	const execDir = dirname(process.execPath);
	roots.push(join(execDir, "..", "npm", "node_modules"));
	roots.push(join(execDir, "..", "lib", "node_modules"));
	// Windows 的 npm 全局前缀是 %APPDATA%\npm（不在 node 安装目录旁边）
	if (process.env.APPDATA) roots.push(join(process.env.APPDATA, "npm", "node_modules"));
	// 自定义全局前缀
	const home = homedir();
	if (home) roots.push(join(home, ".npm-global", "lib", "node_modules"));
	if (process.env.npm_config_prefix) roots.push(join(process.env.npm_config_prefix, "node_modules"));
	// 扩展自身位置向上找 node_modules（扩展装在 npm 布局里时成立）
	const selfFile = currentFilePath();
	if (selfFile) {
		let dir = dirname(selfFile);
		for (let depth = 0; depth < 6; depth += 1) {
			roots.push(dir);
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}
	return [...new Set(roots.filter(Boolean))];
}

/**
 * 定位 pi 的 `dist/core/extensions/types.d.ts`。
 *
 * 每个锚点只用于拼路径，**不要求锚点本身存在**——只检查最终候选文件。
 * 锚点全落空时再试一次 `createRequire`（对非标准布局兜底）。
 */
export function resolvePiTypesDts(): string | null {
	for (const root of candidateRoots()) {
		const candidate = join(root, "@earendil-works", "pi-coding-agent", "dist", "core", "extensions", "types.d.ts");
		if (existsSync(candidate)) return candidate;
	}
	try {
		const selfFile = currentFilePath();
		if (!selfFile) return null;
		const req = createRequire(selfFile);
		const pkg = req.resolve("@earendil-works/pi-coding-agent/package.json");
		const candidate = join(dirname(pkg), "dist", "core", "extensions", "types.d.ts");
		if (existsSync(candidate)) return candidate;
	} catch {
		// ESM-only 包可能拒绝 resolve package.json 子路径——正常降级
	}
	return null;
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

// ── 2. 从 .d.ts 抽 ui 方法与事件 ────────────────────────────────

/** 抽 `ExtensionUIContext` 的成员（方法签名 + 只读属性）。 */
export function parseUiPoints(source: string): ExtPoint[] {
	const block = source.match(/export interface ExtensionUIContext \{([\s\S]*?)\n\}/);
	if (!block) return [];
	const body = block[1];
	const points: ExtPoint[] = [];
	const seen = new Set<string>();
	const push = (point: ExtPoint): void => {
		if (seen.has(point.id)) return; // 同名双重载只保第一条（如 setWidget）
		seen.add(point.id);
		points.push(point);
	};
	// 泛型参数要容忍 —— `custom<T>(...)` 就是这种，漏了它会少一个点
	for (const m of body.matchAll(/^\s{4}(\w+)\s*(<[^>]*>)?\s*\(([\s\S]*?)\)\s*:\s*([^;]+);/gm)) {
		const params = m[3].replace(/\s+/g, " ").trim();
		push({ id: `ui:${m[1]}`, group: "ui", label: `ctx.ui.${m[1]}`, signature: `${m[1]}(${params}): ${m[4].replace(/\s+/g, " ").trim()}` });
	}
	for (const m of body.matchAll(/^\s{4}readonly\s+(\w+)\s*:\s*([^;]+);/gm)) {
		push({ id: `ui:${m[1]}`, group: "ui", label: `ctx.ui.${m[1]}`, signature: `readonly ${m[1]}: ${m[2].trim()}` });
	}
	return points;
}

/**
 * 抽 pi 的扩展事件名。
 *
 * 扫 `ExtensionAPI` 的 `on(event: "...")` 签名，**不扫**各 `XxxEvent` 接口的
 * `type` 字面量 —— 后者会漏掉没有简单字面量的那几个（实测漏 3 个）。
 */
export function parseEvents(source: string): ExtPoint[] {
	const api = source.match(/export interface ExtensionAPI \{([\s\S]*?)\n\}/);
	if (!api) return [];
	const names = new Set<string>();
	for (const m of api[1].matchAll(/on\(event:\s*"([^"]+)"/g)) names.add(m[1]);
	return [...names].sort().map((name) => ({ id: `event:${name}`, group: "event", label: name, signature: `pi.on("${name}", handler)` }));
}

// ── 3. 桥的 GUI 落点（spec 表 + 运行时枚举，零同步）─────────────

/**
 * 运行时枚举 `ctx.gui` 上的落点 setter。
 *
 * 桥的命名空间是普通对象：15 个 `setXxx` 落点 setter + 若干交互服务
 * （custom / command / toast / confirm / overlay / icon / theme）。
 * 只认 `set` 大写开头且值为函数的属性——这就是桥实例**真实提供**的落点集合。
 */
export function enumerateGuiSlotMethods(gui: unknown): string[] {
	if (!gui || typeof gui !== "object") return [];
	return Object.keys(gui).filter((key) => /^set[A-Z]/.test(key) && typeof (gui as Record<string, unknown>)[key] === "function");
}

/** method → 落点 id（直接取桥的 spec 表，避免两张表漂移）。 */
const GUI_SLOT_IDS: Record<string, string> = { ...GUI_SLOT_METHODS };

/** 每个落点的一句话说明（策展，人工维护但**只有这一处**）。 */
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
	"config.page": { note: "Pi 管理 → Agent 能力 的一级导航页（本扩展自己占用的落点）" },
	"session.item": { note: "会话列表条目" },
	"context.menu": { note: "右键菜单" },
};

/**
 * 由桥实例上枚举到的落点 setter 组装清单项。
 *
 * 落点 id 与**渲染顺序**都取自桥的 `GUI_SLOT_METHODS`（桥与渲染层之间的稳定契约，
 * 两者同源），不再在本模块另存一张 method → slot 表 —— 「本扩展登记过的落点」
 * 与「桥实际提供的落点」因此不可能对不上。
 * 枚举到 spec 表里没有的方法（桥升级加了新落点）照样列出，落点 id 暂以方法名代替并标注。
 */
export function buildGuiPoints(methods: string[]): { points: ExtPoint[]; unknown: string[] } {
	const available = new Set(methods);
	const registered = (Object.keys(GUI_SLOT_METHODS) as string[]).filter((method) => available.has(method));
	const unregistered = methods.filter((method) => GUI_SLOT_IDS[method] === undefined);
	const points = [...registered, ...unregistered].map((method) => {
		const slot = GUI_SLOT_IDS[method];
		const known = slot !== undefined;
		return {
			id: `gui:${slot ?? method}`,
			group: "gui" as const,
			label: `ctx.gui.${method}`,
			signature: `${method}(key, factory, opts?)${known ? `  →  落点 "${slot}"` : "  →  落点待登记"}`,
			status: "wired" as const,
			note: known ? (GUI_SLOT_META[slot]?.note ?? undefined) : "桥新增的落点，本扩展尚未登记说明；详见 docs/gui-extension-bridge.md",
		};
	});
	return { points, unknown: unregistered };
}

// ── 4. pi 原生扩展点在 PiDeck 里的处理方式（人工策展，唯一一处）─

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

// ── 5. 汇总 ─────────────────────────────────────────────────────

/**
 * 组装清单：GUI 落点来自运行时枚举，pi 原生点来自读一次 pi 的 `.d.ts`。
 *
 * @param gui 桥挂到 `ExtensionContext` 上的 `ctx.gui`（由入口在 mount 时传入）
 * @param guiSource 诊断用的来源描述（如 `桥 ctx.gui 运行时枚举（15 个落点）`）
 * @returns 读不到 `.d.ts` 时降级为只列桥的落点（typesPath 为 null），不抛错
 */
export function loadCatalog(gui: unknown, guiSource: string): Catalog {
	const guiMethods = enumerateGuiSlotMethods(gui);
	const { points: guiPoints, unknown } = buildGuiPoints(guiMethods);
	const typesPath = resolvePiTypesDts();
	if (!typesPath) {
		return { points: guiPoints, piVersion: null, typesPath: null, guiSource, guiUnknown: unknown };
	}
	try {
		const source = readFileSync(typesPath, "utf8");
		const uiPoints = parseUiPoints(source).map((point) => {
			const name = point.id.slice("ui:".length);
			const handling = UI_HANDLING[name];
			return { ...point, status: handling?.status ?? ("passthrough" as const), note: handling?.note };
		});
		return { points: [...uiPoints, ...parseEvents(source), ...guiPoints], piVersion: readPiVersion(typesPath), typesPath, guiSource, guiUnknown: unknown };
	} catch {
		return { points: guiPoints, piVersion: null, typesPath: null, guiSource, guiUnknown: unknown };
	}
}

/** 供测试直接调用（不经 pi 运行时）。 */
export const __test__ = { parseUiPoints, parseEvents, enumerateGuiSlotMethods, buildGuiPoints, loadCatalog, resolvePiTypesDts };
