/**
 * 全局快捷键注册表与匹配/录制工具（主进程 before-input-event 与渲染层设置页共用）。
 *
 * 为什么需要这份注册表：主窗口刻意没有原生应用菜单（SettingsStore.applyMenu 里
 * Menu.setApplicationMenu(null)），Electron 菜单加速键不可用，所有全局快捷键都走
 * 主窗口 + webview guest 的 before-input-event 手工匹配。因此「有哪些快捷键、
 * 平台默认值、用户覆盖、匹配语义」必须收敛在单一纯模块里——设置页展示的默认值、
 * 主进程实际匹配的键、写进 settings.json 前的校验规则来自同一份数据，避免
 * 「改了设置不生效 / 默认值对不上 / 手工改 json 写入坏值」三类漂移。
 *
 * 存储：用户覆盖值存 AppSettings.shortcuts（ShortcutId → accelerator），
 * 缺省键 = 平台默认；未知 id / 非法 accelerator 的条目在保存时丢弃
 * （sanitizeShortcutOverrides，见 SettingsStore.update），主进程匹配同样按
 * resolveShortcutBindings 兜底到平台默认。
 *
 * accelerator 语法：Electron 加速键子集——修饰键（Ctrl/Cmd/Alt/Shift/Super，
 * CmdOrCtrl 按平台解析）+ 主键（字母/数字/F1-F24/命名键/少量标点），
 * 见 parseAccelerator。纯函数实现，node --test 可直接单测，不依赖 electron 运行时。
 */

export type ShortcutId = "openSettings" | "toggleDevTools" | "openNewSession" | "openSearch" | "openCommandPalette" | "cycleModel" | "cycleThinking" | "openQuickMessages" | "toggleVoiceRecording";

/** 设置页分组：general=通用（普通用户常用），dev=开发调试 */
export type ShortcutGroupId = "general" | "dev";

export type ShortcutDef = {
	id: ShortcutId;
	group: ShortcutGroupId;
	/** 设置页行标题 i18n key */
	labelKey: string;
	/** 设置页行描述 i18n key */
	descriptionKey: string;
	/**
	 * 平台默认 accelerator：darwin 与其他平台分开（macOS 有系统惯例 ⌘,，
	 * Windows/Linux 无统一惯例，由产品指定）。
	 */
	defaultAccelerator: { darwin: string; other: string };
};

