import type { TpsDisplayMode } from "../../../shared/types/settings";
import { selectTokensPerSecond } from "../../../shared/tps";
import { t } from "../i18n";

/** 统计栏、上下文明细和轨迹共用数值、标签与统计范围说明。 */
export function buildTpsDisplay(mode: TpsDisplayMode, streaming: number | undefined, endToEnd: number | undefined, scope: "reply" | "session", precision = 0): { label: string; value: string; text: string; hint: string } {
	const value = selectTokensPerSecond(mode, streaming, endToEnd);
	const throughput = value == null ? "—" : value.toFixed(precision);
	return {
		label: t(mode === "endToEnd" ? "ctx.detail.endToEndTps" : "ctx.detail.streamingTps"),
		value: `${throughput} tok/s`,
		text: t(mode === "endToEnd" ? "composerStats.endToEndTps" : "composerStats.streamingTps", { throughput }),
		hint: t(mode === "endToEnd" ? (scope === "session" ? "ctx.detail.endToEndTpsAverageHint" : "ctx.detail.endToEndTpsHint") : scope === "session" ? "ctx.detail.tpsAverageHint" : "ctx.detail.tpsHint"),
	};
}
