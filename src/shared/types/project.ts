export type Project = {
	id: string;
	name: string;
	path: string;
	lastOpenedAt: number;
	pinned?: boolean;
	sortOrder?: number;
	kind?: "chat";
	/** 是否启用 git worktree 工作区模式，开启后侧栏显示分支子项 */
	worktreeEnabled?: boolean;
	/** 如果是 worktree 子项目，指向父项目的 id */
	worktreeParentId?: string;
	/** 项目所属环境：windows 或 wsl。缺省视为 windows（兼容旧数据）。 */
	environment?: "windows" | "wsl";
	/**
	 * 项目目录在磁盘上不存在（被删除/移动/未挂载）。列表保留记录并标记，
	 * 由用户决定手动移除或恢复目录——不自动删除：网络盘/WSL/移动盘短暂
	 * 不可达时自动移除会误删项目关联（2026-08 用户反馈「目录删了项目列表
	 * 还有残留」）。
	 */
	missing?: boolean;
};

/**
 * 渲染层读取项目文件时携带的最小授权上下文。
 * 主进程只信任 projectId，并从 ProjectStore 重新取得根目录；不接受渲染层直接声明可信根路径。
 */
export type ProjectFileAccessScope = {
	projectId: string;
};

export const SUPPORTED_EXTERNAL_EDITORS = [
	{ id: "vscode", name: "Visual Studio Code" },
	{ id: "cursor", name: "Cursor" },
	{ id: "zed", name: "Zed" },
	{ id: "idea", name: "IntelliJ IDEA" },
	{ id: "webstorm", name: "WebStorm" },
	{ id: "phpstorm", name: "PhpStorm" },
	{ id: "pycharm", name: "PyCharm" },
] as const;

export type ExternalEditorId = typeof SUPPORTED_EXTERNAL_EDITORS[number]["id"];

export type ExternalEditorDetectedFrom = "path" | "common-path" | "manual";

export type ExternalEditorSetting = {
	enabled: boolean;
	command: string;
	detectedFrom?: ExternalEditorDetectedFrom;
	updatedAt?: number;
};

export type ExternalEditorSettings = Record<ExternalEditorId, ExternalEditorSetting>;

export function createDefaultExternalEditorSettings(): ExternalEditorSettings {
	return Object.fromEntries(
		SUPPORTED_EXTERNAL_EDITORS.map((editor) => [
			editor.id,
			{ enabled: false, command: "" },
		]),
	) as ExternalEditorSettings;
}

export type ExternalEditor = {
	id: ExternalEditorId;
	name: string;
	command: string;
	args?: string[];
	detectedFrom: ExternalEditorDetectedFrom;
};

/**
 * 平台可用的文件管理器（「打开方式」下拉的补充入口）。
 * id 供渲染层选择 logo 与本地化名称；command 为启动命令；
 * name 为 Linux 文件管理器本名（Dolphin/Files/Thunar 等专名不翻译）。
 */
export type FileManagerInfo = {
	id:
		| "windows-explorer"
		| "finder"
		| "nautilus"
		| "dolphin"
		| "nemo"
		| "thunar"
		| "pcmanfm"
		| "konqueror";
	name: string;
	command: string;
	/** 系统图标 data URL（Windows 取 explorer.exe 真实图标；其余平台缺省走内联 SVG） */
	iconDataUrl?: string;
};
