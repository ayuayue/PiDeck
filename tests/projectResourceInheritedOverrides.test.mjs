/**
 * 项目作用域「停用继承的全局资源」的读写契约（T7-3 回归）。
 *
 * 历史缺陷（2026-10-04 实测）：渲染层把 PiDeck 身份键（pi-global:<名>）当路径传给原生规则，
 * pi 不认这种值 → 项目层停用继承技能完全不生效；同时读回还盯着已无人写入的
 * pideckDisabledGlobal* 私有字段 → 开关状态永远不更新。本文件锁定修复后的契约：
 * 写「绝对路径 plain + -路径」，读「原生 ± 规则」，旧私有字段只作未迁移兜底。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { projectResourceOverridesFromRecord } = loadTsCommonJs("src/main/projects/projectResourceOverrides.ts");
const { ProjectResourceManager } = loadTsCommonJs("src/main/projects/ProjectResourceManager.ts");

test("原生 ± 规则解析为停用集合；历史身份键形态不算停用（pi 不认，实际并未停用）", () => {
	const overrides = projectResourceOverridesFromRecord({
		skills: [
			"/home/u/.pi/agent/skills/image-gen/SKILL.md",
			"-/home/u/.pi/agent/skills/image-gen/SKILL.md",
			"-pi-global:legacy", // 历史缺陷形态：忽略
		],
		prompts: ["-/home/u/.pi/agent/prompts/x.md"],
		extensions: ["-/home/u/ext.ts"],
	});
	assert.deepEqual([...overrides.disabledGlobalSkills], ["/home/u/.pi/agent/skills/image-gen/skill.md"]);
	assert.deepEqual([...overrides.disabledGlobalPrompts], ["/home/u/.pi/agent/prompts/x.md"]);
	assert.deepEqual([...overrides.disabledGlobalExtensions], ["/home/u/ext.ts"]);
});

test("未迁移旧文件的私有字段仍作兜底（迁移会清掉它们）", () => {
	const overrides = projectResourceOverridesFromRecord({ pideckDisabledGlobalSkills: ["pi-global:legacy"] });
	assert.deepEqual([...overrides.disabledGlobalSkills], ["pi-global:legacy"]);
});

test("native 分支：toggleInheritedResource 写「路径 plain + -路径」，回读按路径报停用", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-inherited-"));
	try {
		const settingsPath = join(root, ".pi", "settings.json");
		mkdirSync(join(root, ".pi"), { recursive: true });
		writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));
		const project = { id: "p1", name: "P1", path: root, lastOpenedAt: 1 };
		const manager = new ProjectResourceManager(
			(projectId) => (projectId === "p1" ? project : undefined),
			() => "Project resource operation failed.",
			undefined,
			{},
			{
				setFileResourceEnabled: async () => ({ ok: true }),
				// 契约是位置参数（projectId, kind, value, state）；index.ts 的真实适配器才包成对象传给 service
				setInheritedOverride: async (projectId, kind, value, state) => {
					// 断言写进原生数组的是路径（含大小写原样），不是身份键
					assert.equal(projectId, "p1");
					assert.equal(kind, "skills");
					assert.equal(value, "/home/u/.pi/agent/skills/image-gen/SKILL.md");
					assert.equal(state, "disabled");
					const current = JSON.parse(readFileSync(settingsPath, "utf8"));
					current.skills = [value, `-${value}`];
					writeFileSync(settingsPath, JSON.stringify(current, null, 2));
					return { ok: true };
				},
				readEntries: () => [],
			},
		);
		const overrides = await manager.toggleInheritedResource({ projectId: "p1", kind: "skill", key: "/home/u/.pi/agent/skills/image-gen/SKILL.md", enabled: false });
		const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
		assert.deepEqual(settings.skills, ["/home/u/.pi/agent/skills/image-gen/SKILL.md", "-/home/u/.pi/agent/skills/image-gen/SKILL.md"]);
		assert.ok(overrides.disabledGlobalSkills.includes("/home/u/.pi/agent/skills/image-gen/skill.md"), "回读必须按路径报停用");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
