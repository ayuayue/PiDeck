/** ACP permissions own their deferred RPC responses, UI identities and paired expiry timers. */
import type { AgentUiResponse } from "../../shared/types/agent";
import type { AcpPermissionOption, AcpPermissionOutcome, AcpPermissionResult, AcpRpcId } from "./acpProtocol";
import { ACP_DEFER_RESPONSE, type AcpConnection } from "./AcpConnection";

const PERMISSION_TIMEOUT_MS = 10 * 60_000;
const CANCELLED: AcpPermissionResult = { outcome: { outcome: "cancelled" } };
const PERMISSION_KINDS = new Set(["allow_once", "allow_always", "reject_once", "reject_always"]);

type PermissionUiEvent = { requestId: string } & ({ method: "select"; title: string; options: string[]; allowOther: false } | { completed: true });
type PendingPermission = { rpcId: AcpRpcId; optionsByLabel: Map<string, string>; timer: NodeJS.Timeout };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPermissionOption(value: unknown): value is AcpPermissionOption {
	return isRecord(value) && typeof value.optionId === "string" && value.optionId.length > 0 && typeof value.name === "string" && typeof value.kind === "string" && PERMISSION_KINDS.has(value.kind);
}

/** UI only exposes string labels; disambiguate them without substituting kind for the wire optionId. */
function permissionLabels(options: readonly AcpPermissionOption[]): Map<string, string> {
	const counts = new Map<string, number>();
	for (const option of options) counts.set(option.name, (counts.get(option.name) ?? 0) + 1);
	const labels = new Map<string, string>();
	for (const option of options) {
		const base = option.name || option.optionId;
		const candidate = (counts.get(option.name) ?? 0) > 1 ? `${base} (${option.optionId})` : base;
		let label = candidate;
		let suffix = 2;
		while (labels.has(label)) label = `${candidate} (${suffix++})`;
		labels.set(label, option.optionId);
	}
	return labels;
}

/** Session-local permission owner; every pending entry has one terminal response and one UI withdrawal. */
export class AcpPermissionRequests {
	private readonly pending = new Map<string, PendingPermission>();
	private nextRequestId = 0;

	constructor(
		private readonly conn: AcpConnection,
		private readonly emit: (event: PermissionUiEvent) => void,
		private readonly timeoutMs = PERMISSION_TIMEOUT_MS,
	) {}

	/** Malformed/foreign requests are answered immediately; valid ones defer until selection, cancel or expiry. */
	request(params: unknown, rpcId: AcpRpcId, sessionId: string, cancelling: boolean): AcpPermissionResult | typeof ACP_DEFER_RESPONSE {
		if (cancelling || !isRecord(params) || params.sessionId !== sessionId || !isRecord(params.toolCall) || typeof params.toolCall.toolCallId !== "string" || !params.toolCall.toolCallId || !Array.isArray(params.options) || params.options.length === 0 || !params.options.every(isPermissionOption)) return CANCELLED;
		if (new Set(params.options.map((option) => option.optionId)).size !== params.options.length) return CANCELLED;
		const requestId = `acp-ask-${++this.nextRequestId}`;
		const optionsByLabel = permissionLabels(params.options);
		const timer = setTimeout(() => this.finish(requestId, { outcome: "cancelled" }), this.timeoutMs);
		timer.unref?.();
		this.pending.set(requestId, { rpcId, optionsByLabel, timer });
		this.emit({ requestId, method: "select", title: typeof params.toolCall.title === "string" && params.toolCall.title ? params.toolCall.title : params.toolCall.toolCallId, options: [...optionsByLabel.keys()], allowOther: false });
		return ACP_DEFER_RESPONSE;
	}

	/** Map a UI label back to the original ACP optionId; unknown values fail closed. */
	respond(requestId: string, response: AgentUiResponse): boolean {
		const pending = this.pending.get(requestId);
		if (!pending) return false;
		const optionId = typeof response.value === "string" ? pending.optionsByLabel.get(response.value) : undefined;
		this.finish(requestId, !response.cancelled && optionId !== undefined ? { outcome: "selected", optionId } : { outcome: "cancelled" });
		return true;
	}

	/** Abort, stop and connection failure share the same idempotent cleanup path. */
	cancelAll(): void {
		for (const requestId of this.pending.keys()) this.finish(requestId, { outcome: "cancelled" });
	}

	/** 回合 stall 看门狗用：审批挂起 = agent 合法等待用户输入，不算挂死。 */
	hasPending(): boolean {
		return this.pending.size > 0;
	}

	private finish(requestId: string, outcome: AcpPermissionOutcome): void {
		const pending = this.pending.get(requestId);
		if (!pending) return;
		this.pending.delete(requestId);
		clearTimeout(pending.timer);
		this.conn.respond(pending.rpcId, { outcome });
		this.emit({ requestId, completed: true });
	}
}
