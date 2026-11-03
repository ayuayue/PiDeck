import { useEffect } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import type { SendShortcut } from "../../composerBehavior";
import { sendShortcutKeyHint } from "../../composerBehavior";
import { sendShortcutAtom } from "../../atoms/composer-atoms";
import { detectRendererPlatform } from "../../lib/detectRendererPlatform";

/** 平台在进程内不变：模块级判一次，发送按钮与时间线编辑框的键帽就不会各判各的。 */
const IS_MAC = detectRendererPlatform() === "darwin";

/** 设置里的「发送快捷键」同步到 atom：composer 发送按钮与时间线编辑框的键帽都读它。 */
export function useSendShortcut(sendShortcut: SendShortcut): void {
	const setSendShortcut = useSetAtom(sendShortcutAtom);
	useEffect(() => {
		setSendShortcut(sendShortcut);
	}, [sendShortcut, setSendShortcut]);
}

/**
 * 发送键帽文案（↵ / ⌘↵ / Ctrl+↵ / ⇧↵）。
 *
 * 与 `getComposerEnterIntent` 的判定同源，平台判断也只在这里做一次：组件只负责渲染，
 * 才不会出现「设置改成 Enter 发送、界面还提示 ⌘↵」这种各写各的引导。
 */
export function useSendShortcutKeyHint(): string {
	return sendShortcutKeyHint(useAtomValue(sendShortcutAtom), IS_MAC);
}
