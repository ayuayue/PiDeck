import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// 会话内 Markdown 代码块自动换行（Discussions #423 第三块）的契约链：
// shared 类型 → 主进程默认 + 载入归一化 + 补丁校验 → 渲染层 data 属性 → CSS →
// 外观设置行 + 未保存汇总 → 三份词典。
// 默认必须是「横滚」：这是所有人现在的观感，开关只在用户主动打开后生效。

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("settings 类型与两处默认值都是关闭", () => {
	const types = read("src/shared/types/settings.ts");
	assert.ok(types.includes("codeBlockWordWrap?: boolean;"), "shared 类型缺字段");
	assert.ok(types.includes("\t\tcodeBlockWordWrap: false,"), "shared 默认值不是 false");

	const store = read("src/main/settings/SettingsStore.ts");
	assert.ok(store.includes("\tcodeBlockWordWrap: false,"), "主进程默认值不是 false");
});

test("主进程对旧配置缺字段/脏值回落，且拒绝非布尔补丁", () => {
	const store = read("src/main/settings/SettingsStore.ts");
	assert.ok(store.includes('if (typeof this.settings.codeBlockWordWrap !== "boolean") {'), "缺载入归一化");
	assert.ok(store.includes("this.settings.codeBlockWordWrap = defaultSettings.codeBlockWordWrap;"), "归一化没回落到默认值");
	assert.ok(store.includes('if ("codeBlockWordWrap" in safePatch && typeof safePatch.codeBlockWordWrap !== "boolean") {'), "缺补丁校验");
	assert.ok(store.includes("delete safePatch.codeBlockWordWrap;"), "脏补丁没被丢弃");
});

test("渲染层写 data 属性，CSS 只认 on", () => {
	const appearance = read("src/renderer/src/hooks/appearance/useAppAppearance.ts");
	assert.ok(appearance.includes('root.dataset.codeBlockWrap = settings.codeBlockWordWrap === true ? "on" : "off";'), "没写 dataset");
	// dataset 必须进 effect 依赖，否则改设置后要重启才生效
	assert.ok(appearance.includes("settings.codeBlockWordWrap, settings.reduceMotion, settings.themePalette"), "dataset 没进依赖");

	const css = read("src/renderer/src/styles/streamdownChrome.css");
	assert.ok(css.includes('[data-code-block-wrap="on"] [data-streamdown="code-block-body"] > pre'), "CSS 缺折行选择器");
	assert.ok(css.includes("white-space: pre-wrap;"), "CSS 缺折行规则");
});

test("外观设置行与未保存汇总都接上", () => {
	const tab = read("src/renderer/src/components/app/settings/AppearanceTab.tsx");
	assert.ok(tab.includes('anchor="appearance-code-block-wrap"'), "设置行缺 anchor");
	assert.ok(tab.includes("checked={draft.codeBlockWordWrap === true}"), "设置行没读草稿值");
	assert.ok(tab.includes("updateDraft({ codeBlockWordWrap: checked })"), "设置行没写草稿值");

	const summary = read("src/renderer/src/components/app/settings/unsavedChangesSummary.ts");
	assert.ok(summary.includes('{ field: "codeBlockWordWrap", tab: "appearance", itemKey: "settings.codeBlockWordWrap" },'), "未保存汇总缺条目");
});

test("三份词典都有标题与说明", () => {
	for (const file of ["rendererCopy.zh-CN.ts", "rendererCopy.en-US.ts", "rendererCopy.zh-TW.ts"]) {
		const source = read(`src/renderer/src/i18n/${file}`);
		for (const key of ['"settings.codeBlockWordWrap"', '"settings.codeBlockWordWrapDesc"']) {
			assert.ok(source.includes(key), `${file} 缺少 ${key}`);
		}
	}
});
