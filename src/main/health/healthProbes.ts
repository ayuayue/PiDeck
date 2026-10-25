import type { ConfigFileDiagnostic, PiInstallStatus } from "../../shared/types";
import type { AppSettings } from "../../shared/types";
import type { HealthCheckItem, HealthStatus } from "../../shared/types";
import { truncateText } from "./redact";

/**
 * 环境体检的判定规则（纯函数）。
 *
 * 为什么与 EnvironmentDoctor 分开：采集需要 app/os/fs/子进程等副作用，判定不需要。
 * 判定规则单独成纯函数后，可以脱离 Electron 直接单测——「剩余 400MB 磁盘算 error 还是 warn」
 * 这类阈值争议，用测试锁定比靠注释可靠。
 */

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** 数据盘剩余空间低于此值视为 error（应用写不进日志/会话数据）。 */
export const DISK_ERROR_BYTES = 512 * MB;
/** 数据盘剩余空间低于此值提醒用户清理。 */
export const DISK_WARN_BYTES = 2 * GB;
/** 主进程常驻内存超过此值视为 error（通常是内存泄漏或超大会话）。 */
export const RSS_ERROR_BYTES = 3 * GB;
export const RSS_WARN_BYTES = 1.5 * GB;
/** 统计窗口内 error 条数达到此值视为 error 级。 */
export const LOG_ERROR_COUNT_ERROR = 10;

function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
	if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
	return `${Math.round(bytes / MB)} MB`;
}

/** pi 是否可用：装了且能读出版本才算真正可用。 */
export function checkPiInstalled(pi: PiInstallStatus | null): HealthCheckItem {
	if (!pi) {
		return { id: "pi.installed", status: "error", detail: "" };
	}
	if (pi.installed && pi.version) {
		return { id: "pi.installed", status: "ok", detail: pi.version };
	}
	if (pi.installed) {
		// 能执行但读不到版本：多半是自定义路径指到了非 pi 程序，或 pi 版本过老不支持 --version
		return { id: "pi.installed", status: "warn", detail: truncateText(pi.error ?? "", 160) };
	}
	return { id: "pi.installed", status: "error", detail: truncateText(pi.error ?? "", 160) };
}

/** pi 配置（models.json / auth.json / settings.json）是否可解析。 */
export function checkConfigParsable(diagnostics: Array<{ fileName: string; message: string }>): HealthCheckItem {
	if (diagnostics.length === 0) {
		return { id: "config.parsable", status: "ok", detail: "" };
	}
	// 配置损坏是硬故障：会话起不来、模型列表为空，因此直接 error，不做降级。
	return {
		id: "config.parsable",
		status: "error",
		detail: truncateText(diagnostics.map((item) => `${item.fileName}: ${item.message}`).join("; "), 200),
	};
}

/** 最近统计窗口内的报错密度。 */
export function checkLogErrors(errorCount: number, warnCount: number): HealthCheckItem {
	if (!Number.isFinite(errorCount) || errorCount <= 0) {
		return { id: "logs.errors", status: "ok", detail: `${warnCount} warns` };
	}
	return {
		id: "logs.errors",
		status: errorCount >= LOG_ERROR_COUNT_ERROR ? "error" : "warn",
		detail: `${errorCount} errors / ${warnCount} warns`,
	};
}

/** 数据目录所在磁盘的剩余空间。 */
export function checkDiskSpace(freeBytes: number): HealthCheckItem {
	if (!Number.isFinite(freeBytes) || freeBytes <= 0) {
		// statfs 在部分网络盘/WSL 挂载点上不可用：不是故障，标 skipped 避免误报。
		return { id: "disk.space", status: "skipped", detail: "" };
	}
	if (freeBytes < DISK_ERROR_BYTES) {
		return { id: "disk.space", status: "error", detail: formatBytes(freeBytes) };
	}
	if (freeBytes < DISK_WARN_BYTES) {
		return { id: "disk.space", status: "warn", detail: formatBytes(freeBytes) };
	}
	return { id: "disk.space", status: "ok", detail: formatBytes(freeBytes) };
}

/** 主进程常驻内存。 */
export function checkAppMemory(rssBytes: number): HealthCheckItem {
	if (!Number.isFinite(rssBytes) || rssBytes <= 0) {
		return { id: "memory.rss", status: "skipped", detail: "" };
	}
	if (rssBytes >= RSS_ERROR_BYTES) {
		return { id: "memory.rss", status: "error", detail: formatBytes(rssBytes) };
	}
	if (rssBytes >= RSS_WARN_BYTES) {
		return { id: "memory.rss", status: "warn", detail: formatBytes(rssBytes) };
	}
	return { id: "memory.rss", status: "ok", detail: formatBytes(rssBytes) };
}

/**
 * 代理开关与地址是否自洽。
 * 开了代理却没填地址是极常见的「网络请求全部失败」根因，值得单独列为检查项。
 */
export function checkProxyConfig(settings: AppSettings): HealthCheckItem {
	const broken: string[] = [];
	if (settings.piProxyEnabled && !settings.piProxyUrl.trim()) broken.push("pi");
	if (settings.desktopProxyEnabled && !settings.desktopProxyUrl.trim()) broken.push("desktop");
	if (broken.length > 0) {
		return { id: "proxy.consistency", status: "warn", detail: broken.join(", ") };
	}
	return {
		id: "proxy.consistency",
		status: "ok",
		detail: settings.piProxyEnabled || settings.desktopProxyEnabled ? "enabled" : "off",
	};
}

