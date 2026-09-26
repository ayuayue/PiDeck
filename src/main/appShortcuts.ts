/**
 * 主进程全局快捷键匹配（主窗口 + 内置浏览器 webview guest 的 before-input-event 共用）。
 *
 * 窗口刻意没有原生菜单（SettingsStore 里 Menu.setApplicationMenu(null)），
 * 菜单加速键不可用，「打开设置」「开发者工具」等全局快捷键都走这条链路。
 *
 * 快捷键定义、平台默认值、匹配语义收敛在 shared/shortcuts.ts（设置页与主进程
 * 共用同一份注册表）；本模块只做两件事：
 * 1. 持有「设置 → 生效绑定」的内存缓存（启动 load 后与 settings:update 保存后刷新，
 *    见 main/index.ts 与 ipc/systemIpc.ts），匹配时按缓存判键，改设置即时生效；
 * 2. 兜底常用组合键——开发者工具仅当该快捷键仍是默认 F12 时保留
 *    Ctrl+Shift+I/J（macOS ⌘⌥I/J）；窗口缩放保持默认时兼容等价按键
 *    （Ctrl++ / 数字键盘 + 等，见 isZoomEquivalentChord）。用户自定义后只认新绑定，
 *    避免两套规则并存。
 */

import { getShortcutDef, matchesAccelerator, normalizeInputKey, resolveDefaultAccelerator, resolveShortcutBindings, type ShortcutId, type ShortcutInput } from "../shared/shortcuts";

/** 当前生效的快捷键绑定（id → accelerator），null = 尚未刷新（此时按全默认匹配）。 */
let activeBindings: Record<ShortcutId, string> | null = null;

/**
 * 用最新设置刷新生效绑定。settingsStore.load() 后与 settings:update 保存后调用；
 * 未调用前匹配按全默认处理（与「用户从没改过」等价）。
 */
export function refreshShortcutBindings(settings: { shortcuts?: Record<string, unknown> }) {
	activeBindings = resolveShortcutBindings(settings.shortcuts, process.platform);
}

function bindings(): Record<ShortcutId, string> {
	if (!activeBindings) refreshShortcutBindings({});
	return activeBindings as Record<ShortcutId, string>;
}

/**
 * 判断一次 before-input-event 输入是否命中指定快捷键。
 * 匹配语义（精确修饰键 / 输入法组合不命中 / 大小写不敏感）见 shared/shortcuts.ts。
 */
export function isShortcutInput(id: ShortcutId, input: ShortcutInput): boolean {
	const acc = bindings()[id];
	if (!acc) return false;
	if (matchesAccelerator(acc, input, process.platform)) return true;
	// 开发者工具保持默认（F12）时兼容浏览器习惯组合键：Ctrl+Shift+I/J（macOS ⌘⌥I/J）。
	// 用户自定义后只认新绑定；F12 本身已由 matchesAccelerator 覆盖，这里只判组合键。
	if (id === "toggleDevTools") {
		const def = getShortcutDef(id);
		if (def && acc === resolveDefaultAccelerator(def, process.platform)) {
			return isLegacyDevToolsChord(input);
		}
	}
	// 缩放保持默认时兼容同一动作的等价按键（Ctrl++ / 数字键盘 + 等），
	// 用户自定义后只认新绑定。
	if (id === "zoomIn" || id === "zoomOut") {
		const def = getShortcutDef(id);
		if (def && acc === resolveDefaultAccelerator(def, process.platform)) {
			return isZoomEquivalentChord(id, input);
		}
	}
	return false;
}

/**
 * 缩放快捷键的等价按键：物理键盘上「放大」的常见按法是 Ctrl+= 与 Ctrl+Shift+=（即 Ctrl++），
 * 数字键盘的 + 则不带 Shift；「缩小」同理（- / _ / 数字键盘 -）。
 * 只允许本平台的主修饰键且不叠加其它修饰键，避免抢 Ctrl+Alt+= 这类组合。
 */
function isZoomEquivalentChord(id: ShortcutId, input: ShortcutInput): boolean {
	if (input.type !== "keyDown" || input.isComposing) return false;
	const isMac = process.platform === "darwin";
	if (isMac) {
		if (!input.meta || input.control || input.alt) return false;
	} else if (!input.control || input.meta || input.alt) {
		return false;
	}
	const key = normalizeInputKey(input.key);
	if (id === "zoomIn") return key === "=" || key === "+" || key === "plus";
	return key === "-" || key === "_";
}

/** 默认态保留的 DevTools 组合键（F12 不在此判，由绑定匹配兜底）。 */
function isLegacyDevToolsChord(input: ShortcutInput): boolean {
	if (input.type !== "keyDown") return false;
	const isMac = process.platform === "darwin";
	const ctrlOrCmd = isMac ? input.meta : input.control;
	const shiftOrOption = input.shift || (isMac && input.alt);
	if (!ctrlOrCmd || !shiftOrOption) return false;
	const key = input.key.toLowerCase();
	return key === "i" || key === "j";
}
