import type { PiConfigTarget } from "../../../../shared/piConfig";
import type { PiConfigTargetHost } from "../piConfigTargetModel";
import type { ConfigTab, ModelItem, ModelsFile } from "../configTypes";

/**
 * 配置弹窗的本地持久化与入参归一化：上次停留位置（tab/环境/后端分页）、主机清单等价判断、
 * 以及读盘内容的结构归一化。都是纯函数，与 React 无关，从 ConfigModal 搬出只为让外壳专注渲染。
 */

// ── 配置弹窗左侧导航 = shadcn Vertical Tabs ──
// config 组子页（模型/认证/设置/信任/MCP/原始文件）用 "config:<tab>" 复合值，
// 其余组直接以 section 名作 value；Tabs 受控 value 由此编码，业务仍走 section/tab 双 state，
// loadConfig 等既有依赖零改动。
export type ConfigSection = "config" | "security" | "skills" | "prompts" | "extensions" | "mcp";

// 注意：修改 ConfigSection/ConfigTab 枚举时需同步更新 CONFIG_SECTIONS/CONFIG_TABS 校验数组

/** section+tab → Tabs value（config 组子页编码为 "config:<tab>"）。 */
export function sectionTabValue(section: ConfigSection, tab: ConfigTab): string {
	return section === "config" ? `config:${tab}` : section;
}

/** localStorage 键：Pi 管理页上次打开的 tab（重开弹窗时恢复位置，跨应用重启保留）。 */
const CONFIG_LAST_TAB_KEY = "pideck-config-last-tab";

/** localStorage 键：Pi 环境上次选择（重开弹窗时恢复：用户选过的机器不该每次被打回本机）。 */
const CONFIG_LAST_TARGET_KEY = "pideck-config-last-target";

/** localStorage 键：配置管理顶层后端分页（Pi/DSH）上次选择（重开弹窗时恢复）。 */
const CONFIG_BACKEND_PANE_KEY = "pideck-config-backend-pane";

/**
 * 主机清单结构等价：分区重新可见时会重读一次清单，但「内容没变」不应换来一个新数组身份
 * （状态条按 hosts 变化自动确保连接，身份一变就会重发连接/重弹密码框）。
 */
export function sameConfigTargetHosts(left: readonly PiConfigTargetHost[], right: readonly PiConfigTargetHost[]): boolean {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index += 1) {
		const before = left[index];
		const after = right[index];
		if (before.kind !== after.kind) return false;
		if (before.kind === "ssh" && (after.kind !== "ssh" || before.id !== after.id || before.label !== after.label || before.sshHost !== after.sshHost)) return false;
		if (before.kind === "wsl" && (after.kind !== "wsl" || before.label !== after.label || before.distro !== after.distro || before.user !== after.user)) return false;
	}
	return true;
}

/** 读取上次选定的 Pi 环境；值失效/损坏一律回本机（host 是否仍存在由主机清单回来后判定）。 */
export function loadLastConfigTarget(): PiConfigTarget {
	try {
		const parsed: unknown = JSON.parse(localStorage.getItem(CONFIG_LAST_TARGET_KEY) ?? "null");
		if (typeof parsed !== "object" || parsed === null) return { kind: "local" };
		const record = parsed as { kind?: unknown; hostId?: unknown };
		// 旧值里 WSL 目标带 hostId（档案已退役）：一律归一到“那一个 WSL 环境”。
		if (record.kind === "wsl") return { kind: "wsl" };
		if (record.kind === "ssh" && typeof record.hostId === "string" && record.hostId.length > 0) return { kind: "ssh", hostId: record.hostId };
		return { kind: "local" };
	} catch {
		return { kind: "local" };
	}
}

/** 记住本次选择的 Pi 环境；localStorage 不可用（隐私模式）时只影响下次打开，不影响当前页。 */
export function rememberConfigTarget(target: PiConfigTarget): void {
	try {
		localStorage.setItem(CONFIG_LAST_TARGET_KEY, JSON.stringify(target));
	} catch {
		/* 静默失败：记忆位置是锦上添花，不能影响切换本身 */
	}
}

