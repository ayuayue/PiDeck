/**
 * 内置技能热更新器（技能管理页「内置技能」更新入口）。
 *
 * 随包分发的内置技能（resources/skills/<name>/SKILL.md）在应用启动时被复制到用户
 * 全局技能目录（~/.pi/agent/skills/）供 pi 发现加载；热更新把远端有差异的技能写进
 * `<userData>/skills-overlay` 覆盖层，SkillManager 安装模板时覆盖层优先——
 * 技能修 bug 或新增技能都不用等发版。
 *
 * allowNewFiles=true：技能是文档不是注入代码，远端**新增**的技能目录也可以安装
 * （复制到用户技能目录后 pi 自然发现），这是技能热更新区别于扩展热更新的核心价值。
 */

import { BuiltinContentUpdater } from "../updates/builtinContentUpdater";
import type { UpdateSourceId } from "../../shared/types/settings";

/** 覆盖层目录名（userData 下）。 */
export const SKILL_OVERLAY_DIR_NAME = "skills-overlay";
/** 备份目录名（userData 下）。 */
export const SKILL_OVERLAY_BACKUP_DIR_NAME = "skills-overlay.bak";
/** 清单文件名（远端与内置目录同名）。 */
export const SKILLS_MANIFEST_FILE_NAME = "skills-manifest.json";
/** 内置技能在 PiDeck 仓库中的相对目录（与 resources/skills 一致）。 */
const SKILLS_REPO_DIR = "resources/skills";
/** 技能文件形态：多段相对路径（<skill-dir>/SKILL.md），单段或带子目录均可。 */
const SKILL_FILE_PATTERN = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

export class SkillStoreUpdater {
	private readonly updater: BuiltinContentUpdater;

	constructor(options: {
		userDataDir: string;
		builtinSkillsDir: string;
		source?: () => UpdateSourceId;
		fetchImpl?: typeof fetch;
	}) {
		this.updater = new BuiltinContentUpdater({
			userDataDir: options.userDataDir,
			builtinDir: options.builtinSkillsDir,
			overlayDirName: SKILL_OVERLAY_DIR_NAME,
			backupDirName: SKILL_OVERLAY_BACKUP_DIR_NAME,
			manifestFileName: SKILLS_MANIFEST_FILE_NAME,
			repoDir: SKILLS_REPO_DIR,
			fileNamePattern: SKILL_FILE_PATTERN,
			// 技能是文档不是注入代码：允许远端新增技能目录（装进 ~/.pi/agent/skills 后 pi 自然发现）
			allowNewFiles: true,
			source: options.source,
			fetchImpl: options.fetchImpl,
		});
	}

	resolveOverlayDir(): string {
		return this.updater.resolveOverlayDir();
	}

	/** 安装侧入口：返回校验通过的有效覆盖层目录，否则 null（SkillManager 安装模板时优先）。 */
	resolveEffectiveOverlayDir(): string | null {
		return this.updater.resolveEffectiveOverlayDir();
	}

	/** 当前生效目录（覆盖层校验通过则覆盖层，否则内置；IPC「打开目录」用）。 */
	resolveEffectiveDir(): string {
		return this.updater.resolveEffectiveDir();
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
