import type { RuntimePromptTemplate } from "../../../shared/types/prompts";
import { parseArgumentHint, type PromptTemplateInfo } from "../composerBehavior";

/**
 * 输入框模板表的来源合并（用户目录/项目目录 ∪ pi 运行时模板）。
 *
 * 为什么需要两份来源：
 * - 来源 A（`prompts:list` / `listByProject`）覆盖 `~/.pi/agent/prompts` 与 `<项目>/.pi/prompts`，
 *   带 description / path / enabled 等编辑元数据，离线可用。
 * - 来源 B（pi `get_commands` 的 `source: "prompt"` 条目 + 按路径读回的正文）覆盖 **pi 实际
 *   加载的全部模板**，包括已安装 npm 包声明的 `pi.prompts`（如 pi-subagents 的
 *   `parallel-review`），这部分 A 看不到。
 *
 * 合并规则：
 * 1. 同名时**正文取 B**——B 是 pi 去重后的最终视图，用它展开才与 pi 的行为一致；
 *    A 的展示元数据（description/path/enabled）继续沿用，避免菜单里丢描述。
 * 2. B 独有条目追加在后，description 用 pi 给的命令描述，`path` 留空（不可编辑）。
 * 3. 顺序：A 原有顺序不变，B 新增项按 pi 的命令表顺序追加。
 */
/**
 * 合并「项目模板 + 全局模板」，复刻 pi 的加载优先级。
 *
 * pi 侧事实（`dist/core/resource-loader.js`）：
 * - 资源路径按 `resourcePrecedenceRank` 升序加载：project = 0 < user(global) = 2 < package = 4 < builtin = 5；
 * - `dedupePrompts` 按 **名字** 去重，**先加载者胜** → 同名时项目模板赢；
 * - 被禁用的模板（settings 的 prompts 规则）根本不会被加载。
 *
 * 所以这里做三件事，顺序不能换：
 * 1. 先剔除 `enabled === false`（项目里禁用 → 回到全局那份，而不是直接消失）；
 * 2. 按「项目在前、全局在后」排列（与 pi 的 rank 顺序一致，读代码就能对上）；
 * 3. 按名字去重，保留先出现的那份（项目胜）。
 *
 * 为什么不直接按「数组里最后一个胜」：那是隐式约定，且与 pi 的「先到先得」相反，
 * 改一行顺序就会静默换掉用户实际用的模板正文。
 */
export function assembleTemplates(sources: { project?: readonly PromptTemplateInfo[]; global?: readonly PromptTemplateInfo[] }): PromptTemplateInfo[] {
	const ordered = [...(sources.project ?? []), ...(sources.global ?? [])];
	const seen = new Set<string>();
	const assembled: PromptTemplateInfo[] = [];
	for (const template of ordered) {
		if (!template.name) continue;
		// pi 不加载被禁用的模板：它既不能出现在菜单里，也不该被 `/名称` 展开
		if (template.enabled === false) continue;
		if (seen.has(template.name)) continue;
		seen.add(template.name);
		assembled.push(template);
	}
	return assembled;
}

export function mergeRuntimeTemplates(base: PromptTemplateInfo[], runtime: readonly RuntimePromptTemplate[]): PromptTemplateInfo[] {
	if (runtime.length === 0) return base;
	const runtimeByName = new Map(runtime.map((template) => [template.name, template]));
	const merged = base.map((template) => {
		const override = runtimeByName.get(template.name);
		if (!override) return template;
		runtimeByName.delete(template.name);
		// 正文以 pi 的为准；描述缺失时保留 A 的，避免已配置的说明被空串覆盖
		return {
			...template,
			content: override.content,
			description: template.description || override.description || "",
		};
	});
	for (const template of runtimeByName.values()) {
		merged.push({
			name: template.name,
			// 包带模板不在 PiDeck 的可编辑目录里，path 留空表示「不可编辑」
			path: "",
			description: template.description ?? "",
			content: template.content,
			argumentHint: parseArgumentHint(template.content),
		});
	}
	return merged;
}
