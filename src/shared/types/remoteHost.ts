export type RemoteHostListItem = {
	id: string;
	label: string;
	sshHost: string;
	verified: boolean;
	disabled: boolean;
};

export type RemoteHostListResult = { ok: true; status: "ready" | "needs-repair"; hosts: RemoteHostListItem[] } | { ok: false; code: "REMOTE_FEATURE_DISABLED" | "REMOTE_HOST_LIST_UNAVAILABLE" };
