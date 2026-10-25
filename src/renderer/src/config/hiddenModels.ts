/**
 * AppSettings.hiddenModels（`provider/modelId` 条目）的统一读写工具。
 *
 * 为什么单独成模块：这个键格式有四个消费方——卡片眼睛按钮、供应商页的隐藏集合、
 * 保存前的孤儿清理、供应商改名时的替换写入；分散手拼前缀必然漂移。
 * 条目语义：只影响 PiDeck 自己的界面（会话模型选择器隐藏它、配置页折叠进「已隐藏模型」区），
 * 不删任何配置，也不写进 pi 的配置文件。
 */

import type { ProviderModelIdIndex } from "../../../shared/types/modelSpecs";

/** `provider/modelId` 键（provider 名不含 `/`，由 isValidProviderName 保证；模型 id 可含 `/`）。 */
export function hiddenModelKey(provider: string, modelId: string): string {
	return `${provider}/${modelId}`;
}

/** 取出某 provider 已隐藏的模型 id（保序去重）。 */
export function pickProviderHiddenIds(hiddenModels: readonly string[] | undefined, provider: string): string[] {
	if (!provider) return [];
	const prefix = `${provider}/`;
	const ids: string[] = [];
	for (const entry of hiddenModels ?? []) {
		if (!entry.startsWith(prefix)) continue;
		const modelId = entry.slice(prefix.length);
		if (modelId && !ids.includes(modelId)) ids.push(modelId);
	}
	return ids;
}

/** 单条切换（卡片眼睛按钮 / 「已隐藏模型」区的恢复按钮）。 */
export function toggleHiddenModelKey(hiddenModels: readonly string[], provider: string, modelId: string): string[] {
	const key = hiddenModelKey(provider, modelId);
	return hiddenModels.includes(key) ? hiddenModels.filter((entry) => entry !== key) : [...hiddenModels, key];
}

/**
 * 替换某 provider 的隐藏集合（供应商页确认时用）：其它 provider 的条目原样保留，
 * 该 provider 的条目换成传入的模型 id 列表。
 *
 * savedProvider ≠ finalProvider（供应商页里改了名）时旧名字下的条目一并清掉，
 * 所以不需要额外的改名迁移；页面里删掉的模型也不会把隐藏条目留成孤儿。
 */
export function replaceProviderHiddenIds(hiddenModels: readonly string[] | undefined, savedProvider: string, finalProvider: string, modelIds: readonly string[]): string[] {
	const savedPrefix = savedProvider ? `${savedProvider}/` : "";
	const next = (hiddenModels ?? []).filter((entry) => !(savedProvider && entry.startsWith(savedPrefix)));
	if (!finalProvider) return next;
	for (const modelId of modelIds) {
		if (!modelId) continue;
		const key = hiddenModelKey(finalProvider, modelId);
		if (!next.includes(key)) next.push(key);
	}
	return next;
}

/** 两条隐藏名单是否逐项相同（写盘前判断要不要真的写）。 */
export function sameHiddenModelEntries(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

/**
 * 清掉「provider 在 models.json 里、但模型 id 不在它的模型列表里」的孤儿条目（设置跟着模型走）。
 * 不在 modelIdsByProvider 表里的 provider 一律不碰：pi 内置 provider 的模型也能隐藏，
 * 而它们的 provider 并不写在用户的 models.json 里。
 */
export function pruneHiddenModelOrphans(hiddenModels: readonly string[], modelIdsByProvider: ProviderModelIdIndex): string[] {
	return hiddenModels.filter((entry) => {
		const slash = entry.indexOf("/");
		if (slash <= 0) return true;
		const known = modelIdsByProvider.get(entry.slice(0, slash));
		return !known || known.has(entry.slice(slash + 1));
	});
}
