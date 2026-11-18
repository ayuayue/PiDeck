import type { PiDesktopApi } from "../../../preload";
import { REMOTE_CONFIG_CODES, remotePiConfigCodeFromError, type RemotePiAuthSnapshot } from "../../../shared/piConfig";
import type { RemoteAuthEntry } from "../../../shared/types/remotePiManagement";

/** Editable references to host-retained credentials; the displayed draft contains no existing secret. */
export function createRemoteAuthEditor(api: PiDesktopApi, hostId: string, connected: () => Promise<void>, invalidate: () => void) {
	const snapshots = new Map<string, RemotePiAuthSnapshot>();
	const reads = new Map<string, number>();
	let epoch = 0;
	let blocked: string | undefined;
	let pending = false;
	function snapshot(value: RemotePiAuthSnapshot | undefined): RemotePiAuthSnapshot {
		if (!value || value.kind !== "remote-auth" || value.hostId !== hostId || value.version !== value.sha256 || !/^[0-9a-f]{64}$/.test(value.version) || !Array.isArray(value.providers) || value.providers.length > 200) throw new Error(REMOTE_CONFIG_CODES.fileInvalid);
		const names = new Set<string>();
		for (const entry of value.providers) {
			if (!entry || Object.keys(entry).sort().join(",") !== "configured,provider,type" || !/^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/.test(entry.provider) || names.has(entry.provider) || !["api_key", "oauth", "unsupported"].includes(entry.type) || typeof entry.configured !== "boolean")
				throw new Error(REMOTE_CONFIG_CODES.fileInvalid);
			names.add(entry.provider);
		}
		return value;
	}
	return {
		reset() {
			epoch += 1;
			snapshots.clear();
			blocked = undefined;
		},
		async read(view = "form") {
			const started = epoch;
			const request = (reads.get(view) ?? 0) + 1;
			reads.set(view, request);
			await connected();
			const result = await api.config.getRaw("auth.json", { target: { kind: "ssh", hostId } });
			const remoteAuth = snapshot(result.remoteAuth);
			if (started !== epoch || reads.get(view) !== request) throw new Error(REMOTE_CONFIG_CODES.versionConflict);
			snapshots.set(view, structuredClone(remoteAuth));
			const parsed = Object.fromEntries(remoteAuth.providers.map((entry) => [entry.provider, { type: entry.type, retain: true, source: entry.provider, configured: entry.configured }]));
			return { raw: JSON.stringify(parsed, null, 2), parsed, remoteAuth };
		},
		async write(data: unknown, view = "form") {
			if (blocked) throw new Error(blocked);
			if (pending) throw new Error(REMOTE_CONFIG_CODES.resultUnconfirmed);
			const baseline = snapshots.get(view);
			if (!baseline) throw new Error(REMOTE_CONFIG_CODES.versionConflict);
			if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error(REMOTE_CONFIG_CODES.fileInvalid);
			const entries: RemoteAuthEntry[] = Object.entries(data).map(([provider, value]) => {
				if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(REMOTE_CONFIG_CODES.fileInvalid);
				const type: unknown = Reflect.get(value, "type");
				const key: unknown = Reflect.get(value, "key");
				if (Object.keys(value).some((name) => !["type", "key", "retain", "source", "configured"].includes(name))) throw new Error(REMOTE_CONFIG_CODES.fileInvalid);
				if (type === "api_key" && typeof key === "string") return { provider, apiKey: key };
				const source: unknown = Reflect.get(value, "source");
				if (Reflect.get(value, "retain") !== true || typeof source !== "string" || !baseline.providers.some((entry) => entry.provider === source && entry.type === type) || key !== undefined) throw new Error(REMOTE_CONFIG_CODES.fileInvalid);
				return { provider, retain: true, source };
			});
			pending = true;
			try {
				await connected();
				const result = await api.config.replaceRemoteAuth({ hostId, expectedVersion: baseline.version, entries });
				try {
					if (result.valid !== true) throw new Error();
					snapshot(result.remoteAuth);
				} catch {
					throw new Error(REMOTE_CONFIG_CODES.resultUnconfirmed);
				}
				snapshots.delete(view);
				invalidate();
				return { valid: true };
			} catch (error) {
				const code = remotePiConfigCodeFromError(error);
				if (code === REMOTE_CONFIG_CODES.versionConflict || code === REMOTE_CONFIG_CODES.resultUnconfirmed) blocked = code;
				throw error;
			} finally {
				pending = false;
			}
		},
	};
}
