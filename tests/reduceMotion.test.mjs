import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// 「减弱动效」应用内开关的契约链：
// shared 类型 → 主进程默认 + 载入归一化 + 补丁校验 → 渲染层 data-motion →
// 全局 CSS 降级 → 外观设置行 / 未保存汇总 / 字段锚点 → 三份词典。
//
// 存在的理由：全仓 20+ 处动效只认 prefers-reduced-motion，而 Electron 在部分平台
// 不把系统「减弱动态效果」传给 renderer，media query 整体失效时用户没有任何退路。
// 所以这里既校验开关链路，也校验降级用 0.001ms 而不是 animation:none
//（AppShell 折叠、时间线大纲依赖 animationend 收尾，砍掉事件会让面板关不掉）。

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("settings 类型与两处默认值都是关闭（保留历史观感）", () => {
	const types = read("src/shared/types/settings.ts");
	assert.ok(types.includes("reduceMotion?: boolean;"), "shared 类型缺字段");
	assert.ok(types.includes("\t\treduceMotion: false,"), "shared 默认值不是 false");

	const store = read("src/main/settings/SettingsStore.ts");
	assert.ok(store.includes("\treduceMotion: false,"), "主进程默认值不是 false");
});

test("主进程对旧配置缺字段/脏值回落，且拒绝非布尔补丁", () => {
	const store = read("src/main/settings/SettingsStore.ts");
	assert.ok(store.includes('if (typeof this.settings.reduceMotion !== "boolean") {'), "缺载入归一化");
	assert.ok(store.includes("this.settings.reduceMotion = defaultSettings.reduceMotion;"), "归一化没回落到默认值");
	assert.ok(store.includes('if ("reduceMotion" in safePatch && typeof safePatch.reduceMotion !== "boolean") {'), "缺补丁校验");
	assert.ok(store.includes("delete safePatch.reduceMotion;"), "脏补丁没被丢弃");
});

test("渲染层写 data-motion 并进 effect 依赖", () => {
	const appearance = read("src/renderer/src/hooks/appearance/useAppAppearance.ts");
	assert.ok(appearance.includes('root.dataset.motion = settings.reduceMotion === true ? "reduced" : "on";'), "没写 dataset.motion");
	assert.ok(appearance.includes("settings.codeBlockWordWrap, settings.reduceMotion,"), "dataset 没进 effect 依赖");
});

test("全局 CSS 用 0.001ms 降级，保留 animationend", () => {
	const css = read("src/renderer/src/styles/tailwind.css");
	assert.ok(css.includes(':root[data-motion="reduced"] *,'), "缺应用内开关选择器");
	assert.ok(css.includes("@media (prefers-reduced-motion: reduce)"), "缺系统偏好兜底");
	assert.ok(css.includes("animation-duration: 0.001ms !important;"), "动画没有压到 0.001ms");
	assert.ok(css.includes("animation-iteration-count: 1 !important;"), "无限循环动画没被收敛成一次");
	assert.ok(css.includes("transition-duration: 0.001ms !important;"), "过渡没有压到 0.001ms");
	assert.ok(!/^\s*animation:\s*none/m.test(css), "禁止 animation:none —— 会丢掉 animationend，折叠面板关不掉");
});

test("外观设置行、未保存汇总与字段锚点都接上", () => {
	const tab = read("src/renderer/src/components/app/settings/AppearanceTab.tsx");
	assert.ok(tab.includes('anchor="appearance-reduce-motion"'), "设置行缺 anchor");
	assert.ok(tab.includes("checked={draft.reduceMotion === true}"), "设置行没读草稿值");
	assert.ok(tab.includes("updateDraft({ reduceMotion: checked })"), "设置行没写草稿值");

	const summary = read("src/renderer/src/components/app/settings/unsavedChangesSummary.ts");
	assert.ok(summary.includes('{ field: "reduceMotion", tab: "appearance", itemKey: "settings.reduceMotion" },'), "未保存汇总缺条目");

	const anchors = read("src/renderer/src/utils/settingsFieldAnchors.ts");
	assert.ok(anchors.includes('slug: "appearance-reduce-motion"'), "设置搜索索引缺条目");
	assert.ok(anchors.includes('keywords: ["减弱动效"'), "搜索关键词缺中文触发词");
});

test("三份词典都有标题与说明", () => {
	for (const file of ["rendererCopy.zh-CN.ts", "rendererCopy.en-US.ts", "rendererCopy.zh-TW.ts"]) {
		const source = read(`src/renderer/src/i18n/${file}`);
		for (const key of ['"settings.reduceMotion"', '"settings.reduceMotionDesc"']) {
			assert.ok(source.includes(key), `${file} 缺少 ${key}`);
		}
	}
});
