import { randomBytes } from "node:crypto";

/**
 * Main-process ownership table for one-shot project transfers.
 *
 * A job id is random and opaque: it never encodes a path, host or sender. Cancellation only
 * aborts the worker; the worker still owns settlement after its process and temporary files
 * have been reaped. Closing a sender/project makes that worker unable to publish a late event.
 */

export const REMOTE_PROJECT_TRANSFER_CODES = {
	inputInvalid: "REMOTE_TRANSFER_INPUT_INVALID",
	jobIdCollision: "REMOTE_TRANSFER_JOB_ID_COLLISION",
	cancelled: "REMOTE_TRANSFER_CANCELLED",
} as const;

export type RemoteProjectTransferOperation = "upload" | "download";

export type RemoteProjectTransferScope = {
	readonly senderId: number;
	readonly projectId: string;
	readonly hostId: string;
	readonly canonicalRoot: string;
	readonly connectionId: string;
	readonly hostRevision: number;
};

export type RemoteProjectTransferProgress = {
	readonly jobId: string;
	readonly operation: RemoteProjectTransferOperation;
	readonly transferred: number;
	readonly total: number;
};

export type RemoteProjectTransferSettlement =
	| {
			readonly jobId: string;
			readonly operation: RemoteProjectTransferOperation;
			readonly outcome: "succeeded";
			readonly result?: unknown;
	  }
	| {
			readonly jobId: string;
			readonly operation: RemoteProjectTransferOperation;
			readonly outcome: "failed" | "cancelled" | "unknown";
			readonly code: string;
	  };

export type RemoteProjectTransferSettlementInput = { readonly outcome: "succeeded"; readonly result?: unknown } | { readonly outcome: "failed" | "cancelled" | "unknown"; readonly code: string };

export type RemoteProjectTransferJobHandle = {
	readonly jobId: string;
	readonly operation: RemoteProjectTransferOperation;
	readonly signal: AbortSignal;
	reportProgress(transferred: number): boolean;
	settle(input: RemoteProjectTransferSettlementInput): boolean;
};

export type RemoteProjectTransferCreateInput = {
	readonly scope: RemoteProjectTransferScope;
	readonly operation: RemoteProjectTransferOperation;
	readonly total: number;
	readonly onProgress?: (event: RemoteProjectTransferProgress) => void;
	readonly onSettled?: (event: RemoteProjectTransferSettlement) => void;
};

type Job = {
	handle: RemoteProjectTransferJobHandle;
	readonly scope: RemoteProjectTransferScope;
	readonly operation: RemoteProjectTransferOperation;
	readonly total: number;
	readonly controller: AbortController;
	readonly onProgress?: (event: RemoteProjectTransferProgress) => void;
	readonly onSettled?: (event: RemoteProjectTransferSettlement) => void;
	lastTransferred: number;
	reported: boolean;
	cancelRequested: boolean;
	silenced: boolean;
};

export type RemoteProjectTransferRegistry = {
	create(input: RemoteProjectTransferCreateInput): RemoteProjectTransferJobHandle;
	cancel(input: { senderId: number; projectId: string; jobId: string }): boolean;
	closeSender(senderId: number): number;
	closeProject(projectId: string): number;
	size(): number;
};

const JOB_ID = /^[A-Za-z0-9_-]{16,128}$/;
const STABLE_CODE = /^[A-Z][A-Z0-9_]{2,127}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const PROJECT_ID_MAX = 256;

function validText(value: unknown, maximum = 4096): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= maximum && !CONTROL.test(value);
}

