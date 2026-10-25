import { t } from "../i18n";
import { writeClipboard } from "./clipboard";
import { showNotice } from "./notice";

/**
 * 复制纯文本并弹「已复制」提示。
 *
 * 收敛原因：复制动作散落在侧栏会话菜单、会话 Tab 菜单、命令面板等多处，
 * 各写各的会漂移成「有的走 navigator.clipboard（窗口失焦即抛错）、
 * 有的提示时长不一致、有的干脆不提示」。剪贴板写入统一走 writeClipboard
 * （Electron 主进程优先，不依赖 document focus），提示统一走全局 toast。
 */
export async function copyTextWithCopiedNotice(text: string): Promise<void> {
	const value = text?.trim();
	if (!value) return;
	await writeClipboard(value);
	showNotice(t("common.copied"));
}
