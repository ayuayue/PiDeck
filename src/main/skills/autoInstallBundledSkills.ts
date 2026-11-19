/**
 * 内置技能自动安装：启动时把随包技能模板（resources/skills/<name>/）落到用户技能目录，
 * 让 /skill:<name> 立刻可用。
 *
 * 为什么单独成模块：这是一组「启动期一次性副作用」，与主进程装配逻辑无关；
 * main/index.ts 是存量巨文件（口径：只准降不准升），新逻辑按仓库规矩放新模块。
 *
 * 两个目标位置，按技能的适用范围选，不是一律 pideck-global：
 * - pideck-global（~/.pi/agent/pideck-skills）：不在 pi 的自动发现根里，只有 PiDeck
 *   spawn 时以 --skill 注入，终端里直接启动的 pi（TUI）不会加载。桌面端专用技能用这个。
 * - pi-global：pi 自己的发现根，TUI 与 PiDeck 都能用。通用能力用这个。
 *
 * 2026-11-18：桌面端四个技能（image-gen / usage-probe / pideck-doctor / pideck-web-api）
 * 合并成一个 `pideck` 路由入口，正文拆到它的 references/ 下按需读取；旧副本按
 * RETIRED_BUNDLED_SKILLS 退役，`getBundledSkillLoadPaths` 同时按名单跳过，清不掉也不会重新注入。
 */
import type { SkillManager } from "./SkillManager";
import { BUNDLED_SKILLS, RETIRED_BUNDLED_SKILLS } from "./bundledSkills";

interface BundledSkillLogger {
	info(scope: string, message: string, detail?: unknown): unknown;
	warn(scope: string, message: string, detail?: unknown): unknown;
}

type BundledSkillInstaller = Pick<SkillManager, "installTemplate" | "retireBundledSkills">;

/**
 * 逐个安装内置技能模板。fire-and-forget：失败只记日志，不阻塞启动。
 * 幂等：模板内容随应用更新同步覆盖，用户自定义配置在各自数据文件里，不受影响。
 */
export function autoInstallBundledSkills(skillManager: BundledSkillInstaller, logger?: BundledSkillLogger | null): void {
	// 退役旧入口与安装新入口互不依赖：旧目录清不掉时，spawn 侧仍按名单跳过。
	void skillManager
		.retireBundledSkills(RETIRED_BUNDLED_SKILLS)
		.then((result) => {
			for (const name of result.removed) logger?.info("skill", `Retired bundled skill: ${name}`, { location: "pideck-global" });
			for (const failure of result.failed) logger?.warn("skill", `Bundled skill retirement failed: ${failure.name}`, { error: failure.error, location: "pideck-global" });
		})
		.catch((error: unknown) => {
			logger?.warn("skill", "Bundled skill retirement failed", { error: error instanceof Error ? error.message : String(error) });
		});

	for (const { name, location } of BUNDLED_SKILLS) {
		void skillManager.installTemplate(name, location).then((result) => {
			if (result.success) logger?.info("skill", `Bundled skill auto-installed: ${name}`, { path: result.path, location });
			else logger?.warn("skill", `Bundled skill auto-install failed: ${name}`, { error: result.error, location });
		});
	}
}