function validCanonicalRoot(value: unknown): value is string {
	if (!validText(value) || !value.startsWith("/")) return false;
	if (value === "/") return true;
	return value
		.slice(1)
		.split("/")
		.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function validSender(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}

function validScope(value: unknown): value is RemoteProjectTransferScope {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const scope = value as Partial<RemoteProjectTransferScope>;
	return validSender(scope.senderId) && validText(scope.projectId, PROJECT_ID_MAX) && validText(scope.hostId, 128) && validCanonicalRoot(scope.canonicalRoot) && validText(scope.connectionId, 512) && Number.isSafeInteger(scope.hostRevision) && (scope.hostRevision as number) >= 0;
}

function validOperation(value: unknown): value is RemoteProjectTransferOperation {
	return value === "upload" || value === "download";
}

function invalid(): never {
	throw new Error(REMOTE_PROJECT_TRANSFER_CODES.inputInvalid);
}

function validateSettlement(value: unknown): asserts value is RemoteProjectTransferSettlementInput {
	if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
	const settlement = value as Partial<RemoteProjectTransferSettlementInput>;
	if (settlement.outcome === "succeeded") return;
	if ((settlement.outcome === "failed" || settlement.outcome === "cancelled" || settlement.outcome === "unknown") && typeof settlement.code === "string" && STABLE_CODE.test(settlement.code)) return;
	invalid();
}

function freezeScope(scope: RemoteProjectTransferScope): RemoteProjectTransferScope {
	return Object.freeze({
		senderId: scope.senderId,
		projectId: scope.projectId,
		hostId: scope.hostId,
		canonicalRoot: scope.canonicalRoot,
		connectionId: scope.connectionId,
		hostRevision: scope.hostRevision,
	});
}

function notify<T>(callback: ((event: T) => void) | undefined, event: T): void {
	try {
		callback?.(event);
	} catch {
		// Observers are transport consumers, never part of the job state machine.
	}
}

export function createRemoteProjectTransferRegistry(options: { createJobId?: () => string } = {}): RemoteProjectTransferRegistry {
	const jobs = new Map<string, Job>();
	const createJobId = options.createJobId ?? (() => randomBytes(24).toString("base64url"));

	const register = (input: RemoteProjectTransferCreateInput): RemoteProjectTransferJobHandle => {
		if (!validScope(input?.scope) || !validOperation(input.operation) || !Number.isSafeInteger(input.total) || input.total < 0 || (input.onProgress !== undefined && typeof input.onProgress !== "function") || (input.onSettled !== undefined && typeof input.onSettled !== "function")) invalid();
		let jobId: string;
		try {
			jobId = createJobId();
		} catch {
			return invalid();
		}
		if (typeof jobId !== "string" || !JOB_ID.test(jobId) || jobs.has(jobId)) throw new Error(REMOTE_PROJECT_TRANSFER_CODES.jobIdCollision);
		const controller = new AbortController();
		let job: Job;
		const handle: RemoteProjectTransferJobHandle = {
			jobId,
			operation: input.operation,
			signal: controller.signal,
			reportProgress(transferred: number): boolean {
				if (jobs.get(jobId) !== job || job.cancelRequested || job.silenced || !Number.isSafeInteger(transferred) || transferred < 0 || transferred > job.total) return false;
				if (job.reported && transferred <= job.lastTransferred) return false;
				job.reported = true;
				job.lastTransferred = transferred;
				notify(job.onProgress, {
					jobId,
					operation: job.operation,
					transferred,
					total: job.total,
				});
				return true;
			},
			settle(settlement): boolean {
				validateSettlement(settlement);
				if (jobs.get(jobId) !== job) return false;
				jobs.delete(jobId);
				const event: RemoteProjectTransferSettlement =
					settlement.outcome === "succeeded"
						? {
								jobId,
								operation: job.operation,
								outcome: "succeeded",
								...(settlement.result === undefined ? {} : { result: settlement.result }),
							}
						: {
								jobId,
								operation: job.operation,
								outcome: settlement.outcome,
								code: settlement.code,
							};
				if (!job.silenced) notify(job.onSettled, event);
				return true;
			},
		};
		job = {
			handle,
			scope: freezeScope(input.scope),
			operation: input.operation,
			total: input.total,
			controller,
			...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
			...(input.onSettled === undefined ? {} : { onSettled: input.onSettled }),
			lastTransferred: 0,
			reported: false,
			cancelRequested: false,
			silenced: false,
		};
		jobs.set(jobId, job);
		return handle;
	};

	const abortMatching = (predicate: (job: Job) => boolean): number => {
		let count = 0;
		for (const job of jobs.values()) {
			if (!predicate(job)) continue;
			count += 1;
			job.cancelRequested = true;
			job.silenced = true;
			if (!job.controller.signal.aborted) job.controller.abort();
		}
		return count;
	};

	return {
		create: register,
		cancel(input): boolean {
			if (!input || typeof input !== "object" || !validSender(input.senderId) || !validText(input.projectId, PROJECT_ID_MAX) || typeof input.jobId !== "string" || !JOB_ID.test(input.jobId)) invalid();
			const job = jobs.get(input.jobId);
			if (job === undefined || job.scope.senderId !== input.senderId || job.scope.projectId !== input.projectId) return false;
			job.cancelRequested = true;
			if (!job.controller.signal.aborted) job.controller.abort();
			return true;
		},
		closeSender(senderId): number {
			if (!validSender(senderId)) invalid();
			return abortMatching((job) => job.scope.senderId === senderId);
		},
		closeProject(projectId): number {
			if (!validText(projectId, PROJECT_ID_MAX)) invalid();
			return abortMatching((job) => job.scope.projectId === projectId);
		},
		size(): number {
			return jobs.size;
		},
	};
}
