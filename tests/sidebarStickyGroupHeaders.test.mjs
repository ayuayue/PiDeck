import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 侧栏「聊天」「项目」分组标题栏冻结开关（外观设置 → 聊天排版）。
 *
 * 默认关闭 = 历史行为（标题随列表滚走）；显式 true 才开启 sticky 冻结。
 * 全链路：settings.json ↔ SettingsStore（默认/迁移/update 三处收窄）↔
 * App → AppSidebar → SidebarContent → ProjectTree（聊天/项目两处标题栏）。
 * SettingsStore 依赖 electron / 日志 / git 路径解析器，用 stub 顶掉（与
 * tests/scrollToLatestOnSend.test.mjs 同款）。
 */
function makeStore() {
	const userData = mkdtempSync(join(tmpdir(), "pideck-sticky-headers-user-"));
	const home = mkdtempSync(join(tmpdir(), "pideck-sticky-headers-home-"));
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

/** 预置最小 settings.json：installationType / chatContentWidthPct 避免 load 尾部迁移钩子额外写盘。 */
function seed(userData, extra) {
	writeFileSync(join(userData, "settings.json"), JSON.stringify({ installationType: "installed", chatContentWidthPct: 80, ...extra }));
}

const read = (path) => readFileSync(path, "utf8");

it("老 settings.json 缺字段按关闭处理：默认就是现有行为，零迁移", async () => {
	const { SettingsStore, userData } = makeStore();
	seed(userData, {});
	const store = new SettingsStore();
	await store.load();
	assert.equal(store.get().sidebarStickyGroupHeaders, false);

	// 脏值不能隐式开启（字符串 "true" 若原样透传会被真值判断误读成开启）
	seed(userData, { sidebarStickyGroupHeaders: "true" });
	const dirty = new SettingsStore();
	await dirty.load();
	assert.equal(dirty.get().sidebarStickyGroupHeaders, false);
});

it("显式 true 可持久化；update 只认布尔，脏值不落盘", async () => {
	const { SettingsStore, userData } = makeStore();
	seed(userData, { sidebarStickyGroupHeaders: true });
	const store = new SettingsStore();
	await store.load();
	assert.equal(store.get().sidebarStickyGroupHeaders, true);

	await store.update({ sidebarStickyGroupHeaders: "yes" });
	assert.equal(store.get().sidebarStickyGroupHeaders, true, "非布尔 patch 不落盘");
	await store.update({ sidebarStickyGroupHeaders: false });
	assert.equal(store.get().sidebarStickyGroupHeaders, false);
});

it("契约字段与三处默认值/接线齐全（防半截实现）", () => {
	const shared = read("src/shared/types/settings.ts");
	assert.match(shared, /sidebarStickyGroupHeaders\?:\s*boolean\s*;/, "Settings 需要 sidebarStickyGroupHeaders?: boolean 可选字段（旧配置兼容）");

	const store = read("src/main/settings/SettingsStore.ts");
	assert.match(store, /sidebarStickyGroupHeaders\s*:\s*false\b/, "SettingsStore 默认值应为 false（历史行为）");
	assert.match(store, /this\.settings\.sidebarStickyGroupHeaders\s*=\s*defaultSettings\.sidebarStickyGroupHeaders/, "load 迁移缺字段回落默认值");
	assert.match(store, /delete safePatch\.sidebarStickyGroupHeaders/, "update 必须丢弃非布尔 patch");

	const projectTree = read("src/renderer/src/components/sidebar/ProjectTree.tsx");
	// 正则空白容忍：格式化基线不折行，但 class 组合方式可能被调整
	assert.match(projectTree, /stickyGroupHeaders\?:\s*boolean/, "ProjectTree 接收 stickyGroupHeaders prop");
	assert.match(projectTree, /sticky\s+top-0/, "标题栏冻结用 sticky top-0 实现");
	assert.match(projectTree, /bg-sidebar/, "冻结标题栏必须遮底，行从字下穿过时不可读");

	const app = read("src/renderer/src/App.tsx");
	assert.match(app, /stickyGroupHeaders=\{settings\.sidebarStickyGroupHeaders\s*===\s*true\}/, "App 按 === true 收窄传递（缺省 = 关闭）");

	const appearance = read("src/renderer/src/components/app/settings/AppearanceTab.tsx");
	assert.match(appearance, /anchor="appearance-sidebar-sticky-group-headers"/, "外观 tab 有开关行（锚点 slug）");
	assert.match(appearance, /sidebarStickyGroupHeaders:\s*checked/, "开关行写入 sidebarStickyGroupHeaders 草稿字段");
});