export const SHORTCUT_DEFS: readonly ShortcutDef[] = [
	{
		id: "openSettings",
		group: "general",
		labelKey: "settings.shortcuts.openSettingsLabel",
		descriptionKey: "settings.shortcuts.openSettingsDesc",
		// macOS 走系统惯例 ⌘,（与系统偏好设置一致）；Windows/Linux 用 Ctrl+Alt+S
		defaultAccelerator: { darwin: "Cmd+,", other: "Ctrl+Alt+S" },
	},
	{
		id: "openNewSession",
		group: "general",
		labelKey: "settings.shortcuts.openNewSessionLabel",
		descriptionKey: "settings.shortcuts.openNewSessionDesc",
		// 与浏览器/IDE 惯例一致：Cmd/Ctrl+N 新建会话（打开引导页）
		defaultAccelerator: { darwin: "Cmd+N", other: "Ctrl+N" },
	},
	{
		id: "openSearch",
		group: "general",
		labelKey: "settings.shortcuts.openSearchLabel",
		descriptionKey: "settings.shortcuts.openSearchDesc",
		// Cmd/Ctrl+F 打开会话搜索命令面板（输入框聚焦时不触发，见 SidebarContent）
		defaultAccelerator: { darwin: "Cmd+F", other: "Ctrl+F" },
	},
	{
		id: "openCommandPalette",
		group: "general",
		labelKey: "settings.shortcuts.openCommandPaletteLabel",
		descriptionKey: "settings.shortcuts.openCommandPaletteDesc",
		// 与 VSCode 惯例一致：Cmd/Ctrl+P 打开命令面板（模糊搜索设置项并跳转 + 执行操作），
		// 与会话搜索（openSearch）分开入口：前者搜「配置与操作」，后者搜「项目/会话」。
		defaultAccelerator: { darwin: "Cmd+P", other: "Ctrl+P" },
	},
	{
		id: "cycleModel",
		group: "general",
		labelKey: "settings.shortcuts.cycleModelLabel",
		descriptionKey: "settings.shortcuts.cycleModelDesc",
		// 语义对齐 pi TUI 的模型循环（Ctrl+P / Shift+Ctrl+P），但 Ctrl+P 在 PiDeck 是命令面板，
		// 加 Alt 让位；macOS 侧进一步避开 Cmd+M（系统惯例 = 最小化窗口）。
		// 循环范围 = 模型选择器里的「收藏」，见 renderer/utils/preferenceCycle.ts。
		defaultAccelerator: { darwin: "Cmd+Alt+M", other: "Ctrl+M" },
	},
	{
		id: "cycleThinking",
		group: "general",
		labelKey: "settings.shortcuts.cycleThinkingLabel",
		descriptionKey: "settings.shortcuts.cycleThinkingDesc",
		// 语义对齐 pi TUI 的思考档位循环（Shift+Tab），但 PiDeck 里 Shift+Tab 承担焦点导航
		// （全局拦截会让对话框/设置页失去反向 Tab），因此默认走 Ctrl+T；macOS 避开 Cmd+T
		// （新标签页惯例）改用 Cmd+Alt+T。
		defaultAccelerator: { darwin: "Cmd+Alt+T", other: "Ctrl+T" },
	},
	{
		id: "openQuickMessages",
		group: "general",
		labelKey: "settings.shortcuts.openQuickMessagesLabel",
		descriptionKey: "settings.shortcuts.openQuickMessagesDesc",
		// M = 消息（message），与底栏浮层语义同源。必须带 Shift 避让：Ctrl+M 已被
		// cycleModel 占用，且 macOS 的裸 ⌘M 是系统惯例（最小化窗口）。
		// 与其它快捷键的关键差异：本键在输入框聚焦时**仍然生效**——它的用途恰恰是
		// 「打字打到一半插入口令」，而输入框正是常驻焦点；Ctrl/Cmd+Shift+M 在文本编辑
		// 与浏览器里都没有既有含义（无「静音标签页」之类冲突），劫持它是安全的。
		defaultAccelerator: { darwin: "Cmd+Shift+M", other: "Ctrl+Shift+M" },
	},
	{
		id: "toggleVoiceRecording",
		group: "general",
		labelKey: "settings.shortcuts.toggleVoiceRecordingLabel",
		descriptionKey: "settings.shortcuts.toggleVoiceRecordingDesc",
		// 开始/停止语音录音（需先在设置里开启语音输入）。功能键可裸按且全平台无
		// 文本编辑/浏览器既有含义，避让已占用区（Ctrl+M/T、Ctrl+Shift+M 等）。
		defaultAccelerator: { darwin: "F9", other: "F9" },
	},
	{
		id: "toggleDevTools",
		group: "dev",
		labelKey: "settings.shortcuts.toggleDevToolsLabel",
		descriptionKey: "settings.shortcuts.toggleDevToolsDesc",
		// 三平台默认都是 F12；保持默认时还兼容浏览器习惯组合键（见 appShortcuts.isShortcutInput）
		defaultAccelerator: { darwin: "F12", other: "F12" },
	},
];

export function getShortcutDef(id: ShortcutId): ShortcutDef | undefined {
	return SHORTCUT_DEFS.find((def) => def.id === id);
}

/** 解析平台默认 accelerator（非 darwin 平台统一用 other 值） */
export function resolveDefaultAccelerator(def: ShortcutDef, platform: string): string {
	return platform === "darwin" ? def.defaultAccelerator.darwin : def.defaultAccelerator.other;
}

/** 主键的规范化命名（小写）；匹配时把 Electron input.key / KeyboardEvent.key 归一到同一套。 */
export type ParsedAccelerator = {
	ctrl: boolean;
	meta: boolean;
	alt: boolean;
	shift: boolean;
	/** 规范化主键：字母小写；命名键见 normalizeKeyToken（"space"/"enter"/"up"/"f12"/","…） */
	key: string;
};

const MODIFIER_ALIASES: Record<string, "ctrl" | "meta" | "alt" | "shift" | "cmdorctrl"> = {
	control: "ctrl",
	ctrl: "ctrl",
	option: "alt",
	opt: "alt",
	alt: "alt",
	shift: "shift",
	meta: "meta",
	super: "meta",
	win: "meta",
	cmd: "meta",
	command: "meta",
	cmdorctrl: "cmdorctrl",
	commandorcontrol: "cmdorctrl",
};

