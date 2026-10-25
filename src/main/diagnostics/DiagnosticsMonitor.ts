/**
 * 开发诊断采样：内存 CSV + 事件循环延迟 + 关键路径耗时。
 *
 * 为什么独立于 MemoryMonitor：MemoryMonitor 仍可由 PIDECK_MEMORY_PROFILE=1
 * 在启动瞬间打开（覆盖窗口创建）；本模块由设置开关热启停，给用户一条
 * 「打开就能记」的路径，不必改环境变量重启。
 *
 * 默认关闭。开启后写入 userData/diagnostics/，quit 时必须 stop()。
 */

import { app } from "electron";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { startMemoryProfile, type MemoryProfileHandle } from "../memory/MemoryMonitor";
import type { DiagnosticsEventTiming, DiagnosticsSnapshot } from "../../shared/types/diagnostics";
import type { AppLogger } from "../logging/AppLogger";
import { openSystemPath } from "../fs/openPath";

const MAX_RECENT_TIMINGS = 80;
const LAG_SAMPLE_MS = 1000;
const LAG_WARN_MS = 50;

export type DiagnosticsMonitorDeps = {
	logger?: Pick<AppLogger, "info" | "warn" | "debug">;
	streamingProbe?: () => boolean;
};

export class DiagnosticsMonitor {
	private enabled = false;
	private memoryHandle: MemoryProfileHandle | null = null;
	private timingsPath: string | null = null;
	private lagTimer: NodeJS.Timeout | null = null;
	private lastLagMs = 0;
	private maxLagMs = 0;
	private recent: DiagnosticsEventTiming[] = [];
	private writeQueue: Promise<void> = Promise.resolve();

	constructor(private readonly deps: DiagnosticsMonitorDeps = {}) {}

	isEnabled(): boolean {
		return this.enabled;
	}

	/**
	 * 按设置开关启停。重复 set(true) 不重建采样，避免 settings:update 抖一下重开文件。
	 */
	async setEnabled(enabled: boolean): Promise<void> {
		if (enabled === this.enabled) return;
		if (!enabled) {
			this.stop();
			return;
		}
		this.enabled = true;
		this.maxLagMs = 0;
		this.lastLagMs = 0;
		const dir = join(app.getPath("userData"), "diagnostics");
		await mkdir(dir, { recursive: true });
		const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
		this.timingsPath = join(dir, `timings-${stamp}.jsonl`);
		try {
			this.memoryHandle = await startMemoryProfile(this.deps.streamingProbe);
		} catch (error) {
			this.deps.logger?.warn("diagnostics", "Memory profile failed to start", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
		this.startLagSampler();
		this.deps.logger?.info("diagnostics", "Developer diagnostics enabled", {
			timingsPath: this.timingsPath,
			memoryProfilePath: this.memoryHandle?.filePath ?? null,
		});
	}

	stop(): void {
		this.enabled = false;
		if (this.lagTimer) {
			clearInterval(this.lagTimer);
			this.lagTimer = null;
		}
		this.memoryHandle?.stop();
		this.memoryHandle = null;
		this.timingsPath = null;
	}

	/**
	 * 记录一条关键路径耗时。未开启时直接丢弃（零开销）。
	 * 写盘走队列，不 await 调用方。
	 */
	recordTiming(name: string, startedAt: number, detail?: DiagnosticsEventTiming["detail"]): void {
		if (!this.enabled) return;
		const durationMs = Math.max(0, Date.now() - startedAt);
		const entry: DiagnosticsEventTiming = {
			name,
			startedAt,
			durationMs,
			...(detail ? { detail } : {}),
		};
		this.recent.unshift(entry);
		if (this.recent.length > MAX_RECENT_TIMINGS) this.recent.length = MAX_RECENT_TIMINGS;
		const path = this.timingsPath;
		if (!path) return;
		this.writeQueue = this.writeQueue
			.then(() => appendFile(path, `${JSON.stringify(entry)}\n`, "utf8"))
			.catch((error) => {
				this.deps.logger?.warn("diagnostics", "Failed to append timing", {
					error: error instanceof Error ? error.message : String(error),
				});
			});
		if (durationMs >= 200) {
			this.deps.logger?.warn("diagnostics", "Slow path", {
				name,
				durationMs,
				...detail,
			});
		} else {
			this.deps.logger?.debug("diagnostics", "Timing", { name, durationMs, ...detail });
		}
	}

	snapshot(): DiagnosticsSnapshot {
		const mem = process.memoryUsage();
		return {
			enabled: this.enabled,
			sampledAt: Date.now(),
			main: {
				rssBytes: mem.rss,
				heapUsedBytes: mem.heapUsed,
				heapTotalBytes: mem.heapTotal,
				externalBytes: mem.external,
				arrayBuffersBytes: mem.arrayBuffers,
			},
			eventLoopLagMs: this.lastLagMs,
			eventLoopLagMaxMs: this.maxLagMs,
			memoryProfilePath: this.memoryHandle?.filePath ?? null,
			timingsPath: this.timingsPath,
			recentTimings: this.recent.slice(0, 40),
		};
	}

	async openFolder(): Promise<void> {
		const dir = join(app.getPath("userData"), "diagnostics");
		await mkdir(dir, { recursive: true });
		await openSystemPath(dir);
	}

	private startLagSampler(): void {
		let inFlight = false;
		this.lagTimer = setInterval(() => {
			if (!this.enabled || inFlight) return;
			inFlight = true;
			const sent = Date.now();
			setImmediate(() => {
				const lag = Date.now() - sent;
				this.lastLagMs = lag;
				if (lag > this.maxLagMs) this.maxLagMs = lag;
				if (lag >= LAG_WARN_MS) {
					this.deps.logger?.warn("diagnostics", "Event loop lag", { lagMs: lag });
				}
				inFlight = false;
			});
		}, LAG_SAMPLE_MS);
		this.lagTimer.unref();
	}
}