/**
 * WSL 兜底配置是否自洽。
 * 只在 Windows 上有意义（其他平台标 skipped）；pi 已装时不关心 WSL 配置。
 */
export function checkWslConfig(settings: AppSettings, platform: NodeJS.Platform, piInstalled: boolean): HealthCheckItem {
	if (platform !== "win32") {
		return { id: "wsl.config", status: "skipped", detail: "" };
	}
	if (!settings.wslEnabled) {
		return { id: "wsl.config", status: "ok", detail: "off" };
	}
	if (!piInstalled && !settings.wslDistro.trim()) {
		// 开了 WSL 兜底却没填发行版，等于兜底永远不会生效
		return { id: "wsl.config", status: "warn", detail: "distro missing" };
	}
	return { id: "wsl.config", status: "ok", detail: settings.wslDistro.trim() || "default" };
}

/**
 * 实例锁快照项。state 由 instanceLockFile 的进程身份判定映射而来：
 * live = 主人还活着；stale = 死进程/僵尸/PID 复用留下的残留锁；corrupt = 文件半截或非本格式。
 */
export type InstanceLockState = "live" | "stale" | "corrupt";
export type InstanceLockSummary = { version: string; pid: number; state: InstanceLockState };

type InstanceLockCheckOptions = {
	/** 当前主进程 pid；用于识别「单实例开启但本进程没拿到锁」（锁目录不可写等降级场景） */
	ownPid: number;
	singleInstanceEnabled: boolean;
};

/**
 * 实例锁文件是否健康。
 *
 * 为什么不只是「锦上添花」：0.7.5 及以前，升级时被中断留下的锁文件会让
 * 再次启动「双击图标没反应」（无窗口、无报错、退出码 0），只能靠手删文件恢复。
 * 把「锁目录里有什么」变成体检项后，这类反馈不再依赖用户自己会看日志。
 */
export function checkInstanceLocks(locks: InstanceLockSummary[] | null, options: InstanceLockCheckOptions): HealthCheckItem {
	if (locks === null) {
		// 锁目录读不到（权限/不存在）：采集失败，不作为故障上报
		return { id: "instance.locks", status: "skipped", detail: "" };
	}
	const stale = locks.filter((item) => item.state === "stale");
	const corrupt = locks.filter((item) => item.state === "corrupt");
	const summary = (items: InstanceLockSummary[]) => truncateText(items.map((item) => `${item.version}(pid ${item.pid})`).join(", "), 160);

	if (stale.length > 0) {
		// 残留锁说明上一次退出不是干净退出（崩溃/被 kill/升级中断），值得提醒
		return { id: "instance.locks", status: "warn", detail: summary(stale) };
	}
	if (corrupt.length > 0) {
		return { id: "instance.locks", status: "warn", detail: summary(corrupt) };
	}
	if (options.singleInstanceEnabled && options.ownPid > 0) {
		const own = locks.find((item) => item.pid === options.ownPid);
		if (!own) {
			// 单实例开着却没有自己的锁：写锁失败（只读盘/权限）已降级为无锁启动，
			// 表现是「同版本能开两个窗口、会话被抢」，这是必须看见的诊断结论。
			return { id: "instance.locks", status: "warn", detail: "no lock for current process" };
		}
	}
	return { id: "instance.locks", status: "ok", detail: `${locks.length} lock file(s)` };
}

/** 把 ConfigManager 的诊断结果压成检查项需要的形状（不含路径，只留文件名与信息）。 */
export function toConfigDiagnostics(results: Array<{ diagnostic?: ConfigFileDiagnostic | null }>): Array<{ fileName: string; message: string }> {
	return results
		.map((result) => result.diagnostic)
		.filter((item): item is ConfigFileDiagnostic => Boolean(item?.fileName))
		.map((item) => ({
			fileName: truncateText(item.fileName, 60),
			message: truncateText(item.message, 160),
		}));
}

export type HealthTally = {
	ok: number;
	warn: number;
	error: number;
	skipped: number;
	/** 0–100 的总体健康度；只由参与评估的项（非 skipped）计算 */
	score: number;
};

/** 汇总检查结果：给渲染层渲染「3 项异常 / 健康度 82」这类概览。 */
export function tallyChecks(checks: HealthCheckItem[]): HealthTally {
	const tally: HealthTally = { ok: 0, warn: 0, error: 0, skipped: 0, score: 100 };
	for (const check of checks) {
		tally[check.status] += 1;
	}
	const evaluated = tally.ok + tally.warn + tally.error;
	if (evaluated === 0) return tally;
	// error 全额扣分，warn 半额扣分：警告不应把一个还能用的环境打成 0 分。
	tally.score = Math.max(0, Math.round(((tally.ok + tally.warn * 0.5) / evaluated) * 100));
	return tally;
}

const SEVERITY: Record<HealthStatus, number> = { error: 0, warn: 1, ok: 2, skipped: 3 };

/** 按严重度排序（error → warn → ok → skipped），让最该看的问题排在最前。 */
export function sortChecksBySeverity(checks: HealthCheckItem[]): HealthCheckItem[] {
	return [...checks].sort((a, b) => SEVERITY[a.status] - SEVERITY[b.status] || a.id.localeCompare(b.id));
}
