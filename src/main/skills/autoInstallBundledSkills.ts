/**
 * 内置技能自动安装：启动时把随包技能模板（resources/skills/<name>/SKILL.md）落到用户技能目录，
 * 让 /skill:<name> 立刻可用。
 *
 * 为什么单独成模块：这是一组「启动期一次性副作用」，与主进程装配逻辑无关；
 * main/index.ts 是存量巨文件（口径：只准降不准升），新逻辑按仓库规矩放新模块。
 *
 * 两个目标位置，按技能的适用范围选，不是一律 pideck-global：
 * - pideck-global（~/.pi/agent/pideck-skills）：不在 pi 的自动发现根里，只有 PiDeck
 *   spawn 时以 --skill 注入，终端里直接启动的 pi（TUI）不会加载。桌面端专用技能用这个。
 * - pi-global：pi 自己的发现根，TUI 与 PiDeck 都能用。通用能力用这个。
 */
import type { SkillManager } from "./SkillManager";

/**
 * 内置技能清单：目录名即技能名，与 resources/skills/ 下的子目录一一对应。
 *
 * 每个技能带自己的目标位置。mcp-setup 必须是 pi-global：它讲的是 pi 的 mcp.json 与
 * `pi mcp list`，在 TUI 里同样要用。手动入口 configInstallMcpSetupSkill 一直显式传
 * "pi-global"，如果启动期自动安装走默认的 pideck-global，同一个技能就有两个入口装到
 * 两个位置，TUI 里 /skill:mcp-setup 不存在——装了却不在面。
 */
const BUNDLED_SKILLS = [
	{ name: "usage-probe", location: "pideck-global" },
	{ name: "image-gen", location: "pideck-global" },
	{ name: "pideck-doctor", location: "pideck-global" },
	{ name: "mcp-setup", location: "pi-global" },
	{ name: "pideck-web-api", location: "pideck-global" },
] as const;

interface BundledSkillLogger {
	info(scope: string, message: string, detail?: unknown): unknown;
	warn(scope: string, message: string, detail?: unknown): unknown;
}

/**
 * 逐个安装内置技能模板。fire-and-forget：失败只记日志，不阻塞启动。
 * 幂等：模板内容随应用更新同步覆盖，用户自定义配置在各自数据文件里，不受影响。
 */
export function autoInstallBundledSkills(skillManager: Pick<SkillManager, "installTemplate">, logger?: BundledSkillLogger | null): void {
	for (const { name, location } of BUNDLED_SKILLS) {
		void skillManager.installTemplate(name, location).then((result) => {
			if (result.success) logger?.info("skill", `Bundled skill auto-installed: ${name}`, { path: result.path, location });
			else logger?.warn("skill", `Bundled skill auto-install failed: ${name}`, { error: result.error, location });
		});
	}
}
