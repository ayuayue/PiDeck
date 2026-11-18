import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const loadTsModule = createTsSandbox({ stubs: { "./SkillManager": {} } });

/** 让 fire-and-forget 的 Promise 链跑完（安装是 void 调用，不做 await）。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 旧入口名单：这里写死而不是从产品模块导入——产品名单被整体改掉时，测试才会红。 */
const RETIRED = ["usage-probe", "image-gen", "pideck-doctor", "pideck-web-api"];

function createManager(overrides = {}) {
	const calls = { installed: [], retired: [] };
	const manager = {
		installTemplate: (name, location) => {
			calls.installed.push({ name, location });
			return Promise.resolve({ success: true, path: `/tmp/${name}/SKILL.md` });
		},
		retireBundledSkills: (names) => {
			calls.retired.push([...names]);
			return Promise.resolve({ removed: [...names], failed: [] });
		},
		...overrides,
	};
	return { manager, calls };
}

test("autoInstallBundledSkills 按名字安装全部内置技能", async () => {
	const { autoInstallBundledSkills } = loadTsModule("src/main/skills/autoInstallBundledSkills.ts");
	const { manager, calls } = createManager();
	const logs = [];
	autoInstallBundledSkills(manager, {
		info: (scope, message, detail) => logs.push({ level: "info", scope, message, detail }),
		warn: (scope, message, detail) => logs.push({ level: "warn", scope, message, detail }),
	});
	await settle();
	// 坏样本：从 BUNDLED_SKILLS 删掉任一项（例如 mcp-setup），本断言立刻红。
	assert.deepEqual(calls.installed.map((entry) => entry.name).sort(), ["mcp-setup", "pideck"]);
	assert.ok(
		logs.filter((entry) => entry.message.startsWith("Bundled skill auto-installed")).every((entry) => entry.level === "info" && entry.scope === "skill"),
		"安装成功应逐条记 info：技能名漏登记时能直接定位",
	);
	assert.equal(logs.filter((entry) => entry.level === "warn").length, 0);
});

test("模板安装失败只记 warn，不抛异常、不中断其余技能", async () => {
	const { autoInstallBundledSkills } = loadTsModule("src/main/skills/autoInstallBundledSkills.ts");
	const logs = [];
	autoInstallBundledSkills(
		{
			installTemplate: () => Promise.resolve({ success: false, error: "boom" }),
			retireBundledSkills: () => Promise.resolve({ removed: [], failed: [] }),
		},
		{ info: () => logs.push({ level: "info" }), warn: (scope, message, detail) => logs.push({ level: "warn", scope, message, detail }) },
	);
	await settle();
	assert.equal(logs.filter((entry) => entry.level === "warn").length, 2, "两个技能各记一条 warn");
});

/**
 * 目标位置不能一律走默认值。mcp-setup 讲的是 pi 的 mcp.json 与 `pi mcp list`，在 TUI 里同样要用；
 * 手动入口 configInstallMcpSetupSkill 一直显式传 "pi-global"。自动安装若走默认 "pideck-global"，
 * 同一个技能就有两个入口装到两个位置：TUI 里 /skill:mcp-setup 不存在，而且不报错。
 */
test("pideck 装进 pideck-global，mcp-setup 装进 pi-global", async () => {
	const { autoInstallBundledSkills } = loadTsModule("src/main/skills/autoInstallBundledSkills.ts");
	const { manager, calls } = createManager();
	autoInstallBundledSkills(manager, null);
	await settle();
	const where = new Map(calls.installed.map((entry) => [entry.name, entry.location]));
	assert.equal(where.get("mcp-setup"), "pi-global", "mcp-setup 必须在 pi-global：TUI 里也要能用 /skill:mcp-setup");
	assert.equal(where.get("pideck"), "pideck-global", "pideck 是桌面端路由入口，装进 pideck-global");
});

/**
 * 旧入口必须退役：四个旧技能的名字与描述会常驻系统提示词。
 * 合并成 pideck 之后如果还留着旧副本，省 token 的目的就落空了。
 * 坏样本：删掉 retireBundledSkills 调用、或把名单缩成一个，本断言立刻红。
 */
test("启动时退役并入 pideck 的四个旧入口", async () => {
	const { autoInstallBundledSkills } = loadTsModule("src/main/skills/autoInstallBundledSkills.ts");
	const { manager, calls } = createManager();
	autoInstallBundledSkills(manager, null);
	await settle();
	assert.deepEqual(calls.retired, [RETIRED], "一次调用传全部旧入口名，启动日志才能逐条点名");
	// 旧入口不能再出现在安装清单里：否则刚退役又被装回来。
	const installedNames = calls.installed.map((entry) => entry.name);
	for (const retired of RETIRED) assert.equal(installedNames.includes(retired), false, `${retired} 仍在 BUNDLED_SKILLS`);
});

test("退役失败只记 warn，不影响新技能安装", async () => {
	const { autoInstallBundledSkills } = loadTsModule("src/main/skills/autoInstallBundledSkills.ts");
	const logs = [];
	const installed = [];
	autoInstallBundledSkills(
		{
			installTemplate: (name) => {
				installed.push(name);
				return Promise.resolve({ success: true, path: "/tmp/" + name });
			},
			retireBundledSkills: () => Promise.resolve({ removed: ["usage-probe"], failed: [{ name: "image-gen", error: "EBUSY" }] }),
		},
		{ info: (scope, message, detail) => logs.push({ level: "info", scope, message, detail }), warn: (scope, message, detail) => logs.push({ level: "warn", scope, message, detail }) },
	);
	await settle();
	assert.match(logs.find((entry) => entry.level === "warn")?.message ?? "", /retirement failed: image-gen/);
	assert.equal(installed.length, 2, "退役失败不能拖住安装");
});

/**
 * 路由表是新的契约：SKILL.md 指向的每份 references 都必须真实存在。
 * 路径写错时安装照常成功、pi 也照常加载 SKILL.md，只有模型真去读参考时才失败——
 * 那是用户侧才发现、且表现为「技能没讲清楚」，不是报错。
 */
test("pideck 路由表指向的 references 都真实存在", async () => {
	const dir = new URL("../resources/skills/pideck/", import.meta.url);
	const raw = readFileSync(new URL("SKILL.md", dir), "utf8");
	const refs = [...raw.matchAll(/`(references\/[^`]+)`/g)].map((match) => match[1]);
	assert.ok(refs.length >= 4, "路由表至少应指向四份参考（生图 / 用量 / 诊断 / web-api）");
	for (const rel of refs) {
		assert.equal(existsSync(new URL(rel, dir)), true, `路由指向不存在的文件：${rel}`);
	}
});

/**
 * 清单与目录对拍：resources/skills 下有 SKILL.md 的目录，必须都进 BUNDLED_SKILLS。
 * 第一条测试硬编码名字，只能抓「删掉某一项」，抓不到「新增了技能目录但忘了登记」——
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
	const { manager, calls } = createManager();
	autoInstallBundledSkills(manager, null);
	await settle();
	const installed = calls.installed.map((entry) => entry.name).sort();
	assert.deepEqual(installed, onDisk, "resources/skills 下有目录没进 BUNDLED_SKILLS：用户装完 /skill: 里看不到它，且不报错。缺的是 " + onDisk.filter((name) => !installed.includes(name)).join("、"));
});
