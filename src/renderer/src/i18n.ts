import type { AppLanguageMode } from "../../shared/types";

export type SupportedLocale = "zh-CN" | "en-US";

type TranslationKey =
	| "app.chatProject"
	| "app.createAgent"
	| "app.files"
	| "app.model"
	| "app.newSession"
	| "app.restart"
	| "app.restarting"
	| "app.search"
	| "app.selectProject"
	| "app.startAgent"
	| "app.terminal"
	| "app.think"
	| "app.cycleModel"
	| "app.compact"
	| "app.compacting"
	| "common.cancel"
	| "common.collapse"
	| "common.copy"
	| "common.details"
	| "common.expand"
	| "code.copy"
	| "config.title"
	| "config.nav.config"
	| "config.nav.models"
	| "config.nav.auth"
	| "config.nav.settings"
	| "config.nav.raw"
	| "config.nav.extensions"
	| "config.nav.skills"
	| "terminal.closeAll"
	| "terminal.closeAllConfirm"
	| "terminal.closeAllDescription"
	| "terminal.closeCurrent"
	| "terminal.collapse"
	| "terminal.copied"
	| "terminal.exited"
	| "terminal.expand"
	| "terminal.new"
	| "terminal.starting"
	| "terminal.theme"
	| "thinking.title"
	| "tool.copyDetail"
	| "tool.countSuffix"
	| "tool.done"
	| "tool.error"
	| "tool.failedSuffix"
	| "tool.running"
	| "tool.statusDone"
	| "tool.statusError"
	| "tool.statusRunning"
	| "settings.title"
	| "settings.tabs.base"
	| "settings.tabs.baseDesc"
	| "settings.tabs.proxy"
	| "settings.tabs.proxyDesc"
	| "settings.tabs.web"
	| "settings.tabs.webDesc"
	| "settings.tabs.dev"
	| "settings.tabs.devDesc"
	| "settings.interface"
	| "settings.theme"
	| "settings.themeSystem"
	| "settings.themeLight"
	| "settings.themeDark"
	| "settings.language"
	| "settings.languageSystem"
	| "settings.languageZh"
	| "settings.languageEn";

