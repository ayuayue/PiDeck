// 草稿期不提供任何重命名入口：此时 pi 侧自动命名还没跑，先钉一个名字会把 catalog 条目
// 钉成 manual 终态，扩展规划出的会话名再也写不进来（#266 同一所有权链路的 UI 侧闸门）。
// 回归守卫：曾经只有 Tab ⋯ 菜单漏了草稿闸门（侧栏草稿菜单早已没有重命名）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function read(path) {
	return readFileSync(path, "utf8");
}

test("tab ⋯ menu hides rename for draft sessions", () => {
	const app = read("src/renderer/src/App.tsx");
	// 与 canCopySession/canExportHtml 同款草稿闸门：草稿态直接不传 onRenameSession。
	// 闸门形态随 ⋯ 菜单工厂演进为 canRename（record.status !== "draft"）+ onRename 三元；
	// 草稿态仍显式给 undefined（菜单项因此不渲染）。
	assert.match(app, /const canRename = record\.status !== "draft";/);
	assert.match(app, /onRename: canRename\s*\?\s*\(\) =>\s*\{[\s\S]*?: undefined,/);

	// 菜单项只在回调存在时渲染，因此草稿态不会出现「重命名」。
	const tabsBar = read("src/renderer/src/components/session/SessionTabsBar.tsx");
	assert.match(tabsBar, /props\.sessionActions\.onRename\s*&&\s*\(/);
});

test("sidebar draft context menu stays rename-free", () => {
	const components = read("src/renderer/src/components/sidebar/SidebarComponents.tsx");
	const content = read("src/renderer/src/components/sidebar/SidebarContent.tsx");

	const start = components.indexOf("export function DraftSessionContextMenu");
	assert.notEqual(start, -1, "DraftSessionContextMenu should be discoverable");
	const nextExport = components.indexOf("\nexport function", start + 1);
	assert.notEqual(nextExport, -1, "SessionContextMenu should follow the draft menu");
	const draftMenu = components.slice(start, nextExport);
	assert.doesNotMatch(draftMenu, /common\.rename/);

	// 草稿行走草稿菜单，非草稿行走带重命名的 SessionContextMenu。
	assert.match(content, /menu\?\.kind === "draft"[\s\S]{0,200}?<DraftSessionContextMenu/);
});
