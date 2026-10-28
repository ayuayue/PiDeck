import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

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
