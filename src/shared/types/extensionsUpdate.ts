/**
 * 内置扩展热更新的跨进程契约（主进程 updater ↔ 渲染层扩展页）。
 *
 * 与模型目录更新（shared/types/catalog.ts）同构——两者都是「resources 只读 →
 * userData 覆盖层」的资源热更新；但状态与结果各自独立建模，不共用类型，
 * 以免一方的字段演进牵动另一方。
 */

/** 一端（内置 / 覆盖层）的生效摘要；校验通过才有值。 */
export type BuiltInExtensionsArtifactStatus = {
	/** 包级版本号（manifest.version）；不跟 PiDeck 应用版本走。 */
	version: string;
	/** 参与分发的文件数（含被扩展 import 的辅助模块）。 */
	fileCount: number;
};

export type BuiltInExtensionsUpdateStatus = {
	/** 随应用分发的内置版本。 */
	builtin: BuiltInExtensionsArtifactStatus | null;
	/** 当前生效的覆盖层版本（用户更新过才有）。 */
	overlay: BuiltInExtensionsArtifactStatus | null;
	/** 覆盖层目录是否存在文件（即便校验失败，也提示用户可「还原内置」）。 */
	hasOverlayFiles: boolean;
	/** 是否存在可恢复的上一个覆盖版。 */
	hasBackup: boolean;
	/** 当前实际生效的版本（覆盖层优先，否则内置）；两者都无效为 null。 */
	effectiveVersion: string | null;
	/** 覆盖层目录绝对路径（供 UI 展示「打开目录」）；无覆盖层时为 null。 */
	overlayDir: string | null;
};

export type BuiltInExtensionsCheckResult = {
	ok: boolean;
	code?: "network" | "validation";
	message?: string;
	/** 远端清单版本号。 */
	remoteVersion?: string;
	/** 本地生效版本（覆盖层优先，否则内置）。 */
	localVersion?: string | null;
	hasUpdate: boolean;
	/** 内容与本地不同的文件名，供 UI 展示「本次会更新哪几个扩展」。 */
	changedFiles?: string[];
};

export type BuiltInExtensionsUpdateResult = {
	ok: boolean;
	code?: "network" | "validation" | "write";
	message?: string;
	/** false = 已是最新（未写盘）。 */
	updated: boolean;
	/** 更新后的生效版本号。 */
	version?: string;
	/** 实际写入覆盖层的文件数（含从内置复制的未变化文件）。 */
	filesWritten?: number;
};
