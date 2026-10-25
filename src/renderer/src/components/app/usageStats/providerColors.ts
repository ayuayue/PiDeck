/**
 * provider 可视化色板（用量图表共享）。
 * 与统计语义无关，仅数据可视化区分；不足时循环取色。
 */

const PROVIDER_COLORS = ["rgba(74,158,255,0.85)", "rgba(74,222,128,0.85)", "rgba(251,146,60,0.85)", "rgba(232,121,249,0.85)", "rgba(250,204,21,0.85)", "rgba(52,211,153,0.85)", "rgba(167,139,250,0.85)", "rgba(248,113,113,0.85)"];

/** provider 稳定取色（按名称哈希取色板下标，同一 provider 跨图表颜色一致）。 */
export function colorForProvider(provider: string): string {
	let hash = 0;
	for (let i = 0; i < provider.length; i++) {
		hash = (hash * 31 + provider.charCodeAt(i)) >>> 0;
	}
	return PROVIDER_COLORS[hash % PROVIDER_COLORS.length];
}

/** 按出现顺序取色（旧图表逻辑：index 取模）。 */
export function colorFor(index: number): string {
	return PROVIDER_COLORS[index % PROVIDER_COLORS.length];
}
