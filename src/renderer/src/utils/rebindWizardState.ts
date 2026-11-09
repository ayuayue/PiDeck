import type { RemoteHostRebindOutcome, RemoteHostRebindSummary } from "../../../shared/types/remoteHost";

/**
 * Rebind 向导的状态机（设计 §3.2 的 5 步，纯函数，方便单测）。
 *
 * 为什么单独一个 reducer：向导里有三处最容易做错的地方——
 * 1. 改了来源/目标之后，旧的预检结果**必须**作废（否则会拿旧摘要去确认新状态）；
 * 2. 只有 `previewed` 才能进入确认页，只有确认页的 `approve` 才能进入执行；
 * 3. 失败停在当前步（不倒退、不假装成功），错误码只记稳定码。
 */
export type RebindWizardStep = "select" | "preview" | "confirm" | "running" | "result";

export type RebindWizardState = {
	readonly step: RebindWizardStep;
	readonly sourceHostId: string | null;
	readonly targetHostId: string | null;
	readonly summary: RemoteHostRebindSummary | null;
	readonly requestId: string | null;
	readonly outcome: RemoteHostRebindOutcome | null;
	readonly errorCode: string | null;
};

export type RebindWizardAction =
	| { readonly type: "select-source"; readonly hostId: string }
	| { readonly type: "select-target"; readonly hostId: string }
	/** 预检成功：摘要与一次性 requestId 必须来自同一次 main 调用。 */
	| { readonly type: "previewed"; readonly summary: RemoteHostRebindSummary; readonly requestId: string }
	| { readonly type: "failed"; readonly code: string }
	| { readonly type: "continue" }
	| { readonly type: "approved" }
	| { readonly type: "answered"; readonly outcome: RemoteHostRebindOutcome }
	| { readonly type: "reset" };

export const INITIAL_REBIND_WIZARD: RebindWizardState = {
	step: "select",
	sourceHostId: null,
	targetHostId: null,
	summary: null,
	requestId: null,
	outcome: null,
	errorCode: null,
};

/** 预检只对"当时那一对 host"有效：换任一端就丢掉摘要与 requestId（requestId 在 main 也会过期）。 */
function withPair(state: RebindWizardState, patch: { sourceHostId?: string | null; targetHostId?: string | null }): RebindWizardState {
	return { ...state, ...patch, step: "select", summary: null, requestId: null, outcome: null, errorCode: null };
}

export function reduceRebindWizard(state: RebindWizardState, action: RebindWizardAction): RebindWizardState {
	switch (action.type) {
		case "select-source":
			return action.hostId === state.sourceHostId ? state : withPair(state, { sourceHostId: action.hostId });
		case "select-target":
			return action.hostId === state.targetHostId ? state : withPair(state, { targetHostId: action.hostId });
		case "previewed":
			return { ...state, step: "preview", summary: action.summary, requestId: action.requestId, outcome: null, errorCode: null };
		case "failed":
			// 失败停在原步：select 的失败仍可重试，执行失败也不能回到"看起来没开始"。
			return { ...state, errorCode: action.code };
		case "continue":
			// 没有摘要就没有可确认的内容；拒绝非法跃迁而不是让 UI 转到一个空页面。
			return state.step === "preview" && state.summary !== null && state.requestId !== null ? { ...state, step: "confirm", errorCode: null } : state;
		case "approved":
			return state.step === "confirm" ? { ...state, step: "running", errorCode: null } : state;
		case "answered":
			return { ...state, step: "result", outcome: action.outcome, errorCode: null };
		case "reset":
			return INITIAL_REBIND_WIZARD;
	}
}
