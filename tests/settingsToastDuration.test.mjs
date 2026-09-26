import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { DEFAULT_TOAST_DURATION_MS, TOAST_DURATION_STICKY_MS } from "../src/shared/types/settings.ts";

// SettingsStore 依赖 electron / 日志 / git 路径解析器，全部用 stub 顶掉
// （与 tests/settingsStoreHiddenModules.test.mjs 同款）。
function makeStore() {
	const userData = mkdtempSync(join(tmpdir(), "pideck-toast-duration-user-"));
	const home = mkdtempSync(join(tmpdir(), "pideck-toast-duration-home-"));
	const { SettingsStore } = loadTsCommonJs("src/main/settings/SettingsStore.ts", {
		stubs: {
			electron: {
				app: {
					getPath: (key) => (key === "userData" ? userData : key === "home" ? home : tmpdir()),
				},
				BrowserWindow: class {},
				Menu: { setApplicationMenu: () => undefined },
			},
			"../logging/sharedLogger": { getAppLogger: () => undefined },
			"../git/gitExecutable": { setConfiguredGitPath: () => undefined },
		},
	});
	return { SettingsStore, userData };
}

/** 预置一份最小 settings.json：installationType / chatContentWidthPct 避免 load 尾部迁移钩子额外写盘。 */
function seed(userData, extra) {
	writeFileSync(join(userData, "settings.json"), JSON.stringify({ installationType: "installed", chatContentWidthPct: 80, ...extra }));
}

it("旧 settings.json 缺 toastDurationMs 时 load 回落默认值", async () => {
	const { SettingsStore, userData } = makeStore();
	seed(userData, {});
	const store = new SettingsStore();
	await store.load();
	assert.equal(store.get().toastDurationMs, DEFAULT_TOAST_DURATION_MS);
});

it("load 钳制脏值：0/负数/超界/字符串回落默认，常驻哨兵 -1 放行", async () => {
	const dirtyValues = [0, -5, 999, 60001, "4000", null, Number.POSITIVE_INFINITY];
	for (const dirty of dirtyValues) {
		const { SettingsStore, userData } = makeStore();
		seed(userData, { toastDurationMs: dirty });
		const store = new SettingsStore();
		await store.load();
		assert.equal(store.get().toastDurationMs, DEFAULT_TOAST_DURATION_MS, `脏值 ${String(dirty)} 应回落默认`);
	}
	const { SettingsStore, userData } = makeStore();
	seed(userData, { toastDurationMs: TOAST_DURATION_STICKY_MS });
	const store = new SettingsStore();
	await store.load();
	assert.equal(store.get().toastDurationMs, TOAST_DURATION_STICKY_MS);
});

it("update 钳制渲染层 patch 并落盘；合法档位与哨兵原样保留", async () => {
	const { SettingsStore, userData } = makeStore();
	seed(userData, {});
	const store = new SettingsStore();
	await store.load();

	const clamped = await store.update({ toastDurationMs: -3 });
	assert.equal(clamped.toastDurationMs, DEFAULT_TOAST_DURATION_MS);

	const sticky = await store.update({ toastDurationMs: TOAST_DURATION_STICKY_MS });
	assert.equal(sticky.toastDurationMs, TOAST_DURATION_STICKY_MS);
	// 哨兵必须是有限数：JSON.stringify(Infinity) 会写成 null，重启即丢
	const persisted = JSON.parse(readFileSync(join(userData, "settings.json"), "utf8"));
	assert.equal(persisted.toastDurationMs, TOAST_DURATION_STICKY_MS);

	const longer = await store.update({ toastDurationMs: 8000 });
	assert.equal(longer.toastDurationMs, 8000);
});
