import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { shouldShowDshRuntimeMigrationNotice } = loadTsCommonJs("src/shared/types/dshRuntime.ts");

// SettingsStore 依赖 electron / 日志 / git 路径解析器，全部用 stub 顶掉
// （与 tests/settingsStoreHiddenModules.test.mjs 同款）。
function makeStore() {
	const userData = mkdtempSync(join(tmpdir(), "pideck-migration-notice-user-"));
	const home = mkdtempSync(join(tmpdir(), "pideck-migration-notice-home-"));
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

/** 预置一份最小 settings.json（installationType/chatContentWidthPct 避免 load 尾部迁移钩子额外写盘）。 */
function seed(userData, extra) {
	writeFileSync(join(userData, "settings.json"), JSON.stringify({ installationType: "installed", chatContentWidthPct: 80, ...extra }));
}

// 注意：loadTsCommonJs 用 vm 沙箱加载，返回对象的原型不是本 realm 的 Object.prototype，
// deepEqual 断言逐字段进行，避开跨 realm 比较。

it("迁移提示判定：runtime 不可用 + 有 dsh 会话 + 未提示过 → 弹", () => {
	for (const state of ["notInstalled", "broken", "outdated"]) {
		assert.equal(shouldShowDshRuntimeMigrationNotice({ state, hasDshSessions: true, alreadyShown: false }), true, state);
	}
});

it("迁移提示判定：已提示过（闩置位）永不重弹——#317 的原始抱怨是每次重启都弹", () => {
	for (const state of ["notInstalled", "broken", "outdated"]) {
		assert.equal(shouldShowDshRuntimeMigrationNotice({ state, hasDshSessions: true, alreadyShown: true }), false, state);
	}
});

it("迁移提示判定：checking/installed 不弹（中间态误报 / runtime 正常无迁移）", () => {
	for (const state of ["checking", "installed"]) {
		assert.equal(shouldShowDshRuntimeMigrationNotice({ state, hasDshSessions: true, alreadyShown: false }), false, state);
	}
});

it("迁移提示判定：没有 dsh 会话不弹（新装用户自然走安装引导）", () => {
	assert.equal(shouldShowDshRuntimeMigrationNotice({ state: "notInstalled", hasDshSessions: false, alreadyShown: false }), false);
});

it("SettingsStore：旧 JSON 缺字段回落 false（首次启动照常提示一次）", async () => {
	const { SettingsStore, userData } = makeStore();
	seed(userData, {});
	const store = new SettingsStore();
	await store.load();
	assert.equal(store.get().dshRuntimeMigrationNoticeShown, false);
});

it("SettingsStore：load 清洗脏值——非布尔回落 false，不得永久静音提示", async () => {
	const { SettingsStore, userData } = makeStore();
	seed(userData, { dshRuntimeMigrationNoticeShown: "true" });
	const store = new SettingsStore();
	await store.load();
	assert.equal(store.get().dshRuntimeMigrationNoticeShown, false);
});

it("SettingsStore：展示后可持久化置位，跨重启读到 true", async () => {
	const { SettingsStore, userData } = makeStore();
	seed(userData, {});
	const store = new SettingsStore();
	await store.load();
	await store.update({ dshRuntimeMigrationNoticeShown: true });
	assert.equal(store.get().dshRuntimeMigrationNoticeShown, true);

	const reloaded = new SettingsStore();
	await reloaded.load();
	assert.equal(reloaded.get().dshRuntimeMigrationNoticeShown, true);
});

it("SettingsStore：update 拒绝非布尔——脏 true 会静音提示、脏 false 会重弹", async () => {
	const { SettingsStore, userData } = makeStore();
	seed(userData, {});
	const store = new SettingsStore();
	await store.load();
	await store.update({ dshRuntimeMigrationNoticeShown: "yes" });
	assert.equal(store.get().dshRuntimeMigrationNoticeShown, false);
	await store.update({ dshRuntimeMigrationNoticeShown: 1 });
	assert.equal(store.get().dshRuntimeMigrationNoticeShown, false);
});
