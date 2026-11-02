import type { Op } from "../op";

export type RemoteTransferOperation = "upload" | "download";

export type RemoteTransferSource = { kind: "picker" } | { kind: "paths"; paths: readonly string[] };

/** Renderer-visible transfer request. Local paths are revalidated in main. */
export type RemoteTransferStartInput =
	| {
			operation: "upload";
			projectId: string;
			targetRelativePath: string;
			source: RemoteTransferSource;
	  }
	| {
			operation: "download";
			projectId: string;
			targetRelativePath: string;
	  };

export type RemoteTransferStartReceipt = Op<
	| { canceled: true }
	| {
			canceled?: false;
			jobId: string;
			operation: RemoteTransferOperation;
			total: number;
	  }
>;

export type RemoteTransferUploadResult = {
	uploaded: Array<{ name: string; bytes: number }>;
	failed: Array<{ name: string; code: string }>;
};

export type RemoteTransferDownloadResult = {
	path: string;
	bytes: number;
};

export type RemoteTransferSettlementResult = RemoteTransferUploadResult | RemoteTransferDownloadResult;

export type RemoteTransferProgressEvent = {
	kind: "progress";
	jobId: string;
	operation: RemoteTransferOperation;
	transferred: number;
	total: number;
};

export type RemoteTransferSettledEvent =
	| {
			kind: "settled";
			jobId: string;
			operation: RemoteTransferOperation;
			outcome: "succeeded";
			result: RemoteTransferSettlementResult;
	  }
	| {
			kind: "settled";
			jobId: string;
			operation: RemoteTransferOperation;
			outcome: "failed" | "cancelled" | "unknown";
			code: string;
	  };

export type RemoteTransferEvent = RemoteTransferProgressEvent | RemoteTransferSettledEvent;

export type RemoteTransferCancelReceipt = Op<{ accepted: boolean }>;
