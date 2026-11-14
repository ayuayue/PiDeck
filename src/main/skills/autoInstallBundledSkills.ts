/**
 * 内置技能自动安装：启动时把随包技能模板（resources/skills/<name>/SKILL.md）落到用户技能目录，
 * 让 /skill:<name> 立刻可用。
 *
 * 为什么单独成模块：这是一组「启动期一次性副作用」，与主进程装配逻辑无关；
 * main/index.ts 是存量巨文件（口径：只准降不准升），新逻辑按仓库规矩放新模块。
 *
 * 目标位置：pideck-global（~/.pi/agent/pideck-skills）。该目录不在 pi 的自动发现根里，
 * 只有 PiDeck spawn 时以 --skill 注入，终端里直接启动的 pi（TUI）不会加载。
 */
import type { SkillManager } from "./SkillManager";

/** 内置技能清单：目录名即技能名，与 resources/skills/ 下的子目录一一对应。 */
const BUNDLED_SKILLS = ["usage-probe", "image-gen", "pideck-doctor", "pideck-web-api"] as const;

interface BundledSkillLogger {
	info(scope: string, message: string, detail?: unknown): unknown;
	warn(scope: string, message: string, detail?: unknown): unknown;
}

/**
 * 逐个安装内置技能模板。fire-and-forget：失败只记日志，不阻塞启动。
 * 幂等：模板内容随应用更新同步覆盖，用户自定义配置在各自数据文件里，不受影响。
 */
export function autoInstallBundledSkills(skillManager: Pick<SkillManager, "installTemplate">, logger?: BundledSkillLogger | null): void {
	for (const name of BUNDLED_SKILLS) {
		void skillManager.installTemplate(name).then((result) => {
			if (result.success) logger?.info("skill", `Bundled skill auto-installed: ${name}`, { path: result.path });
			else logger?.warn("skill", `Bundled skill auto-install failed: ${name}`, { error: result.error });
		});
	}
}
