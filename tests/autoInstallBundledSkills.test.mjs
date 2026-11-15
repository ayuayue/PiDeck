import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import test from "node:test";

import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const loadTsModule = createTsSandbox({ stubs: { "./SkillManager": {} } });

/** 让 fire-and-forget 的 Promise 链跑完（安装是 void 调用，不做 await）。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("autoInstallBundledSkills 按名字安装全部内置技能", async () => {
	const { autoInstallBundledSkills } = loadTsModule("src/main/skills/autoInstallBundledSkills.ts");
	const called = [];
	const logs = [];
	autoInstallBundledSkills(
		{
			installTemplate: (name) => {
				called.push(name);
				return Promise.resolve({ success: true, path: `/tmp/${name}/SKILL.md` });
			},
		},
		{
			info: (scope, message, detail) => logs.push({ level: "info", scope, message, detail }),
			warn: (scope, message, detail) => logs.push({ level: "warn", scope, message, detail }),
		},
	);
	await settle();
	// 坏样本：从 BUNDLED_SKILLS 删掉任一项（例如 pideck-web-api），本断言立刻红。
	assert.deepEqual([...called].sort(), ["image-gen", "mcp-setup", "pideck-doctor", "pideck-web-api", "usage-probe"]);
	assert.ok(
		logs.every((entry) => entry.level === "info" && entry.scope === "skill"),
		"安装成功应逐条记 info：技能名漏登记时能直接定位",
	);
});

test("模板安装失败只记 warn，不抛异常、不中断其余技能", async () => {
	const { autoInstallBundledSkills } = loadTsModule("src/main/skills/autoInstallBundledSkills.ts");
	const logs = [];
	autoInstallBundledSkills({ installTemplate: () => Promise.resolve({ success: false, error: "boom" }) }, { info: () => logs.push({ level: "info" }), warn: (scope, message, detail) => logs.push({ level: "warn", scope, message, detail }) });
	await settle();
	assert.equal(logs.filter((entry) => entry.level === "warn").length, 5, "五个技能各记一条 warn");
});

/**
 * 目标位置不能一律走默认值。mcp-setup 讲的是 pi 的 mcp.json 与 `pi mcp list`，在 TUI 里同样要用；
 * 手动入口 configInstallMcpSetupSkill 一直显式传 "pi-global"。自动安装若走默认 "pideck-global"，
 * 同一个技能就有两个入口装到两个位置：TUI 里 /skill:mcp-setup 不存在，而且不报错。
 * 坏样本：把 BUNDLED_SKILLS 里 mcp-setup 的 location 改回 "pideck-global"，本断言红。
 */
test("mcp-setup 装进 pi-global，其余装进 pideck-global", async () => {
	const { autoInstallBundledSkills } = loadTsModule("src/main/skills/autoInstallBundledSkills.ts");
	const where = new Map();
	autoInstallBundledSkills(
		{
			installTemplate: (name, location) => {
				where.set(name, location);
				return Promise.resolve({ success: true, path: "/tmp/" + name });
			},
		},
		null,
	);
	await settle();
	assert.equal(where.get("mcp-setup"), "pi-global", "mcp-setup 必须在 pi-global：TUI 里也要能用 /skill:mcp-setup");
	assert.deepEqual(
		[...where].filter(([name]) => name !== "mcp-setup").map(([, location]) => location),
		["pideck-global", "pideck-global", "pideck-global", "pideck-global"],
		"其余四个技能是桌面端专用，装进 pideck-global",
	);
});

/**
 * 清单与目录对拍：resources/skills 下有 SKILL.md 的目录，必须都进 BUNDLED_SKILLS。
 * 第一条测试硬编码五个名字，只能抓「删掉某一项」，抓不到「新增了技能目录但忘了登记」——
 * 那是真实会发生的方向：新技能随包发出，用户装完却在 /skill: 里看不到它，没有任何报错。
 * 注释写「与 resources/skills 下的子目录一一对应」，这条把注释变成可执行的判据。
 */
test("BUNDLED_SKILLS 与 resources/skills 目录一一对应", async () => {
	const dir = new URL("../resources/skills/", import.meta.url);
	const onDisk = readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && existsSync(new URL(entry.name + "/SKILL.md", dir)))
		.map((entry) => entry.name)
		.sort();
	const { autoInstallBundledSkills } = loadTsModule("src/main/skills/autoInstallBundledSkills.ts");
	const called = [];
	autoInstallBundledSkills(
		{
			installTemplate: (name) => {
				called.push(name);
				return Promise.resolve({ success: true, path: "/tmp/" + name });
			},
		},
		null,
	);
	await settle();
	assert.deepEqual([...called].sort(), onDisk, "resources/skills 下有目录没进 BUNDLED_SKILLS：用户装完 /skill: 里看不到它，且不报错。缺的是 " + onDisk.filter((name) => !called.includes(name)).join("、"));
});
