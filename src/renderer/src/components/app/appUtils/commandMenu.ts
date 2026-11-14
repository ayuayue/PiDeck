/**
 * 从 AppUtils 拆出的「命令菜单」域：`/` 菜单可见性、内置命令补齐与 i18n 描述。
 */

import type { PiCommand } from "../../../../../shared/types";
import { t, type TranslationKey } from "../../../i18n";

/* ── 命令管理 ── */

// 桌面端已有独立 UI 的 pi 内置命令不进 `/` 菜单，避免点进去却落到 CLI 语义。
// `/new` 例外：发送时由桌面拦截，走新建 Agent 会话（与侧栏 + 同源），不再藏起来。
//
// copy/export/session/settings/clone 与 tree/reload 是两类不同原因，但都要藏：
// pi 的 builtin 斜杠命令只在交互式 TUI 里处理（`dist/core/slash-commands.js` 只被
// modes/interactive 引用，RPC 的 get_commands 只返回 extension/prompt/skill），发下去
// 不会执行、只会被模型当成普通文本回答。这些命令桌面都已有等价入口（消息复制、
// 会话菜单导出 HTML、圆环/打开会话文件、设置页、复制会话），所以直接不列；
// `/hotkeys` 无等价按钮，靠 classifyComposerSlashCommand 接管到设置里的快捷键页。
const HIDDEN_DESKTOP_BUILTIN_COMMAND_NAMES = new Set(["model", "resume", "fork", "name", "logout", "goal", "tree", "reload", "copy", "export", "share", "session", "settings", "clone"]);

/**
 * 内置扩展命令的菜单描述：pi 进程没有渲染层词典，扩展只能给英文 fallback；
 * 渲染层对这些已知命令补 i18n 描述（不覆盖用户扩展自带 description）。
 */
const COMMAND_DESCRIPTION_KEYS: Record<string, TranslationKey> = {
	reload: "prompt.command.reload.description",
};

/** 菜单描述：i18n 覆盖优先，扩展自带 description 次之。 */
export function localizedCommandDescription(command: PiCommand): string {
	const key = COMMAND_DESCRIPTION_KEYS[command.name];
	if (key) return t(key);
	return command.description ?? "";
}

function isBuiltinDesktopCommand(command: PiCommand) {
	return command.source == null || command.source === "builtin";
}

function isVisibleDesktopCommand(command: PiCommand) {
	return !(isBuiltinDesktopCommand(command) && HIDDEN_DESKTOP_BUILTIN_COMMAND_NAMES.has(command.name.toLowerCase()));
}

function getBuiltinCommands(): PiCommand[] {
	return [
		{ name: "new", description: "", source: "builtin" },
		{ name: "session", description: "", source: "builtin" },
		{ name: "tree", description: "", source: "builtin" },
		{ name: "clone", description: "", source: "builtin" },
		{ name: "compact", description: "", source: "builtin" },
		{ name: "copy", description: "", source: "builtin" },
		{ name: "export", description: "", source: "builtin" },
		{ name: "share", description: "", source: "builtin" },
		{ name: "settings", description: "", source: "builtin" },
		{ name: "reload", description: "", source: "builtin" },
		{ name: "hotkeys", description: "", source: "builtin" },
		{ name: "login", description: "", source: "builtin" },
		{ name: "logout", description: "", source: "builtin" },
	];
}

/**
 * DSH 已知斜杠命令建议（G4）：与 dsh-web 命名空间一致——host 侧 pideck-slash-bridge
 * 在 agent/pre-step 拦截执行，未命中（未知命令）放行给模型。列表仅作 Composer `/` 菜单
 * 建议，不参与执行正确性。description 用 i18n key（controller 注入时翻译）。
 */
export const DSH_COMMAND_SUGGESTIONS: Array<{ name: string; descriptionKey: TranslationKey; source: "dsh" }> = [
	{ name: "permission", descriptionKey: "dshCommand.permission", source: "dsh" },
	{ name: "plan", descriptionKey: "dshCommand.plan", source: "dsh" },
	{ name: "plan off", descriptionKey: "dshCommand.planOff", source: "dsh" },
	{ name: "compact", descriptionKey: "dshCommand.compact", source: "dsh" },
	{ name: "help", descriptionKey: "dshCommand.help", source: "dsh" },
	{ name: "goal", descriptionKey: "dshCommand.goal", source: "dsh" },
	{ name: "subagent", descriptionKey: "dshCommand.subagent", source: "dsh" },
	{ name: "feedback", descriptionKey: "dshCommand.feedback", source: "dsh" },
];

export function mergeCommands(commands: PiCommand[]) {
	const visibleCommands = commands.filter(isVisibleDesktopCommand);
	const names = new Set(visibleCommands.map((command) => command.name));
	const extras = getBuiltinCommands().filter((command) => !names.has(command.name) && isVisibleDesktopCommand(command));
	return [...visibleCommands, ...extras];
}
