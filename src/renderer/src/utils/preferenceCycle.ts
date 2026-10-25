/**
 * 模型 / 思考强度「循环切换」的纯策略。
 *
 * 背景：PiDeck 增加了两个快捷键（Ctrl+M / Ctrl+T，见 shared/shortcuts.ts），
 * 语义对齐 pi TUI 的 `app.model.cycleForward` 与 `app.thinking.cycle`：
 * - 模型：在「用户收藏」里环绕，不落到全量模型目录（pi 是 scoped models，PiDeck 用收藏）；
 * - 思考强度：在当前模型「可用档位」里环绕，遵循同一份能力表（选择器看到的档位）。
 *
 * 这里只做「下一个目标是谁」的纯计算，落盘/运行时应用由 hook 负责，便于 node --test 直接单测。
 */

import type { AvailableModel } from "../../../shared/types";

export type CycleDirection = "forward" | "backward";

/** 收藏项与目录模型的统一身份键（与 settings.favoriteModels 的存储格式一致）。 */
export function modelKey(provider: string, id: string): string {
	return `${provider}/${id}`;
}

/**
 * 收藏 → 可循环候选（顺序 = favoriteModels 的添加顺序）。
 *
 * 过滤三类「不在当前目录里」的收藏：模型已被重命名/删除、供应商被用户隐藏、
 * 模型被用户单独隐藏（后两者与选择器可见性同规则，DSH 无供应商/模型隐藏概念）。
 * 目录尚未加载完（models 为空）时结果自然为空。
 */
export function resolveFavoriteCycleCandidates(input: { favorites: readonly string[]; models: readonly AvailableModel[]; hiddenProviders?: readonly string[]; hiddenModels?: readonly string[]; backend?: "pi" | "dsh" }): AvailableModel[] {
	const hidden = new Set((input.backend ?? "pi") === "dsh" ? [] : (input.hiddenProviders ?? []));
	const hiddenModels = new Set((input.backend ?? "pi") === "dsh" ? [] : (input.hiddenModels ?? []));
	const byKey = new Map<string, AvailableModel>();
	for (const model of input.models) {
		if (!model?.provider || !model.id) continue;
		if (hidden.has(model.provider)) continue;
		const key = modelKey(model.provider, model.id);
		// 用户手动隐藏的模型不进循环（与选择器可见性同规则，DSH 无此概念）
		if (hiddenModels.has(key)) continue;
		if (!byKey.has(key)) byKey.set(key, model);
	}

	const seen = new Set<string>();
	const candidates: AvailableModel[] = [];
	for (const favorite of input.favorites) {
		const key = typeof favorite === "string" ? favorite.trim() : "";
		if (!key || seen.has(key)) continue;
		const model = byKey.get(key);
		if (!model) continue;
		seen.add(key);
		candidates.push(model);
	}
	return candidates;
}

/**
 * 环绕取下一个候选。
 *
 * 语义（相对 pi 的两处刻意偏差，理由是人类预期）：
 * - 当前模型不在候选里（例如用户切到了没收藏的模型）时，前进返回第一个、后退返回最后一个，
 *   pi 在这条路径上会前进到第二个（indexOf = -1 → 0 → 1）；
 * - 候选 <= 1 个时返回 undefined，由调用方给提示（对应 pi 的 "Only one model in scope"）。
 */
export function pickCycleTarget<T>(items: readonly T[], currentIndex: number, direction: CycleDirection = "forward"): T | undefined {
	if (items.length <= 1) return undefined;
	if (currentIndex < 0) return direction === "forward" ? items[0] : items[items.length - 1];
	const offset = direction === "forward" ? 1 : -1;
	return items[(currentIndex + offset + items.length) % items.length];
}

/** 在候选里找当前项；找不到返回 -1。 */
export function indexOfModelKey(candidates: readonly AvailableModel[], currentKey: string | undefined): number {
	if (!currentKey) return -1;
	return candidates.findIndex((model) => modelKey(model.provider, model.id) === currentKey);
}

/** 模型循环：返回下一个模型（`<= 1` 个候选时返回 undefined）。 */
export function pickCycleModel(input: { candidates: readonly AvailableModel[]; currentKey?: string; direction?: CycleDirection }): AvailableModel | undefined {
	return pickCycleTarget(input.candidates, indexOfModelKey(input.candidates, input.currentKey), input.direction);
}

/**
 * 思考档位循环：在「当前模型可用档位」里环绕（与选择器同一份档位表）。
 * 当前档位不在表内（模型能力变了 / 刚切完模型）时，前进取首档、后退取末档。
 */
export function pickCycleThinkingLevel(input: { levels: readonly { value: string }[]; current?: string; direction?: CycleDirection }): string | undefined {
	const values = input.levels.map((level) => level.value).filter((value): value is string => !!value);
	const currentIndex = input.current ? values.indexOf(input.current) : -1;
	return pickCycleTarget(values, currentIndex, input.direction);
}
