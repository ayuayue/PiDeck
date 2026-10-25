/**
 * 配置备份 IPC handlers（config-backup:*）。
 * 备份域独立注册：创建/查看/恢复/删除只与 ConfigBackupManager 交互，
 * 恢复成功后的 pi 目录刷新由装配层注入 afterRestore 完成（本文件不碰 ConfigManager）。
 */

import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { ConfigBackupDetail, ConfigBackupListResult, ConfigBackupReason } from "../../shared/types/backup";
import { BACKUP_FILE_KEYS, type ConfigBackupManager } from "../config/ConfigBackupManager";
import type { AppLogger } from "../logging/AppLogger";

export type BackupIpcDeps = {
	configBackupManager: ConfigBackupManager;
	appLogger: AppLogger;
	/** 恢复成功后执行（装配层注入：settingsStore.load() + refreshPiModelCatalogs()）。 */
	afterRestore?: () => Promise<void>;
	/**
	 * 备份/恢复前落盘在途的设置写（2027-02 性能治理）：settings.json 带 150ms
	 * 尾随合并窗口，手动备份与 pre-restore 保护快照必须先 flush，否则可能
	 * 抓到窗口前的旧一代内容。
	 */
	flushSettings?: () => Promise<void>;
};

export function registerBackupIpc({ configBackupManager, appLogger, afterRestore, flushSettings }: BackupIpcDeps): void {
	/** id 入参校验：必须为本应用命名的备份文件名（backup-<时间戳>[-序号].json；ConfigBackupManager 内还会做路径逃逸检查）。 */
	const requireBackupId = (value: unknown): string => {
		if (typeof value !== "string" || !/^backup-[0-9]+(?:-[0-9]+)?\.json$/.test(value)) {
			throw new Error("Invalid backup id.");
		}
		return value;
	};

	/**
	 * 恢复目标文件校验：缺省（undefined）= 恢复全部；显式数组必须逐项命中
	 * 备份白名单 key（pi/* + pideck/settings.json），任何非法项直接拒绝——
	 * 渲染层入参不可信，静默忽略会掩盖错误。
	 */
	const requireRestoreFiles = (value: unknown): string[] | undefined => {
		if (value === undefined) return undefined;
		if (!Array.isArray(value) || value.length === 0) {
			throw new Error("Invalid backup files.");
		}
		const allowed = new Set<string>(BACKUP_FILE_KEYS);
		const files = value.filter((entry): entry is string => typeof entry === "string" && allowed.has(entry));
		// 有任何一项不在白名单 → 拒绝（与“过滤后剩空”同等处理）。
		if (files.length !== value.length) {
			throw new Error("Invalid backup file.");
		}
		return files;
	};

	/** 批量删除入参校验：非空字符串数组，逐项必须是本应用命名的备份文件名。 */
	const requireBackupIds = (value: unknown): string[] => {
		if (!Array.isArray(value) || value.length === 0) {
			throw new Error("Invalid backup ids.");
		}
		const ids = value.filter((entry): entry is string => typeof entry === "string" && /^backup-[0-9]+(?:-[0-9]+)?\.json$/.test(entry));
		if (ids.length !== value.length) {
			throw new Error("Invalid backup id.");
		}
		return ids;
	};

	ipcMain.handle(ipcChannels.configBackupList, (): ConfigBackupListResult => configBackupManager.list());

	ipcMain.handle(ipcChannels.configBackupCreate, async (_event, _reason: unknown) => {
		// 渲染层不可信：手动备份固定 reason=manual（first-run/upgrade/on-save/pre-restore
		// 均为主进程内部触发，不接受渲染层指定）。
		await flushSettings?.().catch(() => undefined);
		const safeReason: ConfigBackupReason = "manual";
		const result = configBackupManager.create(safeReason);
		if (result.ok) {
			void appLogger.info("backup", "Config backup created", { reason: safeReason, id: result.id });
		}
		return result;
	});

	ipcMain.handle(ipcChannels.configBackupRead, (_event, id: unknown): ConfigBackupDetail | null => {
		const detail = configBackupManager.read(requireBackupId(id));
		if (!detail) void appLogger.warn("backup", "Backup read failed or missing", { id: String(id) });
		return detail;
	});

	ipcMain.handle(ipcChannels.configBackupRestore, async (_event, id: unknown, files: unknown) => {
		// pre-restore 保护备份要捕获「当前这一代」内容：先落盘在途的设置合并窗口
		await flushSettings?.().catch(() => undefined);
		const result = configBackupManager.restore(requireBackupId(id), requireRestoreFiles(files));
		if (result.ok) {
			// 恢复写回的是磁盘文件；pi 目录刷新（模型目录缓存）与 pideck 设置重载
			// 属于装配层职责，走注入回调，避免 backupIpc 依赖 ConfigManager/SettingsStore。
			await afterRestore?.();
			void appLogger.info("backup", "Config backup restored", { id: result.id, files: files });
		}
		return result;
	});

	ipcMain.handle(ipcChannels.configBackupDelete, (_event, id: unknown) => {
		const result = configBackupManager.delete(requireBackupId(id));
		if (result.ok) void appLogger.info("backup", "Config backup deleted", { id });
		return result;
	});

	ipcMain.handle(ipcChannels.configBackupDeleteMany, (_event, ids: unknown) => {
		const result = configBackupManager.deleteMany(requireBackupIds(ids));
		if (result.ok) {
			void appLogger.info("backup", "Config backups deleted", { count: result.deleted });
		}
		return result;
	});

	ipcMain.handle(ipcChannels.configBackupDeleteAll, () => {
		const result = configBackupManager.deleteAll();
		if (result.ok) void appLogger.info("backup", "All config backups deleted");
		return result;
	});
}
