/**
 * `defaultTools` 语义的纯函数实现（逐条复刻 pi 0.99 settings-manager.js 的
 * resolveDefaultTools / mergeDefaultTools），供设置页与项目资源页使用。
 * 放 shared 以便 node 单测直接加载（零 React / 零 Electron 依赖）。
 *
 * pi 语义（0.99 settings.md#tools）：
 * - 无 `+`/`-` 前缀的条目 = 裸名字，整体替换内置默认集；
 * - `+name` 加、`-name` 删，按列表顺序应用；
 * - 空数组：本层解析为空选择；只有 `+`/`-` 的列表 = 在继承（用户/项目两层合并后）的选择上增量修改。
 *
 * 跨层细节（0.99.2 InMemorySettingsStorage 实测，见计划 1.3）：
 * - 全局 `[]` + 项目 `["+codemode"]` → 默认四工具 + codemode（并入默认集，不是并入空集）；
 * - 全局 `["read"]` + 项目 `[]` → `["read"]`（空 modifier 列表等于不变）；
 * - 全局未设置 + 项目 `[]` → `[]`（空数组本身是「空选择」）。
 * 因此本模块不直接拼 token，而是「生成候选 → 用同一套合并/解析逻辑回验」，
 * 保证 UI 选择的集合就是保存后 pi 解析出的集合。
 */

/** pi 内置默认工具集（dist/core/settings-manager.js DEFAULT_TOOL_NAMES）。 */
export const PI_DEFAULT_TOOL_NAMES = ["read", "bash", "edit", "write"] as const;

/** 设置页工具选择器暴露的完整工具目录（内置工具 + 内置扩展工具）。 */
export const TOOL_CATALOG: Array<{ name: string; group: "builtin" | "extension" }> = [
	{ name: "read", group: "builtin" },
	{ name: "bash", group: "builtin" },
	{ name: "powershell", group: "builtin" },
	{ name: "edit", group: "builtin" },
	{ name: "write", group: "builtin" },
	{ name: "grep", group: "builtin" },
	{ name: "find", group: "builtin" },
	{ name: "ls", group: "builtin" },
	{ name: "codemode", group: "extension" },
	{ name: "tool_search", group: "extension" },
];

function isToolModifier(entry: string): boolean {
	return entry.startsWith("+") || entry.startsWith("-");
}

/** 合并两层 defaultTools：覆盖层只有增量时叠加，否则整体替换（与 pi mergeDefaultTools 一致）。 */
export function mergeDefaultTools(base: readonly string[] | undefined, overrides: readonly string[] | undefined): string[] | undefined {
	if (overrides === undefined) return base === undefined ? undefined : [...base];
	if (!Array.isArray(base) || !overrides.every(isToolModifier)) return [...overrides];
	return [...base, ...overrides];
}

/** 解析 defaultTools 列表为实际生效的工具集（与 pi resolveDefaultTools 一致）。 */
export function resolveDefaultTools(entries: readonly string[] | undefined): string[] {
	if (entries === undefined) return [...PI_DEFAULT_TOOL_NAMES];
	const plain = entries.filter((entry) => !isToolModifier(entry));
	const tools = plain.length > 0 || entries.length === 0 ? [...plain] : [...PI_DEFAULT_TOOL_NAMES];
	for (const entry of entries) {
		if (!isToolModifier(entry)) continue;
		const name = entry.slice(1);
		const index = tools.indexOf(name);
		if (entry.startsWith("+") && index === -1 && name) tools.push(name);
		else if (entry.startsWith("-") && index !== -1) tools.splice(index, 1);
	}
	return tools;
}

/**
 * 解析某一层合并后的生效工具集。
 * `baseEntries` 是该层之下的原始值（全局层不传；项目层传全局原始数组）。
 */
export function resolveDefaultToolsInLayer(baseEntries: readonly string[] | undefined, entries: readonly string[] | undefined): string[] {
	return resolveDefaultTools(mergeDefaultTools(baseEntries, entries));
}

/** 目标工具在该层合并后是否生效。 */
export function isToolEnabledInLayer(baseEntries: readonly string[] | undefined, entries: readonly string[] | undefined, name: string): boolean {
	return resolveDefaultToolsInLayer(baseEntries, entries).includes(name);
}

/** 目标工具在当前（单层）配置下是否生效；等价于全局层查询。 */
export function isToolEnabled(entries: readonly string[] | undefined, name: string): boolean {
	return isToolEnabledInLayer(undefined, entries, name);
}

