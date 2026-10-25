/**
 * 用量统计 IPC handler（薄层：只做入参校验与适配，业务在 UsageStatsService）。
 */

import { ipcChannels } from "../../shared/ipc";
import type { UsageStatsService } from "../usageStats/UsageStatsService";

/** 校验 service 可用性：装配失败时返回结构化错误而非抛裸异常。 */
function serviceError(): never {
	throw new Error("Usage stats service is not available");
}

export function registerUsageStatsIpc(ipc: Electron.IpcMain, service: UsageStatsService | null): void {
	const requireService = (): UsageStatsService => {
		if (!service) serviceError();
		return service;
	};

	ipc.handle(ipcChannels.usageStatsDetect, async () => {
		const s = requireService();
		return s.detect();
	});

	ipc.handle(ipcChannels.usageStatsRefresh, async () => {
		const s = requireService();
		return s.refresh();
	});

	ipc.handle(ipcChannels.usageStatsGet, async () => {
		const s = requireService();
		return s.getAggregated();
	});
}
