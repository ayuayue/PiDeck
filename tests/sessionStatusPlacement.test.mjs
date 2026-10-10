import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { describe } from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const placementModule = loadTsCommonJs("src/shared/sessionStatusPlacement.ts");
const { DEFAULT_SESSION_STATUS_PLACEMENT, parseSessionStatusPlacement, placementShowsSidebarPanel } = placementModule;

/** 会话状态显示位置（shared/sessionStatusPlacement.ts）：sidebar / composer 二选一，解析容错 + 装配判定。 */
describe("parseSessionStatusPlacement", () => {
	test("合法值原样返回", () => {
		assert.equal(parseSessionStatusPlacement("sidebar"), "sidebar");
		assert.equal(parseSessionStatusPlacement("composer"), "composer");
	});

	test("缺省/坏值回落默认 sidebar（旧 settings.json 无此字段）", () => {
		assert.equal(DEFAULT_SESSION_STATUS_PLACEMENT, "sidebar");
		for (const raw of [undefined, null, "", "top", "right", "Sidebar", 1, {}, []]) {
			assert.equal(parseSessionStatusPlacement(raw), "sidebar", `raw=${JSON.stringify(raw)}`);
		}
	});

	test("已移除的 both（开发期存过）按默认 sidebar 处理", () => {
		assert.equal(parseSessionStatusPlacement("both"), "sidebar");
	});
});

describe("装配判定", () => {
	test("sidebar 挂右侧边栏下半区，composer 不挂", () => {
		assert.equal(placementShowsSidebarPanel("sidebar"), true);
		assert.equal(placementShowsSidebarPanel("composer"), false);
	});

	test("二选一后不再导出「是否隐藏折叠条」的独立判定（与是否挂面板等价）", () => {
		assert.equal(placementModule.placementHidesComposerStrips, undefined);
	});
});

describe("设置链路契约", () => {
	const store = readFileSync("src/main/settings/SettingsStore.ts", "utf8");

	test("SettingsStore：默认 sidebar，读盘归一化，写入时非法值丢弃而非重置", () => {
		assert.match(store, /sessionStatusPlacement: "sidebar",/);
		assert.match(store, /this\.settings\.sessionStatusPlacement = parseSessionStatusPlacement\(this\.settings\.sessionStatusPlacement\);/);
		assert.match(store, /if \("sessionStatusPlacement" in safePatch && parseSessionStatusPlacement\(safePatch\.sessionStatusPlacement\) !== safePatch\.sessionStatusPlacement\) \{\s*delete safePatch\.sessionStatusPlacement;/);
		// 丢弃必须发生在「空 patch 直接返回」之前，否则只含坏值的 patch 仍会触发一次写盘
		assert.ok(store.indexOf("delete safePatch.sessionStatusPlacement") < store.indexOf("所有字段都被去重剔除后没有可写内容"));
	});

	test("渲染层默认值与主进程一致", () => {
		assert.match(readFileSync("src/shared/types/settings.ts", "utf8"), /sessionStatusPlacement: "sidebar",/);
		assert.match(readFileSync("src/renderer/src/previewApi.ts", "utf8"), /sessionStatusPlacement: "sidebar",/);
	});

	test("设置页：外观页二选一（无 both），可搜索，纳入未保存提示", () => {
		const tab = readFileSync("src/renderer/src/components/app/settings/AppearanceTab.tsx", "utf8");
		assert.match(tab, /anchor="appearance-session-status-placement"/);
		for (const value of ["sidebar", "composer"]) assert.match(tab, new RegExp(`<SelectItem value="${value}">`));
		assert.doesNotMatch(tab, /<SelectItem value="both">/);
		assert.match(readFileSync("src/renderer/src/utils/settingsFieldAnchors.ts", "utf8"), /slug: "appearance-session-status-placement"/);
		assert.match(readFileSync("src/renderer/src/components/app/settings/unsavedChangesSummary.ts", "utf8"), /field: "sessionStatusPlacement", tab: "appearance"/);
	});
});
