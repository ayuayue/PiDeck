/**
 * 繁体中文（zh-TW）支持：locale 解析、四份词典的接线、以及各进程的语言分支。
 *
 * 词典是 `scripts/genZhTwCopy.mjs` 从 zh-CN 源生成的（台湾用语 + 繁体字形），所以这里既测行为，
 * 也守住「生成物没落后于 zh-CN 源」——加键忘了重新生成时，键集断言会红。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const ROOT = process.cwd();
const load = (relativePath) => loadTsCommonJs(`${ROOT}/${relativePath}`);
const readSource = (relativePath) => readFileSync(join(ROOT, relativePath), "utf8");

test("resolveLocale：显式选择优先，system 下 zh-Hant 系列走 zh-TW", () => {
	const i18n = load("src/renderer/src/i18n.ts");

	// 显式选项不受系统语言影响
	assert.equal(i18n.resolveLocale("zh-TW", "en-US"), "zh-TW");
	assert.equal(i18n.resolveLocale("zh-CN", "zh-TW"), "zh-CN");
	assert.equal(i18n.resolveLocale("en-US", "zh-TW"), "en-US");
	assert.equal(i18n.resolveLocale("pseudo", "zh-TW"), "pseudo");

	// system：Electron app.getLocale()（zh-TW/zh_HK）与浏览器 navigator.language（zh-Hant-TW）两种形态都要认
	for (const tag of ["zh-TW", "zh-tw", "zh_HK", "zh-Hant", "zh-Hant-TW", "zh-hant-hk"]) {
		assert.equal(i18n.resolveLocale("system", tag), "zh-TW", tag);
	}
	for (const tag of ["zh", "zh-CN", "zh-Hans", "zh-SG"]) {
		assert.equal(i18n.resolveLocale("system", tag), "zh-CN", tag);
	}
	for (const tag of ["en-US", "ja-JP", "fr"]) {
		assert.equal(i18n.resolveLocale("system", tag), "en-US", tag);
	}
});

test("渲染层 t()：zh-TW 出繁体，简繁两份词典互不串味", () => {
	const i18n = load("src/renderer/src/i18n.ts");
	const previous = i18n.getI18nLocale();
	try {
		i18n.setI18nLocale("zh-CN");
		assert.equal(i18n.t("settings.languageZh"), "简体中文");
		i18n.setI18nLocale("zh-TW");
		assert.equal(i18n.t("settings.languageZh"), "簡體中文");
		assert.equal(i18n.t("settings.languageZhTW"), "繁體中文");
		assert.match(i18n.formatI18nDateTime("2026-01-02T03:04:05Z"), /\d/);
	} finally {
		i18n.setI18nLocale(previous);
	}
});

test("主进程词典：normalizeMainProcessLocale 认繁体，mainProcessT 取到繁体文案", () => {
	const { normalizeMainProcessLocale, mainProcessT } = load("src/shared/i18n/mainProcessCopy.ts");

	assert.equal(normalizeMainProcessLocale("zh-TW"), "zh-TW");
	assert.equal(normalizeMainProcessLocale("zh_Hant_HK"), "zh-TW");
	assert.equal(normalizeMainProcessLocale("zh-CN"), "zh-CN");
	assert.equal(normalizeMainProcessLocale("en-GB"), "en-US");
	assert.equal(normalizeMainProcessLocale(undefined), "zh-CN");
	assert.equal(normalizeMainProcessLocale(42), "zh-CN");

	assert.equal(mainProcessT("zh-TW", "shellMenu.quickTask"), "使用 PiDeck 發起任務");
	assert.equal(mainProcessT("zh-CN", "shellMenu.quickTask"), "使用 PiDeck 发起任务");
	assert.equal(mainProcessT("en-US", "shellMenu.quickTask"), "Start a task with PiDeck");
});

test("Web 客户端：词典含 zh-TW，注入脚本按浏览器语言分流", () => {
	const web = load("src/main/web/WebI18n.ts");
	assert.ok(Object.hasOwn(web.webClientDictionaries, "zh-TW"));
	assert.match(web.serializeWebClientDictionaries(), /"zh-TW"/);
	assert.match(web.serializeWebClientDictionaries(), /"zh-CN"/);

	// 注入给手机端页面的那段脚本在模板字符串里，只能按源码断言（大小写与下划线都要归一）
	const manager = readSource("src/main/web/WebServiceManager.ts");
	assert.match(manager, /replace\(\/_\/g,\s*"-[^"]*"\)/);
	assert.match(manager, /hant/);
	assert.match(manager, /"zh-TW"/);
});

/** 飞书的 zhCN 是模块内局部常量（未导出），从 `const zhCN = {` 到键类型声明之间提取键。 */
function feishuSourceKeys() {
	const source = readSource("src/main/feishu/FeishuI18n.ts");
	const block = source.slice(source.indexOf("const zhCN = {"), source.indexOf("export type FeishuTranslationKey"));
	return [...block.matchAll(/^\t"([^"]+)":/gm)].map((match) => match[1]);
}

