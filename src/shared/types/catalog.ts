/**
 * pi-ai 模型目录（pi-ai-catalog）更新功能的跨进程契约。
 *
 * 目录文件是构建期从 @earendil-works/pi-ai 提取的静态 artifact（resources/），
 * 打包态只读，因此更新版写入 userData 覆盖层；运行时 piAiBuiltinCatalog
 * 按「覆盖层 → 内置」顺序消费，两层都过 manifest 校验。
 */

/** 某个目录来源的摘要（内置 resources 或 userData 覆盖层）。 */
export type CatalogArtifactSourceStatus = {
	/** 对应 pi-ai 包版本（manifest.source.packageVersion）；缺失/无效为 null */
	packageVersion: string | null;
	/** 有效模型条目数；缺失/无效为 null */
	entryCount: number | null;
};

/** 设置页「模型目录」状态卡片所需的整体状态。 */
export type CatalogUpdateStatus = {
	/** 打包/项目内置目录（resources） */
	builtin: CatalogArtifactSourceStatus | null;
	/** userData 覆盖层（更新版目录，仅校验通过时提供） */
	overlay: CatalogArtifactSourceStatus | null;
	/** 覆盖层文件存在（无论是否有效）——便于提示「本地有无效覆盖，建议还原」 */
	hasOverlayFiles: boolean;
	/** 是否存在上一个覆盖版备份（.bak），决定「恢复上一个覆盖版」按钮可用性 */
	hasBackup: boolean;
};

/** 更新/还原失败原因码：渲染层按码映射 i18n 文案，message 仅入日志。 */
export type CatalogUpdateFailCode =
	| "network" // 两个下载源（npm + 分支回退）都失败/超时
	| "validation" // 下载内容与 manifest 校验不过（防坏数据上盘）
	| "incompatible" // 远端产物 schemaVersion 与当前版本支持的版本不一致，需先升级 PiDeck
	| "write" // 磁盘写入失败
	| "no-backup"; // 没有可用备份（恢复上一个覆盖版时）

/** 检查结论里的远端来源：分支预生成件（branch）或 npm latest 回退（npm）。 */
export type CatalogCheckSourceId = "branch" | "npm";

export type CatalogUpdateResult =
	| {
			// updated=false 表示没有发生覆盖写：远端不高于当前生效版本
			ok: true;
			updated: boolean;
			/** updated=false 的原因：远端与当前一致 / 远端比当前旧（发布分支目录同步滞后） */
			skipped?: "already-latest" | "remote-behind";
			/** updated=false 时远端源给出的版本，供 UI 说明「谁落后」 */
			remoteVersion?: string | null;
			/** updated=false 时当前生效版本（覆盖层优先，否则内置） */
			localVersion?: string | null;
	  }
	| { ok: false; code: CatalogUpdateFailCode; message: string };

/** 「检查更新」结果：远端 manifest 比对当前生效版本。 */
export type CatalogCheckResult =
	| {
			ok: true;
			remoteVersion: string;
			localVersion: string | null;
			hasUpdate: boolean;
			/** 本次结论来自哪条源；分支不可达时的 npm 回退版本可能与仓库预生成件不同 */
			source?: CatalogCheckSourceId;
	  }
	| { ok: false; code: CatalogUpdateFailCode; message: string };
