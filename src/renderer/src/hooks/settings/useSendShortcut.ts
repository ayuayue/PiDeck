import { useEffect } from "react";
import { useSetAtom } from "jotai";
import type { SendShortcut } from "../../composerBehavior";
import { sendShortcutAtom } from "../../atoms/composer-atoms";

/** 设置里的「发送快捷键」同步到 atom：composer 发送按钮与时间线编辑框的键帽都读它。 */
export function useSendShortcut(sendShortcut: SendShortcut): void {
	const setSendShortcut = useSetAtom(sendShortcutAtom);
	useEffect(() => {
		setSendShortcut(sendShortcut);
	}, [sendShortcut, setSendShortcut]);
}
