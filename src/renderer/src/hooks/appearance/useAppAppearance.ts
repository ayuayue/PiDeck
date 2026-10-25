import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { applyAppearanceAttributes } from "../../themeAppearance";
import { msUntilNextThemeBoundary, resolveAppColorScheme } from "../../../../shared/themeSchedule";
import { ensureI18nLocale, isI18nLocaleLoaded, resolveLocale, setI18nLocale } from "../../i18n";
import type { AppSettings } from "../../../../shared/types";
import { applyAppearanceWithTransition } from "./appearanceTransition";
import { isVideoWallpaperActive } from "./videoWallpaper";

// 壁纸模式已注入的 token 键（effect 重跑/清除设置时需要跨运行保留，避免漏清）
let injectedWallpaperTokens = new Set<string>();
// 自定义外观主题（customThemeOverrides / customTheme 快照）已注入的 token 键：切换主题时先清后注，防残留
let injectedCustomTokens = new Set<string>();
// 壁纸模式最近一次注入的 token 值：applyCustomThemeTokens 会用自定义主题的不透明色覆盖
// 同名 --color-bg-* 壁纸 token（设置弹窗预览/取消回滚都会调它），注入后据此恢复半透明，
// 否则打开再关闭设置弹窗后面板变成不透明、盖住背景图（issue #398）。
const injectedWallpaperValues = new Map<string, string>();

/**
 * 自定义 token 注入（主题包快照 + 手写 overrides）：App 持久化应用与设置弹窗实时预览共用。
 * 先清后注、幂等；快照仅 themeSkin=custom 时生效（切回内置皮肤不残留），
 * overrides 沿袭历史行为始终叠加（inline 样式压过 [data-appearance] 样式表）。
 */
export function applyCustomThemeTokens(root: HTMLElement, settings: Pick<AppSettings, "themeSkin" | "customTheme" | "customThemeOverrides">, isDark: boolean): void {
	for (const k of injectedCustomTokens) root.style.removeProperty(`--color-${k}`);
	injectedCustomTokens.clear();
	if (settings.themeSkin === "custom" && settings.customTheme) {
		const schemeTokens = isDark ? settings.customTheme.dark : settings.customTheme.light;
		for (const [k, v] of Object.entries(schemeTokens)) {
			root.style.setProperty(`--color-${k}`, v);
			injectedCustomTokens.add(k);
		}
	}
	for (const [k, v] of Object.entries(settings.customThemeOverrides ?? {})) {
		root.style.setProperty(`--color-${k}`, v);
		injectedCustomTokens.add(k);
	}
	// 壁纸开启时壁纸 token 必须压在自定义色之上（与 useAppAppearance 中「先自定义、后壁纸」的顺序一致）
	for (const [k, v] of injectedWallpaperValues) root.style.setProperty(k, v);
}

/**
 * 字号档位 dataset 写入：ui/tab/chat/input 四区域 + 旧 fontSize 属性。
 * 回落链：ui ← uiFontSize ?? fontSize；tab ← tabBarFontSize ?? ui（Tab 跟界面不跟全局）；
 * chat/input ← 各自字段 ?? fontSize。设置弹窗实时预览与持久化应用共用本函数，防两处漂移。
 */
export function applyFontSizeAttributes(root: HTMLElement, settings: AppSettings): void {
	const uiFontSize = settings.uiFontSize ?? settings.fontSize;
	root.dataset.uiFontSize = uiFontSize;
	root.dataset.tabFontSize = settings.tabBarFontSize ?? uiFontSize;
	root.dataset.chatFontSize = settings.chatFontSize ?? settings.fontSize;
	root.dataset.inputFontSize = settings.inputFontSize ?? settings.fontSize;
	// 旧属性保留，兼容外部依赖或测试仍读取 dataset.fontSize 的场景
	root.dataset.fontSize = settings.fontSize;
}

/**
 * 应用外观域：明暗/时间表主题解析、data 属性应用、壁纸与自定义皮肤 token 注入、
 * 字号/字体 data 属性与自定义字体注入、i18n locale 与 document.lang 同步。
 * 全部副作用自包含，无返回值；settings 变化即重算（纯函数 of props）。
 */