/** 读取上次选定的配置管理后端分页；无记录/值失效时回退 Pi（默认后端，Pi 标签在左）。 */
export function loadLastConfigBackendPane(): "dsh" | "pi" {
	try {
		return localStorage.getItem(CONFIG_BACKEND_PANE_KEY) === "dsh" ? "dsh" : "pi";
	} catch {
		return "pi";
	}
}

/** 记住本次选定的后端分页。 */
export function rememberConfigBackendPane(pane: "dsh" | "pi"): void {
	try {
		localStorage.setItem(CONFIG_BACKEND_PANE_KEY, pane);
	} catch {
		/* localStorage 不可用（隐私模式等）时静默失败，仅本次会话内不记忆 */
	}
}

/** 记住本次停留的 tab（Tabs value 原始编码，切回时直接还原）。 */
export function rememberConfigTab(value: string): void {
	try {
		localStorage.setItem(CONFIG_LAST_TAB_KEY, value);
	} catch {
		/* localStorage 不可用（隐私模式等）时静默失败，仅本次会话内不记忆 */
	}
}

/** 全部合法 section / config 组子 tab，用于校验持久化值（避免版本更新后残留旧值导致无高亮）。 */
const CONFIG_SECTIONS: readonly ConfigSection[] = ["config", "security", "skills", "prompts", "extensions", "mcp"];
const CONFIG_TABS: readonly ConfigTab[] = ["models", "auth", "oauth", "settings", "trust", "mcp", "raw"];

/**
 * 读取上次打开的 tab；localStorage 不可用、无记录或值已失效时返回 null（由调用方回退默认值）。
 * Radix Dialog 关闭会卸载内容，state 在每次打开时重建，因此需要从外部存储恢复。
 */
export function loadLastConfigTab(): { section: ConfigSection; tab?: ConfigTab } | null {
	try {
		const raw = localStorage.getItem(CONFIG_LAST_TAB_KEY);
		if (!raw) return null;
		const parsed = parseSectionTabValue(raw);
		if (!CONFIG_SECTIONS.includes(parsed.section)) return null;
		if (parsed.section === "config" && (!parsed.tab || !CONFIG_TABS.includes(parsed.tab))) return null;
		return parsed;
	} catch {
		return null;
	}
}

/** Tabs value → section/tab；非 config 组无子 tab。 */
export function parseSectionTabValue(value: string): {
	section: ConfigSection;
	tab?: ConfigTab;
} {
	const idx = value.indexOf(":");
	if (idx > 0) {
		return {
			section: value.slice(0, idx) as ConfigSection,
			tab: value.slice(idx + 1) as ConfigTab,
		};
	}
	return { section: value as ConfigSection };
}

/** 读取原文后解析成对象；损坏的文件回退空对象（诊断卡负责说明），不让一次 parse 失败挡住整页。 */
export function parseJsonObject<T extends Record<string, unknown>>(raw: string, fallback: T): T {
	try {
		const parsed: unknown = JSON.parse(raw);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as T) : fallback;
	} catch {
		return fallback;
	}
}

/**
 * 配置页必须能打开用户手写/旧版本生成的非标准 models.json。
 * pi 自身对配置较宽松，但 UI 会访问 provider.models.length / map；这里先把缺失或异常字段归一化，
 * 避免单个 provider 配置错误导致整个 renderer 白屏。
 */
export function normalizeModelsFile(value: unknown): ModelsFile {
	const rawProviders = value && typeof value === "object" && !Array.isArray(value) ? (value as { providers?: unknown }).providers : undefined;
	const providers: ModelsFile["providers"] = {};
	if (!rawProviders || typeof rawProviders !== "object" || Array.isArray(rawProviders)) {
		return { providers };
	}
	for (const [name, rawProvider] of Object.entries(rawProviders)) {
		const provider = rawProvider && typeof rawProvider === "object" && !Array.isArray(rawProvider) ? (rawProvider as Record<string, unknown>) : {};
		const rawModels = provider.models;
		providers[name] = {
			...provider,
			models: Array.isArray(rawModels) ? rawModels.filter((model): model is ModelItem | string => Boolean(model) && ((typeof model === "object" && !Array.isArray(model)) || typeof model === "string")).map((model) => (typeof model === "string" ? { id: model } : model)) : [],
		};
	}
	return { providers };
}
