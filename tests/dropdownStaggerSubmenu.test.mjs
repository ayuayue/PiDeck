import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const foundation = readFileSync("src/renderer/src/styles/foundation.css", "utf8");
const dropdownMenu = readFileSync("src/renderer/src/components/ui-shadcn/dropdown-menu.tsx", "utf8");

/** 取 foundation.css 里所有 `.dropdown-stagger > ...` 选择器（含其声明块）。 */
function staggerRules() {
	const withoutComments = foundation.replace(/\/\*[\s\S]*?\*\//g, "");
	const rules = [];
	for (const match of withoutComments.matchAll(/(^[\t ]*\.dropdown-stagger\s*>[\s\S]*?)\{([\s\S]*?)\}/gm)) {
		rules.push({ selector: match[1].replace(/\s+/g, " ").trim(), body: match[2] });
	}
	return rules;
}

/**
 * 契约：菜单项级联入场动画不得作用到 Radix popper 包裹层。
 * 包裹层定位依赖内联 transform，动画的 transform 优先级更高会把定位顶掉，
 * 导致二级菜单先在父菜单左上角闪现再瞬移（回归：导入会话子菜单）。
 */
test("dropdown-stagger animation excludes the Radix popper wrapper", () => {
	const animated = staggerRules().filter((rule) => /animation\s*:/.test(rule.body));
	assert.ok(animated.length > 0, "dropdown-stagger animation rule must exist");

	for (const rule of animated) {
		assert.match(rule.selector, /:not\(\s*\[data-radix-popper-content-wrapper\]\s*\)/, `selector "${rule.selector}" animates the popper wrapper and breaks submenu positioning`);
	}
});

/** 前提守卫：菜单内容仍带 dropdown-stagger，且子菜单仍未走 Portal（排除条件不能删）。 */
test("submenu content still renders inside the staggered menu content", () => {
	assert.match(dropdownMenu, /data-slot="dropdown-menu-content"[\s\S]{0,2000}?dropdown-stagger/);
	assert.match(dropdownMenu, /function DropdownMenuSubContent\([\s\S]{0,400}?<DropdownMenuPrimitive\.SubContent/);
});
