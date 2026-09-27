import type { SettingsTabId } from "../../../atoms";
import type { TranslationKey } from "../../../i18n";

/**
 * 设置页侧栏展示布局：tab 顺序 + 分组分割线位置。
 * 只影响视觉呈现，不改变 SettingsTabId 本身——深链（settingsFocusAtom）、
 * localStorage 记忆位置、脏标记黄点都仍按 tab id 工作。
 *
 * 14 个 tab 平铺不易扫读，按「基础 → 扩展集成 → 开发者工具 → 开发与维护」四个簇
 * 重排并在簇边界渲染一条分割线：
 * - 基础：常用 / 快捷键 / 通知 / 外观 / 代理（打开应用必看的全局项）
 * - 扩展集成：飞书机器人 / 桌面宠物 / 视觉桥 / 生图（外部能力与增值功能）
 * - 开发者工具：局域网 Web 服务 / 外部编辑器 / Git
 * - 开发与维护：开发设置 / 用量统计 / 进程监控 / 缓存与日志 / 配置备份
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
	{ id: "shortcuts" },
	{ id: "notification" },
	{ id: "appearance" },
	{ id: "proxy" },
	{ id: "connections" },
	{ id: "im", dividerBefore: true },
	{ id: "pet" },
	{ id: "vision" },
	{ id: "imagegen" },
	{ id: "web", dividerBefore: true },
	{ id: "editors" },
	{ id: "git" },
	{ id: "dev", dividerBefore: true },
	{ id: "usage" },
	{ id: "process" },
	{ id: "storage" },
	{ id: "backup" },
];

/** 全部合法 tab id（顺序即展示顺序）：校验 localStorage 记忆值、防止旧版本残留值导致无高亮。 */
export const SETTINGS_TAB_IDS: readonly SettingsTabId[] = SETTINGS_TAB_LAYOUT.map((entry) => entry.id);

/**
 * 各 tab 的标题 i18n key。
 *
 * 与 SETTINGS_TAB_LAYOUT 放在同一份文件是刻意的：命令面板（Ctrl+P 搜设置项）
 * 与设置页侧栏必须展示同一套标题，两处各维护一份字符串迟早漂移成
 * 「命令面板搜到的名字和侧栏对不上」。SettingsModal 的 TAB_META 只保留图标，
 * 标题一律从这里取。
 */
export const SETTINGS_TAB_LABEL_KEYS: Record<SettingsTabId, TranslationKey> = {
	common: "settings.tabs.common",
	shortcuts: "settings.tabs.shortcuts",
	appearance: "settings.tabs.appearance",
	proxy: "settings.tabs.proxy",
	connections: "settings.tabs.connections",
	web: "settings.tabs.web",
	editors: "settings.tabs.editors",
	git: "settings.tabs.git",
	dev: "settings.tabs.dev",
	im: "settings.tabs.im",
	pet: "settings.tabs.pet",
	notification: "settings.tabs.notification",
	storage: "settings.tabs.storage",
	backup: "settings.tabs.backup",
	usage: "settings.tabs.usage",
	process: "settings.tabs.process",
	vision: "settings.tabs.vision",
	imagegen: "settings.tabs.imagegen",
};

/**
 * 各 tab 的搜索别名（中英同义、用户常用俗称），供命令面板模糊匹配命中。
 * 例如用户搜「代理」要能出「代理」tab，搜 "mcp"/"模型" 要能出配置管理对应页。
 */
export const SETTINGS_TAB_KEYWORDS: Record<SettingsTabId, readonly string[]> = {
	common: ["常用", "基础", "通用", "general", "基本设置"],
	shortcuts: ["快捷键", "按键", "热键", "keybind", "hotkey", "shortcut"],
	appearance: ["外观", "主题", "深色", "浅色", "字体", "theme", "appearance", "dark"],
	proxy: ["代理", "网络", "proxy", "http proxy", "网络代理"],
	connections: ["连接", "远程", "ssh", "远程连接", "主机", "connections", "remote", "host", "wsl"],
	web: ["局域网", "web 服务", "远程", "手机访问", "lan", "webserver"],
	editors: ["外部编辑器", "vscode", "编辑器", "editor", "ide"],
	git: ["git", "版本控制", "提交", "commit", "分支", "branch"],
	dev: ["开发者", "调试", "dev", "developer", "debug"],
	im: ["飞书", "机器人", "im", "feishu", "lark", "消息"],
	pet: ["桌面宠物", "宠物", "pet", "桌宠"],
	notification: ["通知", "提醒", "消息提示", "notification", "toast"],
	storage: ["缓存", "日志", "存储", "清理", "cache", "log", "storage"],
	backup: ["备份", "恢复", "配置备份", "backup", "restore", "导入导出"],
	usage: ["用量", "统计", "token", "花费", "usage", "statistics"],
	process: ["进程", "监控", "内存", "process", "monitor"],
	vision: ["视觉", "图片识别", "视觉桥", "vision", "multimodal"],
	imagegen: ["生图", "画图", "图片生成", "imagegen", "image"],
};
