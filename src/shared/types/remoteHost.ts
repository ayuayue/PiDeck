export type RemoteHostListItem = {
	id: string;
	label: string;
	sshHost: string;
	verified: boolean;
	disabled: boolean;
};

export type RemoteHostRepairSummary = {
	reason: string;
	classification: "orphan-pin" | "anchor-invalid" | "lock" | "snapshot" | "write-uncertain" | "unknown";
	hostIds: string[];
};

export type RemoteHostListResult = { ok: true; status: "ready" | "needs-repair"; hosts: RemoteHostListItem[]; repair?: RemoteHostRepairSummary[] } | { ok: false; code: "REMOTE_FEATURE_DISABLED" | "REMOTE_HOST_LIST_UNAVAILABLE" };
