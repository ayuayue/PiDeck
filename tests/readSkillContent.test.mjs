// readSkillContent 白名单校验 + 大小上限测试：
// 渲染层传来的路径不可信，目录必须落在全局技能位置或项目 .pi/skills/.agents/skills 下，
// 其它任意路径必须拒绝；正文超长时截断（防止渲染进程拿全量大文件）。
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readSkillContent } from "../src/main/skills/readSkillContent.ts";

test("合法位置可读：全局技能目录与项目技能目录", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pid-skill-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const globalSkills = join(home, ".pi", "agent", "skills");
	const projectRoot = join(home, "proj");
	const projectPi = join(projectRoot, ".pi", "skills");
	const projectAgents = join(projectRoot, ".agents", "skills");
	for (const dir of [globalSkills, projectPi, projectAgents]) {
		await mkdir(dir, { recursive: true });
	}
	await mkdir(join(globalSkills, "grill-me"), { recursive: true });
	await mkdir(join(projectPi, "x"), { recursive: true });
	await mkdir(join(projectAgents, "y"), { recursive: true });
	await writeFile(join(globalSkills, "grill-me", "SKILL.md"), "---\nname: grill-me\n---\nBody", "utf8");
	await writeFile(join(projectPi, "x", "SKILL.md"), "Project pi skill", "utf8");
	await writeFile(join(projectAgents, "y", "SKILL.md"), "Project agents skill", "utf8");
	const deps = {
		globalSkillPaths: [globalSkills],
		projectRootPaths: [projectRoot],
	};

	assert.equal((await readSkillContent(join(globalSkills, "grill-me", "SKILL.md"), deps)).content, "---\nname: grill-me\n---\nBody");
	assert.equal((await readSkillContent(join(projectPi, "x", "SKILL.md"), deps)).content, "Project pi skill");
	assert.equal((await readSkillContent(join(projectAgents, "y", "SKILL.md"), deps)).content, "Project agents skill");
});

test("白名单外路径拒绝：项目根之外、任意用户路径、仅前缀相似目录", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pid-skill-reject-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const globalSkills = join(home, ".pi", "agent", "skills");
	const projectRoot = join(home, "proj");
	await mkdir(join(globalSkills, "a", "SKILL.md"), { recursive: true });
	await mkdir(join(projectRoot, ".pi", "skills", "b", "SKILL.md"), { recursive: true });
	await writeFile(join(home, "secret.md"), "secret", "utf8");
	const deps = { globalSkillPaths: [globalSkills], projectRootPaths: [projectRoot] };

	// 任意用户路径（如项目外的秘密文件）必须拒绝
	await assert.rejects(() => readSkillContent(join(home, "secret.md"), deps));
	// 不在已注册项目下的目录（home/skill/... 与全局目录不同名）
	await assert.rejects(() => readSkillContent(join(home, "hacker", "SKILL.md"), deps));
	// 项目技能只允许 .pi/skills 与 .agents/skills：同目录前缀但不在白名单下也要拒绝
	await mkdir(join(projectRoot, ".pi", "other"), { recursive: true });
	await writeFile(join(projectRoot, ".pi", "other", "SKILL.md"), "x", "utf8");
	await assert.rejects(() => readSkillContent(join(projectRoot, ".pi", "other", "SKILL.md"), deps));
});

test("超长正文截断：超过 64KB 只返回前 64KB", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pid-skill-big-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const globalSkills = join(home, ".pi", "agent", "skills");
	const skillPath = join(globalSkills, "big", "SKILL.md");
	await mkdir(join(globalSkills, "big"), { recursive: true });
	await writeFile(skillPath, "x".repeat(80 * 1024), "utf8");
	const result = await readSkillContent(skillPath, { globalSkillPaths: [globalSkills], projectRootPaths: [] });
	assert.equal(result.content.length, 64 * 1024);
});

test("截断必须发生在读盘阶段（句柄定位读，不整文件进内存）", async () => {
	const source = readFileSync(new URL("../src/main/skills/readSkillContent.ts", import.meta.url), "utf8");
	assert.match(source, /handle\.read\(buf, 0, MAX_SKILL_CONTENT_BYTES, 0\)/, "应用句柄定位读读取文件头");
	assert.ok(!source.includes("readFile(skillPath"), "禁止全量 readFile 后再截断（截断前整文件已在内存）");
});
