import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

/**
 * issue #398 回归：themeSkin=custom + 背景图时，打开设置弹窗、不改任何东西直接关闭，
 * 面板变成不透明并盖住背景图（切会话后才恢复）。
 *
 * 根因：设置弹窗的实时预览与取消回滚都调用 applyCustomThemeTokens，它把自定义主题的
 * 不透明 --color-bg-* 直接写进 inline style，覆盖了壁纸注入的 color-mix 半透明值；
 * useAppAppearance 的壁纸 effect 只在 settings 变化时重跑，取消/无改动关闭不触发，半透明不再恢复。
 *
 * 测试方式：用 esbuild 打包真实的 useAppAppearance.ts（React 与外观依赖替换成同步桩，
 * effect 立即执行），在假的 <html> 上先跑一次 App 的持久化注入（壁纸开启），
 * 再像 SettingsModal 那样调用 applyCustomThemeTokens，断言面板 token 仍是半透明。
 */

const stubs = {
	react: `export const useRef = (v) => ({ current: v });
export const useState = (v) => [typeof v === "function" ? v() : v, () => {}];
export const useReducer = (_r, v) => [v, () => {}];
export const useEffect = (fn) => { fn(); };
export const useLayoutEffect = (fn) => { fn(); };`,
	themeAppearance: `export const applyAppearanceAttributes = (root, s) => { root.dataset.theme = "light"; };`,
	themeSchedule: `export const resolveAppColorScheme = () => "light"; export const msUntilNextThemeBoundary = () => 1e9;`,
	i18n: `export const ensureI18nLocale = async () => {}; export const isI18nLocaleLoaded = () => true; export const setI18nLocale = () => {}; export const resolveLocale = () => "zh-CN";`,
	appearanceTransition: `export const applyAppearanceWithTransition = ({ apply }) => apply();`,
};

async function loadModule() {
	const result = await build({
		entryPoints: ["src/renderer/src/hooks/appearance/useAppAppearance.ts"],
		bundle: true,
		write: false,
		format: "esm",
		platform: "neutral",
		logLevel: "silent",
		plugins: [
			{
				name: "stubs",
				setup(b) {
					b.onResolve({ filter: /^react$|themeAppearance$|themeSchedule$|i18n$|appearanceTransition$/ }, (args) => ({ path: args.path, namespace: "stub" }));
					b.onLoad({ filter: /.*/, namespace: "stub" }, (args) => {
						const key = Object.keys(stubs).find((k) => args.path === k || args.path.endsWith(k));
						return { contents: stubs[key], loader: "js" };
					});
				},
			},
		],
	});
	const code = result.outputFiles[0].text;
	return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

// 最小假 DOM：inline style + 样式表默认值；getComputedStyle = inline 覆盖样式表
function makeRoot() {
	const sheet = new Map([
		["--color-bg-app", "#f5f5f5"],
		["--color-bg-sidebar", "#eeeeee"],
		["--color-bg-panel", "#ffffff"],
		["--color-card", "#ffffff"],
	]);
	const inline = new Map();
	const style = {
		setProperty: (k, v) => inline.set(k, v),
		removeProperty: (k) => inline.delete(k),
		getPropertyValue: (k) => inline.get(k) ?? "",
	};
	const root = { style, dataset: {}, lang: "" };
	const computed = () => ({ getPropertyValue: (k) => inline.get(k) ?? sheet.get(k) ?? "" });
	return { root, computed };
}

function baseSettings(extra) {
	return {
		theme: "light",
		themeSkin: "custom",
		customTheme,
		customThemeOverrides: {},
		backgroundImage: null,
		backgroundImageOpacity: 0.8,
		language: "zh-CN",
		fontSize: "md",
		fontFamilyBase: "system",
		fontFamilyBaseCustom: "",
		fontFamilyMono: "system",
		fontFamilyMonoCustom: "",
		...extra,
	};
}

const customTheme = {
	light: { "bg-app": "#fafafa", "bg-sidebar": "#f0f0f0", "bg-panel": "#ffffff", card: "#ffffff" },
	dark: { "bg-app": "#111111", "bg-sidebar": "#151515", "bg-panel": "#1a1a1a", card: "#1a1a1a" },
};

test("closing the settings modal without changes keeps wallpaper panels translucent (#398)", async () => {
	const { root, computed } = makeRoot();
	globalThis.window = { matchMedia: () => ({ matches: false }), setTimeout, clearTimeout };
	globalThis.document = { documentElement: root };
	globalThis.getComputedStyle = computed;

	const mod = await loadModule();
	const settings = baseSettings({ backgroundImage: "bg.png" });
	// App 持久化应用：自定义主题 → 壁纸半透明注入
	mod.useAppAppearance({ settings, systemLanguage: null, settingsLoaded: true });
	const before = root.style.getPropertyValue("--color-bg-panel");
	assert.match(before, /^color-mix\(in srgb, .+ 30%, transparent\)$/, "wallpaper should make panels translucent first");

	// 设置弹窗：打开时预览（草稿 = 当前设置），关闭时回滚到快照——两次都调 applyCustomThemeTokens
	mod.applyCustomThemeTokens(root, settings, false);
	mod.applyCustomThemeTokens(root, settings, false);

	for (const k of ["--color-bg-app", "--color-bg-sidebar", "--color-bg-panel", "--color-card"]) {
		const v = root.style.getPropertyValue(k);
		assert.match(v, /^color-mix\(in srgb, .+, transparent\)$/, `${k} became opaque after closing the settings modal: ${v}`);
	}
	assert.equal(root.style.getPropertyValue("--color-bg-panel"), before);
});

test("without a wallpaper applyCustomThemeTokens still injects the opaque custom colors", async () => {
	const { root, computed } = makeRoot();
	globalThis.window = { matchMedia: () => ({ matches: false }), setTimeout, clearTimeout };
	globalThis.document = { documentElement: root };
	globalThis.getComputedStyle = computed;
	const mod = await loadModule();
	// 关闭壁纸：App 持久化应用走 else 分支，清掉此前注入的壁纸 token
	const settings = baseSettings();
	mod.useAppAppearance({ settings, systemLanguage: null, settingsLoaded: true });
	mod.applyCustomThemeTokens(root, settings, false);
	assert.equal(root.style.getPropertyValue("--color-bg-panel"), "#ffffff");
	assert.equal(root.style.getPropertyValue("--color-bg-app"), "#fafafa");
});
