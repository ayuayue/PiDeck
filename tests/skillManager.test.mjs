import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

class SymlinkUnavailableError extends Error {}

function loadSkillManagerModule({ trash = async () => {} } = {}) {
	// createTsSandbox 按源文件目录解析相对 import：SkillManager 现在把模板安装拆到了
	// bundledSkillInstaller.ts，手写 vm 沙箱会因为解析不到该模块而整片失败。
	const load = createTsSandbox({
		stubs: {
			electron: {
				shell: { openPath: async () => "" },
				// installTemplate 需要 app：dev 模式读 <appPath>/resources/skills/pideck/SKILL.md 与 references/。
				// 测试跑在项目根，该模板真实存在，用 cwd 作为 appPath 即可测通「读模板→写目标」链路。
				app: { isPackaged: false, getAppPath: () => process.cwd() },
			},
			// 删除统一入口：默认 noop；退役技能的用例注入「真删」替身来观察目录消失
			"../fs/trash": { trashPath: trash },
			// 打开目录统一入口（issue #396）：本测试不触达打开路径，noop stub。
			"../fs/openPath": { openSystemPath: async () => "" },
			"./pideckSkillsPath": { pideckBundledSkillsDir: (home) => join(home, ".pi", "agent", "pideck-skills") },
		},
	});
	return load("src/main/skills/SkillManager.ts");
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

test("installTemplate copies the pideck router with every reference file", async () => {
	await withTemporaryHome(async (home) => {
		const { SkillManager } = loadSkillManagerModule();
		const manager = new SkillManager(home);
		const result = await manager.installTemplate("pideck");
		assert.equal(result.success, true);
		const targetDir = join(home, ".pi", "agent", "pideck-skills", "pideck");
		const target = join(targetDir, "SKILL.md");
		const written = readFileSync(target, "utf8");
		assert.match(written, /name: pideck/);
		// 路由入口必须指向 references 里的真实文件；只装 SKILL.md 时用户那边是死链。
		for (const reference of ["references/image-gen.md", "references/usage-probe.md", "references/pideck-doctor.md", "references/web-api/connect.md", "references/web-api/actions.md", "references/web-api/maintenance.md"]) {
			assert.equal(existsSync(join(targetDir, reference)), true, `缺少安装的参考文件 ${reference}`);
		}
		assert.match(readFileSync(join(targetDir, "references", "web-api", "actions.md"), "utf8"), /\/api\/sessions\/<id>\/runtime/);

		// 幂等覆盖：重复安装不报错、内容一致（用户自定义配置在各自的数据文件，不在此模板文件）
		const again = await manager.installTemplate("pideck");
		assert.equal(again.success, true);
		assert.equal(readFileSync(target, "utf8"), written);

		// 旧版本删掉的参考文件不能留在用户目录：路由指向它时不会报错，读到的是过期内容。
		await writeFile(join(targetDir, "references", "web-api", "obsolete.md"), "old\n", "utf8");
		const third = await manager.installTemplate("pideck");
		assert.equal(third.success, true);
		assert.equal(existsSync(join(targetDir, "references", "web-api", "obsolete.md")), false);
	});
});

test("installTemplate 覆盖层里没有该技能时回落到打包副本", async () => {
	await withTemporaryHome(async (home) => {
		// 远端清单换成新技能名后，旧版客户端仍按旧名安装；覆盖层是整包快照，里面没有旧目录。
		// 此时必须回落打包模板，否则「技能热更新成功」会变成「技能全部消失」。
		const overlay = join(home, "overlay");
		await createSkillFile(join(overlay, "some-future-skill", "SKILL.md"), "some-future-skill");
		const { SkillManager } = loadSkillManagerModule();
		const manager = new SkillManager(home);
		manager.configureSkillOverlay(() => overlay);
		const result = await manager.installTemplate("pideck");
		assert.equal(result.success, true);
		const target = join(home, ".pi", "agent", "pideck-skills", "pideck", "SKILL.md");
		assert.match(readFileSync(target, "utf8"), /name: pideck/);
	});
});

test("installTemplate 保留用户对内置技能的禁用标记（重启覆盖回归）", async () => {
	await withTemporaryHome(async (home) => {
		const { SkillManager } = loadSkillManagerModule();
		const manager = new SkillManager(home);
		// 1. 首次启动安装模板
		const first = await manager.installTemplate("pideck");
		assert.equal(first.success, true);
		const target = join(home, ".pi", "agent", "pideck-skills", "pideck", "SKILL.md");
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
		assert.deepEqual(settings.disabledSkills, ["pideck"]);
		// 3. 模拟重启：main/index.ts 启动时 fire-and-forget 再次安装模板
		const second = await manager.installTemplate("pideck");
		assert.equal(second.success, true);
		// 4. PiDeck settings 禁用列表在模板覆盖后仍保留。
		const { skills } = await manager.list();
		const skill = skills.find((item) => item.path === target);
		assert.ok(skill);
		assert.equal(skill.enabled, false);
		assert.deepEqual(settings.disabledSkills, ["pideck"]);
	});
});

test("legacy 内置技能整目录迁到 PiDeck 目录：旧位置消失、附加文件保留", async () => {
	await withTemporaryHome(async (home) => {
		const { SkillManager } = loadSkillManagerModule();
		const manager = new SkillManager(home);
		const legacyDir = join(home, ".pi", "agent", "skills", "pideck");
		await createSkillFile(join(legacyDir, "SKILL.md"), "pideck");
		await writeFile(join(legacyDir, "notes.txt"), "keep me", "utf8");

		const result = await manager.installTemplate("pideck");
		assert.equal(result.success, true);
		assert.equal(existsSync(legacyDir), false);
		const migratedDir = join(home, ".pi", "agent", "pideck-skills", "pideck");
		assert.equal(readFileSync(join(migratedDir, "notes.txt"), "utf8"), "keep me");
		assert.match(readFileSync(join(migratedDir, "SKILL.md"), "utf8"), /name: pideck/);

		// 列表里只剩一份，来源是 pideck-global（TUI 的扫描根里已经没有它）
		const { skills } = await manager.list();
		const matches = skills.filter((skill) => skill.name === "pideck");
		assert.equal(matches.length, 1);
		assert.equal(matches[0].sourceId, "pideck-global");
	});
});

test("legacy 内置技能是软链时不动用户的链接与库文件", async (t) => {
	await withTemporaryHome(async (home) => {
		const libraryDir = join(home, "library", "pideck");
		await createSkillFile(join(libraryDir, "SKILL.md"), "pideck", "library copy");
		const legacyLink = join(home, ".pi", "agent", "skills", "pideck");
		await mkdir(dirname(legacyLink), { recursive: true });
		try {
			await createDirectoryLink(libraryDir, legacyLink);
		} catch (error) {
			if (skipUnavailable(t, error)) return;
			throw error;
		}

		const { SkillManager } = loadSkillManagerModule();
		const manager = new SkillManager(home);
		const result = await manager.installTemplate("pideck");
		assert.equal(result.success, true);
		// 链接与库文件原样保留（不是 PiDeck 建的东西），新副本落在 PiDeck 目录
		assert.equal(lstatSync(legacyLink).isSymbolicLink(), true);
		assert.match(readFileSync(join(libraryDir, "SKILL.md"), "utf8"), /library copy/);
		assert.match(readFileSync(join(home, ".pi", "agent", "pideck-skills", "pideck", "SKILL.md"), "utf8"), /name: pideck/);
	});
});

test("getBundledSkillLoadPaths 只返回存在、已启用且未退役的内置技能目录", async () => {
	await withTemporaryHome(async (home) => {
		const { SkillManager } = loadSkillManagerModule();
		const manager = new SkillManager(home);
		await manager.installTemplate("pideck");
		await manager.installTemplate("mcp-setup", "pi-global");
		// 跨 vm realm 的数组原型不同，先复制成本 realm 数组再比较。
		// mcp-setup 装在 pi-global（pi 的自动发现根），不在 --skill 注入范围里。
		assert.deepEqual(
			Array.from(manager.getBundledSkillLoadPaths(), (path) => basename(path)),
			["pideck"],
		);

		// 旧版本留下的退役入口：即使还没被回收站清掉，也不能重新注入。
		await createSkillFile(join(home, ".pi", "agent", "pideck-skills", "usage-probe", "SKILL.md"), "usage-probe");
		assert.deepEqual(
			Array.from(manager.getBundledSkillLoadPaths(), (path) => basename(path)),
			["pideck"],
			"退役名单里的技能不得注入",
		);

		// 模拟 pi settings.json 投影：pideck 被显式停用 → 不再注入
		manager.configureNativeEnabledReader((skillPath) => (skillPath.replace(/\\/g, "/").includes("/pideck/SKILL.md") ? false : undefined));
		assert.deepEqual(Array.from(manager.getBundledSkillLoadPaths()), []);
	});
});

test("retireBundledSkills 只清普通目录：软链与普通文件原样保留", async (t) => {
	await withTemporaryHome(async (home) => {
		// 回收站替身：直接删，才能观察「目录真的没了」。生产实现走 shell.trashItem。
		const { SkillManager } = loadSkillManagerModule({
			trash: async (target) => {
				await rm(target, { recursive: true, force: true });
			},
		});
		const manager = new SkillManager(home);
		const retiredDir = join(home, ".pi", "agent", "pideck-skills", "usage-probe");
		await createSkillFile(join(retiredDir, "SKILL.md"), "usage-probe");

		const libraryDir = join(home, "library", "image-gen");
		await createSkillFile(join(libraryDir, "SKILL.md"), "image-gen", "library copy");
		const retiredLink = join(home, ".pi", "agent", "pideck-skills", "image-gen");
		await mkdir(dirname(retiredLink), { recursive: true });
		try {
			await createDirectoryLink(libraryDir, retiredLink);
		} catch (error) {
			if (skipUnavailable(t, error)) return;
			throw error;
		}

		const result = await manager.retireBundledSkills(["usage-probe", "image-gen", "pideck-doctor"]);
		assert.deepEqual(Array.from(result.removed), ["usage-probe"]);
		assert.deepEqual(Array.from(result.failed), []);
		assert.equal(existsSync(retiredDir), false, "普通目录必须被清掉");
		assert.equal(lstatSync(retiredLink).isSymbolicLink(), true, "技能库链接不是 PiDeck 建的，不能动");
		assert.match(readFileSync(join(libraryDir, "SKILL.md"), "utf8"), /library copy/);
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

test("list() 结果缓存：1.5s 内重复读复用同一结果，写操作后立刻失效（2027-02 性能治理）", async () => {
	await withTemporaryHome(async (home) => {
		const { SkillManager, shouldSkipSkillWalkEntry } = loadSkillManagerModule();
		const manager = new SkillManager(home);
		const target = join(home, ".pi", "agent", "skills", "cached-skill", "SKILL.md");
		await createSkillFile(target, "Cached-Skill");

		const first = await manager.list();
		assert.equal(
			first.skills.some((skill) => skill.path === target),
			true,
		);
		const second = await manager.list();
		assert.ok(second === first, "TTL 内必须复用同一结果对象（不重新扫盘）");

		// 写操作后立即失效：新建技能下一次 list 必须能看见
		await manager.create({ locationId: "pi-global", name: "New-Skill", description: "新技能" });
		const afterCreate = await manager.list();
		assert.notEqual(afterCreate, first, "写操作必须让缓存失效");
		// create 会把名字规范化为小写 kebab（normalizeSkillName）
		assert.equal(
			afterCreate.skills.some((skill) => skill.name === "new-skill"),
			true,
			"新建的技能立即可见",
		);

		// 递归扫描忽略开发产物与隐藏目录
		assert.equal(shouldSkipSkillWalkEntry("node_modules"), true);
		assert.equal(shouldSkipSkillWalkEntry(".git"), true);
		assert.equal(shouldSkipSkillWalkEntry("dist"), true);
		assert.equal(shouldSkipSkillWalkEntry("my-skill"), false, "普通业务目录不得跳过（技能可以嵌套）");
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

test("configureWsl 切换 HOME 后列表缓存立刻失效（设置保存热切换，无需重启）", async () => {
	await withTemporaryHome(async (home) => {
		const { SkillManager } = loadSkillManagerModule();
		const manager = new SkillManager(home);
		await createSkillFile(join(home, ".pi", "agent", "skills", "local-skill", "SKILL.md"), "local-skill");
		const before = await manager.list();
		assert.equal(
			before.skills.some((skill) => skill.name === "local-skill"),
			true,
		);

		const wslHome = await mkdtemp(join(tmpdir(), "pideck-skill-manager-wsl-"));
		try {
			await createSkillFile(join(wslHome, ".pi", "agent", "skills", "wsl-skill", "SKILL.md"), "wsl-skill");
			manager.configureWsl({ distro: "Test", user: "tester", linuxHome: "/home/tester", windowsHome: wslHome });

			const after = await manager.list();
			assert.notEqual(after, before, "切换环境必须让 TTL 缓存失效");
			assert.equal(after.locations[0].path, join(wslHome, ".pi", "agent", "skills"));
			assert.equal(
				after.skills.some((skill) => skill.name === "wsl-skill"),
				true,
			);
			assert.equal(
				after.skills.some((skill) => skill.name === "local-skill"),
				false,
				"不得混入旧环境的技能",
			);
		} finally {
			await rm(wslHome, { recursive: true, force: true });
		}
	});
});
