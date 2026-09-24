import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

class SymlinkUnavailableError extends Error {}

function loadSkillManagerModule() {
	const source = readFileSync("src/main/skills/SkillManager.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const sandbox = {
		exports: {},
		process,
		require: (id) => {
			if (id === "electron")
				return {
					shell: { openPath: async () => "" },
					// installUsageProbeTemplate 需要 app：dev 模式读 <appPath>/resources/skills/usage-probe/SKILL.md。
					// 测试跑在项目根，该模板真实存在，用 cwd 作为 appPath 即可测通「读模板→写目标」链路。
					app: { isPackaged: false, getAppPath: () => process.cwd() },
				};
			// 删除统一入口：测试环境无回收站，noop stub（本测试不触达删除路径）
			if (id === "../fs/trash") return { trashPath: async () => {} };
			if (id === "../logging/sharedLogger") return { getAppLogger: () => null };
			return require(id);
		},
	};
	sandbox.global = sandbox;
	vm.runInNewContext(outputText, sandbox, {
		filename: "SkillManager.ts",
	});
	return sandbox.exports;
}

async function createSkillFile(path, name, description = `${name} description`) {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`, "utf8");
}

async function createSkillRoot(home) {
	const globalSkills = join(home, ".pi", "agent", "skills");
	await mkdir(globalSkills, { recursive: true });
	return globalSkills;
}

/**
 * 部分 Windows 环境（进程无 SeCreateSymbolicLinkPrivilege 且开发者模式关闭）
 * `symlink` 会**静默成功但不创建链接**（lstat ENOENT）——只 catch 抛错挡不住。
 * 创建后必须验证链接真实存在，否则按「软连接不可用」处理（测试 skip）。
 */
function assertLinkCreated(linkPath) {
	try {
		if (lstatSync(linkPath).isSymbolicLink()) return;
	} catch {
		// lstat 失败 = 链接不存在
	}
	throw new SymlinkUnavailableError("symlink was silently not created on this environment");
}

async function createDirectoryLink(target, linkPath) {
	try {
		await symlink(target, linkPath, process.platform === "win32" ? "junction" : "dir");
	} catch (error) {
		if (["EACCES", "EINVAL", "ENOTSUP", "EPERM"].includes(error?.code)) {
			throw new SymlinkUnavailableError(error.message);
		}
		throw error;
	}
	assertLinkCreated(linkPath);
}

async function createFileLink(target, linkPath) {
	try {
		await symlink(target, linkPath, "file");
	} catch (error) {
		if (["EACCES", "EINVAL", "ENOTSUP", "EPERM"].includes(error?.code)) {
			throw new SymlinkUnavailableError(error.message);
		}
		throw error;
	}
	assertLinkCreated(linkPath);
}

// ── 重命名回归：markdown 技能绝不能把技能根目录搬走（数据丢失事故） ──

test("rename a root markdown skill renames only the file, never the skills root", async () => {
	await withTemporaryHome(async (home) => {
		const { SkillManager } = loadSkillManagerModule();
		const manager = new SkillManager(home);
		const skillsRoot = join(home, ".pi", "agent", "skills");
		await createSkillFile(join(skillsRoot, "foo.md"), "foo");
		await createSkillFile(join(skillsRoot, "bar", "SKILL.md"), "bar");

		const { skills } = await manager.list();
		const foo = skills.find((s) => s.type === "markdown");
		assert.ok(foo);
		const renamed = await manager.rename(foo.path, "foo-renamed");

		// 技能根目录原地不动，其他技能不受影响
		assert.equal(existsSync(join(skillsRoot, "bar", "SKILL.md")), true);
		assert.equal(existsSync(join(skillsRoot, "foo.md")), false);
		assert.equal(existsSync(join(skillsRoot, "foo-renamed.md")), true);
		// 旧实现会把整个 skills 根改名为新技能名（内容全部搬走），此处必须不存在
		assert.equal(existsSync(join(home, ".pi", "agent", "foo-renamed")), false);
		assert.equal(renamed.name, "foo-renamed");
		assert.equal(renamed.path, join(skillsRoot, "foo-renamed.md"));
		assert.match(readFileSync(renamed.path, "utf8"), /name: foo-renamed/);
	});
});

test("renaming a disabled skill migrates the settings disabled list", async () => {
	await withTemporaryHome(async (home) => {
		const { SkillManager } = loadSkillManagerModule();
		const manager = new SkillManager(home);
		const target = join(home, ".pi", "agent", "skills", "my-skill", "SKILL.md");
		await createSkillFile(target, "My-Skill");
		const settings = { disabledSkills: [] };
		manager.configureSettings(
			() => settings,
			(patch) => {
				Object.assign(settings, patch);
				return Promise.resolve(settings);
			},
		);
		await manager.toggle(target, false);
		assert.deepEqual(settings.disabledSkills, ["My-Skill"]);

		const renamed = await manager.rename(target, "renamed-skill");
		// 旧名条目被新名替换，不残留孤儿数据；禁用状态保持
		assert.deepEqual(settings.disabledSkills, ["renamed-skill"]);
		assert.equal(renamed.enabled, false);
	});
});

test("markdown skill without frontmatter name falls back to its file name and writes name on rename", async () => {
	await withTemporaryHome(async (home) => {
		const { SkillManager } = loadSkillManagerModule();
		const manager = new SkillManager(home);
		const skillsRoot = join(home, ".pi", "agent", "skills");
		await mkdir(skillsRoot, { recursive: true });
		await writeFile(join(skillsRoot, "bare.md"), "---\ndescription: no name field\n---\n\nbody\n", "utf8");
		const { skills } = await manager.list();
		const bare = skills.find((s) => s.path === join(skillsRoot, "bare.md"));
		assert.ok(bare);
		// 回归：旧实现用 dirname().pop()，markdown 技能会显示成父目录名「skills」
		assert.equal(bare.name, "bare");

		// 重命名一个原 frontmatter 缺 name 字段的技能：成功写回并补全 name 字段
		const renamed = await manager.rename(bare.path, "named-now");
		assert.equal(renamed.name, "named-now");
		assert.match(readFileSync(renamed.path, "utf8"), /name: named-now/);
	});
});

test("renaming a directory skill keeps it inside the skills root", async () => {
	await withTemporaryHome(async (home) => {
		const { SkillManager } = loadSkillManagerModule();
		const manager = new SkillManager(home);
		const skillsRoot = join(home, ".pi", "agent", "skills");
		await createSkillFile(join(skillsRoot, "bar", "SKILL.md"), "bar");

		const { skills } = await manager.list();
		const bar = skills.find((s) => s.type === "directory");
		assert.ok(bar);
		const renamed = await manager.rename(bar.path, "bar-renamed");

		assert.equal(existsSync(join(skillsRoot, "bar")), false);
		assert.equal(existsSync(join(skillsRoot, "bar-renamed", "SKILL.md")), true);
		assert.equal(renamed.name, "bar-renamed");
		assert.equal(renamed.path, join(skillsRoot, "bar-renamed", "SKILL.md"));
	});
});

async function withTemporaryHome(run) {
	const home = await mkdtemp(join(tmpdir(), "pideck-skill-manager-"));
	try {
		await run(home);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
}

function skipUnavailable(t, error) {
	if (error instanceof SymlinkUnavailableError) {
		t.skip(`软连接不可用：${error.message}`);
		return true;
	}
	return false;
}

test("discovers a directory skill through a root-level symlink", async (t) => {
	await withTemporaryHome(async (home) => {
		const globalSkills = await createSkillRoot(home);
		const target = join(home, "linked", "directory-skill");
		const link = join(globalSkills, "directory-skill");
		await createSkillFile(join(target, "SKILL.md"), "directory-skill");

		try {
			await createDirectoryLink(target, link);
		} catch (error) {
			if (skipUnavailable(t, error)) return;
			throw error;
		}

		const { SkillManager } = loadSkillManagerModule();
		const result = await new SkillManager(home).list();
		const skill = result.skills.find((item) => item.path === join(link, "SKILL.md"));
		assert.ok(skill);
		assert.equal(skill.type, "directory");
		assert.equal(skill.name, "directory-skill");
	});
});

test("discovers a root markdown skill through a file symlink", async (t) => {
	await withTemporaryHome(async (home) => {
		const globalSkills = await createSkillRoot(home);
		const target = join(home, "linked", "root-skill.md");
		const link = join(globalSkills, "root-skill.md");
		await createSkillFile(target, "root-skill");

		try {
			await createFileLink(target, link);
		} catch (error) {
			if (skipUnavailable(t, error)) return;
			throw error;
		}

		const { SkillManager } = loadSkillManagerModule();
		const result = await new SkillManager(home).list();
		const skill = result.skills.find((item) => item.path === link);
		assert.ok(skill);
		assert.equal(skill.type, "markdown");
		assert.equal(skill.name, "root-skill");
	});
});

test("discovers a nested skill through a directory symlink", async (t) => {
	await withTemporaryHome(async (home) => {
		const globalSkills = await createSkillRoot(home);
		const parent = join(globalSkills, "collection");
		const target = join(home, "linked", "nested-skill");
		const link = join(parent, "nested-skill");
		await mkdir(parent, { recursive: true });
		await createSkillFile(join(target, "SKILL.md"), "nested-skill");

		try {
			await createDirectoryLink(target, link);
		} catch (error) {
			if (skipUnavailable(t, error)) return;
			throw error;
		}

		const { SkillManager } = loadSkillManagerModule();
		const result = await new SkillManager(home).list();
		const skill = result.skills.find((item) => item.path === join(link, "SKILL.md"));
		assert.ok(skill);
		assert.equal(skill.name, "nested-skill");
	});
});

test("does not recurse forever through a directory symlink cycle", async () => {
	await withTemporaryHome(async (home) => {
		const globalSkills = await createSkillRoot(home);
		const cycleRoot = join(globalSkills, "cycle");
		await createSkillFile(join(cycleRoot, "visible", "SKILL.md"), "visible-skill");
		try {
			await createDirectoryLink(cycleRoot, join(cycleRoot, "loop"));
		} catch (error) {
			if (skipUnavailable(t, error)) return;
			throw error;
		}

		const { SkillManager } = loadSkillManagerModule();
		const result = await Promise.race([new SkillManager(home).list(), new Promise((_, reject) => setTimeout(() => reject(new Error("scan timed out")), 1000))]);
		assert.ok(result.skills.some((item) => item.name === "visible-skill"));
	});
});

test("installUsageProbeTemplate copies the bundled template into the global skills dir", async () => {
	await withTemporaryHome(async (home) => {
		const { SkillManager } = loadSkillManagerModule();
		const manager = new SkillManager(home);
		const result = await manager.installUsageProbeTemplate();
		assert.equal(result.success, true);
		const target = join(home, ".pi", "agent", "skills", "usage-probe", "SKILL.md");
		const written = readFileSync(target, "utf8");
		assert.match(written, /name: usage-probe/);
		assert.match(written, /usage-probes\.json/);
		// 幂等覆盖：重复安装不报错、内容一致（用户自定义配置在 usage-probes.json，不在此模板文件）
		const again = await manager.installUsageProbeTemplate();
		assert.equal(again.success, true);
		assert.equal(readFileSync(target, "utf8"), written);
	});
});

test("installTemplate 保留用户对内置技能的禁用标记（重启覆盖回归）", async () => {
	await withTemporaryHome(async (home) => {
		const { SkillManager } = loadSkillManagerModule();
		const manager = new SkillManager(home);
		// 1. 首次启动安装模板
		const first = await manager.installUsageProbeTemplate();
		assert.equal(first.success, true);
		const target = join(home, ".pi", "agent", "skills", "usage-probe", "SKILL.md");
		const settings = { disabledSkills: [] };
		manager.configureSettings(
			() => settings,
			(patch) => {
				Object.assign(settings, patch);
				return Promise.resolve(settings);
			},
		);
		// 2. 用户在技能页禁用：PiDeck settings 禁用列表是全禁用的唯一状态源。
		await manager.toggle(target, false);
		assert.deepEqual(settings.disabledSkills, ["usage-probe"]);
		// 3. 模拟重启：main/index.ts 启动时 fire-and-forget 再次安装模板
		const second = await manager.installUsageProbeTemplate();
		assert.equal(second.success, true);
		// 4. PiDeck settings 禁用列表在模板覆盖后仍保留。
		const { skills } = await manager.list();
		const skill = skills.find((item) => item.path === target);
		assert.ok(skill);
		assert.equal(skill.enabled, false);
		assert.deepEqual(settings.disabledSkills, ["usage-probe"]);
	});
});

test("installImageGenTemplate copies the bundled image-gen skill into the global skills dir", async () => {
	await withTemporaryHome(async (home) => {
		const { SkillManager } = loadSkillManagerModule();
		const manager = new SkillManager(home);
		const result = await manager.installImageGenTemplate();
		assert.equal(result.success, true);
		const target = join(home, ".pi", "agent", "skills", "image-gen", "SKILL.md");
		const written = readFileSync(target, "utf8");
		assert.match(written, /name: image-gen/);
		assert.match(written, /images\/generations/);
		// 幂等覆盖：重复安装不报错、内容一致
		const again = await manager.installImageGenTemplate();
		assert.equal(again.success, true);
		assert.equal(readFileSync(target, "utf8"), written);
	});
});

test("external skill directory import supports both managed global destinations", async () => {
	await withTemporaryHome(async (home) => {
		const source = join(home, "external", "source-skill");
		await createSkillFile(join(source, "SKILL.md"), "external-skill", "External source skill");
		await mkdir(join(source, "references"), { recursive: true });
		await writeFile(join(source, "references", "guide.md"), "preserved attachment\n", "utf8");

		const { SkillManager } = loadSkillManagerModule();
		const manager = new SkillManager(home);
		await manager.importSkillDirectory("pi-global", source, "external-pi");
		await manager.importSkillDirectory("agents-global", source, "external-agents");

		assert.equal(readFileSync(join(home, ".pi", "agent", "skills", "external-pi", "SKILL.md"), "utf8"), readFileSync(join(source, "SKILL.md"), "utf8"));
		assert.equal(readFileSync(join(home, ".agents", "skills", "external-agents", "references", "guide.md"), "utf8"), "preserved attachment\n");
	});
});

test("toggle 同步持久化 PiDeck settings 禁用列表（白名单模式依据）", async () => {
	await withTemporaryHome(async (home) => {
		const { SkillManager } = loadSkillManagerModule();
		const manager = new SkillManager(home);
		const target = join(home, ".pi", "agent", "skills", "my-skill", "SKILL.md");
		await createSkillFile(target, "My-Skill");

		// 内存 settings 替身：模拟 SettingsStore 的 get/update 语义
		const settings = { disabledSkills: [] };
		manager.configureSettings(
			() => settings,
			(patch) => {
				Object.assign(settings, patch);
				return Promise.resolve(settings);
			},
		);

		// 禁用：只有 PiDeck settings 列表记录全禁用，不改写 Pi 的用户手动调用标记。
		await manager.toggle(target, false);
		assert.deepEqual(settings.disabledSkills, ["My-Skill"]);
		assert.doesNotMatch(readFileSync(target, "utf8"), /disable-model-invocation: true/);
		const afterDisable = await manager.list();
		assert.equal(afterDisable.skills.find((s) => s.path === target).enabled, false);

		// 启用：从 settings 列表移除（名称大小写不敏感去重）；frontmatter 状态独立保留。
		await manager.toggle(target, true);
		assert.deepEqual(settings.disabledSkills, []);
		assert.doesNotMatch(readFileSync(target, "utf8"), /disable-model-invocation: true/);
		const afterEnable = await manager.list();
		assert.equal(afterEnable.skills.find((s) => s.path === target).enabled, true);
	});
});

test("list treats legacy disable-model-invocation as user-only, not a PiDeck disabled setting", async () => {
	await withTemporaryHome(async (home) => {
		const { SkillManager } = loadSkillManagerModule();
		const manager = new SkillManager(home);
		const target = join(home, ".pi", "agent", "skills", "legacy-skill", "SKILL.md");
		// 老版本 UI 写入的禁用标记（无 settings 禁用列表）
		await createSkillFile(target, "legacy-skill");
		const raw = readFileSync(target, "utf8");
		await writeFile(target, raw.replace("---", "---\ndisable-model-invocation: true"), "utf8");

		const settings = { disabledSkills: [] };
		manager.configureSettings(
			() => settings,
			(patch) => {
				Object.assign(settings, patch);
				return Promise.resolve(settings);
			},
		);
		const result = await manager.list();
		const skill = result.skills.find((s) => s.path === target);
		assert.equal(skill.enabled, true);
		assert.equal(skill.userOnly, true);
		// Pi frontmatter 标记不持久化为 PiDeck settings 全禁用状态。
		assert.deepEqual(settings.disabledSkills, []);
	});
});
