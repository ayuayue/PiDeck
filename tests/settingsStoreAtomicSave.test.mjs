import { it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// SettingsStore 依赖 electron（app/Menu/BrowserWindow）、主进程日志与 git 路径解析器，
// 全部用 stub 顶掉；userData/home 指向临时目录，Menu/日志/git 为 no-op。
// stub 结构与 tests/dshSettingsConflict.test.mjs 同款（同一生产模块的既有加载先例）。
function makeStore() {
	const userData = mkdtempSync(join(tmpdir(), "pideck-settings-user-"));
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
	return { SettingsStore, userData };
}

it("主文件损坏时回退 .bak 而不是静默重置为默认值（H4）", async () => {
	const { SettingsStore, userData } = makeStore();
	// .bak 预置 installationType / chatContentWidthPct，避免 load 尾部的
	// detectAndSaveInstallationType / migrateContentWidth 钩子触发额外 save 干扰断言。
	writeFileSync(join(userData, "settings.json.bak"), JSON.stringify({ closeToTray: false, installationType: "installed", chatContentWidthPct: 80 }));
	// 模拟撕裂写：截断的 JSON 主文件
	writeFileSync(join(userData, "settings.json"), '{"closeToTray": false, "rpcTim');

	const store = new SettingsStore();
	await store.load();
	assert.equal(store.get().closeToTray, false);
});

it("update 保存后：主文件可解析、无 .tmp 残留、.bak 为上一代内容（H4；2027-02 起写盘带 150ms 尾随合并）", async () => {
	const { SettingsStore, userData } = makeStore();
	const store = new SettingsStore();
	await store.load();
	// 第一代：落盘 closeToTray=false（flush 立即结算合并窗口）
	await store.update({ closeToTray: false });
	await store.flushPendingSave();
	// 第二代：burst 内的两次 update 合并为一次写盘（防写放大治理），最终值 true
	void store.update({ closeToTray: true });
	await store.update({ closeToTray: true });
	await store.flushPendingSave();

	const mainPath = join(userData, "settings.json");
	assert.equal(JSON.parse(readFileSync(mainPath, "utf8")).closeToTray, true);
	assert.equal(existsSync(`${mainPath}.tmp`), false);
	// .bak 必须保留上一代内容（内容未变化不重复复制——去重后的上一代），供 load 损坏兜底回退
	const bak = JSON.parse(readFileSync(`${mainPath}.bak`, "utf8"));
	assert.equal(bak.closeToTray, false);
});

it("写盘尾随合并：burst 内多次 update 只落一轮盘（2027-02 写放大治理）", async () => {
	const { SettingsStore, userData } = makeStore();
	const store = new SettingsStore();
	await store.load();
	await store.flushPendingSave();
	const mainPath = join(userData, "settings.json");
	const before = readFileSync(mainPath, "utf8");
	// 连续 5 次 update（模拟面板宽度拖拽的高频写源），全部落在合并窗口内
	for (let index = 0; index < 5; index += 1) {
		void store.update({ chatContentWidthPct: 60 + index });
		await new Promise((resolve) => setImmediate(resolve));
	}
	// 窗口未到期：主文件仍是旧一代（burst 尚未落盘——这正是合并的意义）
	assert.equal(readFileSync(mainPath, "utf8"), before, "合并窗口内不得写盘");
	await store.flushPendingSave();
	assert.equal(JSON.parse(readFileSync(mainPath, "utf8")).chatContentWidthPct, 64, "flush 后 burst 的最终值一次性落盘");
});
it("TPS 模式兼容旧设置和非法磁盘值，默认流式", async () => {
	for (const value of [undefined, null, "unknown", 123]) {
		const { SettingsStore, userData } = makeStore();
		writeFileSync(join(userData, "settings.json"), JSON.stringify({ installationType: "installed", chatContentWidthPct: 80, tpsDisplayMode: value }));
		const store = new SettingsStore();
		await store.load();
		assert.equal(store.get().tpsDisplayMode, "streaming");
	}
});

it("TPS 模式保存后立即返回，重启恢复；非法更新保留已选模式", async () => {
	const { SettingsStore, userData } = makeStore();
	const store = new SettingsStore();
	await store.load();
	assert.equal((await store.update({ tpsDisplayMode: "endToEnd" })).tpsDisplayMode, "endToEnd");
	assert.equal(store.get().tpsDisplayMode, "endToEnd");
	await store.update({ tpsDisplayMode: "invalid" });
	assert.equal(store.get().tpsDisplayMode, "endToEnd");
	// 2027-02 起写盘带 150ms 合并窗口：读盘断言前先 flush（生产读设置走内存 get()，不受影响）
	await store.flushPendingSave();
	assert.equal(JSON.parse(readFileSync(join(userData, "settings.json"), "utf8")).tpsDisplayMode, "endToEnd");
	const restarted = new SettingsStore();
	await restarted.load();
	assert.equal(restarted.get().tpsDisplayMode, "endToEnd");
	await restarted.update({ tpsDisplayMode: "streaming" });
	await restarted.flushPendingSave();
	assert.equal(JSON.parse(readFileSync(join(userData, "settings.json"), "utf8")).tpsDisplayMode, "streaming");
});

it("SettingsStore 源码使用 renameWithRetry + 保存串行链（漂移守卫，H4）", () => {
	const source = readFileSync("src/main/settings/SettingsStore.ts", "utf8");
	assert.match(source, /renameWithRetry\(/);
	assert.match(source, /saveChain/);
	// 2027-02 写盘合并守卫：单一在途窗口 + 等待者集合（多窗口级联会让 burst 延迟 N×150ms）
	assert.match(source, /SAVE_DEBOUNCE_MS = 150/);
	assert.match(source, /private firePendingSave\(\): void/, "落盘必须收口在单一 fire 函数（窗口到期与 flush 共用）");
	assert.match(source, /flushPendingSave\(\): Promise<void>/, "退出/备份路径必须有收尾入口");
	// .bak 去重判据：内容未变不得重复复制（3×写放大的三分之一）
	assert.match(source, /lastPersistedJson !== json/);
});