function sameToolSet(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((name, index) => name === right[index]);
}

/** 相对 `from` 得到 `to` 所需的增量 token（删除在前、新增在后）。 */
function diffModifiers(from: readonly string[], to: readonly string[]): string[] {
	const modifiers: string[] = [];
	for (const name of from) if (!to.includes(name)) modifiers.push(`-${name}`);
	for (const name of to) if (!from.includes(name)) modifiers.push(`+${name}`);
	return modifiers;
}

/**
 * 把「期望的最终工具集合」编码回某一层的原始 defaultTools 值。
 *
 * 候选按「改动最小」排序逐个回验，只有 `resolveDefaultToolsInLayer(base, candidate)`
 * 恰好等于 `selection` 才采用；最后用裸名列表兜底（裸名列表在两层都精确等于选择集）。
 * 返回 `undefined` 表示删除该层键（回到继承/默认）。
 */
export function encodeDefaultToolsSelection(options: { baseEntries?: readonly string[] | undefined; entries?: readonly string[] | undefined; selection: readonly string[] }): string[] | undefined {
	const { baseEntries, entries } = options;
	const selection = [...options.selection];
	const resolvesTo = (candidate: readonly string[] | undefined) => sameToolSet(resolveDefaultToolsInLayer(baseEntries, candidate), selection);

	// 当前值已经表达目标（含用户手写的未知工具/排序）时不改写。
	if (resolvesTo(entries)) return entries === undefined ? undefined : [...entries];
	// 删除键 = 回到继承值/pi 默认；精确命中时优先，保持配置干净。
	if (resolvesTo(undefined)) return undefined;

	const current = resolveDefaultToolsInLayer(baseEntries, entries);
	const changed = new Set([...current.filter((name) => !selection.includes(name)), ...selection.filter((name) => !current.includes(name))]);
	const kept = (entries ?? []).filter((entry) => !changed.has(isToolModifier(entry) ? entry.slice(1) : entry));
	const diff = diffModifiers(current, selection);

	const candidates: Array<readonly string[] | undefined> = [kept, [...kept, ...diff], diff, selection];
	for (const candidate of candidates) {
		if (resolvesTo(candidate)) return candidate === undefined ? undefined : [...candidate];
	}
	return selection;
}

/**
 * 开关一个工具并返回该层新的 defaultTools 值。
 * 与 `encodeDefaultToolsSelection` 共用回验，显式空选择后只开一个工具不会意外带回默认工具。
 */
export function setToolEnabled(options: { baseEntries?: readonly string[] | undefined; entries?: readonly string[] | undefined; name: string; on: boolean }): string[] | undefined {
	const current = resolveDefaultToolsInLayer(options.baseEntries, options.entries);
	const selection = options.on ? (current.includes(options.name) ? current : [...current, options.name]) : current.filter((name) => name !== options.name);
	return encodeDefaultToolsSelection({ baseEntries: options.baseEntries, entries: options.entries, selection });
}

/** 列表是否显式为「禁用全部内置工具」（空数组）。 */
export function defaultToolsDisablesAll(entries: readonly string[] | undefined): boolean {
	return Array.isArray(entries) && entries.length === 0;
}

/**
 * 合并 codemode 子设置：只改 patch 里明确给出的键，保留未知嵌套字段。
 * - 值为 undefined = 删除该键；
 * - 合并后对象为空 = 删除整个 `codemode` 键（避免落盘 `codemode: {}` 脏数据）；
 * - 返回 undefined 表示从 settings 中移除该键。
 */
export function mergeCodemodeSetting(existing: unknown, patch: { mode?: string | undefined; inlineBudget?: number | undefined }): Record<string, unknown> | undefined {
	const next: Record<string, unknown> = existing && typeof existing === "object" && !Array.isArray(existing) ? { ...(existing as Record<string, unknown>) } : {};
	for (const [key, value] of Object.entries(patch)) {
		if (value === undefined) delete next[key];
		else next[key] = value;
	}
	return Object.keys(next).length > 0 ? next : undefined;
}

/** 校验并规范化 mode 输入；非法值返回 undefined（表示不改写该键）。 */
export function normalizeCodemodeMode(value: unknown): "on" | "only" | undefined {
	return value === "on" || value === "only" ? value : undefined;
}

/** 校验并规范化 inlineBudget 输入；非负整数才有效，0 必须保留。 */
export function normalizeCodemodeInlineBudget(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}
