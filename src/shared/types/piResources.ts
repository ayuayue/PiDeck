/**
 * pi 原生资源配置契约（计划 A1/A2）。
 * 只描述文件形状与请求/结果类型，不复刻 pi 的加载逻辑；纯类型 + 若干常量，
 * 供主进程 IPC 与渲染层共用（渲染层不 import 主进程实现）。
 */

/** 配置作用域：全局 agentDir/settings.json 或项目 `.pi/settings.json`。 */
export type PiResourceScope = { scope: "global" } | { scope: "project"; projectId: string };

/** pi 支持过滤的资源类别（settings.json 的四个数组）。 */
export type PiResourceKind = "extensions" | "skills" | "prompts" | "themes";

export const PI_RESOURCE_KINDS: readonly PiResourceKind[] = ["extensions", "skills", "prompts", "themes"];

/** pi 原生内置扩展标识（settings.json 的 `builtin:<name>`）。 */
export const PI_BUILTIN_EXTENSIONS = ["mcp", "llama.cpp", "codemode", "tool-search"] as const;
export type PiBuiltinExtension = (typeof PI_BUILTIN_EXTENSIONS)[number];

export function builtinSpecifier(name: PiBuiltinExtension): string {
	return `builtin:${name}`;
}

/** 项目层能不能覆盖全局层（用于 UI 展示三态）。 */
export type PiResourceOverrideState = "inherit" | "explicit-enabled" | "explicit-disabled";

/** 单条资源的有效状态（列表展示用）。 */
export type PiResourceEffectiveState = "enabled" | "disabled" | "unavailable";

/** pi 原生内置扩展在当前作用域的开关状态。 */
export type PiBuiltinExtensionState = {
	name: PiBuiltinExtension;
	/** 扩展是否允许 Pi 加载；不是 codemode/tool-search 工具是否选入 defaultTools。 */
	enabled: boolean;
	/** codemode/tool-search 在当前 defaultTools 解析结果中的选择状态。 */
	toolEnabled?: boolean;
	/** 本层是否有显式条目（false = 沿用下层/默认）。 */
	explicitInLayer: boolean;
	/** 生效来源：本层显式 / 继承。 */
	state: PiResourceOverrideState;
};

/** 切换一个原生内置扩展开关。 */
export type PiBuiltinToggleRequest = {
	scope: PiResourceScope;
	name: PiBuiltinExtension;
	enabled: boolean;
};

export type PiResourceToggleResult = {
	ok: boolean;
	error?: string;
	/** 写入后的文件 revision（渲染层可据此判断是否需要刷新）。 */
	revision?: string;
};

/**
 * 单个原生文件/目录资源（独立扩展、技能、提示词）的过滤开关请求。
 * `matchValue` 是 pi 过滤匹配用的值（绝对路径或包内相对路径），由主进程从
 * 已解析资源列表里取得，不接受渲染层任意路径。
 */
export type PiFileResourceToggleRequest = {
	scope: PiResourceScope;
	kind: Exclude<PiResourceKind, "themes">;
	resourceId: string;
	enabled: boolean;
};

/** 包整体启停请求：四类资源过滤一起关闭/恢复。 */
export type PiPackageToggleRequest = {
	scope: PiResourceScope;
	resourceId: string;
	enabled: boolean;
};

/** 项目覆盖继承资源的三态设置。 */
export type PiResourceOverrideRequest = {
	scope: { scope: "project"; projectId: string };
	kind: PiResourceKind;
	/** 继承资源的原生匹配值（绝对路径或 builtin:<name>）。 */
	matchValue: string;
	state: PiResourceOverrideState;
};

/** 某个作用域下 pi 原生配置的可读摘要（UI 首屏）。 */
export type PiResourceConfigSummary = {
	/** 写入目标文件路径。 */
	settingsPath: string;
	/** 文件是否存在。 */
	exists: boolean;
	/** JSON 损坏时的诊断；此时禁止可视化写入。 */
	error?: string;
	/** 当前 revision（内容哈希），用于并发冲突检测。 */
	revision: string;
	builtins: PiBuiltinExtensionState[];
	/** 四类资源数组的原文条目（含用户 glob/显式路径，只读展示）。 */
	entries: Record<PiResourceKind, string[]>;
};
