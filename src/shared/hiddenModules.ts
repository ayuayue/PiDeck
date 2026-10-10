/**
 * 「隐藏功能模块」（设置 → 外观 → 功能模块）：用户按需收起不用的模块 UI 入口。
 *
 * 只隐藏入口，不清配置、不停后台功能：飞书 Bridge 已连接就继续跑，DSH 会话照常运行；
 * 用户要停用应先去对应页面关掉再隐藏。默认 `[]` = 全部显示，旧 settings.json 缺字段零迁移。
 *
 * 为什么存 id 数组而不是 N 个布尔：模块清单会随功能增减，数组只需在
 * HIDEABLE_MODULE_IDS 加一项即可扩展，不用每次改 AppSettings 类型和 SettingsStore。
 * 存储层只做去重去空、不按清单过滤——未知 id 原样保留（可能来自更新的版本），
 * 读取方按需判断成员关系即可，不会因未知值报错。
 */

/**
 * 可隐藏的设置页 tab（与 renderer 的 SettingsTabId 同名）。
 * 顺序即外观设置里开关的排列顺序，与侧栏分组顺序一致（扩展集成 → 开发者工具 → 开发与维护）。
 * 常用 / 快捷键 / 通知 / 外观 / 代理 / 外部编辑器 / 开发设置 / 缓存 / 备份 是应用基础项，不提供隐藏。
 */
export const HIDEABLE_SETTINGS_TAB_IDS = ["im", "pet", "vision", "imagegen", "acp", "hostplugins", "web", "git", "usage", "process"] as const;

/**
 * 全部可隐藏模块：设置 tab + `dsh`（DSH 后端不是设置 tab，它对应配置管理的 DSH 分页
 * 与新建会话的 DSH 后端选项）+ `composerModes`（输入框底栏的模式选择器）。
 */
export const HIDEABLE_MODULE_IDS = [...HIDEABLE_SETTINGS_TAB_IDS, "composerModes", "dsh"] as const;

export type HideableSettingsTabId = (typeof HIDEABLE_SETTINGS_TAB_IDS)[number];
export type HideableModuleId = (typeof HIDEABLE_MODULE_IDS)[number];

/** 上限：清单本身只有个位数条目，留余量容纳未知 id，同时挡住脏数据把 settings.json 塞爆。 */
export const MAX_HIDDEN_MODULES = 64;

/**
 * 设置边界的清洗：只收非空字符串、去重、截断；非数组回落空数组。
 * 主进程 load()/update() 与渲染层写入共用同一份规则，避免「界面允许但落盘被截掉」。
 */
export function normalizeHiddenModules(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const ids = new Set<string>();
	for (const candidate of value) {
		if (typeof candidate !== "string") continue;
		const id = candidate.trim();
		if (!id) continue;
		ids.add(id);
		if (ids.size >= MAX_HIDDEN_MODULES) break;
	}
	return [...ids];
}

/** 某模块当前是否被用户隐藏。 */
export function isModuleHidden(hiddenModules: readonly string[], moduleId: HideableModuleId): boolean {
	return hiddenModules.includes(moduleId);
}

/** 切换某模块的隐藏状态，返回新数组（不改入参）；用于外观设置开关的 onChange。 */
export function toggleHiddenModule(hiddenModules: readonly string[], moduleId: HideableModuleId, hidden: boolean): string[] {
	const without = hiddenModules.filter((id) => id !== moduleId);
	return hidden ? [...without, moduleId] : without;
}
