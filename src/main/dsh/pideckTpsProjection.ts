/** DSH 会话 TPS 投影：框架负责全量日志重放/恢复，折叠只负责配对 token 和耗时。 */
import type { Context } from "@deepseek-ai/cordis";
import type { ProjectionDefinition } from "@deepseek-ai/dsh-session-projection";
import type { DshTpsProjection } from "../../shared/types/agent";
import { isDshTpsProjection } from "../../shared/tps";

type OpenStep = { turn: number; step: number; startedAt: number; firstTokenAt: number | null };
type DshTpsState = { totals: DshTpsProjection; openStep: OpenStep | null };
type TpsDefinition = ProjectionDefinition<"pideckTps"> & { wire: NonNullable<ProjectionDefinition<"pideckTps">["wire"]> };

declare module "@deepseek-ai/dsh-session-projection" {
	interface SessionProjectionMap {
		pideckTps: DshTpsProjection;
	}
	interface SessionProjectionStateMap {
		pideckTps: DshTpsState;
	}
}

/** Zod 从所选 DSH runtime 取：app 顶层为 Zod 3，registry 要求它自己的 Zod 4。 */
export interface DshTpsSchemaFactory {
	custom(check: (value: unknown) => value is DshTpsState): TpsDefinition["stateSchema"];
	custom(check: (value: unknown) => value is DshTpsProjection): TpsDefinition["wire"]["viewSchema"];
}

/** 持久化 checkpoint 必须保留未完成步骤，非法缓存交由 registry 丢弃重放。 */
function isDshTpsState(value: unknown): value is DshTpsState {
	if (typeof value !== "object" || value === null || !("totals" in value) || !isDshTpsProjection(value.totals) || !("openStep" in value)) return false;
	const open = value.openStep;
	if (open === null) return true;
	if (typeof open !== "object" || open === null) return false;
	const validIndex = (field: unknown) => typeof field === "number" && Number.isSafeInteger(field) && field >= 0;
	const validTime = (field: unknown) => typeof field === "number" && Number.isFinite(field) && field >= 0;
	return "turn" in open && validIndex(open.turn) && "step" in open && validIndex(open.step) && "startedAt" in open && validTime(open.startedAt) && "firstTokenAt" in open && (open.firstTokenAt === null || validTime(open.firstTokenAt));
}

/** 依赖注入避免在主进程 bundle 顶层加载 DSH；注册效应随 host plugin fiber 清理。 */
export function createDshTpsPlugin(schema: DshTpsSchemaFactory, firstTokenTime: typeof import("@deepseek-ai/dsh-llm").assistantStreamFirstTokenTime) {
	const definition: TpsDefinition = {
		key: "pideckTps",
		stateVersion: 1,
		stateSchema: schema.custom(isDshTpsState),
		init: () => ({ totals: { streamingTokens: 0, streamingMs: 0, endToEndTokens: 0, endToEndMs: 0 }, openStep: null }),
		apply(state, event) {
			if (event.type === "step/start") {
				return { ...state, openStep: { turn: event.data.turn, step: event.data.step, startedAt: event.time, firstTokenAt: null } };
			}
			const open = state.openStep;
			if (!open) return state;
			if (event.type === "step/end" || event.type === "turn/end") return { ...state, openStep: null };
			if ((event.type !== "assistant/attempt" && event.type !== "assistant/message") || event.data.turn !== open.turn || event.data.step !== open.step) return state;
			if (event.type === "assistant/attempt") {
				if (open.firstTokenAt !== null) return state;
				const firstTokenAt = firstTokenTime(event.data.stream);
				if (firstTokenAt === undefined || !Number.isFinite(firstTokenAt) || firstTokenAt < open.startedAt) return state;
				return { ...state, openStep: { ...open, firstTokenAt } };
			}
			// usage 只取最终 assistant/message；失败尝试没有独立 token 分子。重试沿用
			// 当前 step 起点和第一次有效 delta，与官方 sessionStats 的 step 边界一致。
			const output = event.data.usage?.outputTokens;
			if (typeof output !== "number" || !Number.isFinite(output) || output < 0) return { ...state, openStep: null };
			const endToEndMs = event.time - open.startedAt;
			// 部分历史日志没有 assistant/attempt，最终 message 仍保留完整 stream。
			const firstTokenAt = open.firstTokenAt ?? firstTokenTime(event.data.stream);
			const streamingMs = firstTokenAt !== undefined && Number.isFinite(firstTokenAt) && firstTokenAt >= open.startedAt ? event.time - firstTokenAt : undefined;
			const includeEndToEnd = Number.isFinite(endToEndMs) && endToEndMs > 0;
			const includeStreaming = streamingMs !== undefined && Number.isFinite(streamingMs) && streamingMs > 0;
			if (!includeEndToEnd && !includeStreaming) return { ...state, openStep: null };
			return {
				totals: {
					streamingTokens: state.totals.streamingTokens + (includeStreaming ? output : 0),
					streamingMs: state.totals.streamingMs + (includeStreaming ? streamingMs : 0),
					endToEndTokens: state.totals.endToEndTokens + (includeEndToEnd ? output : 0),
					endToEndMs: state.totals.endToEndMs + (includeEndToEnd ? endToEndMs : 0),
				},
				openStep: null,
			};
		},
		wire: { viewSchema: schema.custom(isDshTpsProjection), view: (state) => state.totals },
	};
	return {
		name: "pideck-tps",
		inject: ["sessionProjections"],
		apply(ctx: Context): void {
			ctx.sessionProjections.register(definition);
		},
	};
}