const NAMED_KEYS: Record<string, string> = {
	space: "space",
	tab: "tab",
	enter: "enter",
	return: "enter",
	esc: "escape",
	escape: "escape",
	backspace: "backspace",
	delete: "delete",
	del: "delete",
	insert: "insert",
	home: "home",
	end: "end",
	pageup: "pageup",
	pagedown: "pagedown",
	up: "up",
	down: "down",
	left: "left",
	right: "right",
	plus: "plus",
};

/** 加速键可用的标点主键（与 Electron 加速键兼容的常用子集） */
const PUNCTUATION_KEYS = new Set([",", ".", ";", "'", "/", "[", "]", "\\", "-", "=", "`"]);

/** 规范化加速键 token → 主键（小写字母/数字/命名键；F12 → "f12"）。返回 null 表示不支持。 */
export function normalizeKeyToken(token: string): string | null {
	const lower = token.toLowerCase();
	const named = NAMED_KEYS[lower];
	if (named) return named;
	if (/^[a-z]$/.test(lower)) return lower;
	if (/^[0-9]$/.test(lower)) return lower;
	if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) return lower;
	if (PUNCTUATION_KEYS.has(lower)) return lower;
	return null;
}

/**
 * 解析 accelerator 字符串（如 "Cmd+," / "Ctrl+Alt+S" / "F12"）。
 * 返回 null = 语法不支持（未知修饰键/主键/空串/多余主键）。
 */
export function parseAccelerator(acc: string, platform: string): ParsedAccelerator | null {
	const tokens = acc
		.split("+")
		.map((token) => token.trim())
		.filter(Boolean);
	if (tokens.length === 0) return null;
	const parsed: ParsedAccelerator = { ctrl: false, meta: false, alt: false, shift: false, key: "" };
	let keyToken: string | null = null;
	for (const token of tokens) {
		const lower = token.toLowerCase();
		const modifier = MODIFIER_ALIASES[lower];
		if (modifier) {
			if (modifier === "cmdorctrl") {
				// CmdOrCtrl 按平台落位：macOS=⌘，其余=Ctrl
				if (platform === "darwin") parsed.meta = true;
				else parsed.ctrl = true;
			} else if (modifier === "ctrl") parsed.ctrl = true;
			else if (modifier === "meta") parsed.meta = true;
			else if (modifier === "alt") parsed.alt = true;
			else if (modifier === "shift") parsed.shift = true;
			continue;
		}
		if (keyToken !== null) return null; // 多个主键 = 非法
		keyToken = normalizeKeyToken(token);
		if (!keyToken) return null;
	}
	if (keyToken === null) return null; // 只有修饰键没有主键
	parsed.key = keyToken;
	return parsed;
}

/**
 * 加速键是否合法（可持久化）：
 * - 语法必须可解析；
 * - 裸字母/数字/标点（无修饰键）会抢正常输入，拒绝；
 * - 裸 Escape 是录制器的「取消」键，也拒绝（F1-F24 功能键除外，可裸按）。
 */
export function isValidAccelerator(acc: string, platform: string): boolean {
	const parsed = parseAccelerator(acc, platform);
	if (!parsed) return false;
	const isFunctionKey = /^f([1-9]|1[0-9]|2[0-4])$/.test(parsed.key);
	if (isFunctionKey) return true;
	if (!parsed.ctrl && !parsed.meta && !parsed.alt && !parsed.shift) return false;
	return parsed.key !== "escape";
}

/** before-input-event 的输入形状（Electron.Input 的窄化子集，便于单测）。 */
export type ShortcutInput = {
	key: string;
	type: string;
	control?: boolean;
	meta?: boolean;
	shift?: boolean;
	alt?: boolean;
	/** Electron Input.isComposing：输入法组合中的按键不命中，避免 IME 拼音触发快捷键 */
	isComposing?: boolean;
};

/** 把 Electron input.key 归一到规范化主键（" "→"space"、"ArrowUp"→"up"、"A"→"a"…）。 */
export function normalizeInputKey(key: string): string {
	if (key === " ") return "space";
	const named: Record<string, string> = {
		ArrowUp: "up",
		ArrowDown: "down",
		ArrowLeft: "left",
		ArrowRight: "right",
		Esc: "escape",
		Plus: "plus",
	};
	const hit = named[key];
	if (hit) return hit;
	const lower = key.toLowerCase();
	const normalized = normalizeKeyToken(lower);
	return normalized ?? lower;
}

