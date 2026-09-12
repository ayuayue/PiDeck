import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 扩展表格布局契约（用户反馈「页面显示有问题」）：
// TableCell 基类默认 whitespace-nowrap，而内置扩展行会在名称列里渲染最长 90 字的中文简介。
// nowrap 使该列的 min-content = 整行文字宽度（≈1000px），表格 min-content 被顶到 1500px 量级，
// 远超设置弹框内容区可用宽度 → 版本列文字被截断（"可更…"）、操作列（打开目录/启停/卸载）整个
// 被挤出可视区，用户没法在表格里操作扩展。
//
// 布局类冲突只有渲染时才暴露，这里把「长文案 + 必须显式恢复换行 + 折叠展示」三件事锁在一起：
// 一旦有人删掉 whitespace-normal / line-clamp，测试直接红，而不是等用户截图反馈。

const read = (p) => readFileSync(p, "utf8");

const tableRows = read("src/renderer/src/config/extensionsTableRows.tsx");
const tablePrimitive = read("src/renderer/src/components/ui-shadcn/table.tsx");
const zhCopy = read("src/renderer/src/i18n/rendererCopy.zh-CN.ts");

const builtInDescriptions = [...zhCopy.matchAll(/"config\.builtInExtDesc\.[a-z0-9-]+":\s*"([^"]*)"/g)].map(
	(m) => m[1],
);

test("built-in descriptions are long enough to blow up a nowrap column", () => {
	// 前提校验：如果这些简介哪天都变短了，下面两条约束的「为什么」就不成立了
	assert.ok(builtInDescriptions.length >= 12, `expected >=12 descriptions, got ${builtInDescriptions.length}`);
	const longest = builtInDescriptions.reduce((a, b) => (b.length > a.length ? b : a), "");
	assert.ok(
		longest.length >= 40,
		`expected at least one long built-in description (>=40 chars), longest was ${longest.length}`,
	);
});

test("TableCell base class is still nowrap, so the name cell must opt out explicitly", () => {
	assert.match(
		tablePrimitive,
		/function TableCell[\s\S]*?whitespace-nowrap/,
		"TableCell no longer defaults to whitespace-nowrap — revisit the explicit whitespace-normal overrides",
	);
	// 两条扩展行（已安装行 + 运行时发现行）都要覆盖基类，缺一条就会重新顶宽
	const nameCells = [...tableRows.matchAll(/<TableCell className="min-w-0([^"]*)">/g)].map((m) => m[1]);
	assert.ok(nameCells.length >= 2, `expected >=2 name cells, found ${nameCells.length}`);
	for (const extra of nameCells) {
		assert.match(extra, /whitespace-normal/, "name cell must restore wrapping (whitespace-normal)");
	}
});

test("built-in description is line-clamped and keeps the full text in title", () => {
	const span = tableRows.match(/<span[\s\S]{0,200}?line-clamp-2[\s\S]{0,220}?<\/span>/);
	assert.ok(span, "built-in description span must use line-clamp-2");
	assert.match(span[0], /title=\{t\(BUILT_IN_EXTENSION_DESC/, "clamped description must expose full text via title");
});

test("extension tab toolbars wrap instead of clipping their right-most buttons", () => {
	const tab = read("src/renderer/src/config/ExtensionsTab.tsx");
	assert.match(
		tab,
		/skills-toolbar-actions[^"]*flex-wrap[^"]*justify-end/,
		"extensions toolbar action group must wrap (flex-wrap + justify-end)",
	);
	const panel = read("src/renderer/src/config/BuiltInExtensionsUpdatePanel.tsx");
	assert.match(
		panel,
		/flex shrink-0 flex-wrap items-center justify-end gap-1\.5/,
		"built-in extensions panel actions must right-align when wrapped",
	);
});
