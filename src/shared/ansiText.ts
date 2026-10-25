/**
 * 宿主侧的 ANSI 净化兜底（2026-09 ANSI 泄漏事故的收口）。
 *
 * pi 的 `Theme.fg()`（以及第三方扩展顺手上的色）产的是**真 ANSI**，透传到界面
 * 就是一行 `[38;2;…m` 乱码。`shared/fileChanges.ts` 的 `stripAnsi` 只认 CSI，
 * 而扩展帧里还会出现 pi-tui 清行、OSC 超链接、字符集切换等形态 —— 这里补齐，
 * 并做最后一趟裸 ESC 清除（界面上的 ESC 永远是渲染事故，不存在合法残留）。
 *
 * 纯函数、无 Node/Electron/React 依赖，main / renderer 共用并可单测。
 */

import { stripAnsi } from "./fileChanges.ts";

const EXTRA_ESCAPE_RE = /\u001b(?:\[[0-9;?<=>!]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[()*+][0-9A-Za-z]|[P^_X][^\u001b]*(?:\u001b\\)?|[@-Z\\-_])/g;

/** 剥掉文本里的全部 ANSI 转义（含 OSC / 字符集切换 / 裸 ESC）。 */
export function stripAnsiText(text: string): string {
	return stripAnsi(text)
		.replace(EXTRA_ESCAPE_RE, "")
		.replace(/\u001b/g, "");
}
