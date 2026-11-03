import { opFailFromCode, opOk } from "../../../shared/op";
import type { RemoteProjectDownloadResult, RemoteProjectUploadResult } from "../../../shared/types/remoteHost";
import type { RemoteTransferEvent, RemoteTransferSettlementResult, RemoteTransferSettledEvent, RemoteTransferStartInput, RemoteTransferUploadResult } from "../../../shared/types/remoteTransfers";
import type { ProjectFileTarget, ProjectFileTransferOptions, ProjectFileUploadSource, ProjectServicesApi } from "./projectServiceContracts";

const STABLE = /^[A-Z][A-Z0-9_]{2,63}$/;
const JOB_ID = /^[A-Za-z0-9_-]{16,128}$/;

type StartSettlement = { readonly kind: "canceled" } | { readonly kind: "failure"; readonly code: string; readonly outcome: "rejected" | "unknown" } | { readonly kind: "settled"; readonly event: RemoteTransferSettledEvent };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableCode(value: unknown): value is string {
	return typeof value === "string" && STABLE.test(value);
}

function readEvent(value: unknown): RemoteTransferEvent | undefined {
	if (!isRecord(value) || typeof value.jobId !== "string" || !JOB_ID.test(value.jobId) || (value.operation !== "upload" && value.operation !== "download")) return undefined;
	if (value.kind === "progress") {
		if (!Number.isSafeInteger(value.transferred) || !Number.isSafeInteger(value.total) || (value.transferred as number) < 0 || (value.total as number) < 0 || (value.transferred as number) > (value.total as number)) return undefined;
		return {
			kind: "progress",
			jobId: value.jobId,
			operation: value.operation,
			transferred: value.transferred as number,
			total: value.total as number,
		};
	}
	if (value.kind !== "settled") return undefined;
	if (value.outcome === "succeeded") {
		if (value.result === undefined) return undefined;
		return { kind: "settled", jobId: value.jobId, operation: value.operation, outcome: "succeeded", result: value.result as RemoteTransferSettlementResult };
	}
	if ((value.outcome === "failed" || value.outcome === "cancelled" || value.outcome === "unknown") && stableCode(value.code)) {
		return { kind: "settled", jobId: value.jobId, operation: value.operation, outcome: value.outcome, code: value.code };
	}
	return undefined;
}

function notify<T>(callback: ((event: T) => void) | undefined, event: T): void {
	try {
		callback?.(event);
	} catch {
		// Renderer observers drive presentation only; they cannot change the job state machine.
	}
}

/**
 * Subscribe before start so a remote job that settles before the invoke reply
 * cannot lose its terminal frame. Events that arrive before the opaque job id
 * is known are buffered, then matched by that id.
 */
async function startAndWait(api: ProjectServicesApi, input: RemoteTransferStartInput, options: ProjectFileTransferOptions = {}): Promise<StartSettlement> {
	const signal = options.signal;
	if (signal?.aborted) return { kind: "canceled" };
	let started: { jobId: string; operation: "upload" | "download" } | undefined;
	const buffered: RemoteTransferEvent[] = [];
	let wake: ((event: RemoteTransferSettledEvent) => void) | undefined;
	let startCanceled = false;
	let startFailure: { code: string; outcome: "rejected" | "unknown" } | undefined;
	let cancelRequested = false;
	let cancelSent = false;
	let closed = false;

	const settle = (event: RemoteTransferSettledEvent | undefined): void => {
		const fn = wake;
		wake = undefined;
		if (fn !== undefined && event !== undefined) fn(event);
	};
	const requestCancel = (): void => {
		cancelRequested = true;
		if (started === undefined || cancelSent || closed) return;
		cancelSent = true;
		try {
			void api.remoteTransfers.cancel(input.projectId, started.jobId).catch(() => {});
		} catch {
			// The settlement event remains authoritative if the cancel invoke itself fails.
		}
	};
	const unsubscribe = api.remoteTransfers.onEvent((raw) => {
		const event = readEvent(raw);
		if (event === undefined) return;
		if (started === undefined) {
			buffered.push(event);
			return;
		}
		if (event.jobId !== started.jobId || event.operation !== started.operation) return;
		if (event.kind === "progress") {
			notify(options.onProgress, { operation: event.operation, transferred: event.transferred, total: event.total });
			return;
		}
		settle(event);
	});
	const onAbort = (): void => requestCancel();
	signal?.addEventListener("abort", onAbort, { once: true });
	const cleanup = (): void => {
		closed = true;
		signal?.removeEventListener("abort", onAbort);
		unsubscribe();
	};

	try {
		let receipt: Awaited<ReturnType<ProjectServicesApi["remoteTransfers"]["start"]>>;
		try {
			receipt = await api.remoteTransfers.start(input);
		} catch (error) {
			throw error;
		}
		if (!receipt.ok) {
			startFailure = { code: receipt.code, outcome: receipt.outcome };
		} else if (receipt.value.canceled === true) {
			startCanceled = true;
		} else {
			started = { jobId: receipt.value.jobId, operation: input.operation };
			if (receipt.value.operation !== input.operation) {
				startFailure = { code: "REMOTE_TRANSFER_RESULT_INVALID", outcome: "rejected" };
				requestCancel();
			} else {
				notify(options.onStarted, { operation: started.operation, total: receipt.value.total });
				let early: RemoteTransferSettledEvent | undefined;
				for (const event of buffered) {
					if (event.jobId !== started.jobId || event.operation !== started.operation) continue;
					if (event.kind === "progress") notify(options.onProgress, { operation: event.operation, transferred: event.transferred, total: event.total });
					else early ??= event;
				}
				if (early !== undefined) {
					return { kind: "settled", event: early };
				}
				if (cancelRequested || signal?.aborted) requestCancel();
			}
		}

		if (startCanceled) {
			return { kind: "canceled" };
		}
		if (startFailure !== undefined) {
			return { kind: "failure", ...startFailure };
		}

		const event = await new Promise<RemoteTransferSettledEvent>((resolve) => {
			wake = resolve;
		});
		return { kind: "settled", event };
	} catch (error) {
		throw error;
	} finally {
		cleanup();
	}
}

