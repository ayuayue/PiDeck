import type { SettingsTabId } from "../../../atoms";

/**
 * 设置页侧栏展示布局：tab 顺序 + 分组分割线位置。
 * 只影响视觉呈现，不改变 SettingsTabId 本身——深链（settingsFocusAtom）、
 * localStorage 记忆位置、脏标记黄点都仍按 tab id 工作。
 *
 * 14 个 tab 平铺不易扫读，按「基础 → 扩展集成 → 开发者工具 → 开发与维护」四个簇
 * 重排并在簇边界渲染一条分割线：
 * - 基础：常用 / 外观 / 代理（打开应用必看的全局项）
 * - 扩展集成：飞书机器人 / 桌面宠物 / 视觉桥 / 生图（外部能力与增值功能）
 * - 开发者工具：局域网 Web 服务 / 外部编辑器 / Git
 * - 开发与维护：开发设置 / 用量统计 / 进程监控 / 缓存与日志
 *
 * 局域网 Web 服务、外部编辑器与 Git 设置原为其它 tab 内的区块，因用户频繁使用
 * 单独抽为 tab，集中为「开发者工具」；缓存与日志放在开发设置同一组，便于低频维护项集中。
 */
export type SettingsTabLayoutEntry = {
	id: SettingsTabId;
	/** 渲染此 tab 前是否先插入分组分割线；纯视觉标记，首项必须缺省 */
	dividerBefore?: boolean;
};

export const SETTINGS_TAB_LAYOUT: readonly SettingsTabLayoutEntry[] = [
	{ id: "common" },
	{ id: "appearance" },
	{ id: "proxy" },
	{ id: "im", dividerBefore: true },
	{ id: "pet" },
	{ id: "sound" },
	{ id: "vision" },
	{ id: "imagegen" },
	{ id: "web", dividerBefore: true },
	{ id: "editors" },
	{ id: "git" },
	{ id: "dev", dividerBefore: true },
	{ id: "usage" },
	{ id: "process" },
	{ id: "storage" },
];

/** 全部合法 tab id（顺序即展示顺序）：校验 localStorage 记忆值、防止旧版本残留值导致无高亮。 */
export const SETTINGS_TAB_IDS: readonly SettingsTabId[] = SETTINGS_TAB_LAYOUT.map(
	(entry) => entry.id,
);
