/**
 * 配置备份（config-backup）共享类型：主进程 / preload / 渲染层共同依赖的契约。
 *
 * 备份对象：pi 配置文件（models.json / auth.json / settings.json / mcp.json / mcp-auth.json）
 * 与 PiDeck 设置（userData/settings.json）。备份以单文件 JSON 包落盘，
 * 内部键带命名空间前缀（`pi/`、`pideck/`），避免两个同名 settings.json 冲突。
 */

/**
 * 备份触发原因：当前仅产生 first-run（首次使用自动）、manual（用户手动）与
 * pre-restore（恢复前保护）；upgrade / on-save 为旧版本自动备份模式的遗留原因，
 * 只可能出现在历史备份元数据中，类型保留以兼容旧备份文件。
 */
export type ConfigBackupReason = "first-run" | "upgrade" | "on-save" | "manual" | "pre-restore";

/** 备份列表条目元数据（不含文件内容；列表页只读元数据，避免加载全文）。 */
export type ConfigBackupMeta = {
	/** 备份文件名（如 backup-2026-09-19T103000.000Z.json），也是删除/恢复的入参 id。 */
	id: string;
	/** 备份创建时间（ISO 字符串）。 */
	createdAt: string;
	/** 备份时的 PiDeck 版本（用于升级检测与展示）。 */
	appVersion: string;
	/** 触发原因。 */
	reason: ConfigBackupReason;
	/** 备份文件字节数。 */
	size: number;
	/** 包含的文件清单（如 ["pi/models.json", "pi/auth.json", ...]）。 */
	files: string[];
	/** 备份来源的 pi 配置目录（WSL 时随生效目录变化，仅展示）。 */
	configDir: string;
};

/** 备份详情中的单个文件视图：内容已脱敏（API key 打码），供「查看」展示。 */
export type ConfigBackupFileView = {
	/** 命名空间文件名，如 pi/models.json。 */
	name: string;
	/** 脱敏后的原始 JSON 文本（保留缩进）。 */
	raw: string;
	/** 是否发生过脱敏替换（true 时 UI 提示 key 已隐藏）。 */
	redacted: boolean;
};

/** 备份详情 = 元数据（文件清单除外，详情里以文件视图形式给出）+ 脱敏后的文件内容。 */
export type ConfigBackupDetail = {
	id: string;
	createdAt: string;
	appVersion: string;
	reason: ConfigBackupReason;
	size: number;
	configDir: string;
	files: ConfigBackupFileView[];
};

/** 备份列表结果（主进程返回；错误不抛裸异常跨 IPC）。 */
export type ConfigBackupListResult = { ok: true; backups: ConfigBackupMeta[] } | { ok: false; error: string };

/** 备份操作结果（创建 / 恢复 / 删除）。 */
export type ConfigBackupActionResult = { ok: true; id?: string } | { ok: false; error: string };

/** 批量删除结果：ok 时返回实际删除的备份数（部分成功亦 ok）。 */
export type ConfigBackupDeleteManyResult = { ok: true; deleted: number } | { ok: false; error: string };
