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
 writeFileSync(
  join(userData, "settings.json.bak"),
  JSON.stringify({ closeToTray: false, installationType: "installed", chatContentWidthPct: 80 }),
 );
 // 模拟撕裂写：截断的 JSON 主文件
 writeFileSync(join(userData, "settings.json"), '{"closeToTray": false, "rpcTim');

 const store = new SettingsStore();
 await store.load();
 assert.equal(store.get().closeToTray, false);
});

it("update 连续保存后：主文件可解析、无 .tmp 残留、.bak 为上一代内容（H4）", async () => {
 const { SettingsStore, userData } = makeStore();
 const store = new SettingsStore();
 await store.load();
 await store.update({ closeToTray: false });
 await store.update({ closeToTray: true });

 const mainPath = join(userData, "settings.json");
 assert.equal(JSON.parse(readFileSync(mainPath, "utf8")).closeToTray, true);
 assert.equal(existsSync(`${mainPath}.tmp`), false);
 // .bak 必须保留上一代内容（上一次 update 的结果），供 load 损坏兜底回退
 const bak = JSON.parse(readFileSync(`${mainPath}.bak`, "utf8"));
 assert.equal(bak.closeToTray, false);
});

it("SettingsStore 源码使用 renameWithRetry + 保存串行链（漂移守卫，H4）", () => {
 const source = readFileSync("src/main/settings/SettingsStore.ts", "utf8");
 assert.match(source, /renameWithRetry\(/);
 assert.match(source, /saveChain/);
});
