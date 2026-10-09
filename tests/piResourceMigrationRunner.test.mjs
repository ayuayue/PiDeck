import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { runGlobalResourceMigration, runProjectResourceMigration } = loadTsCommonJs("src/main/config/piResourceMigrationRunner.ts");
const { PiResourceStateStore } = loadTsCommonJs("src/main/config/PiResourceStateStore.ts");

const skillResource = { kind: "skills", name: "tidy", value: "/home/me/.pi/agent/skills/tidy/SKILL.md", scope: "user" };

function makeDeps(overrides = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pideck-runner-"));
	const state = new PiResourceStateStore(join(dir, "state.json"));
	const applied = [];
	const settingsPatch = [];
	const projectCleared = [];
	const deps = {
		service: {
			setFileResourceEnabled: async (request) => {
				applied.push(`${request.kind}|${request.resourceId}|${request.enabled}`);
				return { ok: true, revision: "rev" };
			},
		},
		state,
		readSettings: () => ({ disabledExtensions: [], disabledSkills: [], disabledPrompts: [], disableExtensionWhitelist: false }),
		resolveGlobalResources: async () => [skillResource],
		readProjectLegacyState: async () => null,
		resolveProjectResources: async () => [],
		writeSettingsPatch: async (patch) => {
			settingsPatch.push(patch);
		},
		clearProjectLegacyState: async (projectId, patch) => {
			projectCleared.push({ projectId, patch });
		},
		...overrides,
	};
	return { deps, applied, settingsPatch, projectCleared, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("no legacy records: migration is skipped but recorded (idempotent)", async () => {
	const { deps, applied, cleanup } = makeDeps();
	try {
		const first = await runGlobalResourceMigration(deps);
		assert.equal(first.status, "skipped");
		assert.equal(applied.length, 0);
		// 第二次直接跳过（不会重复探测资源）
		let resolved = 0;
		const second = await runGlobalResourceMigration({
			...deps,
			resolveGlobalResources: async () => {
				resolved += 1;
				return [];
			},
		});
		assert.equal(second.status, "skipped");
		assert.equal(resolved, 0);
	} finally {
		cleanup();
	}
});

test("global migration writes native rules then clears only migrated categories", async () => {
	const { deps, applied, settingsPatch, cleanup } = makeDeps({
		readSettings: () => ({
			disabledExtensions: [],
			disabledSkills: ["tidy", "missing-skill"],
			disabledPrompts: [],
			disableExtensionWhitelist: false,
		}),
	});
	try {
		const result = await runGlobalResourceMigration(deps);
		assert.equal(result.status, "completed");
		assert.deepEqual([...applied], ["skills|/home/me/.pi/agent/skills/tidy/SKILL.md|false"]);
		// missing-skill 未解析 → disabledSkills 不清（保留给用户处理）
		assert.equal(settingsPatch.length, 1);
		assert.equal("disabledSkills" in settingsPatch[0], false);
	} finally {
		cleanup();
	}
});

test("failed writes keep legacy records intact and report the error", async () => {
	const { deps, settingsPatch, cleanup } = makeDeps({
		readSettings: () => ({ disabledExtensions: [], disabledSkills: ["tidy"], disabledPrompts: [], disableExtensionWhitelist: false }),
		service: { setFileResourceEnabled: async () => ({ ok: false, error: "ELOCKED" }) },
	});
	try {
		const result = await runGlobalResourceMigration(deps);
		assert.equal(result.status, "failed");
		assert.equal(result.errors.length, 1);
		assert.match(result.errors[0], /ELOCKED/);
		assert.equal(settingsPatch.length, 0);
	} finally {
		cleanup();
	}
});

test("disableExtensionWhitelist archives the list instead of disabling anything", async () => {
	const { deps, applied, settingsPatch, cleanup } = makeDeps({
		readSettings: () => ({
			disabledExtensions: [{ scope: "user", source: "/x/ext.ts" }],
			disabledSkills: [],
			disabledPrompts: [],
			disableExtensionWhitelist: true,
		}),
	});
	try {
		const result = await runGlobalResourceMigration(deps);
		assert.equal(result.status, "completed");
		assert.equal(applied.length, 0);
		// 归档时不清理扩展禁用列表
		assert.equal("disabledExtensions" in settingsPatch[0], false);
	} finally {
		cleanup();
	}
});

test("project migration writes project scope and clears project private fields", async () => {
	const { deps, applied, projectCleared, cleanup } = makeDeps({
		readProjectLegacyState: async () => ({ disabledExtensions: [], disabledSkills: ["tidy"], disabledPrompts: [], inheritedExtensions: [], inheritedSkills: [], inheritedPrompts: [] }),
		resolveProjectResources: async () => [{ kind: "skills", name: "tidy", value: "/repo/.pi/skills/tidy/SKILL.md", scope: "project" }],
	});
	try {
		const result = await runProjectResourceMigration(deps, "p1");
		assert.equal(result.status, "completed");
		assert.deepEqual([...applied], ["skills|/repo/.pi/skills/tidy/SKILL.md|false"]);
		assert.equal(projectCleared.length, 1);
		assert.equal(projectCleared[0].projectId, "p1");
		assert.equal(projectCleared[0].patch.skills, true);
	} finally {
		cleanup();
	}
});

test("global migration disables a package install through the packages entry, not a path rule", async () => {
	const { deps, applied, cleanup } = makeDeps({
		readSettings: () => ({ disabledExtensions: [{ scope: "user", source: "npm:demo" }], disabledSkills: [], disabledPrompts: [], disableExtensionWhitelist: false }),
		// pi list 给的包行：path 是包目录，source 是 npm: 形态
		resolveGlobalResources: async () => [{ kind: "extensions", name: "npm:demo", value: "/home/me/.pi/agent/npm/node_modules/demo", scope: "user", packageSource: "npm:demo" }],
		service: {
			setFileResourceEnabled: async (request) => {
				applied.push(`file|${request.resourceId}`);
				return { ok: true, revision: "rev" };
			},
			setPackageEnabled: async (request) => {
				applied.push(`package|${request.resourceId}|${request.enabled}`);
				return { ok: true, revision: "rev" };
			},
		},
	});
	try {
		const result = await runGlobalResourceMigration(deps);
		assert.equal(result.status, "completed");
		assert.deepEqual([...applied], ["package|npm:demo|false"]);
	} finally {
		cleanup();
	}
});

test("project migration without project legacy records is skipped and recorded", async () => {
	const { deps, cleanup } = makeDeps({
		readProjectLegacyState: async () => ({ disabledExtensions: [], disabledSkills: [], disabledPrompts: [], inheritedExtensions: [], inheritedSkills: [], inheritedPrompts: [] }),
	});
	try {
		const result = await runProjectResourceMigration(deps, "p1");
		assert.equal(result.status, "skipped");
	} finally {
		cleanup();
	}
});