/**
 * 判断一次按键输入是否命中 accelerator。
 * 语义：必须是 keyDown；修饰键精确相等（不允许叠加额外修饰键，避免误触）；
 * 主键大小写不敏感（Shift+A 与 "Shift+A"、"A" 都命中 "Shift+A"）。
 */
export function matchesAccelerator(acc: string, input: ShortcutInput, platform: string): boolean {
	if (input.type !== "keyDown") return false;
	if (input.isComposing) return false;
	const parsed = parseAccelerator(acc, platform);
	if (!parsed) return false;
	if (Boolean(input.control) !== parsed.ctrl) return false;
	if (Boolean(input.meta) !== parsed.meta) return false;
	if (Boolean(input.alt) !== parsed.alt) return false;
	if (Boolean(input.shift) !== parsed.shift) return false;
	return normalizeInputKey(input.key) === parsed.key;
}

/** 键盘事件形状（渲染层录制器用，KeyboardEvent 的窄化子集）。 */
export type KeyEventLike = {
	key: string;
	ctrlKey: boolean;
	metaKey: boolean;
	altKey: boolean;
	shiftKey: boolean;
};

/** KeyboardEvent.key → 加速键主键名（" "→"Space"、"ArrowUp"→"Up"、"+"→"Plus"…）；不支持返回 null。 */
export function acceleratorKeyName(key: string): string | null {
	if (key === " ") return "Space";
	const named: Record<string, string> = {
		ArrowUp: "Up",
		ArrowDown: "Down",
		ArrowLeft: "Left",
		ArrowRight: "Right",
		Escape: "Escape",
		Backspace: "Backspace",
		Delete: "Delete",
		Insert: "Insert",
		Tab: "Tab",
		Home: "Home",
		End: "End",
		PageUp: "PageUp",
		PageDown: "PageDown",
		Enter: "Enter",
		"+": "Plus",
	};
	if (named[key]) return named[key];
	if (/^[a-z0-9]$/i.test(key)) return key.toUpperCase();
	if (PUNCTUATION_KEYS.has(key)) return key;
	if (/^F([1-9]|1[0-9]|2[0-4])$/i.test(key)) return key.toUpperCase();
	return null;
}

/**
 * 从键盘事件构建 accelerator 字符串（录制器用）。
 * 返回 null = 无法构成（纯修饰键按下等），调用方继续等待下一个键。
 * 单字符无修饰键的按键能构建出来但 isValidAccelerator 会拒绝（防止抢正常输入）。
 */
export function buildAcceleratorFromKeyEvent(event: KeyEventLike, platform: string): string | null {
	// 纯修饰键按下（Control/Alt/Shift/Meta）不作为快捷键的主键
	if (event.key === "Control" || event.key === "Alt" || event.key === "Shift" || event.key === "Meta") {
		return null;
	}
	const keyName = acceleratorKeyName(event.key);
	if (!keyName) return null;
	const parts: string[] = [];
	if (event.ctrlKey) parts.push("Ctrl");
	if (event.altKey) parts.push("Alt");
	if (event.shiftKey) parts.push("Shift");
	if (event.metaKey) parts.push(platform === "darwin" ? "Cmd" : "Super");
	parts.push(keyName);
	return parts.join("+");
}

/** 规范化主键 → 展示名（"up"→"↑"、"f12"→"F12"、"space"→"Space"）。 */
export function formatKeyName(canonical: string): string {
	const named: Record<string, string> = {
		space: "Space",
		tab: "Tab",
		enter: "Enter",
		escape: "Esc",
		backspace: "Backspace",
		delete: "Del",
		insert: "Ins",
		home: "Home",
		end: "End",
		pageup: "PgUp",
		pagedown: "PgDn",
		up: "↑",
		down: "↓",
		left: "←",
		right: "→",
		plus: "+",
	};
	if (named[canonical]) return named[canonical];
	if (/^[a-z]$/.test(canonical)) return canonical.toUpperCase();
	if (/^f([1-9]|1[0-9]|2[0-4])$/.test(canonical)) return canonical.toUpperCase();
	return canonical;
}

