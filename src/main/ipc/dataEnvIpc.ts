// 数据环境（dataEnv）IPC 域：决策指针读写 + 启动期 mismatch 确认。
// handler 只做输入校验与适配，业务在 dataEnv/dataEnvService.ts（纯函数，可单测）。
// 决策指针的启动期读取在 index.ts 启动序列（setPath 前）完成，本域只负责渲染层交互。
import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { UpdateChannel } from "../../shared/types/app";
import type { DataEnvMode, ImportPreviewResult, ImportProgress, ImportStartResult } from "../../shared/types/dataEnv";
import { estimateImportBytes, planImportItems, runImport, ImportCancelledError } from "../dataEnv/channelDataImport";
import { applyDataEnvChoice, getDataEnvInfo } from "../dataEnv/dataEnvService";
import { getAppLogger } from "../logging/sharedLogger";

// 纯决策函数再导出：tests/dataEnvIpc.test.mjs 经本模块加载纯逻辑，不经 ipcMain。
export { applyDataEnvChoice, getDataEnvInfo };

export interface DataEnvIpcDeps {
	getChannel: () => UpdateChannel;
	/** 决策指针所在目录（dev 独立数据目录）；stable 通道为空串，service 层空串守卫拒绝（R6）。 */
	getDecisionDir: () => string;
	getActiveDirectory: () => "shared" | "channel-dev";
	getAppVersion: () => string;
	relaunchApp: () => void;
	quitApp: () => void;
	/** 导入源：共用数据目录（与启动 setPath 的 fallbackSharedDir 同源，规格 §6 单向正式→dev）。 */
	getSharedDataDir: () => string;
	/** 导入目标：dev 独立数据目录；空串 = stable 通道，导入不可用（R6 同款空串守卫）。 */
	getChannelDevDataDir: () => string;
	/** 导入进度推送（index.ts 接主窗口 webContents.send）。 */
	sendProgress: (progress: ImportProgress) => void;
}

export function registerDataEnvIpc(deps: DataEnvIpcDeps): void {
	ipcMain.handle(ipcChannels.dataEnvGetInfo, () =>
		getDataEnvInfo({
			channel: deps.getChannel(),
			decisionDir: deps.getDecisionDir(),
			activeDirectory: deps.getActiveDirectory(),
		}),
	);
	ipcMain.handle(ipcChannels.dataEnvChooseMode, (_event, mode: unknown) => {
		// 渲染层数据不可信：只接受两个合法模式，其余一律 invalid-mode
		//（空决策目录的 stable 通道由 applyDataEnvChoice 返回同款错误，R6）。
		if (mode !== "shared" && mode !== "channel-dev") return { ok: false, error: "invalid-mode" as const };
		return applyDataEnvChoice({ mode, decisionDir: deps.getDecisionDir(), appVersion: deps.getAppVersion() });
	});
	ipcMain.handle(ipcChannels.dataEnvRestart, () => {
		deps.relaunchApp();
	});
	ipcMain.handle(ipcChannels.dataEnvConfirmMismatch, (_event, action: unknown) => {
		// 入参不可信：只接受 continue / quit，其余静默忽略（不抛裸异常跨 IPC）。
		if (action !== "continue" && action !== "quit") return;
		if (action === "quit") {
			void getAppLogger()?.warn("data-env", "User chose to quit after data env mismatch");
			deps.quitApp();
		}
	});
	// —— 数据导入（规格 §6：仅首启、仅正式→dev、单向；取消保留已复制内容，可再次导入）——
	// 导入运行状态：单例模块的进行中/取消标志；完成或取消后复位，允许再次 start。
	let importRunning = false;
	let importCancelRequested = false;
	ipcMain.handle(ipcChannels.dataEnvGetImportPreview, (): ImportPreviewResult => {
		// 与 import-start 同款空目录守卫：stable 通道无独立目录，导入语义不存在，
		// 拒绝在共用目录上做整份预估扫描（否则把用户当前数据误展示为「可迁移项」）。
		if (!deps.getChannelDevDataDir()) return { ok: false, error: "unavailable" };
		const items = planImportItems(deps.getSharedDataDir());
		return { ok: true, items, totalBytes: estimateImportBytes(items) };
	});
	ipcMain.handle(ipcChannels.dataEnvImportStart, async (): Promise<ImportStartResult> => {
		// 路径安全（R6 同款空串守卫）：空目标目录（stable 通道）严禁复制，否则落到相对 cwd。
		const targetDir = deps.getChannelDevDataDir();
		if (!targetDir) return { ok: false, error: "unavailable" };
		if (importRunning) return { ok: false, error: "busy" };
		importRunning = true;
		importCancelRequested = false;
		let lastProgress: ImportProgress = { phase: "estimating", currentItem: null, copiedBytes: 0, totalBytes: 0 };
		try {
			await runImport(deps.getSharedDataDir(), targetDir, {
				onProgress: (progress) => {
					lastProgress = progress;
					deps.sendProgress(progress);
				},
				isCancelled: () => importCancelRequested,
			});
			return { ok: true };
		} catch (error) {
			// 取消不是失败：保留已复制内容，不写决策指针（重启后仍处无决策态可重选，规格 §6）。
			if (error instanceof ImportCancelledError) {
				deps.sendProgress({ ...lastProgress, phase: "cancelled", currentItem: null });
				return { ok: false, error: "cancelled" };
			}
			void getAppLogger()?.error("data-env", "Channel data import failed", error);
			deps.sendProgress({ ...lastProgress, phase: "error", currentItem: null });
			return { ok: false, error: "failed" };
		} finally {
			importRunning = false;
			importCancelRequested = false;
		}
	});
	ipcMain.handle(ipcChannels.dataEnvImportCancel, () => {
		importCancelRequested = true;
	});
}
