import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

function importDialog({ scan, importSessions, refreshProjectSessions = async () => {} }) {
	const host = quickMessageHookHost();
	const { useImportSource } = loadTsCommonJs("src/renderer/src/hooks/useImportSource.ts", { stubs: { react: host.react } });
	const notices = [];
	const config = { copyPrefix: "claude", scan, importSessions, refreshProjectSessions, setProjectMenu: () => {}, showToast: (message) => notices.push(message), t: (key) => key };
	return { render: () => host.render(() => useImportSource(config)), notices };
}

test("Claude import keeps B's rows and selection when A's earlier scan finishes last", async () => {
	const slow = Promise.withResolvers();
	const imported = [];
	const { render } = importDialog({
		scan: (id) => (id === "A" ? slow.promise : Promise.resolve([{ sourcePath: "B.jsonl" }])),
		importSessions: async (id, paths) => {
			imported.push([id, ...paths]);
			return { imported: 1, failed: 0 };
		},
	});
	const first = render().open({ id: "A" });
	render().setProject(null);
	await render().open({ id: "B" });
	render().controller.toggle("B.jsonl");
	slow.resolve([{ sourcePath: "A.jsonl" }]);
	await first;
	const { project, controller } = render();
	assert.equal(project.id, "B");
	assert.deepEqual(controller.sessions, [{ sourcePath: "B.jsonl" }]);
	assert.deepEqual([...controller.selectedPaths], ["B.jsonl"]);
	await controller.importSelected();
	assert.deepEqual(imported, [["B", "B.jsonl"]]);
});

test("a dismissed scan cannot show an error or stop a new scan of the same project", async () => {
	const oldScan = Promise.withResolvers();
	const newScan = Promise.withResolvers();
	const scans = [oldScan, newScan];
	const { render, notices } = importDialog({ scan: () => scans.shift().promise });
	const project = { id: "A" };
	const first = render().open(project);
	render().setProject(null);
	const second = render().open(project);
	oldScan.reject(new Error("old scan failed"));
	await first;
	assert.equal(render().controller.loading, true);
	assert.deepEqual(notices, []);
	newScan.resolve([]);
	await second;
	assert.equal(render().controller.loading, false);
});

test("closing the dialog discards a pending scan even when nothing else opens", async () => {
	const pending = Promise.withResolvers();
	const { render } = importDialog({ scan: () => pending.promise });
	const opening = render().open({ id: "A" });
	render().setProject(null);
	pending.resolve([{ sourcePath: "A.jsonl" }]);
	await opening;
	const { project, controller } = render();
	assert.equal(project, null);
	assert.equal(controller.sessions.length, 0);
	assert.equal(controller.loading, false);
});

test("within an open dialog only the latest refresh can replace the list", async () => {
	const first = Promise.withResolvers();
	const second = Promise.withResolvers();
	const responses = [Promise.resolve([]), first.promise, second.promise];
	const { render } = importDialog({ scan: () => responses.shift() });
	await render().open({ id: "A" });
	const earlier = render().controller.refresh();
	const later = render().controller.refresh();
	second.resolve([{ sourcePath: "latest.jsonl" }]);
	await later;
	render().controller.toggle("latest.jsonl");
	first.resolve([]);
	await earlier;
	const { controller } = render();
	assert.deepEqual(controller.sessions, [{ sourcePath: "latest.jsonl" }]);
	assert.deepEqual([...controller.selectedPaths], ["latest.jsonl"]);
});

test("an import finishing after switching projects refreshes only the original catalog", async () => {
	const pending = Promise.withResolvers();
	const scans = [];
	const catalogs = [];
	const { render, notices } = importDialog({
		scan: async (id) => {
			scans.push(id);
			return [{ sourcePath: id + ".jsonl" }];
		},
		importSessions: () => pending.promise,
		refreshProjectSessions: async (id) => catalogs.push(id),
	});
	await render().open({ id: "A" });
	render().controller.toggle("A.jsonl");
	const importing = render().controller.importSelected();
	render().setProject(null);
	await render().open({ id: "B" });
	pending.resolve({ imported: 1, failed: 0 });
	await importing;
	assert.deepEqual(catalogs, ["A"]);
	assert.deepEqual(scans, ["A", "B"]);
	assert.deepEqual(render().controller.sessions, [{ sourcePath: "B.jsonl" }]);
	assert.equal(render().controller.report, null);
	assert.deepEqual(notices, []);
});
