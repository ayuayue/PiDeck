import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "../helpers/loadTsCommonJs.mjs";

const { createDefaultAppSettings } = loadTsCommonJs("src/shared/types/settings.ts");

/** 用隔离目录加载设置，避免默认值测试读写真实桌面或 pi 配置。 */
function makeStore(t) {
	const root = mkdtempSync(join(tmpdir(), "pideck-cua-default-"));
	const userData = join(root, "userData");
	const home = join(root, "home");
	mkdirSync(userData);
	mkdirSync(home);
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const { SettingsStore } = loadTsCommonJs("src/main/settings/SettingsStore.ts", {
		stubs: {
			electron: {
				app: { getPath: (key) => (key === "userData" ? userData : home) },
				BrowserWindow: class {},
				Menu: { setApplicationMenu: () => undefined },
			},
			"../logging/sharedLogger": { getAppLogger: () => undefined },
			"../git/gitExecutable": { setConfiguredGitPath: () => undefined },
		},
	});
	return { SettingsStore, filePath: join(userData, "settings.json") };
}

/** 预置旧配置时跳过无关的安装类型和宽度迁移写盘。 */
function seed(filePath, patch) {
	writeFileSync(filePath, JSON.stringify({ installationType: "installed", chatContentWidthPct: 80, ...patch }));
}

test("shared defaults enable CUA auto-approval but leave CUA itself disabled", () => {
	const settings = createDefaultAppSettings();
	assert.equal(settings.cuaAutoApprove, true);
	assert.equal(settings.cuaEnabled, false);
});

test("a fresh SettingsStore defaults to auto-approval without enabling CUA", async (t) => {
	const { SettingsStore } = makeStore(t);
	const store = new SettingsStore();
	assert.equal(store.get().cuaAutoApprove, true);
	assert.equal(store.get().cuaEnabled, false);
	await store.load();
	assert.equal(store.get().cuaAutoApprove, true);
	assert.equal(store.get().cuaEnabled, false);
});

test("old settings without cuaAutoApprove inherit the enabled default", async (t) => {
	const { SettingsStore, filePath } = makeStore(t);
	seed(filePath, { cuaEnabled: true });
	const store = new SettingsStore();
	await store.load();
	assert.equal(store.get().cuaAutoApprove, true);
	assert.equal(store.get().cuaEnabled, true);
});

test("an explicit opt-out survives loading, saving, and reloading", async (t) => {
	const { SettingsStore, filePath } = makeStore(t);
	seed(filePath, { cuaAutoApprove: false });
	const store = new SettingsStore();
	await store.load();
	assert.equal(store.get().cuaAutoApprove, false);
	await store.update({ cuaAutoApprove: true });
	await store.update({ cuaAutoApprove: false });
	assert.equal(JSON.parse(readFileSync(filePath, "utf8")).cuaAutoApprove, false);
	const reloaded = new SettingsStore();
	await reloaded.load();
	assert.equal(reloaded.get().cuaAutoApprove, false);
});

test("preview and the settings switch use the same enabled auto-approval default", () => {
	const preview = readFileSync("src/renderer/src/previewApi.ts", "utf8");
	assert.match(preview, /cuaAutoApprove\s*:\s*true\b/);
	assert.match(preview, /cuaEnabled\s*:\s*false\b/);
	const commonTab = readFileSync("src/renderer/src/components/app/settings/CommonTab.tsx", "utf8");
	assert.match(commonTab, /checked\s*=\s*\{\s*draft\.cuaAutoApprove\s*\?\?\s*true\s*\}/);
});
