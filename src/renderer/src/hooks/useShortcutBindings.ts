import { useEffect, useMemo, useState } from "react";
import type { AppSettings } from "../../../shared/types";
import { resolveShortcutBindings, type ShortcutId } from "../../../shared/shortcuts";
import { desktopApi } from "../desktopApi";

/**
 * 生效的全局快捷键绑定（用户覆盖 ∪ 平台默认），供 UI 展示真实键位。
 *
 * 数据源：desktopApi.settings.get() 首次拉取 + settingsApplyWindow 广播增量刷新
 * （设置页保存后主进程会广播最新 AppSettings），保证用户改键后侧栏 kbd 提示立即同步，
 * 与主进程 before-input-event 匹配的是同一份覆盖表（shared/shortcuts.resolveShortcutBindings）。
 */
export function useShortcutBindings(): {
	bindings: Record<ShortcutId, string> | null;
	platform: string;
} {
	const [settings, setSettings] = useState<AppSettings | null>(null);
	const [platform, setPlatform] = useState<string>("win32");

	useEffect(() => {
		let alive = true;
		desktopApi.settings
			.get()
			.then((s) => {
				if (alive) setSettings(s);
			})
			.catch(() => {});
		desktopApi.app
			.info()
			.then((info) => {
				if (alive) setPlatform(info.platform);
			})
			.catch(() => {});
		// 设置保存后主进程广播最新设置，无需手动刷新
		return desktopApi.settings.onApplyWindow((s) => {
			if (alive) setSettings(s);
		});
	}, []);

	const bindings = useMemo(() => (settings ? resolveShortcutBindings(settings.shortcuts ?? {}, platform) : null), [settings, platform]);
	return { bindings, platform };
}
