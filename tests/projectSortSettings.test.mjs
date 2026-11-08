import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

const flush = () => new Promise((resolve) => setImmediate(resolve));

function sortHook() {
	const host = quickMessageHookHost();
	const { useProjectSortMode } = loadTsCommonJs("src/renderer/src/hooks/sidebar/useProjectSortMode.ts", { stubs: { react: host.react } });
	return (options) => host.render(() => useProjectSortMode(options));
}

test("project sort hydrates saved settings once and preserves an earlier user choice", () => {
	const render = sortHook();
	const saved = [];
	const options = { settingsLoaded: false, persistProjectSortMode: (mode) => saved.push(mode) };
	assert.equal(render(options).projectSortMode, "manual");
	render({ ...options, settingsLoaded: true, settingsProjectSortMode: "title" });
	assert.equal(render({ ...options, settingsLoaded: true, settingsProjectSortMode: "title" }).projectSortMode, "title");
	const early = sortHook();
	early(options).setProjectSortMode("createdAt");
	early({ ...options, settingsLoaded: true, settingsProjectSortMode: "title" });
	assert.equal(early(options).projectSortMode, "createdAt");
	assert.deepEqual(saved, ["createdAt"]);
});

test("project sort preference persists and invalid disk or update values fall back to manual", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-project-sort-settings-"));
	const userData = join(root, "data");
	const home = join(root, "home");
	try {
		await mkdir(userData);
		await mkdir(home);
		const { SettingsStore } = loadTsCommonJs("src/main/settings/SettingsStore.ts", {
			stubs: {
				electron: { app: { getPath: (key) => (key === "userData" ? userData : home) }, BrowserWindow: class {}, Menu: { setApplicationMenu() {} } },
				"../logging/sharedLogger": { getAppLogger: () => undefined },
				"../git/gitExecutable": { setConfiguredGitPath() {} },
			},
		});
		const file = join(userData, "settings.json");
		await writeFile(file, JSON.stringify({ installationType: "installed", chatContentWidthPct: 80, projectSortMode: "invalid" }));
		const store = new SettingsStore();
		await store.load();
		assert.equal(store.get().projectSortMode, "manual");
		await store.update({ projectSortMode: "updatedAt" });
		assert.equal(JSON.parse(await readFile(file, "utf8")).projectSortMode, "updatedAt");
		const reloaded = new SettingsStore();
		await reloaded.load();
		assert.equal(reloaded.get().projectSortMode, "updatedAt");
		await reloaded.update({ projectSortMode: 123 });
		assert.equal(reloaded.get().projectSortMode, "manual");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("recent project sorting reads only cached catalogs and ignores results after mode changes", async () => {
	const host = quickMessageHookHost();
	const { useCachedProjectActivity } = loadTsCommonJs("src/renderer/src/hooks/sidebar/useCachedProjectActivity.ts", { stubs: { react: host.react } });
	const projects = [{ id: "chat", kind: "chat" }, { id: "a" }, { id: "worktree", worktreeParentId: "a" }];
	const calls = [];
	const pending = [];
	const errors = [];
	const listCatalog = (id, options) => {
		calls.push({ id, ...options });
		return new Promise((resolve, reject) => pending.push({ resolve, reject }));
	};
	const render = (enabled) => host.render(() => useCachedProjectActivity(projects, enabled, listCatalog, (error) => errors.push(error)));
	assert.deepEqual(Object.keys(render(false)), []);
	assert.equal(calls.length, 0);
	render(true);
	assert.deepEqual(calls, [
		{ id: "a", scan: false },
		{ id: "worktree", scan: false },
	]);
	pending[0].resolve([{ updatedAt: 10 }, { updatedAt: 20 }]);
	pending[1].resolve([{ updatedAt: 30 }]);
	await flush();
	assert.deepEqual(JSON.parse(JSON.stringify(render(true))), { a: 20, worktree: 30 });
	render(false);
	render(true);
	render(false);
	pending[2].resolve([{ updatedAt: 999 }]);
	pending[3].reject(new Error("late failure"));
	await flush();
	assert.deepEqual(JSON.parse(JSON.stringify(render(false))), { a: 20, worktree: 30 });
	assert.deepEqual(errors, []);
	render(true);
	pending[4].resolve([]);
	pending[5].reject(new Error("cache unavailable"));
	await flush();
	assert.deepEqual(JSON.parse(JSON.stringify(render(true))), { a: 0 });
	assert.equal(errors.length, 1);
	assert.equal(errors[0].message, "cache unavailable");
	host.unmount();
});
