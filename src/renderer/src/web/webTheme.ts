/**
 * Web 端主题（亮/暗/跟随系统）。
 *
 * 桌面端暗色机制是 `:root[data-theme="dark"]`（foundation.css 变量集），
 * Web 端复用同一套 token：把解析结果写到 documentElement.dataset.theme 即可，
 * 不引入第二套样式。偏好存 localStorage，默认跟随系统。
 */

export type WebThemePreference = "light" | "dark" | "system";
export type ResolvedWebTheme = "light" | "dark";

const STORAGE_KEY = "pideck-web-theme";

export function readStoredWebTheme(): WebThemePreference {
	if (typeof localStorage === "undefined") return "system";
	const value = localStorage.getItem(STORAGE_KEY);
	return value === "light" || value === "dark" || value === "system" ? value : "system";
}

export function storeWebTheme(pref: WebThemePreference): void {
	if (typeof localStorage === "undefined") return;
	try {
		localStorage.setItem(STORAGE_KEY, pref);
	} catch {
		// 隐私模式/存储禁用：仅本次会话生效，不报错
	}
}

/** 偏好 → 实际主题：system 时看 prefers-color-scheme。 */
export function resolveWebTheme(pref: WebThemePreference, systemDark: boolean): ResolvedWebTheme {
	if (pref === "system") return systemDark ? "dark" : "light";
	return pref;
}

/**
 * 三态循环的下一档：light → dark → system → …
 *
 * 从 system 出发时必须跳到「与当前系统解析结果相反」的那一档。若按字面写死 light，
 * 系统本身是亮色时第一次点击毫无视觉变化，用户会以为按钮坏了。
 */
export function nextWebTheme(pref: WebThemePreference, resolved: ResolvedWebTheme): WebThemePreference {
	if (pref === "light") return "dark";
	if (pref === "dark") return "system";
	return resolved === "dark" ? "light" : "dark";
}

export function applyWebTheme(theme: ResolvedWebTheme): void {
	if (typeof document === "undefined") return;
	// foundation 变量只在 dark 有覆盖集，light 显式写属性保持 DOM 状态可观察
	document.documentElement.dataset.theme = theme;
	// theme-color 同步状态栏/标题栏颜色（PWA 场景）
	const meta = document.querySelector('meta[name="theme-color"]');
	if (meta) meta.setAttribute("content", theme === "dark" ? "#18181b" : "#ffffff");
}

export function systemPrefersDark(): boolean {
	if (typeof window === "undefined" || !window.matchMedia) return false;
	return window.matchMedia("(prefers-color-scheme: dark)").matches;
}