test("生成物与 zh-CN 源同键：四份 .zh-TW.ts 都不能漏键", () => {
	const cases = [
		{ name: "rendererCopy", sourceKeys: Object.keys(load("src/renderer/src/i18n/rendererCopy.zh-CN.ts").zhCN), targetKeys: Object.keys(load("src/renderer/src/i18n/rendererCopy.zh-TW.ts").zhTW) },
		{ name: "mainProcessCopy", sourceKeys: Object.keys(load("src/shared/i18n/mainProcessCopy.ts").mainProcessZhCN), targetKeys: Object.keys(load("src/shared/i18n/mainProcessCopy.zh-TW.ts").mainProcessZhTW) },
		{ name: "WebI18n", sourceKeys: Object.keys(load("src/main/web/WebI18n.ts").webZhCN), targetKeys: Object.keys(load("src/main/web/WebI18n.zh-TW.ts").webZhTW) },
		// 飞书的 zhCN 是模块内局部常量（未导出），键集从源文件文本提取
		{ name: "FeishuI18n", sourceKeys: feishuSourceKeys(), targetKeys: Object.keys(load("src/main/feishu/FeishuI18n.zh-TW.ts").feishuZhTW) },
	];

	for (const { name, sourceKeys, targetKeys } of cases) {
		const missing = sourceKeys.filter((key) => !targetKeys.includes(key));
		assert.deepEqual(missing, [], `${name}: zh-TW 缺 ${missing.length} 个键，请重新运行 node scripts/genZhTwCopy.mjs`);
		assert.equal(targetKeys.length, sourceKeys.length, `${name}: zh-TW 键数应与 zh-CN 一致`);
	}
});

test("生成物带生成器标识，且繁体字形确实换过", () => {
	const generated = ["src/renderer/src/i18n/rendererCopy.zh-TW.ts", "src/shared/i18n/mainProcessCopy.zh-TW.ts", "src/main/web/WebI18n.zh-TW.ts", "src/main/feishu/FeishuI18n.zh-TW.ts"];
	for (const path of generated) {
		assert.match(readSource(path), /由 `node scripts\/genZhTwCopy\.mjs` 生成，请勿手改/, `${path}: 缺少生成器标识头`);
	}

	const zhTW = load("src/renderer/src/i18n/rendererCopy.zh-TW.ts").zhTW;
	const zhCN = load("src/renderer/src/i18n/rendererCopy.zh-CN.ts").zhCN;
	// 字形与用词都应是台湾写法（opencc s2twp），不是把简体原样抄过来
	assert.equal(zhTW["settings.composer.security"], "權限");
	assert.equal(zhTW["common.global"], "全域");
	assert.notEqual(zhTW["timeline.processGroup.done.code"], zhCN["timeline.processGroup.done.code"]);
});

test("设置页提供繁体中文选项，AppLanguageMode 已收录 zh-TW", () => {
	assert.match(readSource("src/shared/types/settings.ts"), /AppLanguageMode\s*=\s*"system"\s*\|\s*"zh-CN"\s*\|\s*"zh-TW"\s*\|\s*"en-US"\s*\|\s*"pseudo"/);
	assert.match(readSource("src/renderer/src/components/app/settings/CommonTab.tsx"), /\{\s*value:\s*"zh-TW",\s*label:\s*t\("settings\.languageZhTW"\)\s*\}/);
	// 浮窗是独立窗口，语言值经 IPC 下发，分支必须认 zh-TW
	assert.match(readSource("src/main/floating/MiniOverlayWindow.ts"), /settings\.language\s*===\s*"zh-TW"\s*\?\s*"zh-TW"/);
});

test("日期展示：zh-TW 走中文日历，不回退英文格式", () => {
	const { formatPeriodTitle } = load("src/renderer/src/components/app/usageStats/usagePeriodModel.ts");
	const week = { start: "2026-10-05", end: "2026-10-11" };
	const month = { start: "2026-10-01", end: "2026-10-31" };
	const year = { start: "2026-01-01", end: "2026-12-31" };

	// 只有 en-US 用短月名，中文两种写法（繁/简）都走中文日历
	assert.equal(formatPeriodTitle("week", week, "zh-TW"), "10月5日 – 10月11日");
	assert.equal(formatPeriodTitle("month", month, "zh-TW"), "2026年10月");
	assert.equal(formatPeriodTitle("year", year, "zh-TW"), "2026年");
	assert.equal(formatPeriodTitle("week", week, "zh-CN"), "10月5日 – 10月11日");
	assert.equal(formatPeriodTitle("week", week, "en-US"), "Oct 5 – Oct 11");
	assert.equal(formatPeriodTitle("year", year, "en-US"), "2026");

	// 组件侧：zh-TW 应拿到 date-fns 繁中文 locale，而不是被 en-US 兜底吃掉
	assert.match(readSource("src/renderer/src/components/app/usageStats/UsagePeriodPicker.tsx"), /localeMode\s*===\s*"zh-TW"\s*\?\s*zhTW\s*:\s*zhCN/);
	assert.match(readSource("src/renderer/src/components/app/usageStats/UsageDayDetail.tsx"), /localeMode\s*===\s*"en-US"\s*\|\|\s*localeMode\s*===\s*"pseudo"\s*\?\s*"en-US"\s*:\s*localeMode/);
	assert.match(readSource("src/renderer/src/components/app/settings/LogsDateRangePicker.tsx"), /localeMode\s*===\s*"zh-TW"\s*\?\s*zhTW\s*:\s*zhCN/);
});