/**
 * accelerator → 人类可读展示。
 * macOS 用符号（⌃⌥⇧⌘，与系统偏好设置一致）；其他平台用文字 + "+" 拼接。
 */
export function formatAccelerator(acc: string, platform: string): string {
	const parsed = parseAccelerator(acc, platform);
	if (!parsed) return acc;
	const key = formatKeyName(parsed.key);
	if (platform === "darwin") {
		return `${parsed.ctrl ? "⌃" : ""}${parsed.alt ? "⌥" : ""}${parsed.shift ? "⇧" : ""}${parsed.meta ? "⌘" : ""}${key}`;
	}
	const mods: string[] = [];
	if (parsed.ctrl) mods.push("Ctrl");
	if (parsed.alt) mods.push("Alt");
	if (parsed.shift) mods.push("Shift");
	if (parsed.meta) mods.push("Win");
	return [...mods, key].join("+");
}

/**
 * 规范化主键 → aria-keyshortcuts 的主键名（WAI-ARIA 的专用写法）。
 * 注意不能复用 formatKeyName：它返回给人看的符号（up → "↑"），ARIA 要的是 "ArrowUp"；
 * 标点则直接用字符本身（"," 就是 ","）。
 */
const ARIA_KEY_NAMES: Record<string, string> = {
	space: " ",
	tab: "Tab",
	enter: "Enter",
	escape: "Escape",
	backspace: "Backspace",
	delete: "Delete",
	insert: "Insert",
	home: "Home",
	end: "End",
	pageup: "PageUp",
	pagedown: "PageDown",
	up: "ArrowUp",
	down: "ArrowDown",
	left: "ArrowLeft",
	right: "ArrowRight",
	plus: "+",
};

/**
 * accelerator → aria-keyshortcuts 属性值（读屏软件用）。
 * 语法必须是「Control/Alt/Shift/Meta 全称 + 主键」：直接拿 formatAccelerator 的结果挂上去
 * 是无效值（macOS 得到 "⌘⇧M"、Windows 得到 "Ctrl+Shift+M"，两个都不合 ARIA 语法，读屏读不出）。
 * 无法解析时返回 undefined，调用方应整个省略该属性。
 */
export function toAriaKeyShortcuts(acc: string, platform: string): string | undefined {
	const parsed = parseAccelerator(acc, platform);
	if (!parsed) return undefined;
	const parts: string[] = [];
	// 修饰键顺序不影响含义（ARIA 规范明确说该属性大小写不敏感、未规定修饰键次序），
	// 这里固定按 DOM Level 3 修饰键枚举顺序（字母序）拼，保证同一组合只有一个确定输出。
	if (parsed.alt) parts.push("Alt");
	if (parsed.ctrl) parts.push("Control");
	if (parsed.meta) parts.push("Meta");
	if (parsed.shift) parts.push("Shift");
	parts.push(ARIA_KEY_NAMES[parsed.key] ?? formatKeyName(parsed.key));
	return parts.join("+");
}

/**
 * 合并用户覆盖：已知 id 且 accelerator 合法才保留，其余回落到平台默认。
 * 主进程匹配与设置页展示共用，保证两处看到的键一致。
 */
export function resolveShortcutBindings(overrides: Record<string, unknown> | undefined, platform: string): Record<ShortcutId, string> {
	const result = {} as Record<ShortcutId, string>;
	for (const def of SHORTCUT_DEFS) {
		const candidate = overrides?.[def.id];
		const acc = typeof candidate === "string" ? candidate.trim() : "";
		result[def.id] = acc && isValidAccelerator(acc, platform) ? acc : resolveDefaultAccelerator(def, platform);
	}
	return result;
}

/**
 * 清洗用户覆盖（写盘前调用，IPC 入参不可信）：
 * 只保留已知 id + accelerator 合法（含语法、裸键、裸 Esc 规则）的条目；
 * 非对象入参返回空对象。与 resolveShortcutBindings 共用同一套校验，避免
 * 「设置页能保存、主进程却不认」的取值漂移。
 */
export function sanitizeShortcutOverrides(raw: unknown, platform: string): Record<string, string> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const out: Record<string, string> = {};
	for (const def of SHORTCUT_DEFS) {
		const value = (raw as Record<string, unknown>)[def.id];
		const acc = typeof value === "string" ? value.trim() : "";
		if (acc && isValidAccelerator(acc, platform)) out[def.id] = acc;
	}
	return out;
}
