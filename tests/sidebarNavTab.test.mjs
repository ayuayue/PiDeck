import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function loadModule() {
	const output = ts.transpileModule(readFileSync("src/renderer/src/utils/sidebarNavTab.ts", "utf8"), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
		fileName: "sidebarNavTab.ts",
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(
		output,
		{
			module,
			exports: module.exports,
			JSON,
			Object,
			Array,
			require: (specifier) => {
				throw new Error(`Unexpected import: ${specifier}`);
			},
		},
		{ filename: "sidebarNavTab.ts" },
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

const TAB_KEY = "pid:sidebar-nav-tab";

test("defaults to chats so the sidebar opens on the current project session list", () => {
	const { DEFAULT_SIDEBAR_NAV_TAB } = loadModule();
	assert.equal(DEFAULT_SIDEBAR_NAV_TAB, "chats");
});

test("round-trips active/chats/projects", () => {
	const { readSidebarNavTab, writeSidebarNavTab } = loadModule();
	const storage = createStorage();
	writeSidebarNavTab(storage, "projects");
	assert.equal(readSidebarNavTab(storage), "projects");
	writeSidebarNavTab(storage, "chats");
	assert.equal(readSidebarNavTab(storage), "chats");
	writeSidebarNavTab(storage, "active");
	assert.equal(readSidebarNavTab(storage), "active");
	assert.equal(storage.getItem(TAB_KEY), "active");
});

test("reads null when no cache exists, and ignores malformed payloads", () => {
	const { readSidebarNavTab, parseSidebarNavTab } = loadModule();
	assert.equal(readSidebarNavTab(createStorage()), null);
	assert.equal(readSidebarNavTab(createStorage({ [TAB_KEY]: "files" })), null);
	assert.equal(readSidebarNavTab(createStorage({ [TAB_KEY]: '{"tab":"chats"}' })), null);
	assert.equal(readSidebarNavTab(undefined), null);
	assert.equal(parseSidebarNavTab(null), null);
	assert.equal(parseSidebarNavTab("chats"), "chats");
	assert.equal(parseSidebarNavTab("projects"), "projects");
	assert.equal(parseSidebarNavTab("active"), "active");
	assert.equal(parseSidebarNavTab("files"), null);
});

test("write is a no-op when storage is missing", () => {
	const { writeSidebarNavTab } = loadModule();
	assert.doesNotThrow(() => writeSidebarNavTab(undefined, "projects"));
});
