import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/** 加载 skillWhitelistResolver.ts（技能白名单路径解析，纯 fs 逻辑）。 */
function loadResolverModule() {
	return loadTsCommonJs("src/main/skills/skillWhitelistResolver.ts");
}

/** 在临时根下构造 ~/.pi/agent + ~/.agents + <cwd>/.pi 项目目录骨架。 */
function setupFixtures() {
	const root = mkdtempSync(join(tmpdir(), "pideck-skill-resolver-"));
	const home = root; // 模拟 HOME：~/.pi/agent 落在 root/.pi/agent
	const agentDir = join(home, ".pi", "agent");
	const cwd = join(root, "project");
	// 在临时根建 .git：祖先 .agents/skills 扫描到 git repo root 即止，
	// 避免测试沿真实文件系统爬到用户目录（隔离性 + 确定性）。
	mkdirSync(join(root, ".git"), { recursive: true });
	mkdirSync(join(agentDir, "skills"), { recursive: true });
	mkdirSync(join(home, ".agents", "skills"), { recursive: true });
	mkdirSync(join(cwd, ".pi", "skills"), { recursive: true });
	mkdirSync(join(cwd, ".agents", "skills"), { recursive: true });
	const put = (rel, content = "{}") => {
		const full = join(root, rel);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content, "utf8");
		return full;
	};
	const mkdir = (rel) => {
		const full = join(root, rel);
		mkdirSync(full, { recursive: true });
		return full;
	};
	return { root, home, agentDir, cwd, put, mkdir };
}

function same(actual, expected) {
	// vm 沙箱数组与主 realm deepStrictEqual 可能因原型不同失败
	assert.deepEqual([...actual].sort(), [...expected].sort());
}

function skillMd(dir, name, extraFrontmatter = "") {
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "SKILL.md"),
		`---\nname: ${name}\ndescription: ${name} description\n${extraFrontmatter}---\n\n# ${name}\n`,
		"utf8",
	);
}

