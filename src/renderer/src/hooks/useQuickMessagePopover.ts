import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "jotai";
import { currentSessionIdAtom } from "../atoms";
import { desktopApi } from "../desktopApi";
import { GUIDE_BOOTSTRAP_SESSION_ID } from "../utils/chatSessionBootstrap";
import { ownsQuickMessageShortcut } from "../utils/quickMessageShortcut";

/**
 * 「快捷消息」浮层的开合状态 + 全局快捷键呼出（底栏入口点击与快捷键共用同一份状态）。
 *
 * 为什么单独抽成 hook 而不是在 QuickMessageMenu 里放一个 useState：
 * - 开合有两条来源（鼠标点底栏入口、全局快捷键），而两条都必须在「打开前重读配置文件」。
 *   绑在一处才不会有「鼠标点进去是新的、快捷键进来是旧的」这类入口差异；
 * - 快捷键是主进程 before-input-event 的全局广播，分屏时每个会话栏都挂一份订阅，
 *   必须自证「本栏是聚焦栏」才响应，否则按一次会同时弹出多个浮层
 *   （与 useSessionPreferenceController 的 cycleModel/cycleThinking 同一套判定）。
 *
 * 与其它全局快捷键的差异：本键在输入框聚焦时也生效。它的用途恰恰是「打字打到一半插入
 * 口令」，而输入框是常驻焦点——若沿用「输入框聚焦就跳过」的惯例，这个快捷键等于永远不可用。
 */
export function useQuickMessagePopover(options: {
	/** 本栏会话 id：用于判断广播是否该由本栏响应。 */
	sessionId: string;
	/** 重读磁盘上的清单（useQuickMessages 的 refresh）。 */
	refresh: () => void | Promise<void>;
}): { open: boolean; setOpen: (next: boolean) => void } {
	const store = useStore();
	const [open, setOpenState] = useState(false);
	// 快捷键是「切换式」开合，需要拿到同步的当前值；同时只有真打开时才值得重读文件。
	// 所有写入都经过下面的 setOpen，因此这个镜像不会漂移（Radix 的 Esc/外点收起
	// 也走 onOpenChange → setOpen）。
	const openRef = useRef(false);
	const { sessionId, refresh } = options;

	/** 唯一的开合写入口：打开即重读文件，避免从任一入口进来看到上次挂载时的旧清单。 */
	const setOpen = useCallback(
		(next: boolean) => {
			openRef.current = next;
			setOpenState(next);
			if (next) void refresh();
		},
		[refresh],
	);

	useEffect(() => {
		return desktopApi.app.onShortcutTriggered((triggered) => {
			if (triggered !== "openQuickMessages") return;
			// 只由聚焦栏（或页面唯一存在的引导页输入框）响应（判定见 ownsQuickMessageShortcut）。
			if (!ownsQuickMessageShortcut({ focusedSessionId: store.get(currentSessionIdAtom), sessionId, guideSessionId: GUIDE_BOOTSTRAP_SESSION_ID })) return;
			// 再按一次收起：呼出类快捷键的普遍预期（打开后原键关闭）。
			setOpen(!openRef.current);
		});
	}, [sessionId, store, setOpen]);

	return { open, setOpen };
}
