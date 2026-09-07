import { app } from "electron";
import { statfs } from "node:fs/promises";
import { freemem, release, totalmem } from "node:os";
import type { ConfigManager } from "../config/ConfigManager";
import type { AppLogger } from "../logging/AppLogger";
import type { PiLocator } from "../pi/PiLocator";
import type { SettingsStore } from "../settings/SettingsStore";
import type {
	HealthEnvironment,
	HealthLogFile,
	HealthLogLine,
	HealthReport,
} from "../../shared/types";
import {
	checkAppMemory,
	checkConfigParsable,
	checkDiskSpace,
	checkLogErrors,
	checkPiInstalled,
	checkProxyConfig,
	checkWslConfig,
	sortChecksBySeverity,
	toConfigDiagnostics,
} from "./healthProbes";
import { createPathMasker, redactSecrets, truncateText } from "./redact";

/** 日志统计窗口：只看最近 7 天，更早的日志对「现在出问题」几乎没有诊断价值。 */
const LOG_WINDOW_DAYS = 7;
/** 报告内附的报错条数上限（warn + error 各取一半），防止报告体积失控。
 *  反馈里常抱怨日志太少，提升到 500/级（合并后最多 1000 条），足够覆盖「今天」的全部报错；
 *  展示层（markdown/prompt）另有自己的条数上限，这里是采集上限。 */
const MAX_RECENT_PER_LEVEL = 500;
/** 单条日志消息进入报告前的截断长度。 */
const MAX_LINE_CHARS = 400;

export type EnvironmentDoctorDeps = {
	appLogger: AppLogger;
	piLocator: PiLocator;
	settingsStore: SettingsStore;
	configManager: ConfigManager;
};

/**
 * 环境体检编排器。
 *
 * 职责边界：只做「采集 + 判定 + 脱敏」，不碰 ipcMain、不碰 UI、不写文件。
 * 所有对外输出的数据都已在返回前脱敏，调用方无需二次处理——这是隐私红线的落地方式：
 * 脱敏发生在数据离开主进程之前的最后一环，而不是分散在每个消费点。
 */
export class EnvironmentDoctor {
	constructor(private readonly deps: EnvironmentDoctorDeps) {}

	/** 跑一次完整体检。任一项采集失败都降级为「该项 skipped」，不让整体失败。 */
	async run(): Promise<HealthReport> {
		const generatedAt = Date.now();
		const [environment, logSummary, logFiles] = await Promise.all([
			this.collectEnvironment(),
			this.collectLogSummary(),
			this.collectLogFiles(),
		]);
		const checks = sortChecksBySeverity([
			checkPiInstalled(environment.pi),
			checkConfigParsable(await this.collectConfigDiagnostics()),
			checkLogErrors(logSummary.error, logSummary.warn),
			checkDiskSpace(environment.dataDirFreeBytes),
			checkAppMemory(environment.appRssBytes),
			checkProxyConfig(this.deps.settingsStore.get()),
			checkWslConfig(
				this.deps.settingsStore.get(),
				environment.platform,
				Boolean(environment.pi?.installed),
			),
		]);
		return { generatedAt, environment, checks, logSummary, logFiles };
	}

	private async collectEnvironment(): Promise<HealthEnvironment> {
		const { piLocator, settingsStore } = this.deps;
		const settings = settingsStore.get();
		const home = app.getPath("home");
		const maskPath = createPathMasker(home);
		const userDataDir = app.getPath("userData");
		const memory = process.memoryUsage();
		const pi = await piLocator
			.check(settings.customPiPath, settings.wslEnabled, settings.wslDistro, settings.wslUser)
			.catch(() => null);
		return {
			appVersion: app.getVersion(),
			platform: process.platform,
			arch: process.arch,
			osVersion: release(),
			locale: app.getLocale(),
			timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
			electronVersion: process.versions.electron ?? "",
			chromeVersion: process.versions.chrome ?? "",
			nodeVersion: process.versions.node,
			installMode: this.resolveInstallMode(),
			userDataDir: maskPath(userDataDir),
			logsDir: maskPath(this.deps.appLogger.getLogDir()),
			appRssBytes: memory.rss,
			appHeapUsedBytes: memory.heapUsed,
			systemTotalMemoryBytes: totalmem(),
			systemFreeMemoryBytes: freemem(),
			dataDirFreeBytes: await this.readFreeBytes(userDataDir),
			flags: {
				wslEnabled: settings.wslEnabled,
				wslDistro: settings.wslDistro,
				piProxyEnabled: settings.piProxyEnabled,
				desktopProxyEnabled: settings.desktopProxyEnabled,
				piProxyConfigured: Boolean(settings.piProxyUrl.trim()),
				chromiumSandbox: settings.electronChromiumSandbox,
				developerDiagnostics: settings.developerDiagnostics,
				webServiceEnabled: settings.webServiceEnabled,
				customPiPathConfigured: Boolean(settings.customPiPath.trim()),
			},
			pi: pi
				? {
						...pi,
						// pi 命令/搜索目录可能含 home 路径，统一脱敏；version 是版本号，不含隐私但同样过长时截断
						command: pi.command ? maskPath(pi.command) : pi.command,
						// WSL 解析出的 Linux 绝对路径带用户名，与 command 同级处理
						piPath: pi.piPath ? maskPath(pi.piPath) : pi.piPath,
						version: pi.version ? truncateText(pi.version, 80) : pi.version,
						error: pi.error ? redactSecrets(maskPath(pi.error)) : pi.error,
						searchedDirs: pi.searchedDirs.map((dir) => maskPath(dir)),
					}
				: { installed: false, searchedDirs: [] },
		};
	}

