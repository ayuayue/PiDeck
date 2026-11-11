/**
 * Web 端输入框斜杠命令（纯函数，可单测）。
 *
 * 与桌面端的 `/` 菜单同语义：命令来自会话运行时的权威命令表（扩展 / 提示词模板 /
 * 技能 `skill:<名>`），选中后把 `/名称 ` 插进草稿，发送时原样交给 pi 展开执行。
 *
 * 两条与桌面不同的边界：
 * - Web 只有 textarea，不做 `@` 文件引用/`&` 会话引用的建议；这里只识别 `/`。
 * - pi 的 builtin 命令在 RPC 下不执行（只被交互式 TUI 处理）。Web 自己接管
 *   `/new`、`/compact`（见 WebChatApp 的 handleSend），所以这两条要出现在菜单里；
 *   其余 builtin（login/hotkeys/…）Web 没有等价入口，既不列也不发。
 */

/** `/` token 的定位结果：start 是 `/` 的下标，query 是 `/` 之后到光标的字符。 */
export type WebSlashToken = { start: number; query: string };

/** 菜单条目：`source` 只用于分组/图标，缺省按扩展命令处理。 */
export type WebSlashItem = { name: string; description: string; source?: "extension" | "prompt" | "skill" | "builtin" };

/** Web 接管的 pi builtin（名称与 pi 的 builtin 一致）。 */
export const WEB_SLASH_TAKEOVER_NAMES = ["new", "compact"] as const;

/** 菜单最多展示多少条：窄屏上一屏看得完，再长就用打字收窄。 */
export const WEB_SLASH_MAX_ITEMS = 20;

/** `/` 前必须是行首或空白，否则 `a/b`、`https://x` 里的斜杠会把菜单钉住。 */
function isBoundaryChar(text: string, index: number): boolean {
	if (index <= 0) return true;
	return /\s/.test(text[index - 1] ?? "");
}

/**
 * 识别光标所在的斜杠 token。
 *
 * 光标之后的内容不参与判定（选中命令时只替换 token 本身，用户可能已经在后面写了参数）。
 * query 里出现空白/另一个 `/` 即视为普通正文（例如「今天/明天」这种路径式写法）。
 */
export function detectWebSlashToken(text: string, caret: number): WebSlashToken | null {
	const position = Math.max(0, Math.min(caret, text.length));
	const before = text.slice(0, position);
	const start = before.lastIndexOf("/");
	if (start < 0) return null;
	const query = before.slice(start + 1);
	if (/[\s/]/.test(query)) return null;
	if (!isBoundaryChar(before, start)) return null;
	return { start, query };
}

/**
 * 过滤 + 排序：前缀命中优先于子串命中，其余保持输入顺序（权威命令表的顺序本身有意义：
 * 扩展 → 提示词 → 技能）。
 */
export function filterWebSlashItems(items: readonly WebSlashItem[], query: string): WebSlashItem[] {
	const keyword = query.trim().toLowerCase();
	const scored = items
		.map((item, index) => {
			const name = item.name.toLowerCase();
			const score = !keyword ? 0 : name.startsWith(keyword) ? 2 : name.includes(keyword) ? 1 : 0;
			return { item, index, score };
		})
		.filter((entry) => entry.score > 0 || !keyword)
		.sort((left, right) => right.score - left.score || left.index - right.index);
	return scored.slice(0, WEB_SLASH_MAX_ITEMS).map((entry) => entry.item);
}

/**
 * 把选中的命令写回草稿：替换 token（start→caret）为 `/名称 `，保留光标后的正文，
 * 光标落在插入文本末尾，用户可以直接补参数。
 */
export function applyWebSlashItem(text: string, caret: number, name: string): { text: string; caret: number } {
	const token = detectWebSlashToken(text, caret);
	const position = Math.max(0, Math.min(caret, text.length));
	const start = token?.start ?? position;
	const inserted = `/${name} `;
	return {
		text: `${text.slice(0, start)}${inserted}${text.slice(position)}`,
		caret: start + inserted.length,
	};
}

/** 去重：运行时命令表与本地发现的模板/技能可能同名，先到的（更权威）优先。 */
export function mergeWebSlashItems(lists: ReadonlyArray<ReadonlyArray<WebSlashItem>>): WebSlashItem[] {
	const seen = new Map<string, WebSlashItem>();
	for (const list of lists) {
		for (const item of list) {
			const key = item.name.toLowerCase();
			if (!seen.has(key)) seen.set(key, item);
		}
	}
	return [...seen.values()];
}

/**
 * 运行时命令 → 菜单条目（pi 的 get_commands 形状：name/description/source）。
 * builtin 命令不在 get_commands 里，由调用方单独拼。
 */
export function slashItemsFromCommands(commands: ReadonlyArray<{ name: string; description?: string; source?: string }>): WebSlashItem[] {
	return commands
		.filter((command) => typeof command.name === "string" && command.name.trim().length > 0)
		.map((command) => ({
			name: command.name.trim(),
			description: command.description ?? "",
			...(command.source === "prompt" || command.source === "skill" || command.source === "extension" ? { source: command.source } : {}),
		}));
}

/**
 * 草稿会话（还没有 runtime）的本地发现：pi 的提示词模板按模板名调用，技能是 `/skill:名称`。
 * 只在没有权威命令表时使用——运行时命令表一到就整体替换，不做合并（同名描述可能不一致）。
 */
export function slashItemsFromResources(prompts: ReadonlyArray<{ name: string; description?: string; enabled?: boolean }>, skills: ReadonlyArray<{ name: string; description?: string; enabled?: boolean }>): WebSlashItem[] {
	const items: WebSlashItem[] = [];
	for (const prompt of prompts) {
		const name = prompt.name?.trim();
		if (!name || prompt.enabled === false) continue;
		items.push({ name, description: prompt.description ?? "", source: "prompt" });
	}
	for (const skill of skills) {
		const name = skill.name?.trim();
		if (!name || skill.enabled === false) continue;
		items.push({ name: `skill:${name}`, description: skill.description ?? "", source: "skill" });
	}
	return items;
}
