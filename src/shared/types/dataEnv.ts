/** 数据环境模式：shared=与 stable 共用正式数据目录；channel-dev=dev 专属独立目录。 */
export type DataEnvMode = "shared" | "channel-dev";

/** pideck-env.json 结构（决策指针与数据目录标记同构）。 */
export interface DataEnvDecisionFile {
	schemaVersion: 1;
	dataMode: DataEnvMode;
	lastAppVersion: string;
	createdAt: string;
}

export interface DataEnvInfo {
	channel: import("./app").UpdateChannel;
	/** 决策指针是否存在（dev 首启弹窗判定）。 */
	decided: boolean;
	dataMode: DataEnvMode | null;
	/** 当前生效数据目录类型。 */
	activeDirectory: "shared" | "channel-dev";
}

export type DataEnvMismatchAction = "continue" | "quit";

/** chooseMode 成功结果：决策指针已写入，切换须重启应用才生效（导入引导由任务 5 消费）。 */
export interface DataEnvChoiceResult {
	/** 是否需要重启应用才能让新数据目录生效（channel-dev 需重启后 setPath 分流）。 */
	restartRequired: boolean;
	/** 是否可引导导入旧目录数据（切到 channel-dev 时可用；任务 5 消费）。 */
	importAvailable: boolean;
}

/** chooseMode 拒绝执行的结构化失败（模式非法 / stable 通道无 dev 决策目录）。 */
export type DataEnvChoiceFailure = { ok: false; error: "invalid-mode" };

/** 单个迁移项（规格 §6 附录清单一项的展开结果；目录为递归整体复制）。 */
export interface ImportItem {
	relPath: string;
	isDir: boolean;
	/** 文件字节数；目录为递归求和。 */
	bytes: number;
}

/** 导入进度事件（data-env:import-progress 推送；预估态由 get-import-preview 返回值承载）。 */
export interface ImportProgress {
	phase: "estimating" | "copying" | "done" | "cancelled" | "error";
	currentItem: string | null;
	copiedBytes: number;
	totalBytes: number;
}

/** get-import-preview 结果：unavailable=本通道无独立目录（stable），与 import-start 同款语义（任务 9 账本顺带修复）。 */
export type ImportPreviewResult = { ok: true; items: ImportItem[]; totalBytes: number } | { ok: false; error: "unavailable" };

/** import-start 结果：busy=已有导入进行中；cancelled=用户取消（已复制内容保留）；unavailable=本通道无独立目录；failed=复制出错。 */
export type ImportStartResult = { ok: true } | { ok: false; error: "busy" | "cancelled" | "unavailable" | "failed" };
