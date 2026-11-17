import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import lockfile from "proper-lockfile";
import { mkdtempSync } from "./helpers/tempDir.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { ProjectResourceManager } = loadTsCommonJs("src/main/projects/ProjectResourceManager.ts");
const { clearProjectResourceLegacyFields } = loadTsCommonJs("src/main/projects/projectResourceLegacyCleanup.ts");

function setup() {
	const root = mkdtempSync(join(tmpdir(), "pideck-legacy-project-cleanup-"));
	mkdirSync(join(root, ".pi"));
	const path = join(root, ".pi", "settings.json");
	const manager = new ProjectResourceManager(() => ({ id: "p", name: "P", path: root, lastOpenedAt: 1 }));
	return { path, manager };
}

test("project legacy cleanup waits for the pi settings lock and preserves later native edits", async () => {
	const { path, manager } = setup();
	writeFileSync(path, JSON.stringify({ disabledSkills: ["old"], disabledPrompts: ["keep"], theme: "old" }));
	const release = await lockfile.lock(path, { realpath: false });
	const cleanup = manager.clearProjectLegacyDisables("p", { skills: true });
	try {
		assert.equal(await Promise.race([cleanup.then(() => "completed"), setTimeout(80, "waiting")]), "waiting");
		writeFileSync(path, JSON.stringify({ disabledSkills: ["old"], disabledPrompts: ["keep"], theme: "new", skills: ["-/skills/new.md"], unknown: { keep: true } }));
	} finally {
		await release();
	}
	await cleanup;
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { disabledPrompts: ["keep"], theme: "new", skills: ["-/skills/new.md"], unknown: { keep: true } });
});

test("malformed project settings are retained byte for byte", async () => {
	const { path, manager } = setup();
	writeFileSync(path, "{ broken user settings");
	await assert.rejects(manager.clearProjectLegacyDisables("p", { skills: true }));
	assert.equal(readFileSync(path, "utf8"), "{ broken user settings");
});

test("project cleanup removes only selected legacy fields", () => {
	const settings = {
		disabledExtensions: ["old"],
		disabledSkills: ["skill"],
		disabledPrompts: ["prompt"],
		pideckDisabledGlobalExtensions: ["global"],
		unrelated: true,
	};
	clearProjectResourceLegacyFields(settings, { extensions: true, inherited: true });
	assert.deepEqual(settings, { disabledSkills: ["skill"], disabledPrompts: ["prompt"], unrelated: true });
});
