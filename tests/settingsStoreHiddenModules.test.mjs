import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// SettingsStore 依赖 electron / 日志 / git 路径解析器，全部用 stub 顶掉
// （与 tests/settingsStoreAtomicSave.test.mjs 同款）。
function makeStore() {
	const userData = mkdtempSync(join(tmpdir(), "pideck-hidden-modules-user-"));
	const home = mkdtempSync(join(tmpdir(), "pideck-hidden-modules-home-"));
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

const plain = (value) => JSON.parse(JSON.stringify(value));

it("旧 settings.json 缺 hiddenModules 时回落空数组（默认全部显示，零迁移）", async () => {
	const { SettingsStore, userData } = makeStore();
	seed(userData, {});
	const store = new SettingsStore();
	await store.load();
	assert.deepEqual(plain(store.get().hiddenModules), []);
});

it("load 清洗脏值：非数组回落空数组，数组内非法项被丢弃并去重", async () => {
	const { SettingsStore, userData } = makeStore();
	seed(userData, { hiddenModules: "dsh" });
	let store = new SettingsStore();
	await store.load();
	assert.deepEqual(plain(store.get().hiddenModules), []);

	seed(userData, { hiddenModules: ["dsh", "", 1, null, "dsh", " im "] });
	store = new SettingsStore();
	await store.load();
	assert.deepEqual(plain(store.get().hiddenModules), ["dsh", "im"]);
});

it("update 清洗渲染层 patch 并落盘；未知 id 原样保留", async () => {
	const { SettingsStore, userData } = makeStore();
	seed(userData, {});
	const store = new SettingsStore();
	await store.load();
	const next = await store.update({ hiddenModules: ["im", "im", "", "future-module"] });
	assert.deepEqual(plain(next.hiddenModules), ["im", "future-module"]);
	const persisted = JSON.parse(readFileSync(join(userData, "settings.json"), "utf8"));
	assert.deepEqual(persisted.hiddenModules, ["im", "future-module"]);

	// 非数组 patch 视为清空（回到全部显示），而不是保留旧值——这是「恢复显示全部」的正常路径
	const cleared = await store.update({ hiddenModules: null });
	assert.deepEqual(plain(cleared.hiddenModules), []);
});

it("已删除的 composerModes 开关：旧数据从两份清单里清掉并落盘", async () => {
	const { SettingsStore, userData } = makeStore();
	// 该开关历史上先存在 hiddenModules，后搬到 hiddenComposerFeatures；2026-10 功能删除后两处都要清，
	// 否则 settings.json 会永久携带一个没有 UI 的隐藏项。
	seed(userData, { hiddenModules: ["im", "composerModes"], hiddenComposerFeatures: ["composerModes", "voice"] });
	const store = new SettingsStore();
	await store.load();
	assert.deepEqual(plain(store.get().hiddenModules), ["im"], "旧 id 必须从 hiddenModules 清掉");
	assert.deepEqual(plain(store.get().hiddenComposerFeatures), ["voice"], "新清单里的残留 id 也要清掉，其余隐藏项保留");

	// load 里的迁移 save 是 fire-and-forget；跟一次 update 等在同一条 saveChain 上，确保迁移已落盘
	await store.update({ hiddenModules: plain(store.get().hiddenModules) });
	const persisted = JSON.parse(readFileSync(join(userData, "settings.json"), "utf8"));
	assert.deepEqual(persisted.hiddenModules, ["im"]);
	assert.deepEqual(persisted.hiddenComposerFeatures, ["voice"]);
});
