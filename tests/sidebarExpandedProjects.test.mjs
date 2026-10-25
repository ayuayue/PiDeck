import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function loadModule() {
	const output = ts.transpileModule(readFileSync("src/renderer/src/utils/sidebarExpandedProjects.ts", "utf8"), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
		fileName: "sidebarExpandedProjects.ts",
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(
		output,
		{
			module,
			exports: module.exports,
			JSON,
			Object,
			Set,
			Array,
			require: (specifier) => {
				throw new Error(`Unexpected import: ${specifier}`);
			},
		},
		{ filename: "sidebarExpandedProjects.ts" },
	);
	return module.exports;
}

function createStorage(initial = {}) {
	const saved = new Map(Object.entries(initial));
	return {
		saved,
		getItem: (key) => (saved.has(key) ? saved.get(key) : null),
		setItem: (key, value) => saved.set(key, value),
		removeItem: (key) => saved.delete(key),
	};
}

const EXPANDED_KEY = "pid:sidebar-expanded-projects";
const LEGACY_KEY = "pid:sidebar-collapsed-projects";

test("defaults to chat only so startup does not scan every project", () => {
	const { defaultExpandedSidebarProjects, BUILTIN_CHAT_PROJECT_ID } = loadModule();
	assert.deepEqual([...defaultExpandedSidebarProjects()], [BUILTIN_CHAT_PROJECT_ID]);
});

test("round-trips expanded ids and drops the legacy key on write", () => {
	const { readExpandedSidebarProjects, writeExpandedSidebarProjects } = loadModule();
	const storage = createStorage({ [LEGACY_KEY]: JSON.stringify(["stale"]) });
	writeExpandedSidebarProjects(storage, new Set(["builtin-chat", "p1"]));
	assert.deepEqual(readExpandedSidebarProjects(storage), ["builtin-chat", "p1"]);
	assert.equal(storage.getItem(LEGACY_KEY), null);
});

test("reads null when no cache exists, and ignores malformed payloads", () => {
	const { readExpandedSidebarProjects } = loadModule();
	assert.equal(readExpandedSidebarProjects(createStorage()), null);
	assert.equal(readExpandedSidebarProjects(createStorage({ [EXPANDED_KEY]: "{oops" })), null);
	assert.equal(readExpandedSidebarProjects(createStorage({ [EXPANDED_KEY]: '{"a":1}' })), null);
	assert.equal(readExpandedSidebarProjects(undefined), null);
});

test("keeps only string ids from a mixed array", () => {
	const { readExpandedSidebarProjects } = loadModule();
	const storage = createStorage({ [EXPANDED_KEY]: JSON.stringify(["p1", 42, null, "p2"]) });
	assert.deepEqual(readExpandedSidebarProjects(storage), ["p1", "p2"]);
});

test("migrates the legacy collapsed set by inverting it against the project list", () => {
	const { migrateLegacyCollapsedProjects } = loadModule();
	const storage = createStorage({ [LEGACY_KEY]: JSON.stringify(["p2"]) });
	const migrated = migrateLegacyCollapsedProjects(storage, ["builtin-chat", "p1", "p2"]);
	assert.deepEqual([...migrated].sort(), ["builtin-chat", "p1"]);
});

test("migration always keeps chat expanded so the sidebar is never empty", () => {
	const { migrateLegacyCollapsedProjects } = loadModule();
	const storage = createStorage({ [LEGACY_KEY]: JSON.stringify(["builtin-chat", "p1"]) });
	const migrated = migrateLegacyCollapsedProjects(storage, ["builtin-chat", "p1"]);
	assert.deepEqual([...migrated], ["builtin-chat"]);
});

test("migration is skipped once the new cache exists, and without a legacy key", () => {
	const { migrateLegacyCollapsedProjects } = loadModule();
	const both = createStorage({
		[LEGACY_KEY]: JSON.stringify(["p1"]),
		[EXPANDED_KEY]: JSON.stringify(["p2"]),
	});
	assert.equal(migrateLegacyCollapsedProjects(both, ["p1", "p2"]), null);
	assert.equal(migrateLegacyCollapsedProjects(createStorage(), ["p1"]), null);
	// 项目列表还没到位时不迁移，否则会把全部项目误判为折叠
	const legacyOnly = createStorage({ [LEGACY_KEY]: JSON.stringify(["p1"]) });
	assert.equal(migrateLegacyCollapsedProjects(legacyOnly, []), null);
});

test("set comparison detects membership changes, not just size", () => {
	const { sameProjectIdSet } = loadModule();
	assert.equal(sameProjectIdSet(new Set(["a", "b"]), new Set(["b", "a"])), true);
	assert.equal(sameProjectIdSet(new Set(["a", "b"]), new Set(["a", "c"])), false);
	assert.equal(sameProjectIdSet(new Set(["a"]), new Set(["a", "b"])), false);
});
