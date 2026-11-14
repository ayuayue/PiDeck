import type { ReactNode } from "react";
import { Cpu, FileCode2, LayoutDashboard, Puzzle, ShieldCheck } from "lucide-react";
import { AgentPresetLogo } from "../../components/session/SessionSourceBadge";
import type { TranslationKey } from "../../i18n";

export const NAV_ITEMS: Array<{ id: string; labelKey: TranslationKey; icon: ReactNode }> = [
	{ id: "overview", labelKey: "config.dsh.tab.overview", icon: <LayoutDashboard className="size-3.5" aria-hidden="true" /> },
	{ id: "models", labelKey: "config.dsh.tab.models", icon: <Cpu className="size-3.5" aria-hidden="true" /> },
	{ id: "presets", labelKey: "config.dsh.tab.presets", icon: <AgentPresetLogo className="size-3.5" aria-hidden="true" /> },
	{ id: "plugins", labelKey: "config.dsh.tab.plugins", icon: <Puzzle className="size-3.5" aria-hidden="true" /> },
	{ id: "security", labelKey: "config.dsh.tab.security", icon: <ShieldCheck className="size-3.5" aria-hidden="true" /> },
	{ id: "raw", labelKey: "config.dsh.tab.raw", icon: <FileCode2 className="size-3.5" aria-hidden="true" /> },
];

/** localStorage 键：DSH 配置页上次打开的导航子页（重开配置弹窗/应用重启后恢复位置，与 Pi 管理页同款记忆）。 */
const DSH_LAST_TAB_KEY = "pideck-dsh-config-last-tab";
const DSH_LAST_PLUGIN_PANE_KEY = "pideck-dsh-config-plugin-pane";

/** 读取上次打开的 DSH 导航 id；无记录或值已失效时回退概览。 */
export function loadDshLastTab(): string {
	try {
		const raw = localStorage.getItem(DSH_LAST_TAB_KEY);
		return raw && NAV_ITEMS.some((item) => item.id === raw) ? raw : "overview";
	} catch {
		return "overview";
	}
}

/** 读取上次打开的插件子页（插件配置/插件列表）；默认插件配置。 */
export function loadDshLastPluginPane(): "config" | "list" {
	try {
		return localStorage.getItem(DSH_LAST_PLUGIN_PANE_KEY) === "list" ? "list" : "config";
	} catch {
		return "config";
	}
}

/** 记住上次打开的导航子页（隐私模式等 localStorage 不可用时仅本次会话生效）。 */
export function rememberDshLastTab(id: string): void {
	try {
		localStorage.setItem(DSH_LAST_TAB_KEY, id);
	} catch {
		// 隐私模式等 localStorage 不可用：仅本次会话生效
	}
}

/** 记住上次打开的插件子页（与 rememberDshLastTab 同款记忆）。 */
export function rememberDshLastPluginPane(pane: "config" | "list"): void {
	try {
		localStorage.setItem(DSH_LAST_PLUGIN_PANE_KEY, pane);
	} catch {
		// 同上：不可用时仅本次生效
	}
}
