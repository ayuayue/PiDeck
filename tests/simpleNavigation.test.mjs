import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { visitSession, pruneSessionHistory } = loadTsCommonJs("src/renderer/src/utils/sessionNavigationHistory.ts");
const plain = (value) => JSON.parse(JSON.stringify(value));

test("history: back/forward do not append, a fresh visit truncates forward entries", () => {
	let history = { entries: [], index: -1 };
	for (const id of ["a", "b", "c"]) history = visitSession(history, id);
	history = { ...history, index: 1 };
	assert.equal(visitSession(history, "b"), history);
	assert.deepEqual(plain(visitSession(history, "d")), { entries: ["a", "b", "d"], index: 2 });
});

test("history: deleting recorded sessions prunes entries without retaining invalid targets", () => {
	assert.deepEqual(plain(pruneSessionHistory({ entries: ["a", "b", "c"], index: 2 }, (id) => id !== "b")), { entries: ["a", "c"], index: 1 });
	assert.deepEqual(plain(pruneSessionHistory({ entries: ["a"], index: 0 }, () => false)), { entries: [], index: -1 });
});

test("navigation setting defaults, normalizes old/invalid data, persists and ignores invalid patches", async () => {
	const base = resolve(".cache/simple-navigation-unit");
	mkdirSync(base, { recursive: true });
	const root = mkdtempSync(join(base, "navigation-"));
	try {
		const { SettingsStore } = loadTsCommonJs("src/main/settings/SettingsStore.ts", {
			stubs: {
				electron: { app: { getPath: () => root }, BrowserWindow: class {}, Menu: { setApplicationMenu() {} } },
				"../logging/sharedLogger": { getAppLogger: () => undefined },
				"../git/gitExecutable": { setConfiguredGitPath() {} },
			},
		});
		for (const value of [undefined, "broken", null, 1]) {
			writeFileSync(join(root, "settings.json"), JSON.stringify({ installationType: "installed", chatContentWidthPct: 80, navigationMode: value }));
			const store = new SettingsStore();
			await store.load();
			assert.equal(store.get().navigationMode, "tabs");
			assert.equal((await store.update({ navigationMode: "simple" })).navigationMode, "simple");
			assert.equal((await store.update({ navigationMode: "broken" })).navigationMode, "simple");
			assert.equal(JSON.parse(readFileSync(join(root, "settings.json"), "utf8")).navigationMode, "simple");
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
