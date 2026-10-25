import { createSessionModelPreference } from "../../shared/modelDisplayName";
import type { SessionModelPreference } from "../../shared/types";

/**
 * DSH 会话模型真值补录（host 会话投影 → catalog）。
 *
 * 为什么需要：PiDeck 的 `SessionRecord.model` 只在用户「通过 PiDeck 改模型」时写入
 * （SessionRuntimeCoordinator.setRuntimeModel → catalog.update）。历史/外部 DSH 会话的
 * 模型只存在 host 会话投影 `modelSelection.next ?? lastUsed` 里；catalog 缺 model 时
 * 底栏回退「部署默认模型」这个全局单值——线上案例：会话实际 magpie/group/free，
 * 底栏却显示部署默认 magpie/group/auto，用户表现为「改了一个会话，其他会话的模型
 * 显示也跟着变」。打开会话读历史时用本模块把 host 真值补回 catalog。
 *
 * 只读数据面：不激活会话、不写 host（host 投影是官方持久化结果）。
 */

/** host 会话投影给出的当前模型选择（`modelSelection.next ?? lastUsed`）。 */
export type DshHostModelSelection = {
	provider: string;
	model: string;
	reasoningEffort?: string;
};

/** catalog 补录补丁（只含缺失字段，直接交给 SessionCatalog.update）。 */
export type DshSessionModelPatch = {
	model?: SessionModelPreference;
	thinkingLevel?: string;
};

/**
 * 由 host 会话当前选择推导 catalog 补丁。
 *
 * 只补缺失字段：用户通过 PiDeck 显式选过（或曾由本逻辑补录过）的值不覆盖——host 侧
 * `lastUsed` 可能只是旧值，不能反向覆盖用户意图。selection 缺失（会话从未选过模型 /
 * host 未就绪）时返回 undefined，让底栏继续按部署默认展示。
 */
export function dshSessionModelPatch(entry: { model?: { provider?: string; modelId?: string }; thinkingLevel?: string } | undefined, selection: DshHostModelSelection | undefined): DshSessionModelPatch | undefined {
	if (!entry || !selection) return undefined;
	const patch: DshSessionModelPatch = {};
	if (!entry.model?.provider || !entry.model.modelId) {
		patch.model = createSessionModelPreference(selection.provider, selection.model, undefined);
	}
	if (!entry.thinkingLevel && selection.reasoningEffort) {
		patch.thinkingLevel = selection.reasoningEffort;
	}
	return patch.model || patch.thinkingLevel !== undefined ? patch : undefined;
}
