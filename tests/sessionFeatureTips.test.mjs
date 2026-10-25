/**
 * 流式状态条右侧的功能提示（RespondingIndicator 旁的 RespondingTips）文案契约。
 *
 * 提示是「一次性曝光」的内容：用户扫一眼就过去了，写错了（键缺失、占位符漏渲染、
 * 太长被截断）当场看不出来，也不会有人回报。所以这里把三条硬性约定钉成测试：
 * 三份词典键齐全、{shortcut} 占位符与 shortcutId 一一对应、单行短句。
 *
 * 数据是纯数据模块（sessionFeatureTips.ts），因此可以直接用 loadTsCommonJs 加载，
 * 不需要渲染 React 组件。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { SESSION_FEATURE_TIPS } = loadTsCommonJs("src/renderer/src/components/session/sessionFeatureTips.ts");
const { zhCN } = loadTsCommonJs("src/renderer/src/i18n/rendererCopy.zh-CN.ts");
const { enUS } = loadTsCommonJs("src/renderer/src/i18n/rendererCopy.en-US.ts");
const { zhTW } = loadTsCommonJs("src/renderer/src/i18n/rendererCopy.zh-TW.ts");

const DICTIONARIES = { "zh-CN": zhCN, "en-US": enUS, "zh-TW": zhTW };
const LOCALES = Object.keys(DICTIONARIES);

/** 提示在状态条里是单行 nowrap + 截断，超过这个长度就会被吃掉尾部。 */
const MAX_TIP_LENGTH = 96;

test("功能提示清单：键不重复且都带文案 key", () => {
	assert.ok(SESSION_FEATURE_TIPS.length >= 8, "提示太少，轮播会一直是同几句");
	const keys = SESSION_FEATURE_TIPS.map((tip) => tip.textKey);
	assert.equal(new Set(keys).size, keys.length, "提示文案 key 重复");
	for (const key of keys) assert.match(key, /^agent\.tips\./, `${key} 应落在 agent.tips.* 命名空间`);
});

test("功能提示文案：zh-CN / en-US / zh-TW 三份词典都有", () => {
	for (const [locale, dictionary] of Object.entries(DICTIONARIES)) {
		for (const tip of SESSION_FEATURE_TIPS) {
			assert.ok(Object.hasOwn(dictionary, tip.textKey), `${locale} 缺少 ${tip.textKey}`);
		}
	}
});

test("功能提示文案：{shortcut} 占位符与 shortcutId 一一对应", () => {
	for (const tip of SESSION_FEATURE_TIPS) {
		for (const [locale, dictionary] of Object.entries(DICTIONARIES)) {
			const text = dictionary[tip.textKey] ?? "";
			const hasPlaceholder = text.includes("{shortcut}");
			assert.equal(hasPlaceholder, Boolean(tip.shortcutId), `${locale} 的 ${tip.textKey}：占位符与 shortcutId 不匹配（漏填会露出 {shortcut}，多填会永远不替换）`);
			// 除 {shortcut} 外不该有第二个占位符：这类提示没有别的参数来源
			assert.equal(text.replace("{shortcut}", "").includes("{"), false, `${locale} 的 ${tip.textKey} 含未支持的占位符`);
		}
	}
});

test("功能提示文案：单行短句，不会被截断", () => {
	for (const locale of LOCALES) {
		for (const tip of SESSION_FEATURE_TIPS) {
			const text = DICTIONARIES[locale][tip.textKey];
			assert.equal(text.trim(), text, `${locale} 的 ${tip.textKey} 首尾有空白`);
			assert.equal(text.includes("\n"), false, `${locale} 的 ${tip.textKey} 含换行`);
			assert.ok(text.length <= MAX_TIP_LENGTH, `${locale} 的 ${tip.textKey} 过长（${text.length} > ${MAX_TIP_LENGTH}）`);
		}
	}
});

// 设置 → 外观 → 功能模块的 respondingTips 开关：提示组件本身读该开关才叫真能关掉。
// 组件是 React 组件，测渲染需整套 DOM 环境，这里按仓库既有做法钉源码形状（与 composerModeOption 同款）。
test("功能提示受「功能模块」开关控制（源码形状）", () => {
	const component = readFileSync("src/renderer/src/components/session/RespondingTips.tsx", "utf8");
	assert.match(component, /respondingTipsHiddenAtom/, "读取 respondingTips 隐藏开关");
	// hook 全部执行完之后才允许提前返回：开关在响应中被改时 hook 数量变化会直接抛错
	const prematureReturn = component.indexOf("if (hidden) return null;");
	assert.ok(prematureReturn > component.indexOf("useEffect("), "提前返回必须在全部 hook 之后");
	assert.ok(prematureReturn < component.indexOf("<span"), "提前返回必须挡在渲染之前");

	const modules = readFileSync("src/renderer/src/components/app/settings/ModuleVisibilitySection.tsx", "utf8");
	assert.match(modules, /respondingTips: "settings\.modules\.respondingTips"/, "功能模块设置页列出功能提示开关");
	const atoms = readFileSync("src/renderer/src/atoms/app-ui-atoms.ts", "utf8");
	assert.match(atoms, /isModuleHidden\(get\(hiddenModulesAtom\), "respondingTips"\)/, "隐藏判定走 hiddenModules 清单");
});
