import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const load = createTsSandbox({
	stubs: {
		electron: { app: { isPackaged: false, getAppPath: () => process.cwd() } },
		"../fs/trash": { trashPath: async () => assert.fail("Listing skills must not delete them") },
		"../fs/openPath": { openSystemPath: async () => "" },
		"./pideckSkillsPath": { pideckBundledSkillsDir: (home) => join(home, ".pi", "agent", "pideck-skills") },
	},
});
const { SkillManager } = load("src/main/skills/SkillManager.ts");

/** Keep coinstalled desktop editions and user skills in an isolated profile. */
async function withSkillProfile(run) {
	const home = await mkdtemp(join(tmpdir(), "pideck-bundled-isolation-"));
	try {
		const desktopRoot = join(home, ".pi", "agent", "pideck-skills");
		const snapshots = new Map();
		for (const name of ["pideck", "pideck-lite", "pideck-v2", "other-desktop", "usage-probe", "mcp-setup"]) {
			const path = join(desktopRoot, name, "SKILL.md");
			snapshots.set(path, await createSkill(path, name));
		}
		const looseMarkdown = join(desktopRoot, "other-desktop.md");
		snapshots.set(looseMarkdown, await createSkill(looseMarkdown, "loose-desktop"));
		await run({ home, desktopRoot, snapshots });
		for (const [path, content] of snapshots) {
			assert.equal(await readFile(path, "utf8"), content, "Other editions' skills must remain unchanged");
		}
	} finally {
		await rm(home, { recursive: true, force: true });
	}
}

async function createSkill(path, name) {
	const content = `---\nname: ${name}\ndescription: ${name} test skill\n---\n\n# ${name}\n`;
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content, "utf8");
	return content;
}

test("Electron injects only its declared built-ins when Lite and V2 share the desktop skills directory", async () => {
	await withSkillProfile(async ({ home, desktopRoot }) => {
		const manager = new SkillManager(home);
		assert.deepEqual(Array.from(manager.getBundledSkillLoadPaths()), [join(desktopRoot, "pideck")]);

		manager.configureNativeEnabledReader(() => false);
		assert.deepEqual(Array.from(manager.getBundledSkillLoadPaths()), [], "Disabling Electron's skill must not load another edition instead");
	});
});

test("Electron lists its own built-ins and preserves explicitly installed user skills from either global root", async () => {
	await withSkillProfile(async ({ home, desktopRoot }) => {
		const userV2 = join(home, ".pi", "agent", "skills", "pideck-v2", "SKILL.md");
		const userLite = join(home, ".agents", "skills", "pideck-lite", "SKILL.md");
		const userCustom = join(home, ".pi", "agent", "skills", "my-skill.md");
		await createSkill(userV2, "pideck-v2");
		await createSkill(userLite, "pideck-lite");
		await createSkill(userCustom, "my-skill");

		const { skills } = await new SkillManager(home).list();
		assert.deepEqual(Array.from(skills, (skill) => `${skill.sourceId}:${skill.path}`).sort(), [`pideck-global:${join(desktopRoot, "pideck", "SKILL.md")}`, `pi-global:${userV2}`, `agents-global:${userLite}`, `pi-global:${userCustom}`].sort());
	});
});
