import { useEffect, type Dispatch, type SetStateAction } from "react";
import type { ConfigTab } from "../configTypes";
import type { ConfigSection } from "./configModalStorage";

type ConfigDeepLinkFocusDeps = {
	open: boolean;
	focusConfigTab: ConfigTab | undefined;
	focusProvider: string | undefined;
	resourceOnly: boolean;
	setSection: Dispatch<SetStateAction<ConfigSection>>;
	setTab: Dispatch<SetStateAction<ConfigTab>>;
	setFocusedProvider: Dispatch<SetStateAction<string | undefined>>;
	setExpandedProvider: Dispatch<SetStateAction<string | null>>;
};

/**
 * 深链落点（圆球「去配置用量」等）：focusConfigTab / focusProvider 变化即应用，
 * 设置窗口已打开时也要生效，因此依赖里必须有 open（关窗期间到来的深链留到下次打开）。
 * 顶层区域必须一并切回 config：这些分页只属于 config 区域，只 setTab 会出现「分页跳对了、区域没切」。
 */
export function useConfigDeepLinkFocus(deps: ConfigDeepLinkFocusDeps) {
	const { open, focusConfigTab, focusProvider, resourceOnly, setSection, setTab, setFocusedProvider, setExpandedProvider } = deps;

	useEffect(() => {
		if (!open) return;
		// 顶层区域必须一并切回 config：这些分页（models/auth/...）只属于 config 区域，
		// 只 setTab 的话，上次停在 skills/prompts/extensions 时会「切了分页却看不见」。
		if (!resourceOnly && focusConfigTab) {
			setSection("config");
			setTab(focusConfigTab);
		}
		if (!resourceOnly && focusProvider) {
			setSection("config");
			setFocusedProvider(focusProvider);
			setTab("models");
			setExpandedProvider(focusProvider);
		}
		// focusProvider/focusConfigTab 变化即应用：设置窗口已开时点圆球跳转也要生效。
	}, [open, focusConfigTab, focusProvider, resourceOnly, setSection, setTab, setFocusedProvider, setExpandedProvider]);
}
