/**
 * 遥测快照组装：把「平台环境 / 界面偏好 / 使用规模 / 功能采用度」聚合成每日心跳附带的匿名属性。
 * 纯函数、无 IO——所有运行时事实由装配层（main/index.ts）注入，便于单测。
 * 隐私红线：只收集版本、平台环境、功能开关状态与数量统计；
 * 不碰项目路径、项目名、文件名、会话内容、prompt、模型供应商与凭据。
 */
import type { AppSettings } from "../../shared/types";

export type TelemetrySnapshotDeps = {
	settings: AppSettings;
	/** 会话目录条目总数（SessionCatalog.listEntries().length） */
	sessionsTotal: number;
	/** 项目总数（ProjectStore.list().length） */
	projectsTotal: number;
	/** 当前活跃的 pi agent 进程数（AgentManager.list().length） */
	agentsActive: number;
	/** 已配置的飞书 Bot 数（>0 即视为飞书功能采用） */
	feishuBotsTotal: number;
	/** 定时任务总数（AutomationStore.listTasks().length） */
	automationTasksTotal: number;
	/** 系统 locale（app.getLocale()） */
	systemLocale: string;
	/** 是否 portable 绿色版运行（PORTABLE_EXECUTABLE_DIR 存在） */
	portable: boolean;
	/** 主进程启动至今毫秒数（心跳在 app ready 后立即发出，即本次启动耗时） */
	uptimeMs: number;
	/** OS 版本号（os.release()，如 Windows 11 的 10.0.22631） */
	osRelease: string;
};

/** 心跳属性的合法值类型（PostHog event properties 与 person $set 共用同一快照）。 */
export type TelemetrySnapshotValue = string | number | boolean | string[];
export type TelemetrySnapshot = Record<string, TelemetrySnapshotValue>;

export function collectTelemetrySnapshot(deps: TelemetrySnapshotDeps): TelemetrySnapshot {
	const { settings } = deps;
	const hiddenModules = settings.hiddenModules ?? [];
	return {
		// 平台兼容性：决定旧 OS 支持窗口（遥测承诺的用途之一）
		os_version: deps.osRelease,
		os_locale: deps.systemLocale,
		install_mode: deps.portable ? "portable" : "installed",
		// 界面偏好：i18n 与主题资源投入依据
		language: settings.language,
		theme: settings.theme,
		theme_skin: settings.themeSkin,
		// 启动性能回归监控
		startup_ms: Math.max(0, Math.round(deps.uptimeMs)),
		// 使用规模：把 DAU 拆出「打开看看」与「重度在用」两层
		sessions_total: deps.sessionsTotal,
		projects_total: deps.projectsTotal,
		agents_active: deps.agentsActive,
		automation_tasks_total: deps.automationTasksTotal,
		feishu_bots_total: deps.feishuBotsTotal,
		// 功能采用度：开关状态 + 隐藏模块清单，回答「下个版本投入哪个功能」
		feature_pet: settings.petEnabled,
		feature_floating_ball: settings.floatingBallEnabled,
		feature_web_service: settings.webServiceEnabled,
		feature_cua: settings.cuaEnabled,
		feature_standby: settings.standbyRuntimeEnabled ?? true,
		feature_wsl: settings.wslEnabled,
		feature_desktop_proxy: settings.desktopProxyEnabled,
		feature_pi_proxy: settings.piProxyEnabled,
		feature_feishu: deps.feishuBotsTotal > 0,
		hidden_modules_total: hiddenModules.length,
		hidden_modules: [...hiddenModules],
	};
}
