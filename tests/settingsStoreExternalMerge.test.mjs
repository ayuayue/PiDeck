import { mkdtempSync } from "./helpers/tempDir.mjs";
import { it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// #433：deck 运行期间用户手改 settings.json（如按 release notes 加 acpPromptTurnTimeoutMs），
// 随后任何一次内部 update（版本通知/面板宽度等）触发全量写盘，外部修改被内存旧值整体抹掉。
// 修复语义：写盘前发现磁盘内容 ≠ 上次自写内容（外部被动过）→ 以磁盘为基底做顶层键级合并，
// 只把程序真正变更过的键盖回去。stub 结构与 tests/settingsStoreAtomicSave.test.mjs 同款。
function makeStore() {
	const userData = mkdtempSync(join(tmpdir(), "pideck-settings-merge-"));
	const home = mkdtempSync(join(tmpdir(), "pideck-settings-home-"));
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
	return { SettingsStore, userData, mainPath: join(userData, "settings.json") };
}

it("内部 update 不得抹掉运行期间的外部手改（#433：外部新增键保留 + 内部变更生效）", async () => {
	const { SettingsStore, mainPath } = makeStore();
	const store = new SettingsStore();
	await store.load();
	// 第一代落盘，建立「上次自写内容」基准
	await store.update({ closeToTray: false });
	await store.flushPendingSave();
	// 模拟用户在 deck 运行期间手改 settings.json：新增 acpPromptTurnTimeoutMs
	const external = JSON.parse(readFileSync(mainPath, "utf8"));
	external.acpPromptTurnTimeoutMs = 3600000;
	writeFileSync(mainPath, JSON.stringify(external, null, 2), "utf8");
	// 内部 patch（模拟版本通知等任意 update）触发全量写盘
	await store.update({ closeToTray: true });
	await store.flushPendingSave();

	const onDisk = JSON.parse(readFileSync(mainPath, "utf8"));
	assert.equal(onDisk.acpPromptTurnTimeoutMs, 3600000, "外部手改的键必须存活");
	assert.equal(onDisk.closeToTray, true, "程序自身的变更必须照常生效");
});

it("load 时已存在的文件被外部修改：外部值保留（内存未动该键时不得用内存旧值覆盖）", async () => {
	const { SettingsStore, mainPath } = makeStore();
	writeFileSync(mainPath, JSON.stringify({ closeToTray: false }), "utf8");
	const store = new SettingsStore();
	await store.load();
	// 外部把既有键改成新值，同时加一个外部键
	const external = JSON.parse(readFileSync(mainPath, "utf8"));
	external.closeToTray = true;
	external.acpPromptTurnTimeoutMs = 3600000;
	writeFileSync(mainPath, JSON.stringify(external, null, 2), "utf8");
	// 内部只动了别的键
	await store.update({ chatContentWidthPct: 72 });
	await store.flushPendingSave();

	const onDisk = JSON.parse(readFileSync(mainPath, "utf8"));
	assert.equal(onDisk.closeToTray, true, "外部改的既有键保留外部值");
	assert.equal(onDisk.acpPromptTurnTimeoutMs, 3600000, "外部新增键保留");
	assert.equal(onDisk.chatContentWidthPct, 72, "内部变更的键照常生效");
});

it("程序 update 与基准同值（无实际变更）时视为未碰键：外部改动存活（#433 边界语义）", async () => {
	const { SettingsStore, mainPath } = makeStore();
	const store = new SettingsStore();
	await store.load();
	await store.update({ closeToTray: false });
	await store.flushPendingSave();
	// 外部把键改成 true；随后程序 update 回与基准相同的 false（无实际变更，如重设同值）
	const external = JSON.parse(readFileSync(mainPath, "utf8"));
	external.closeToTray = true;
	writeFileSync(mainPath, JSON.stringify(external, null, 2), "utf8");
	await store.update({ closeToTray: false });
	await store.flushPendingSave();

	assert.equal(JSON.parse(readFileSync(mainPath, "utf8")).closeToTray, true, "程序未实际变更的键保留外部值");
});

it("外部文件被改坏（非法 JSON）时退回内存覆盖，保存不阻塞", async () => {
	const { SettingsStore, mainPath } = makeStore();
	const store = new SettingsStore();
	await store.load();
	await store.update({ closeToTray: false });
	await store.flushPendingSave();
	writeFileSync(mainPath, "{broken json", "utf8");
	await store.update({ closeToTray: true });
	await store.flushPendingSave();

	assert.equal(JSON.parse(readFileSync(mainPath, "utf8")).closeToTray, true, "坏文件场景退回覆盖，写盘成功");
});
