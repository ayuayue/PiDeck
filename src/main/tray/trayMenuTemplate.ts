import type { MenuItemConstructorOptions } from "electron";
import type { MainProcessTranslationKey } from "../../shared/i18n/mainProcessCopy";

/** 托盘「最近项目」条目：只携带菜单需要的字段，避免耦合完整 Project 记录。 */
export interface TrayMenuProject {
	id: string;
	name: string;
	path: string;
}

/** 菜单项触发的动作集合（由 index.ts 装配真实副作用；纯函数只组装结构，便于单测）。 */
export interface TrayMenuCallbacks {
	showWindow: () => void;
	checkUpdate: () => void;
	openProject: (projectId: string) => void;
	openDataDir: () => void;
	openLogsDir: () => void;
	restart: () => void;
	quit: () => void;
	/** 悬浮球：显示/隐藏/退出。 */
	toggleFloatingBall?: (visible: boolean) => void;
	exitFloatingBall?: () => void;
	isFloatingBallActive?: () => boolean;
}

/** 最近项目在托盘菜单里的显示上限：项目多时取排序后前 N 个（与侧栏同序：置顶/最近打开优先）。 */
export const TRAY_RECENT_PROJECTS_LIMIT = 5;

/**
 * 项目 label：`名称 · 尾段路径`，帮助区分重名/嵌套目录。
 * 路径分隔符同时处理 Windows 与 POSIX（WSL 项目的 path 是 Linux 形态）。
 */
export function trayProjectLabel(project: TrayMenuProject): string {
	const segment = project.path.split(/[\\/]/).filter(Boolean).pop();
	if (!segment || segment === project.name) return project.name;
	return `${project.name} · ${segment}`;
}

/**
 * 构建托盘右键菜单模板（纯函数）。结构（对齐成熟软件惯例：版本/更新 → 窗口 → 最近项目 → 工具 → 退出）：
 * - 版本行 disabled，只读展示 app.getVersion()；
 * - 「检查更新」走 UpdateService.checkNow + 系统通知（副作用在 index.ts）；
 * - 最近项目最多 5 个，点击 = 聚焦主窗口并跳转项目；空列表显示占位 disabled 项；
 * - 数据/日志目录直开 userData 与 userData/logs（诊断高频入口，pideck-doctor 同款路径）。
 */
export function buildTrayMenuTemplate(copy: (key: MainProcessTranslationKey, params?: Record<string, string | number>) => string, version: string, projects: TrayMenuProject[], callbacks: TrayMenuCallbacks): MenuItemConstructorOptions[] {
	const recent = projects.slice(0, TRAY_RECENT_PROJECTS_LIMIT);
	const projectItems: MenuItemConstructorOptions[] =
		recent.length > 0
			? recent.map((project) => ({
					label: trayProjectLabel(project),
					click: () => callbacks.openProject(project.id),
				}))
			: [{ label: copy("tray.noProjects"), enabled: false }];

	return [
		// 版本行：只读展示（用户可核对版本 / 反馈时引用），点击无动作
		{ label: copy("tray.version", { version }), enabled: false },
		{ label: copy("tray.checkUpdate"), click: () => callbacks.checkUpdate() },
		{ type: "separator" },
		{
			label: copy("tray.showWindow"),
			click: () => callbacks.showWindow(),
		},
		// 悬浮球控制：显示/隐藏/退出（label 静态，点击时动态切换）
		...(callbacks.toggleFloatingBall
			? [
					{ type: "separator" as const },
					{
						label: copy("tray.floatingBall"),
						submenu: [
							{
								label: copy("tray.floatingBallToggle"),
								click: () => callbacks.toggleFloatingBall?.(!callbacks.isFloatingBallActive?.()),
							},
							{
								label: copy("tray.floatingBallExit"),
								click: () => callbacks.exitFloatingBall?.(),
								enabled: callbacks.isFloatingBallActive?.() ?? false,
							},
						],
					},
				]
			: []),
		{ type: "separator" },
		...projectItems,
		{ type: "separator" },
		{ label: copy("tray.openDataDir"), click: () => callbacks.openDataDir() },
		{ label: copy("tray.openLogsDir"), click: () => callbacks.openLogsDir() },
		{ type: "separator" },
		{
			// 托盘重启与系统设置 IPC 的 appRestart 保持同一套清理语义
			label: copy("tray.restart"),
			click: () => callbacks.restart(),
		},
		{
			label: copy("tray.quit"),
			click: () => callbacks.quit(),
		},
	];
}