export function useAppAppearance({ settings, systemLanguage, settingsLoaded }: { settings: AppSettings; systemLanguage: string | null; settingsLoaded: boolean }): void {
	// 启动默认值和首次权威 settings 都直接应用；只有此后用户/系统触发的切换才播放动画。
	const hasAppliedAuthoritativeAppearanceRef = useRef(false);
	// 系统明暗（prefers-color-scheme）与跟随时间当前时刻提为 state：驱动 resolvedTheme 重算。
	const [systemPrefersDark, setSystemPrefersDark] = useState(() => Boolean(window.matchMedia?.("(prefers-color-scheme: dark)").matches));
	const [scheduleNow, setScheduleNow] = useState<Date | null>(null);
	const resolvedTheme = resolveAppColorScheme({
		theme: settings.theme,
		themeScheduleLightStart: settings.themeScheduleLightStart,
		themeScheduleDarkStart: settings.themeScheduleDarkStart,
		systemPrefersDark,
		now: scheduleNow ?? undefined,
	});

	const resolvedLocale = resolveLocale(settings.language, systemLanguage ?? undefined);
	// 词典按需加载后，切语言可能要先加载另一份 chunk：已加载时仍同步生效（绘制前），
	// 未加载时先 set（t() 回退 zh-CN），加载完再 set 一次并强制重渲染让文案落地。
	const [, bumpLocaleRender] = useReducer((n: number) => n + 1, 0);
	// i18n 是模块级单例：切语言属于外部系统副作用，必须放 effect（渲染期直写在 StrictMode 双渲染下会与其他实例竞态）；
	// 用 useLayoutEffect 保证已加载语言在首帧绘制前生效，避免旧语言闪一帧。
	useLayoutEffect(() => {
		let cancelled = false;
		setI18nLocale(resolvedLocale);
		if (isI18nLocaleLoaded(resolvedLocale)) return;
		void ensureI18nLocale(resolvedLocale)
			.catch(() => undefined)
			.then(() => {
				if (cancelled) return;
				setI18nLocale(resolvedLocale);
				bumpLocaleRender();
			});
		return () => {
			cancelled = true;
		};
	}, [resolvedLocale]);

	useEffect(() => {
		document.documentElement.lang = resolvedLocale;
	}, [resolvedLocale]);

	useEffect(() => {
		// 系统明暗翻转 → setState；resolvedTheme 重算驱动下方外观应用与壁纸注入两个 effect 重跑。
		const media = window.matchMedia?.("(prefers-color-scheme: dark)");
		if (!media?.addEventListener) return;
		const onChange = () => setSystemPrefersDark(Boolean(media.matches));
		media.addEventListener("change", onChange);
		return () => media.removeEventListener("change", onChange);
	}, []);

	useEffect(() => {
		// 跟随时间：睡到下一次浅色/暗色边界，到点刷新 scheduleNow 驱动重解析，避免每分钟轮询。
		if (settings.theme !== "schedule") return;
		let timer: number | undefined;
		const arm = () => {
			const delay = msUntilNextThemeBoundary(new Date(), settings.themeScheduleLightStart, settings.themeScheduleDarkStart);
			timer = window.setTimeout(() => {
				setScheduleNow(new Date());
				arm();
			}, delay);
		};
		arm();
		return () => {
			if (timer !== undefined) window.clearTimeout(timer);
		};
	}, [settings.theme, settings.themeScheduleLightStart, settings.themeScheduleDarkStart]);

	useEffect(() => {
		// 明暗 / 外观主题 / 主色统一经 themeAppearance 应用（与设置弹窗实时预览共用实现）：
		// data-theme(浅暗) + data-appearance(表面色板) + data-accent(主题自带主色)。
		// 保持直调字面 applyAppearanceAttributes(document.documentElement, …)：wallpaperThemeSync
		// 契约扫描锚定该语句定位本 effect，改形状会误报「effect not found」。
		const apply = () => applyAppearanceAttributes(document.documentElement, settings, systemPrefersDark);
		// 启动默认值 → 权威 settings 的两次应用都不做页面快照；否则窗口尚未激活时
		// Chromium 会跳过动画，并把 ready rejection 泄漏成全局「未处理异常」。
		applyAppearanceWithTransition({
			host: document,
			apply,
			settingsLoaded,
			hasAppliedAuthoritativeAppearance: hasAppliedAuthoritativeAppearanceRef.current,
			prefersReducedMotion: Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches),
		});
		if (settingsLoaded) hasAppliedAuthoritativeAppearanceRef.current = true;
		// 依赖 theme 与 accent：只改主题色时也必须重新应用 data-accent（否则界面不变）
		// eslint-disable-next-line react-hooks/exhaustive-deps -- settings 是整对象入参，列全字段反而脆弱；与既有行为一致（见 App.tsx 迁出前同注释）
	}, [resolvedTheme, settings.theme, settings.themeScheduleLightStart, settings.themeScheduleDarkStart, settings.accent, settings.themeSkin, settingsLoaded, systemPrefersDark]);

	// 外观主题自定义覆盖 + 换肤背景图统一管理（原两个 effect 互相清除：
	// 皮肤 effect 清 token 时误清壁纸注入、背景 effect 的 else 分支又误清皮肤 bg 键——
	// 合并后顺序固定：先自定义覆盖，后壁纸覆盖。内置外观主题色板由 CSS data-appearance 承担。）
	useEffect(() => {
		const root = document.documentElement;
		// isDark 不能读 root.dataset.theme：外观应用 effect 经 applyAppearanceWithTransition
		// 走 View Transition（startViewTransition 回调异步执行），同一轮 commit 里
		// dataset.theme 仍是旧明暗——按它选档会把自定义主题（含内置示例莓果夜色）的
		// 错档 token 注入 inline 样式并压过样式表，亮暗切换后界面停留在上一档。
		// resolvedTheme 与 applyAppearanceAttributes 写入 data-theme 用同一输入派生，等价且即时。
		const isDark = resolvedTheme === "dark";
		const BG_TOKENS = [
			"--color-bg-app",
			"--color-bg-sidebar",
			"--color-bg-panel",
			"--color-bg-input",
			"--color-bg-muted",
			"--color-bg-hover",
			"--color-bg-active",
			"--color-background",
			"--color-card",
			// Markdown/表格使用 chat 专属 token；未注入时会继续显示固定白色代码块。
			"--color-chat-card-bg",
			"--color-chat-muted-bg",
			"--color-chat-control-bg",
			"--color-chat-table-bg",
		];

		// 1. 自定义外观主题覆盖：customThemeOverrides 总是叠加在内置外观主题之上
		//    （inline 样式优先于 stylesheet 的 [data-appearance] 块，语义=「自定义压过内置」）。
		//    内置主题（classic-green/graphite/sea-blue/warm-beige）的表面色板由 CSS
		//    [data-appearance] 块承担，这里不再注入内置皮肤变量，避免 inline 与样式表互相覆盖。
		//    注入逻辑与设置弹窗预览共用 applyCustomThemeTokens（见上）。
		applyCustomThemeTokens(root, settings, isDark);

		// 2. 换肤背景图：遮罩同色渐变（浅白/暗黑）+ 壁纸模式 token 半透明注入。
		//    存储语义=图片可见度（0=全遮，1=图全显）；滑块 80% → 遮罩 0.2 → 图 80% 透出。
		// Wallpaper Engine 视频壁纸与静态图共用同一套壁纸模式（面板透明度档位/遮罩），
		// 视频本身由 WallpaperVideoLayer 渲染；视频生效时不再挂静态图，避免两层同时解码。
		const videoWallpaper = isVideoWallpaperActive(settings);
		root.dataset.bgImage = settings.backgroundImage ? "on" : "off";
		if (videoWallpaper) root.dataset.bgImage = "on";
		if (settings.backgroundImage || videoWallpaper) {
			// 采样前先摘掉上一轮注入的壁纸 token：inline style 在 cascade 上压过
			// :root[data-theme="dark"] 样式表，不摘的话 getComputedStyle 读到的是
			// 上一轮主题烤进的旧值，重注入又基于旧值——背景被永久焊死在注入时的
			// 明暗（暗色启动后亮色坏、亮色启动后暗色坏，即主题互相「打架」的根因）。
			for (const k of injectedWallpaperTokens) root.style.removeProperty(k);
			injectedWallpaperTokens.clear();
			injectedWallpaperValues.clear();
			if (settings.backgroundImage && !videoWallpaper) root.style.setProperty("--app-bg-image", `url("pideck-bg://local/${encodeURIComponent(settings.backgroundImage)}")`);
			else root.style.removeProperty("--app-bg-image");
			const alpha = Math.min(1, Math.max(0, 1 - settings.backgroundImageOpacity));
			// 面板不透明度与遮罩同步并加 10% 基础偏移（面板更实一点，可读性更好）：
			// 滑块 80% → 面板 30%；100% → 10%（图完整显示）；0% → 100%（纯色）
			const panelMix = Math.min(100, Math.round(alpha * 100) + 10);
			const rgb = isDark ? "0,0,0" : "255,255,255";
			root.style.setProperty("--app-bg-mask", `linear-gradient(rgba(${rgb},${alpha}), rgba(${rgb},${alpha}))`);
			// 半透明 token：getComputedStyle 取当前计算值（含皮肤覆盖）→ 静态 color-mix，无循环引用。
			// 壁纸模式下所有面板统一用 --color-bg-app 作基色 + 同一个 panelMix，
			// 保证侧栏/会话区/抽屉透出的图片明暗完全一致
			const cs = getComputedStyle(root);
			const base = cs.getPropertyValue("--color-bg-app").trim();
			// 供弹窗覆盖规则使用：纯色基色 + 面板不透明度（弹窗 = 面板 + 10% 更实）
			if (base) root.style.setProperty("--wallpaper-base", base);
			root.style.setProperty("--wallpaper-panel-alpha", `${panelMix}%`);
			for (const k of BG_TOKENS) {
				const v = cs.getPropertyValue(k).trim();
				if (v) {
					const wallpaperValue = `color-mix(in srgb, ${base} ${panelMix}%, transparent)`;
					root.style.setProperty(k, wallpaperValue);
					injectedWallpaperTokens.add(k);
					injectedWallpaperValues.set(k, wallpaperValue);
				}
			}
			// Select/Dropdown/Popover 会 portal 到 body，不能继承 DialogContent 的局部变量。
			// 单独给浮层保留 92% 以上的底色，避免半透明面板 token 让菜单内容透出并误读为“透明坏了”。
			const floatingMix = Math.max(92, Math.min(100, panelMix + 40));
			const popoverValue = `color-mix(in srgb, ${base} ${floatingMix}%, transparent)`;
			root.style.setProperty("--color-bg-popover", popoverValue);
			root.style.setProperty("--wallpaper-floating-alpha", `${floatingMix}%`);
			injectedWallpaperTokens.add("--color-bg-popover");
			injectedWallpaperValues.set("--color-bg-popover", popoverValue);
		} else {
			root.style.removeProperty("--app-bg-image");
			root.style.removeProperty("--app-bg-mask");
			// 只清本 effect 注入过的壁纸 token，绝不误清皮肤设置的 bg 键
			for (const k of injectedWallpaperTokens) root.style.removeProperty(k);
			injectedWallpaperTokens.clear();
			injectedWallpaperValues.clear();
			root.style.removeProperty("--wallpaper-base");
			root.style.removeProperty("--wallpaper-panel-alpha");
			root.style.removeProperty("--wallpaper-floating-alpha");
		}
		// resolvedTheme 必须进依赖：系统明暗翻转/时间边界到达时壁纸 inline token 要按新明暗重算，
		// 否则上一主题烤进的 color-mix 基色焊死在 root.style 上压过样式表（issue #297）
	}, [resolvedTheme, settings.themeSkin, settings.theme, settings.customTheme, settings.customThemeOverrides, settings.backgroundImage, settings.backgroundImageOpacity, settings.weWorkshopDir, settings.weWallpaperId]);

	// 字号与命名字体预设由 data 属性选择 CSS token；只有 custom 字体需要注入用户输入。
	useEffect(() => {
		const root = document.documentElement;
		applyFontSizeAttributes(root, settings);
		root.dataset.fontBase = settings.fontFamilyBase;
		root.dataset.fontMono = settings.fontFamilyMono;

		// 自定义字体统一追加 CJK 回退：用户只填西文字体时，中文不能落到 SimSun 小字挤压
		// （与下方 mono 注入同理，见 foundation.css 注释）。
		const baseCustomFont = settings.fontFamilyBaseCustom.trim();
		if (settings.fontFamilyBase === "custom" && baseCustomFont) {
			root.style.setProperty("--font-family-base", `${baseCustomFont}, "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "HarmonyOS Sans SC", "Hiragino Sans GB", "Noto Sans CJK SC", sans-serif`);
		} else {
			root.style.removeProperty("--font-family-base");
		}

		// 自定义等宽字体同样必须追加 CJK 回退：用户一般只填西文字体
		// （如 JetBrains Mono），不追加时中文会落到 SimSun 小字挤压（见 foundation.css 注释）。
		const monoCustomFont = settings.fontFamilyMonoCustom.trim();
		if (settings.fontFamilyMono === "custom" && monoCustomFont) {
			root.style.setProperty("--font-family-mono", `${monoCustomFont}, "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "HarmonyOS Sans SC", "Hiragino Sans GB", "Noto Sans CJK SC"`);
		} else {
			root.style.removeProperty("--font-family-mono");
		}
	}, [settings.fontSize, settings.uiFontSize, settings.tabBarFontSize, settings.chatFontSize, settings.inputFontSize, settings.fontFamilyBase, settings.fontFamilyBaseCustom, settings.fontFamilyMono, settings.fontFamilyMonoCustom]);
}
