/**
 * 随包分发的内置技能清单（安装目标 + 已退役名单）。
 *
 * 为什么单独成模块：自动安装、spawn 时的 `--skill` 过滤与单测要读同一份名单。
 * 散在两处时，退役一个技能只要漏掉过滤侧，就会继续被 `--skill` 注入——技能虽然
 * 从安装包删了，用户目录里的旧副本仍然常驻上下文。
 */

/** 内置技能的安装目标：pideck-global 只给 PiDeck 用，pi-global 与终端 pi 共用。 */
export type BundledSkillLocationId = "pideck-global" | "pi-global";

export interface BundledSkillDefinition {
	name: string;
	location: BundledSkillLocationId;
}

/**
 * 内置技能：目录名即技能名，与 resources/skills/ 下带 SKILL.md 的子目录一一对应。
 *
 * pideck 是路由入口（正文在 references/ 下按需读取），取代了原来四个独立技能；
 * mcp-setup 讲的是 pi 的 mcp.json 与 `pi mcp list`，终端里的 TUI 也要用，必须装进
 * pi-global。手动入口 configInstallMcpSetupSkill 同样显式传 "pi-global"。
 */
export const BUNDLED_SKILLS: readonly BundledSkillDefinition[] = [
	{ name: "pideck", location: "pideck-global" },
	{ name: "mcp-setup", location: "pi-global" },
];

/**
 * 已并入 pideck 路由技能的旧入口。
 *
 * 升级后必须把用户目录里的旧副本清掉并停止注入，否则 `/skill:` 列表里仍是四个技能，
 * 每个的名字与描述照旧常驻系统提示词——合并成路由入口省 token 的目的就落空了。
 * 这里只放「确定由 PiDeck 自己安装过」的名字；用户手工建的技能不在此列。
 */
export const RETIRED_BUNDLED_SKILLS: readonly string[] = ["usage-probe", "image-gen", "pideck-doctor", "pideck-web-api"];
