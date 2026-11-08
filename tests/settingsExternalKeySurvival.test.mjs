import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * #501：settings.json 里手工添加的键必须在**任意多次**内部写盘后仍然存在。
 *
 * 历史缺陷有两条路径：
 * 1. 基准（合并对照）用的是落盘原文，而落盘原文混进磁盘侧手工键 → 下一轮把键判成
 *    「程序里已删除」；
 * 2. 可选键的 sanitizer 把非法/缺省值归一成 `undefined`，内存里属性存在但值为
 *    undefined，`JSON.stringify` 写盘时把键丢掉（手工改大的 stall 阈值因此静默回滚）。
 */

function createStore(initial) {
	const dir = mkdtempSync(join(tmpdir(), "pideck-settings-501-"));
	const file = join(dir, "settings.json");
	writeFileSync(file, JSON.stringify(initial, null, 2));
	const electronStub = {
		app: { getPath: (key) => (key === "userData" ? dir : tmpdir()), getLocale: () => "zh-CN", on: () => {}, getVersion: () => "0.0.0", isReady: () => true, whenReady: () => Promise.resolve() },
		BrowserWindow: class {},
		Menu: { setApplicationMenu() {}, buildFromTemplate: () => ({}) },
	};
	const { SettingsStore } = loadTsCommonJs("src/main/settings/SettingsStore.ts", { stubs: { electron: electronStub } });
	if (!SettingsStore) assert.fail("SettingsStore 未能加载");
	return { store: new SettingsStore(), file };
}

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

/** update() 的 promise 挂在 unref 过的防抖定时器上，脚本里不会 settle；直接冲刷保存链。 */
async function saveNow(store, patch) {
	void store.update(patch);
	await store.flushPendingSave();
	// 保存链是串行的，冲刷后可能还有一次 await 尾部；给一轮宏任务让写盘完成。
	await new Promise((resolve) => setTimeout(resolve, 30));
}

test("未知手工键在多次内部写盘后仍保留", async () => {
	const { store, file } = createStore({ theme: "system", installationType: "installed", myExternalFlag: true });
	await store.load();
	await saveNow(store, { theme: "dark" });
	await saveNow(store, { theme: "light" });

	const saved = readJson(file);
	assert.equal(saved.myExternalFlag, true, "手工键被静默删除");
	assert.equal(saved.theme, "light", "内部改动必须正常落盘");
});

test("可选键被 sanitizer 归一为 undefined 时，磁盘上的手工值也保留", async () => {
	// 超出 sanitizeOptionalPositiveIntMs 上限（86400000）→ 内存值 undefined，磁盘值仍在
	const { store, file } = createStore({ theme: "system", installationType: "installed", acpPromptStallTimeoutMs: 999999999 });
	await store.load();
	await saveNow(store, { theme: "dark" });
	await saveNow(store, { theme: "light" });

	assert.equal(readJson(file).acpPromptStallTimeoutMs, 999999999, "手工调大的阈值被回滚");
});

test("合法的手工值原样保留且不被内存默认值覆盖", async () => {
	const { store, file } = createStore({ theme: "system", installationType: "installed", acpPromptStallTimeoutMs: 1200000 });
	await store.load();
	await saveNow(store, { theme: "dark" });
	await saveNow(store, { theme: "light" });

	assert.equal(readJson(file).acpPromptStallTimeoutMs, 1200000);
});

test("连续写盘收敛：同样的设置写两次得到同一份 JSON（可重入）", async () => {
	const { store, file } = createStore({ theme: "system", installationType: "installed", myExternalFlag: true });
	await store.load();
	await saveNow(store, { theme: "dark" });
	const first = readFileSync(file, "utf8");
	await saveNow(store, { theme: "dark" });
	assert.equal(readFileSync(file, "utf8"), first, "重复写同一设置不应改变文件内容");
});
