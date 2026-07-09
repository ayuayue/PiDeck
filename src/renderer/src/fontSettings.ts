import type { AppFontBaseMode, AppFontMonoMode } from "../../shared/types";

/**
 * 字体配置解析模块
 *
 * 与 App.tsx 主题 effect 及 styles.css 的 :root[data-font-size] 预设块协同，
 * 提供用户可配置的界面字号与字体族。
 *
 * ── CSS 自定义属性对应的界面区域（无法从单文件推断）──
 *   --font-size-chat      → 会话正文（用户消息与助手回复），用更明显的阅读字号
 *   --font-family-base    → 正文、按钮、列表、表单、输入框、会话气泡（全局继承）
 *   --font-family-mono    → 代码块、消息编辑框、命令面板、tool card 详情（共 52 处）
 *   --font-family-business → 徽标、计时、状态、agent ID 等短技术文本
 *                           （是 --font-family-mono 的别名，因此 mono 被改写时同步变化）
 *   --font-family-brand   → 品牌字标（2 处，不开放配置）
 *
 * ── 生效机制 ──
 *   fontSize（枚举档位） → documentElement.dataset.fontSize
 *                         → styles.css 的 :root[data-font-size="..."] 覆写字号 token
 *                         → --font-size-chat 单独控制会话正文阅读字号
 *   fontFamilyBase/mono  → documentElement.style.setProperty("--font-family-*", 预设栈或自定义字符串)
 *
 * ── 同步约束（修改前必须确认）──
 *   1. FONT_BASE_PRESETS 中的 system 预设栈必须与 styles.css :root 的 --font-family-base
 *      默认值完全一致。启动时 JS 通过 setProperty 覆盖该 token，若两边默认值不同，
 *      浏览器会先按 CSS 旧值渲染一帧，再切换到 JS 新值，导致启动闪烁。
 *   2. --font-family-business 在 styles.css 中是 --font-family-mono 的别名。
 *      因此改写 mono 时徽标/计时等短技术文本同步变化，不可在 styles.css 未改的情况下
 *      将其拆成独立配置。
 *
 * ── 明确不受影响的范围 ──
 *   xterm 终端（TerminalDock.tsx）的 fontFamily / fontSize 是 JS 构造参数，
 *   不读取 CSS token，因此不受本模块控制。
 *   若未来要让终端也受控，需额外重建 xterm 实例（处理 fit、buffer、resize 事件回接），
 *   不在本模块职责内。
 *
 * ── 新增预设项的变更规则 ──
 *   1. 类型：shared/types.ts 加枚举值。
 *   2. 预设栈：fontSettings.ts 加预设条目。
 *   3. 默认值：SettingsStore.ts + App.tsx 初始 state + previewApi.ts 同步补齐。
 *   4. 界面：SettingsModal.tsx 加 SelectField 选项 + i18n.ts 加文案 key。
 *   5. 若新增字号档位：styles.css 须加 :root[data-font-size="..."] 块，并同步设置 --font-size-chat 与行高。
 */

/**
 * 等宽字体预设栈。commit-mono 为内置 PiDeckCommitMono（assets/fonts 随包分发，离线可用）。
 * --font-family-business 在 styles.css 中是 --font-family-mono 的别名，
 * 因此 mono 被改写时徽标/计时等短技术文本同步变化，保持工具感一致。
 */
const FONT_MONO_PRESETS: Record<Exclude<AppFontMonoMode, "custom">, string> = {
	"commit-mono":
		'"PiDeckCommitMono", ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
	"system-mono":
		"ui-monospace, SFMono-Regular, Menlo, Consolas, \"Liberation Mono\", monospace",
};

/**
 * UI 基础字体预设栈。差异主要在中文字体候选顺序，以保证跨平台（Win/macOS/Linux）都有可用字形。
 * 须与 styles.css:root 的 --font-family-base 默认值保持一致 —— 启动 setProperty 前 root CSS 先以此默认值渲染，不一致会导致启动闪烁。
 */
const FONT_BASE_PRESETS: Record<Exclude<AppFontBaseMode, "custom">, string> = {
	system: `-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", "PingFang SC", "HarmonyOS Sans SC", "Hiragino Sans GB", "Noto Sans CJK SC", sans-serif`,
	sans: `"Inter", "Segoe UI", "Microsoft YaHei", "PingFang SC", "HarmonyOS Sans SC", "Noto Sans CJK SC", sans-serif`,
	serif: `Georgia, "Source Han Serif SC", "Noto Serif CJK SC", "Songti SC", "SimSun", serif`,
};

/**
 * custom 时直接取用户输入字符串（不检查字体是否安装，由浏览器按 CSS fallback 兜底）。
 */
export function resolveFontBaseStack(
	mode: AppFontBaseMode,
	custom: string,
): string {
	if (mode === "custom") return custom.trim() || FONT_BASE_PRESETS.system;
	return FONT_BASE_PRESETS[mode];
}

/**
 * custom 时直接取用户输入字符串；否则返回对应预设。
 */
export function resolveFontMonoStack(
	mode: AppFontMonoMode,
	custom: string,
): string {
	if (mode === "custom") return custom.trim() || FONT_MONO_PRESETS["commit-mono"];
	return FONT_MONO_PRESETS[mode];
}