/**
 * 提示词商店官方模板热更新器（提示词商店页「官方模板」更新入口）。
 *
 * 随包分发的官方模板（resources/prompts/*.md，由 scripts/generate-prompts-manifest.mjs
 * 从 docs/pi-prompt-templates/ 生成）与 xueprompts.db 一同作为商店数据的**基线**；
 * 热更新把远端有差异的模板写进 `<userData>/prompt-overlay` 覆盖层，
 * XuePromptManager 查询时对同名 slug 覆盖层优先——模板修 bug 不用等发版。
 *
 * allowNewFiles=true：新增官方模板也允许落盘（内容类资源，安全面与扩展注入代码不同；
 * 新模板会作为新 slug 出现在商店列表里）。
 */

import { BuiltinContentUpdater, type BuiltinContentUpdaterOptions } from "../updates/builtinContentUpdater";
import type { UpdateSourceId } from "../../shared/types/settings";

/** 覆盖层目录名（userData 下）。 */
export const PROMPT_OVERLAY_DIR_NAME = "prompt-overlay";
/** 备份目录名（userData 下）。 */
export const PROMPT_OVERLAY_BACKUP_DIR_NAME = "prompt-overlay.bak";
/** 清单文件名（远端与内置目录同名）。 */
export const PROMPTS_MANIFEST_FILE_NAME = "prompts-manifest.json";
/** 官方模板在 PiDeck 仓库中的相对目录（与 resources/prompts 一致）。 */
const PROMPTS_REPO_DIR = "resources/prompts";
/** 官方模板文件形态：单段 .md（slug 即文件名去后缀）。 */
const PROMPT_FILE_PATTERN = /^[A-Za-z0-9._-]+\.md$/;

export class PromptStoreUpdater {
	private readonly updater: BuiltinContentUpdater;

	constructor(options: {
		userDataDir: string;
		builtinPromptsDir: string;
		source?: () => UpdateSourceId;
		fetchImpl?: typeof fetch;
	}) {
		this.updater = new BuiltinContentUpdater({
			userDataDir: options.userDataDir,
			builtinDir: options.builtinPromptsDir,
			overlayDirName: PROMPT_OVERLAY_DIR_NAME,
			backupDirName: PROMPT_OVERLAY_BACKUP_DIR_NAME,
			manifestFileName: PROMPTS_MANIFEST_FILE_NAME,
			repoDir: PROMPTS_REPO_DIR,
			fileNamePattern: PROMPT_FILE_PATTERN,
			// 官方模板是内容不是注入代码：允许远端新增模板（以新 slug 出现在商店）
			allowNewFiles: true,
			source: options.source,
			fetchImpl: options.fetchImpl,
		});
	}

	resolveOverlayDir(): string {
		return this.updater.resolveOverlayDir();
	}

	/** 查询侧入口：返回校验通过的有效覆盖层目录，否则 null（XuePromptManager 叠加用）。 */
	resolveEffectiveOverlayDir(): string | null {
		return this.updater.resolveEffectiveOverlayDir();
	}

	/** 当前生效目录（覆盖层校验通过则覆盖层，否则内置；IPC「打开目录」用）。 */
	resolveEffectiveDir(): string {
		return this.updater.resolveEffectiveDir();
	}

	/** 提示词商店文件在仓库中的目录（供 manifest 生成脚本使用）。 */
	static get repoDir(): string {
		return PROMPTS_REPO_DIR;
	}

	getStatus() {
		return this.updater.getStatus();
	}

	checkRemote(branch?: string) {
		return this.updater.checkRemote(branch);
	}

	update(branch?: string) {
		return this.updater.update(branch);
	}

	restoreBuiltin() {
		return this.updater.restoreBuiltin();
	}

	restorePrevious() {
		return this.updater.restorePrevious();
	}
}