test("无禁用项时关闭白名单（返回 null）", () => {
	const { resolveEnabledSkillPaths } = loadResolverModule();
	const { root, home, cwd } = setupFixtures();
	try {
		const result = resolveEnabledSkillPaths({ agentHomeDir: home, cwd, disabledNames: [] });
		assert.equal(result, null);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("有禁用项时枚举全局/项目技能并剔除禁用项", () => {
	const { resolveEnabledSkillPaths } = loadResolverModule();
	const { root, home, agentDir, cwd } = setupFixtures();
	try {
		// 全局 ~/.pi/agent/skills：目录技能 + 顶层 md 根技能（pi 模式）
		skillMd(join(agentDir, "skills", "usage-probe"), "usage-probe");
		skillMd(join(agentDir, "skills", "keep-me"), "keep-me");
		skillMd(join(agentDir, "skills", "disabled-one"), "disabled-one");
		writeFileSync(
			join(agentDir, "skills", "root-skill.md"),
			"---\nname: root-skill\ndescription: root skill\n---\n\n# root\n",
			"utf8",
		);
		// ~/.agents/skills：嵌套目录技能算，顶层 md 忽略
		skillMd(join(home, ".agents", "skills", "agents-skill"), "agents-skill");
		writeFileSync(
			join(home, ".agents", "skills", "agents-root.md"),
			"---\nname: agents-root\ndescription: ignored\n---\n",
			"utf8",
		);
		// 项目 .pi/skills（pi 模式）
		skillMd(join(cwd, ".pi", "skills", "project-skill"), "project-skill");

		const result = resolveEnabledSkillPaths({
			agentHomeDir: home,
			cwd,
			disabledNames: ["disabled-one"],
		});
		assert.ok(result, "有禁用项时必须启用白名单");
		same(result, [
			join(agentDir, "skills", "usage-probe", "SKILL.md"),
			join(agentDir, "skills", "keep-me", "SKILL.md"),
			join(agentDir, "skills", "root-skill.md"),
			join(home, ".agents", "skills", "agents-skill", "SKILL.md"),
			join(cwd, ".pi", "skills", "project-skill", "SKILL.md"),
		]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("frontmatter 的 disable-model-invocation（老版禁用语义）同样被排除", () => {
	const { resolveEnabledSkillPaths } = loadResolverModule();
	const { root, home, agentDir, cwd } = setupFixtures();
	try {
		skillMd(join(agentDir, "skills", "frontmatter-disabled"), "frontmatter-disabled", "disable-model-invocation: true\n");
		skillMd(join(agentDir, "skills", "normal"), "normal");

		const result = resolveEnabledSkillPaths({ agentHomeDir: home, cwd, disabledNames: [] });
		// 无 settings 禁用但 frontmatter 禁用 → 仍启用白名单且排除该技能
		assert.ok(result);
		same(result, [join(agentDir, "skills", "normal", "SKILL.md")]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("项目 .pi/settings.json 的 disabledSkills 生效且名称大小写不敏感", () => {
	const { resolveEnabledSkillPaths } = loadResolverModule();
	const { root, home, agentDir, cwd, put } = setupFixtures();
	try {
		skillMd(join(agentDir, "skills", "global-a"), "global-a");
		skillMd(join(cwd, ".pi", "skills", "project-disabled"), "Project-Disabled");
		put(
			"project/.pi/settings.json",
			JSON.stringify({ disabledSkills: ["project-disabled"] }),
		);

		const result = resolveEnabledSkillPaths({ agentHomeDir: home, cwd, disabledNames: [] });
		assert.ok(result);
		same(result, [join(agentDir, "skills", "global-a", "SKILL.md")]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("settings.json 的 skills 数组显式路径参与白名单枚举", () => {
	const { resolveEnabledSkillPaths } = loadResolverModule();
	const { root, home, agentDir, cwd, put, mkdir } = setupFixtures();
	try {
		skillMd(join(agentDir, "skills", "global-a"), "global-a");
		// 显式声明的独立技能文件 + 显式声明的目录
		writeFileSync(
			join(cwd, ".pi", "explicit-skill.md"),
			"---\nname: project-explicit\ndescription: explicit skill\n---\n",
			"utf8",
		);
		const explicitDir = mkdir("explicit-dir");
		skillMd(explicitDir, "explicit-dir-skill");
		put("project/.pi/settings.json", JSON.stringify({ skills: ["explicit-skill.md"] }));
		put(".pi/agent/settings.json", JSON.stringify({ skills: [explicitDir] }));

		const result = resolveEnabledSkillPaths({ agentHomeDir: home, cwd, disabledNames: ["missing"] });
		assert.ok(result);
		// Project-relative paths resolve from <cwd>/.pi; the explicit global directory is also retained.
		same(result, [
			join(agentDir, "skills", "global-a", "SKILL.md"),
			join(explicitDir, "SKILL.md"),
			join(cwd, ".pi", "explicit-skill.md"),
		]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("npm 包内的 skills/ 目录与 pi.skills 声明参与枚举（不存在的包目录跳过）", () => {
	const { resolveEnabledSkillPaths } = loadResolverModule();
	const { root, home, agentDir, cwd, put, mkdir } = setupFixtures();
	try {
		skillMd(join(agentDir, "skills", "global-a"), "global-a");
		// 用户级 npm 包：~/.pi/agent/npm/node_modules/skill-pack/skills/
		const pkgDir = mkdir(".pi/agent/npm/node_modules/skill-pack");
		skillMd(join(pkgDir, "skills", "pack-skill"), "pack-skill");
		writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "skill-pack" }), "utf8");
		// 项目级包声明 pi.skills 字段
		const projPkg = mkdir("project/.pi/npm/node_modules/proj-pack");
		skillMd(join(projPkg, "custom", "nested"), "proj-pack-skill");
		writeFileSync(
			join(projPkg, "package.json"),
			JSON.stringify({ name: "proj-pack", pi: { skills: ["custom/nested"] } }),
			"utf8",
		);
		put(
			".pi/agent/settings.json",
			JSON.stringify({ packages: ["npm:skill-pack"] }),
		);
		put(
			"project/.pi/settings.json",
			JSON.stringify({ packages: ["npm:proj-pack"], disabledSkills: ["proj-pack-skill"] }),
		);

		const result = resolveEnabledSkillPaths({ agentHomeDir: home, cwd, disabledNames: ["proj-pack-skill"] });
		assert.ok(result);
		// proj-pack-skill 被禁用剔除，pack-skill 保留
		same(result, [
			join(agentDir, "skills", "global-a", "SKILL.md"),
			join(pkgDir, "skills", "pack-skill", "SKILL.md"),
		]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("祖先目录的 .agents/skills 参与枚举（到 git repo root）", () => {
	const { resolveEnabledSkillPaths } = loadResolverModule();
	const { root, home, agentDir, cwd, mkdir } = setupFixtures();
	try {
		skillMd(join(agentDir, "skills", "global-a"), "global-a");
		// 项目 cwd = root/project；在 git root（root）下放 .agents/skills
		mkdirSync(join(root, ".git"), { recursive: true });
		skillMd(join(root, ".agents", "skills", "ancestor-skill"), "ancestor-skill");

		const result = resolveEnabledSkillPaths({ agentHomeDir: home, cwd, disabledNames: ["ancestor-skill"] });
		assert.ok(result);
		// ancestor-skill 禁用剔除；且 project/.agents/skills（空目录）不产生条目
		same(result, [join(agentDir, "skills", "global-a", "SKILL.md")]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("ignore 规则（.gitignore）与 pi 一致地排除自动发现技能", () => {
	const { resolveEnabledSkillPaths } = loadResolverModule();
	const { root, home, agentDir, cwd } = setupFixtures();
	try {
		skillMd(join(agentDir, "skills", "ignored-skill"), "ignored-skill");
		skillMd(join(agentDir, "skills", "kept-skill"), "kept-skill");
		writeFileSync(join(agentDir, "skills", ".gitignore"), "ignored-skill/\n", "utf8");
		// 禁用任意技能触发白名单（否则返回 null 无从观察枚举结果）
		skillMd(join(home, ".agents", "skills", "trigger"), "trigger");

		const result = resolveEnabledSkillPaths({ agentHomeDir: home, cwd, disabledNames: ["trigger"] });
		assert.ok(result);
		same(result, [join(agentDir, "skills", "kept-skill", "SKILL.md")]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("settings.skills 的 override patterns：! 排除、+ 强制包含、- 强制排除", () => {
	const { resolveEnabledSkillPaths } = loadResolverModule();
	const { root, home, agentDir, cwd, put } = setupFixtures();
	try {
		skillMd(join(agentDir, "skills", "beta-tool"), "beta-tool");
		skillMd(join(agentDir, "skills", "kept-skill"), "kept-skill");
		put(
			".pi/agent/settings.json",
			JSON.stringify({ skills: ["!beta-tool", "+skills/kept-skill", "-skills/kept-skill"] }),
		);
		// 触发白名单：禁用任一技能（frontmatter 禁用也可）
		skillMd(join(agentDir, "skills", "trigger"), "trigger", "disable-model-invocation: true\n");

		const result = resolveEnabledSkillPaths({ agentHomeDir: home, cwd, disabledNames: [] });
		assert.ok(result);
		// beta-tool 被 ! 排除；kept-skill 被 + 强制包含后又被 - 强制排除（force-exclude 最后判定）
		same(result, []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("override patterns 的 + 强制包含覆盖 ! 排除", () => {
	const { resolveEnabledSkillPaths } = loadResolverModule();
	const { root, home, agentDir, cwd, put } = setupFixtures();
	try {
		skillMd(join(agentDir, "skills", "beta-tool"), "beta-tool");
		put(".pi/agent/settings.json", JSON.stringify({ skills: ["!beta-tool", "+skills/beta-tool"] }));
		skillMd(join(agentDir, "skills", "trigger"), "trigger", "disable-model-invocation: true\n");

		const result = resolveEnabledSkillPaths({ agentHomeDir: home, cwd, disabledNames: [] });
		assert.ok(result);
		same(result, [join(agentDir, "skills", "beta-tool", "SKILL.md")]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("packages 对象条目 skills 空数组 = 该包全部技能禁用", () => {
	const { resolveEnabledSkillPaths } = loadResolverModule();
	const { root, home, agentDir, cwd, put, mkdir } = setupFixtures();
	try {
		const pkgDir = mkdir(".pi/agent/npm/node_modules/skill-pack");
		skillMd(join(pkgDir, "skills", "pack-skill"), "pack-skill");
		writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "skill-pack" }), "utf8");
		put(".pi/agent/settings.json", JSON.stringify({ packages: [{ source: "npm:skill-pack", skills: [] }] }));
		skillMd(join(agentDir, "skills", "trigger"), "trigger", "disable-model-invocation: true\n");

		const result = resolveEnabledSkillPaths({ agentHomeDir: home, cwd, disabledNames: [] });
		assert.ok(result);
		same(result, []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("packages 对象条目 skills patterns 只注入匹配的技能", () => {
	const { resolveEnabledSkillPaths } = loadResolverModule();
	const { root, home, agentDir, cwd, put, mkdir } = setupFixtures();
	try {
		const pkgDir = mkdir(".pi/agent/npm/node_modules/skill-pack");
		skillMd(join(pkgDir, "skills", "alpha-skill"), "alpha-skill");
		skillMd(join(pkgDir, "skills", "beta-skill"), "beta-skill");
		writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "skill-pack" }), "utf8");
		put(
			".pi/agent/settings.json",
			JSON.stringify({ packages: [{ source: "npm:skill-pack", skills: ["alpha-*"] }] }),
		);
		skillMd(join(agentDir, "skills", "trigger"), "trigger", "disable-model-invocation: true\n");

		const result = resolveEnabledSkillPaths({ agentHomeDir: home, cwd, disabledNames: [] });
		assert.ok(result);
		same(result, [join(pkgDir, "skills", "alpha-skill", "SKILL.md")]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("package object without a skill filter falls back only when the manifest omits skills", () => {
	const { resolveEnabledSkillPaths } = loadResolverModule();
	const { root, home, agentDir, cwd, put, mkdir } = setupFixtures();
	try {
		const fallbackPkg = mkdir(".pi/agent/npm/node_modules/fallback-pack");
		skillMd(join(fallbackPkg, "skills", "fallback-skill"), "fallback-skill");
		writeFileSync(
			join(fallbackPkg, "package.json"),
			JSON.stringify({ pi: { prompts: ["prompts/sample.md"] } }),
			"utf8",
		);
		const emptyPkg = mkdir(".pi/agent/npm/node_modules/empty-pack");
		skillMd(join(emptyPkg, "skills", "must-not-load"), "must-not-load");
		writeFileSync(
			join(emptyPkg, "package.json"),
			JSON.stringify({ pi: { skills: [] } }),
			"utf8",
		);
		put(".pi/agent/settings.json", JSON.stringify({
			packages: [{ source: "npm:fallback-pack" }, { source: "npm:empty-pack" }],
		}));
		skillMd(join(agentDir, "skills", "trigger"), "trigger", "disable-model-invocation: true\n");

		const result = resolveEnabledSkillPaths({ agentHomeDir: home, cwd, disabledNames: [] });
		assert.ok(result);
		same(result, [join(fallbackPkg, "skills", "fallback-skill", "SKILL.md")]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("项目 autoload:false package 作为全局包的 delta 覆盖", () => {
	const { resolveEnabledSkillPaths } = loadResolverModule();
	const { root, home, agentDir, cwd, put, mkdir } = setupFixtures();
	try {
		const pkgDir = mkdir(".pi/agent/npm/node_modules/skill-pack");
		skillMd(join(pkgDir, "skills", "alpha-skill"), "alpha-skill");
		skillMd(join(pkgDir, "skills", "beta-skill"), "beta-skill");
		writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "skill-pack" }), "utf8");
		put(
			".pi/agent/settings.json",
			JSON.stringify({ packages: ["npm:skill-pack"] }),
		);
		put(
			"project/.pi/settings.json",
			JSON.stringify({
				packages: [{ source: "npm:skill-pack", skills: ["!skills/beta-*"], autoload: false }],
			}),
		);
		skillMd(join(agentDir, "skills", "trigger"), "trigger", "disable-model-invocation: true\n");

		const result = resolveEnabledSkillPaths({ agentHomeDir: home, cwd, disabledNames: [] });
		assert.ok(result);
		same(result, [join(pkgDir, "skills", "alpha-skill", "SKILL.md")]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("manifest pi.skills 声明的 patterns 过滤生效（! 排除）", () => {
	const { resolveEnabledSkillPaths } = loadResolverModule();
	const { root, home, agentDir, cwd, put, mkdir } = setupFixtures();
	try {
		const pkgDir = mkdir(".pi/agent/npm/node_modules/skill-pack");
		skillMd(join(pkgDir, "custom", "alpha-skill"), "alpha-skill");
		skillMd(join(pkgDir, "custom", "beta-skill"), "beta-skill");
		writeFileSync(
			join(pkgDir, "package.json"),
			JSON.stringify({ name: "skill-pack", pi: { skills: ["custom/alpha-skill", "!custom/beta-skill"] } }),
			"utf8",
		);
		put(".pi/agent/settings.json", JSON.stringify({ packages: ["npm:skill-pack"] }));
		skillMd(join(agentDir, "skills", "trigger"), "trigger", "disable-model-invocation: true\n");

		const result = resolveEnabledSkillPaths({ agentHomeDir: home, cwd, disabledNames: [] });
		assert.ok(result);
		same(result, [join(pkgDir, "custom", "alpha-skill", "SKILL.md")]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("全局禁用与项目同名技能相互隔离", () => {
	const { resolveEnabledSkillPaths } = loadResolverModule();
	const { root, home, agentDir, cwd } = setupFixtures();
	try {
		skillMd(join(agentDir, "skills", "shared"), "shared");
		const projectDir = join(cwd, ".pi", "skills", "shared");
		skillMd(projectDir, "shared");
		const result = resolveEnabledSkillPaths({ agentHomeDir: home, cwd, disabledNames: ["shared"] });
		assert.ok(result);
		same(result, [join(projectDir, "SKILL.md")]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("项目继承覆盖按 global sourceId 匹配且不误伤项目同名技能", () => {
	const { resolveEnabledSkillPaths } = loadResolverModule();
	const { root, home, agentDir, cwd, put } = setupFixtures();
	try {
		skillMd(join(agentDir, "skills", "shared"), "shared");
		const agentsDir = join(home, ".agents", "skills", "shared");
		skillMd(agentsDir, "shared");
		const projectDir = join(cwd, ".pi", "skills", "shared");
		skillMd(projectDir, "shared");
		put("project/.pi/settings.json", JSON.stringify({
			pideckDisabledGlobalSkills: ["pi-global:shared"],
		}));
		const result = resolveEnabledSkillPaths({ agentHomeDir: home, cwd, disabledNames: [] });
		assert.ok(result);
		same(result, [join(agentsDir, "SKILL.md"), join(projectDir, "SKILL.md")]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("拒绝项目 trust 时强制全局白名单且忽略项目技能", () => {
	const { resolveEnabledSkillPaths } = loadResolverModule();
	const { root, home, agentDir, cwd } = setupFixtures();
	try {
		const globalDir = join(agentDir, "skills", "global");
		skillMd(globalDir, "global");
		skillMd(join(cwd, ".pi", "skills", "project"), "project");
		const result = resolveEnabledSkillPaths({
			agentHomeDir: home,
			cwd,
			disabledNames: [],
			includeProjectResources: false,
		});
		assert.ok(result);
		same(result, [join(globalDir, "SKILL.md")]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("package manifest glob expands skill directories", () => {
	const { resolveEnabledSkillPaths } = loadResolverModule();
	const { root, home, agentDir, cwd, put, mkdir } = setupFixtures();
	try {
		const pkgDir = mkdir(".pi/agent/npm/node_modules/glob-pack");
		skillMd(join(pkgDir, "catalog", "alpha"), "alpha");
		skillMd(join(pkgDir, "catalog", "beta"), "beta");
		writeFileSync(
			join(pkgDir, "package.json"),
			JSON.stringify({ pi: { skills: ["catalog/*"] } }),
			"utf8",
		);
		put(".pi/agent/settings.json", JSON.stringify({ packages: ["npm:glob-pack"] }));
		const result = resolveEnabledSkillPaths({ agentHomeDir: home, cwd, disabledNames: ["missing"] });
		assert.ok(result);
		same(result, [
			join(pkgDir, "catalog", "alpha", "SKILL.md"),
			join(pkgDir, "catalog", "beta", "SKILL.md"),
		]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("github package source resolves from pi's managed git install directory", () => {
	const { resolveEnabledSkillPaths } = loadResolverModule();
	const { root, home, agentDir, cwd, put, mkdir } = setupFixtures();
	try {
		const pkgDir = mkdir(".pi/agent/git/github.com/acme/tool");
		skillMd(join(pkgDir, "skills", "git-skill"), "git-skill");
		put(".pi/agent/settings.json", JSON.stringify({ packages: ["git:github:acme/tool#main"] }));
		const result = resolveEnabledSkillPaths({ agentHomeDir: home, cwd, disabledNames: ["missing"] });
		assert.ok(result);
		same(result, [join(pkgDir, "skills", "git-skill", "SKILL.md")]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("project package replaces a same-identity user package", () => {
	const { resolveEnabledSkillPaths } = loadResolverModule();
	const { root, home, agentDir, cwd, put, mkdir } = setupFixtures();
	try {
		const userPkg = mkdir(".pi/agent/npm/node_modules/shared-pack");
		const projectPkg = mkdir("project/.pi/npm/node_modules/shared-pack");
		skillMd(join(userPkg, "skills", "user-skill"), "user-skill");
		skillMd(join(projectPkg, "skills", "project-skill"), "project-skill");
		put(".pi/agent/settings.json", JSON.stringify({ packages: ["npm:shared-pack"] }));
		put("project/.pi/settings.json", JSON.stringify({ packages: ["npm:shared-pack"] }));
		const result = resolveEnabledSkillPaths({ agentHomeDir: home, cwd, disabledNames: ["missing"] });
		assert.ok(result);
		same(result, [join(projectPkg, "skills", "project-skill", "SKILL.md")]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

/* ------------------------------------------------------------------ */
/* 附加 agent home（WSL 场景）：Linux 家目录技能并入白名单（issue #203） */
/* ------------------------------------------------------------------ */

/** 构造模拟 WSL 家目录：独立的 home 根，含 ~/.pi/agent 与 ~/.agents 骨架。 */
function setupWslHome(root, name) {
	const home = join(root, name);
	const agentDir = join(home, ".pi", "agent");
	mkdirSync(join(agentDir, "skills"), { recursive: true });
	mkdirSync(join(home, ".agents", "skills"), { recursive: true });
	return { home, agentDir };
}

test("additionalAgentHomeDirs：WSL 家目录的 ~/.pi/agent/skills 与 ~/.agents/skills 并入白名单", () => {
	const { resolveEnabledSkillPaths } = loadResolverModule();
	const { root, home, agentDir, cwd } = setupFixtures();
	const wsl = setupWslHome(root, "wsl-home");
	try {
		// Windows 家目录（主 home）技能：保持原有行为
		skillMd(join(agentDir, "skills", "win-skill"), "win-skill");
		// WSL 家目录技能：pi 模式顶层 md 算、agents 模式嵌套算
		skillMd(join(wsl.agentDir, "skills", "wsl-pi-skill"), "wsl-pi-skill");
		writeFileSync(
			join(wsl.agentDir, "skills", "wsl-root.md"),
			"---\nname: wsl-root\ndescription: pi mode root\n---\n",
			"utf8",
		);
		skillMd(join(wsl.home, ".agents", "skills", "wsl-agents-skill"), "wsl-agents-skill");
		writeFileSync(
			join(wsl.home, ".agents", "skills", "wsl-agents-root.md"),
			"---\nname: wsl-agents-root\ndescription: agents mode root ignored\n---\n",
			"utf8",
		);

		const result = resolveEnabledSkillPaths({
			agentHomeDir: home,
			cwd,
			disabledNames: ["missing"],
			additionalAgentHomeDirs: [wsl.home],
		});
		assert.ok(result, "存在禁用项时必须启用白名单");
		same(result, [
			join(agentDir, "skills", "win-skill", "SKILL.md"),
			// WSL 侧：pi 模式目录技能 + 顶层 md；agents 模式只认嵌套目录
			join(wsl.agentDir, "skills", "wsl-pi-skill", "SKILL.md"),
			join(wsl.agentDir, "skills", "wsl-root.md"),
			join(wsl.home, ".agents", "skills", "wsl-agents-skill", "SKILL.md"),
		]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("additionalAgentHomeDirs：PiDeck 禁用名与 frontmatter 禁用对 WSL 家目录技能同样生效", () => {
	const { resolveEnabledSkillPaths } = loadResolverModule();
	const { root, home, cwd } = setupFixtures();
	const wsl = setupWslHome(root, "wsl-home");
	try {
		skillMd(join(wsl.home, ".agents", "skills", "wsl-disabled"), "wsl-disabled");
		skillMd(
			join(wsl.home, ".agents", "skills", "wsl-frontmatter-off"),
			"wsl-frontmatter-off",
			"disable-model-invocation: true\n",
		);
		skillMd(join(wsl.home, ".agents", "skills", "wsl-kept"), "wsl-kept");

		const result = resolveEnabledSkillPaths({
			agentHomeDir: home,
			cwd,
			disabledNames: ["wsl-disabled"],
			additionalAgentHomeDirs: [wsl.home],
		});
		assert.ok(result);
		same(result, [join(wsl.home, ".agents", "skills", "wsl-kept", "SKILL.md")]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("additionalAgentHomeDirs：WSL 家目录 settings.json 的 skills 显式路径参与枚举", () => {
	const { resolveEnabledSkillPaths } = loadResolverModule();
	const { root, home, cwd } = setupFixtures();
	const wsl = setupWslHome(root, "wsl-home");
	try {
		const explicitDir = join(wsl.home, "custom-skills");
		skillMd(explicitDir, "wsl-explicit");
		writeFileSync(
			join(wsl.agentDir, "settings.json"),
			JSON.stringify({ skills: [explicitDir] }),
			"utf8",
		);

		const result = resolveEnabledSkillPaths({
			agentHomeDir: home,
			cwd,
			disabledNames: ["missing"],
			additionalAgentHomeDirs: [wsl.home],
		});
		assert.ok(result);
		same(result, [join(explicitDir, "SKILL.md")]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("additionalAgentHomeDirs：拒绝项目 trust 时 WSL 家目录全局技能仍注入", () => {
	const { resolveEnabledSkillPaths } = loadResolverModule();
	const { root, home, agentDir, cwd } = setupFixtures();
	const wsl = setupWslHome(root, "wsl-home");
	try {
		skillMd(join(agentDir, "skills", "win-global"), "win-global");
		skillMd(join(wsl.agentDir, "skills", "wsl-global"), "wsl-global");
		skillMd(join(cwd, ".pi", "skills", "project-skill"), "project-skill");

		const result = resolveEnabledSkillPaths({
			agentHomeDir: home,
			cwd,
			disabledNames: [],
			additionalAgentHomeDirs: [wsl.home],
			includeProjectResources: false,
		});
		assert.ok(result);
		same(result, [
			join(agentDir, "skills", "win-global", "SKILL.md"),
			join(wsl.agentDir, "skills", "wsl-global", "SKILL.md"),
		]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("additionalAgentHomeDirs：与主 home 相同的目录不重复枚举；不存在的目录跳过", () => {
	const { resolveEnabledSkillPaths } = loadResolverModule();
	const { root, home, agentDir, cwd } = setupFixtures();
	try {
		skillMd(join(agentDir, "skills", "win-skill"), "win-skill");

		const withDup = resolveEnabledSkillPaths({
			agentHomeDir: home,
			cwd,
			disabledNames: ["missing"],
			additionalAgentHomeDirs: [home, join(root, "wsl-not-exist")],
		});
		const baseline = resolveEnabledSkillPaths({
			agentHomeDir: home,
			cwd,
			disabledNames: ["missing"],
		});
		assert.ok(withDup && baseline);
		same(withDup, baseline);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