	/**
	 * 安装形态：开发态 / 便携版 / 安装版。
	 * electron-builder 的便携版会注入 PORTABLE_EXECUTABLE_DIR，是官方判定依据。
	 */
	private resolveInstallMode(): HealthEnvironment["installMode"] {
		if (!app.isPackaged) return "dev";
		return process.env.PORTABLE_EXECUTABLE_DIR ? "portable" : "installed";
	}

	/** 读取目录所在磁盘的剩余空间；不支持 statfs 的挂载点返回 0（检查项会标 skipped）。 */
	private async readFreeBytes(dir: string): Promise<number> {
		try {
			const info = await statfs(dir);
			return Number(info.bavail) * Number(info.bsize);
		} catch {
			return 0;
		}
	}

	/**
	 * 读取 pi 配置文件的解析诊断（models/auth/settings）。
	 * 只读诊断结果，不读文件内容——配置里含 apiKey，任何原始内容都不应进入报告。
	 */
	private async collectConfigDiagnostics(): Promise<Array<{ fileName: string; message: string }>> {
		const { configManager } = this.deps;
		try {
			const [models, auth, piSettings] = await Promise.all([
				configManager.getModelsConfig().catch(() => null),
				configManager.getAuthConfig().catch(() => null),
				configManager.getSettingsConfig().catch(() => null),
			]);
			return toConfigDiagnostics([models, auth, piSettings].filter(Boolean) as Array<{
				diagnostic?: import("../../shared/types").ConfigFileDiagnostic | null;
			}>);
		} catch {
			return [];
		}
	}

	/** 统计最近 7 天的日志，并取出最新的 warn/error 明细（已脱敏）。
	 *  同时统计「今天」的 error/warn 条数：报告头部单独展示，
	 *  用户问「今天的错误」时不用翻完整 7 天列表。 */
	private async collectLogSummary(): Promise<HealthReport["logSummary"]> {
		const { appLogger } = this.deps;
		const from = Date.now() - LOG_WINDOW_DAYS * 86_400_000;
		// 今天 0 点（本地时区）：today 计数窗口，不随报告生成时间漂移
		const todayStart = new Date();
		todayStart.setHours(0, 0, 0, 0);
		const todayFrom = todayStart.getTime();
		const maskPath = createPathMasker(app.getPath("home"));
		const empty = {
			total: 0,
			error: 0,
			warn: 0,
			todayError: 0,
			todayWarn: 0,
			recent: [] as HealthLogLine[],
		};
		try {
			const [all, errors, warns, todayErrors, todayWarns, recentErrors, recentWarns] =
				await Promise.all([
					appLogger.listPage({ level: "all", from, page: 0, pageSize: 1 }),
					appLogger.listPage({ level: "error", from, page: 0, pageSize: 1 }),
					appLogger.listPage({ level: "warn", from, page: 0, pageSize: 1 }),
					appLogger.listPage({ level: "error", from: todayFrom, page: 0, pageSize: 1 }),
					appLogger.listPage({ level: "warn", from: todayFrom, page: 0, pageSize: 1 }),
					appLogger.listPage({ level: "error", from, page: 0, pageSize: MAX_RECENT_PER_LEVEL }),
					appLogger.listPage({ level: "warn", from, page: 0, pageSize: MAX_RECENT_PER_LEVEL }),
				]);
			// 只保留 time/level/scope/message：detail 里可能含完整路径或用户内容，一律不带出。
			const recent = [...recentErrors.entries, ...recentWarns.entries]
				.map((entry) => ({
					time: entry.time,
					level: entry.level as "warn" | "error",
					scope: truncateText(entry.scope, 40),
					message: truncateText(redactSecrets(maskPath(entry.message)), MAX_LINE_CHARS),
				}))
				.sort((a, b) => b.time - a.time)
				.slice(0, MAX_RECENT_PER_LEVEL * 2);
			return {
				total: all.total,
				error: errors.total,
				warn: warns.total,
				todayError: todayErrors.total,
				todayWarn: todayWarns.total,
				recent,
			};
		} catch {
			return empty;
		}
	}

	private async collectLogFiles(): Promise<HealthLogFile[]> {
		try {
			const files = await this.deps.appLogger.listFiles();
			return files.map((file) => ({
				name: file.name,
				sizeBytes: file.sizeBytes,
				modifiedAt: file.modifiedAt,
			}));
		} catch {
			return [];
		}
	}
}