function readUploadResult(value: unknown): RemoteTransferUploadResult | undefined {
	if (!isRecord(value) || !Array.isArray(value.uploaded) || !Array.isArray(value.failed)) return undefined;
	const uploaded: Array<{ name: string; bytes: number }> = [];
	const failed: Array<{ name: string; code: string }> = [];
	for (const item of value.uploaded) {
		if (!isRecord(item) || typeof item.name !== "string" || !Number.isSafeInteger(item.bytes) || (item.bytes as number) < 0) return undefined;
		uploaded.push({ name: item.name, bytes: item.bytes as number });
	}
	for (const item of value.failed) {
		if (!isRecord(item) || typeof item.name !== "string" || !stableCode(item.code)) return undefined;
		failed.push({ name: item.name, code: item.code });
	}
	return { uploaded, failed };
}

function readDownloadResult(value: unknown): { path: string; bytes: number } | undefined {
	if (!isRecord(value) || typeof value.path !== "string" || value.path.length === 0 || !Number.isSafeInteger(value.bytes) || (value.bytes as number) < 0) return undefined;
	return { path: value.path, bytes: value.bytes as number };
}

export async function uploadThroughRemoteTransfer(api: ProjectServicesApi, projectId: string, target: ProjectFileTarget, source: ProjectFileUploadSource, options: ProjectFileTransferOptions = {}): Promise<RemoteProjectUploadResult> {
	const settlement = await startAndWait(api, { operation: "upload", projectId, targetRelativePath: target.relativePath, source }, options);
	if (settlement.kind === "canceled") return opOk({ canceled: true });
	if (settlement.kind === "failure") return { ok: false, code: settlement.code, outcome: settlement.outcome };
	if (settlement.event.outcome !== "succeeded") return opFailFromCode(settlement.event.code);
	const result = readUploadResult(settlement.event.result);
	if (result === undefined) return opFailFromCode("REMOTE_TRANSFER_RESULT_INVALID");
	return opOk(result);
}

export async function downloadThroughRemoteTransfer(api: ProjectServicesApi, projectId: string, target: ProjectFileTarget, options: ProjectFileTransferOptions = {}): Promise<RemoteProjectDownloadResult> {
	const settlement = await startAndWait(api, { operation: "download", projectId, targetRelativePath: target.relativePath }, options);
	if (settlement.kind === "canceled") return opOk({ canceled: true });
	if (settlement.kind === "failure") return { ok: false, code: settlement.code, outcome: settlement.outcome };
	if (settlement.event.outcome !== "succeeded") return opFailFromCode(settlement.event.code);
	const result = readDownloadResult(settlement.event.result);
	if (result === undefined) return opFailFromCode("REMOTE_TRANSFER_RESULT_INVALID");
	return opOk(result);
}
