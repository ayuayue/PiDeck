import type { PiCommand } from "../../../shared/types";

/**
 * 后端已经接管的命令名（本地展开必须避让的集合）。
 *
 * 判据来自 pi / DSH / ACP 各自的命令表（`get_commands` → `source` 字段）：
 * - `prompt`：提示词模板，**就是我们要本地展开的对象**，不能进保留集；
 * - `builtin`：PiDeck 自己登记的桌面内置命令（new/compact/copy/export…）。它们在
 *   `classifyComposerSlashCommand` 里被单独接管，没被接管的那些本来也只是文本；
 *   若把它们也当保留项，用户建一个叫 `export` 的模板就永远展开不了（真实回归风险）。
 * - 其余（`extension` / `skill:…` / `dsh` / `acp` / 缺省）：由后端执行，必须让路。
 *
 * 为什么让路：展开后消息以 `<prompt_template>` 开头，不再是 `/` 开头——
 * pi 的扩展命令（`prompt()` 里的 `_tryExecuteExtensionCommand`）与 DSH 的 slash 桥
 * （`hostEntry.ts` 生成的 agent/pre-step 钩子）都只认 `/` 开头的用户消息，
 * 命令会被静默降级成普通提示词发给模型。
 *
 * 名字形态：pi 的技能命令名是 `skill:名称`（裸 `/名称` 在 pi 上仍是模板调用），
 * DSH 的 host 命令本来就是裸名。所以这里不做「skill: → 裸名」的放宽，
 * 否则 pi 上一次技能注册会误封同名的提示词模板。
 */
export function collectReservedCommandNames(commands: readonly PiCommand[]): Set<string> {
	const reserved = new Set<string>();
	for (const command of commands) {
		if (!command.name || command.source === "prompt" || command.source === "builtin") continue;
		reserved.add(command.name);
	}
	return reserved;
}

/**
 * 这次发送是否需要补拉模板表。
 *
 * 三种情况返回 false：
 * - 不是 `/名称` 形态；
 * - 名字在当前模板表里（已知，直接展开）；
 * - 名字属于后端接管的命令（补拉也没用：它永远不会出现在模板表里，
 *   否则每发一次 `/permission` 就白跑三趟 IPC）。
 */
export function needsTemplateRefetch(name: string | undefined, templates: readonly { name: string }[], reserved: ReadonlySet<string>): boolean {
	if (!name) return false;
	if (reserved.has(name)) return false;
	return !templates.some((template) => template.name === name);
}
