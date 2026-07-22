import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
	mkdtemp,
	mkdir,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
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
		require: (id) => {
			if (id === "electron") return { shell: { openPath: async () => "" } };
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
	await writeFile(
		path,
		`---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
		"utf8",
	);
}

async function createSkillRoot(home) {
	const globalSkills = join(home, ".pi", "agent", "skills");
	await mkdir(globalSkills, { recursive: true });
	return globalSkills;
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
}

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
		const result = await Promise.race([
			new SkillManager(home).list(),
			new Promise((_, reject) => setTimeout(() => reject(new Error("scan timed out")), 1000)),
		]);
		assert.ok(result.skills.some((item) => item.name === "visible-skill"));
	});
});
