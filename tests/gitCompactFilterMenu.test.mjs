import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const controls = readFileSync("src/renderer/src/components/app/git/GitPanelControls.tsx", "utf8");

test("Git compact filter uses shadcn Select with SelectValue for positioning", () => {
	// SelectValue 是 Radix 定位契约的一部分；缺了会导致菜单不对齐 / 「点了没反应」
	assert.match(controls, /SelectValue/);
	// 导入列表顺序/数量不变，只容忍 formatter 的换行与尾逗号差异。
	assert.match(controls, /import \{\s*Select,\s*SelectContent,\s*SelectItem,\s*SelectTrigger,\s*SelectValue,?\s*\}/);
	assert.match(controls, /<SelectValue/);
	assert.match(controls, /position="popper"/);
	assert.match(controls, /align="end"/);
});

test("Git compact filter maps empty option values for Radix Select.Item", () => {
	// Select.Item 禁止 value=""；「全部」仍对外用空串，内部映射哨兵
	assert.match(controls, /EMPTY_FILTER_VALUE/);
	assert.match(controls, /toSelectValue/);
	assert.match(controls, /fromSelectValue/);
	assert.match(controls, /value=\{toSelectValue\(props\.value\)\}/);
	assert.match(controls, /fromSelectValue\(next\)/);
});

test("Git compact filter no longer hand positions or tracks the viewport", () => {
	assert.doesNotMatch(controls, /getViewportBoundMenuPlacement/);
	assert.doesNotMatch(controls, /createPortal/);
	assert.doesNotMatch(controls, /handlePointerDown/);
	assert.doesNotMatch(controls, /menuStyle/);
	assert.doesNotMatch(controls, /role="listbox"/);
});

test("Git compact filter keeps a compact trigger and accessible label", () => {
	assert.match(controls, /aria-label=\{props\.ariaLabel\}/);
	// 触发器随右侧余量变宽（max-w-full），不再死卡 80px；标题 shrink-0 保证不被盖住
	assert.match(controls, /max-w-full min-w-0 gap-1 overflow-hidden rounded-sm border border-transparent/);
	assert.doesNotMatch(controls, /max-w-\[80px\]/);
});

test("Git pane header keeps the title fully visible beside compact actions", () => {
	// 标题 shrink-0 + nowrap；筛选/刷新/计数在右侧 flex-1 justify-end，互不挤压
	assert.match(controls, /shrink-0 items-center gap-1\.5 rounded-md/);
	assert.match(controls, /whitespace-nowrap text-control font-semibold/);
	assert.match(controls, /flex min-w-0 flex-1 items-center justify-end gap-0\.5/);
	// 面板标题用项目 UI 字体，不用 mono（中文在 mono 回退栈上会很难看）
	assert.doesNotMatch(controls, /font-mono text-\[13px\] font-semibold/);
	assert.doesNotMatch(controls, /min-w-0 flex-1 truncate font-mono text-\[13px\] font-semibold/);
});
