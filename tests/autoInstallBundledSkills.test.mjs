import assert from "node:assert/strict";
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
	assert.deepEqual([...called].sort(), ["image-gen", "pideck-doctor", "pideck-web-api", "usage-probe"]);
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
	assert.equal(logs.filter((entry) => entry.level === "warn").length, 4, "四个技能各记一条 warn");
});