const dictionaries: Record<SupportedLocale, Record<TranslationKey, string>> = {
	"zh-CN": {
		"app.chatProject": "聊天",
		"app.createAgent": "创建 Agent",
		"app.files": "文件",
		"app.model": "模型",
		"app.newSession": "新会话",
		"app.restart": "重启",
		"app.restarting": "重启中…",
		"app.search": "搜索",
		"app.selectProject": "选择项目并创建 Agent",
		"app.startAgent": "开始一个 pi agent",
		"app.terminal": "终端",
		"app.think": "思考",
		"app.cycleModel": "切换模型",
		"app.compact": "压缩",
		"app.compacting": "压缩中...",
		"common.cancel": "取消",
		"common.collapse": "收起",
		"common.copy": "复制",
		"common.details": "详情",
		"common.expand": "展开",
		"code.copy": "复制代码",
		"config.title": "Pi 管理",
		"config.nav.config": "配置管理",
		"config.nav.models": "模型",
		"config.nav.auth": "认证",
		"config.nav.settings": "设置",
		"config.nav.raw": "源文件",
		"config.nav.extensions": "扩展",
		"config.nav.skills": "技能",
		"terminal.closeAll": "关闭全部",
		"terminal.closeAllConfirm": "关闭全部终端？",
		"terminal.closeAllDescription": "正在运行的命令会被终止，此操作不能撤销。",
		"terminal.closeCurrent": "关闭当前终端",
		"terminal.collapse": "收起终端",
		"terminal.copied": "已复制",
		"terminal.exited": "已退出",
		"terminal.expand": "展开终端",
		"terminal.new": "新建终端",
		"terminal.starting": "正在启动终端…",
		"terminal.theme": "切换终端主题",
		"thinking.title": "思考过程",
		"tool.copyDetail": "复制完整工具调用详情",
		"tool.countSuffix": " 个工具",
		"tool.done": "工具调用完成",
		"tool.error": "工具调用有错误",
		"tool.failedSuffix": " 个失败",
		"tool.running": "工具调用中",
		"tool.statusDone": "完成",
		"tool.statusError": "失败",
		"tool.statusRunning": "运行中",
		"settings.title": "设置",
		"settings.tabs.base": "基础设置",
		"settings.tabs.baseDesc": "界面、输入和会话行为",
		"settings.tabs.proxy": "代理设置",
		"settings.tabs.proxyDesc": "agent 与桌面端网络",
		"settings.tabs.web": "Web 服务",
		"settings.tabs.webDesc": "局域网访问入口",
		"settings.tabs.dev": "开发设置",
		"settings.tabs.devDesc": "环境、版本和调试",
		"settings.interface": "界面",
		"settings.theme": "主题",
		"settings.themeSystem": "跟随系统",
		"settings.themeLight": "浅色",
		"settings.themeDark": "暗色",
		"settings.language": "语言",
		"settings.languageSystem": "跟随系统",
		"settings.languageZh": "简体中文",
		"settings.languageEn": "English",
	},
	"en-US": {
		"app.chatProject": "Chat",
		"app.createAgent": "Create Agent",
		"app.files": "Files",
		"app.model": "Model",
		"app.newSession": "New Session",
		"app.restart": "Restart",
		"app.restarting": "Restarting...",
		"app.search": "Search",
		"app.selectProject": "Select a project and create an agent",
		"app.startAgent": "Start a pi agent",
		"app.terminal": "Terminal",
		"app.think": "Think",
		"app.cycleModel": "Cycle Model",
		"app.compact": "Compact",
		"app.compacting": "Compacting...",
		"common.cancel": "Cancel",
		"common.collapse": "Collapse",
		"common.copy": "Copy",
		"common.details": "Details",
		"common.expand": "Expand",
		"code.copy": "Copy Code",
		"config.title": "Pi Management",
		"config.nav.config": "Configuration",
		"config.nav.models": "Models",
		"config.nav.auth": "Auth",
		"config.nav.settings": "Settings",
		"config.nav.raw": "Raw Files",
		"config.nav.extensions": "Extensions",
		"config.nav.skills": "Skills",
		"terminal.closeAll": "Close All",
		"terminal.closeAllConfirm": "Close all terminals?",
		"terminal.closeAllDescription": "Running commands will be terminated. This cannot be undone.",
		"terminal.closeCurrent": "Close current terminal",
		"terminal.collapse": "Collapse terminal",
		"terminal.copied": "Copied",
		"terminal.exited": "exited",
		"terminal.expand": "Expand terminal",
		"terminal.new": "New Terminal",
		"terminal.starting": "Starting terminal...",
		"terminal.theme": "Change terminal theme",
		"thinking.title": "Thinking",
		"tool.copyDetail": "Copy full tool call details",
		"tool.countSuffix": " tools",
		"tool.done": "Tool calls complete",
		"tool.error": "Tool calls have errors",
		"tool.failedSuffix": " failed",
		"tool.running": "Running tools",
		"tool.statusDone": "Done",
		"tool.statusError": "Failed",
		"tool.statusRunning": "Running",
		"settings.title": "Settings",
		"settings.tabs.base": "General",
		"settings.tabs.baseDesc": "Interface, input, and session behavior",
		"settings.tabs.proxy": "Proxy",
		"settings.tabs.proxyDesc": "Agent and desktop networking",
		"settings.tabs.web": "Web Service",
		"settings.tabs.webDesc": "LAN access entry",
		"settings.tabs.dev": "Developer",
		"settings.tabs.devDesc": "Environment, version, and debugging",
		"settings.interface": "Interface",
		"settings.theme": "Theme",
		"settings.themeSystem": "System",
		"settings.themeLight": "Light",
		"settings.themeDark": "Dark",
		"settings.language": "Language",
		"settings.languageSystem": "System",
		"settings.languageZh": "简体中文",
		"settings.languageEn": "English",
	},
};

let currentLocale: SupportedLocale = resolveLocale("system");

export function resolveLocale(
	mode: AppLanguageMode,
	systemLanguage = navigator.language,
): SupportedLocale {
	if (mode === "zh-CN" || mode === "en-US") return mode;
	return systemLanguage.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}

export function setI18nLocale(locale: SupportedLocale) {
	currentLocale = locale;
}

export function t(key: TranslationKey) {
	return dictionaries[currentLocale][key] ?? dictionaries["en-US"][key] ?? key;
}
