import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

const missing = { sourcePath: "missing.jsonl", projectPathExists: false };
const existing = { sourcePath: "existing.jsonl", projectPathExists: true };

async function openDirectoryImport(sessions) {
	const host = quickMessageHookHost();
	const calls = [];
	const directorySessions = {
		listSources: async () => [],
		scan: async () => ({ kind: "group", sessions }),
		import: async (projectId, directory, paths) => {
			calls.push({ projectId, directory, paths: [...paths] });
			return { imported: paths.length, failed: 0, results: [] };
		},
	};
	const load = createTsSandbox({
		stubs: {
			react: host.react,
			"../i18n": { t: (key) => key },
			"../desktopApi": { desktopApi: { directorySessions, dialog: { pickFiles: async () => ["/source"] } } },
		},
	});
	const { useDirectoryImport } = load("src/renderer/src/hooks/useDirectoryImport.ts");
	const input = { setProjectMenu() {}, refreshProjectSessions: async () => {}, showToast() {} };
	const render = () => host.render(() => useDirectoryImport(input));
	render().open({ id: "target" });
	const controller = () => render().controller;
	await controller().chooseDirectory();
	controller().setOnlyMissingCwd(false);
	return { controller, calls };
}

test("directory import counts and submits only checked sessions allowed by the directory filter", async () => {
	const unchecked = { sourcePath: "unchecked.jsonl", projectPathExists: false };
	const { controller, calls } = await openDirectoryImport([existing, missing, unchecked]);
	controller().toggleAll();
	controller().toggle(unchecked.sourcePath);
	controller().setOnlyMissingCwd(true);

	const filtered = controller();
	await filtered.importSelected();
	assert.deepEqual(calls, [{ projectId: "target", directory: "/source", paths: [missing.sourcePath] }]);
	assert.deepEqual([...filtered.selectedPaths], [missing.sourcePath]);
});

test("directory import with only hidden selections skips submission and restores checks when shown again", async () => {
	const { controller, calls } = await openDirectoryImport([existing]);
	controller().toggle(existing.sourcePath);
	controller().setOnlyMissingCwd(true);

	const filtered = controller();
	assert.equal(filtered.sessions.length, 0);
	assert.equal(filtered.selectedPaths.length, 0);
	assert.equal(await filtered.importSelected(), null);
	assert.deepEqual(calls, []);

	controller().setOnlyMissingCwd(false);
	assert.deepEqual([...controller().selectedPaths], [existing.sourcePath]);
	await controller().importSelected();
	assert.deepEqual(calls, [{ projectId: "target", directory: "/source", paths: [existing.sourcePath] }]);
});

test("directory import cannot submit previous rows while a refresh hides the list", async () => {
	const { controller, calls } = await openDirectoryImport([missing]);
	controller().toggle(missing.sourcePath);
	const refresh = controller().refresh();
	const refreshing = controller();
	assert.equal(refreshing.loading, true);
	assert.equal(refreshing.selectedPaths.length, 0);
	assert.equal(await refreshing.importSelected(), null);
	await refresh;
	assert.deepEqual(calls, []);
});
