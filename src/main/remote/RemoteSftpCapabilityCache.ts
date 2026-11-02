/**
 * Generation-scoped cache for SFTP subsystem probes.
 *
 * Positive probes remain reusable only for the exact host/root/connection/revision/binary
 * identity. Negative probes use a short TTL so a missing subsystem does not cause one SSH
 * round trip per click, while a fixed server is picked up without an app restart.
 */

export type RemoteSftpCapabilityKey = {
	readonly hostId: string;
	readonly canonicalRoot: string;
	readonly connectionId: string;
	readonly hostRevision: number;
	readonly binaryIdentity: string;
};

export type RemoteSftpProbeResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: string };

export type RemoteSftpCapabilityHit<T> = { readonly kind: "positive"; readonly value: T } | { readonly kind: "negative"; readonly code: string; readonly retryAt: number };

type Entry<T> = {
	readonly key: RemoteSftpCapabilityKey;
	readonly result: RemoteSftpProbeResult<T>;
	readonly retryAt?: number;
};

export type RemoteSftpCapabilityCache<T> = {
	get(key: RemoteSftpCapabilityKey): RemoteSftpCapabilityHit<T> | undefined;
	set(key: RemoteSftpCapabilityKey, result: RemoteSftpProbeResult<T>): void;
	invalidateHost(hostId: string): number;
	invalidateRoot(hostId: string, canonicalRoot: string): number;
	invalidateConnection(connectionId: string): number;
	clear(): void;
	size(): number;
};

const DEFAULT_NEGATIVE_TTL_MS = 15_000;
const DEFAULT_MAX_ENTRIES = 256;
const STABLE_CODE = /^[A-Z][A-Z0-9_]{2,127}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

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

function validateKey(value: unknown): asserts value is RemoteSftpCapabilityKey {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("REMOTE_SFTP_CACHE_KEY_INVALID");
	const key = value as Partial<RemoteSftpCapabilityKey>;
	if (!validText(key.hostId, 128) || !validCanonicalRoot(key.canonicalRoot) || !validText(key.connectionId, 512) || !Number.isSafeInteger(key.hostRevision) || (key.hostRevision as number) < 0 || !validText(key.binaryIdentity, 512)) {
		throw new Error("REMOTE_SFTP_CACHE_KEY_INVALID");
	}
}

function identity(key: RemoteSftpCapabilityKey): string {
	return [key.hostId, key.canonicalRoot, key.connectionId, key.hostRevision, key.binaryIdentity].join("\0");
}

function scopeIdentity(key: RemoteSftpCapabilityKey): string {
	return key.hostId + "\0" + key.canonicalRoot;
}

export function createRemoteSftpCapabilityCache<T>(options: { negativeTtlMs?: number; maxEntries?: number; now?: () => number } = {}): RemoteSftpCapabilityCache<T> {
	const negativeTtlMs = options.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS;
	const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
	const now = options.now ?? Date.now;
	if (!Number.isSafeInteger(negativeTtlMs) || negativeTtlMs <= 0 || !Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
		throw new Error("REMOTE_SFTP_CACHE_OPTIONS_INVALID");
	}
	const entries = new Map<string, Entry<T>>();

	const touch = (id: string, entry: Entry<T>): void => {
		entries.delete(id);
		entries.set(id, entry);
	};

	const removeWhere = (predicate: (key: RemoteSftpCapabilityKey) => boolean): number => {
		let removed = 0;
		for (const [id, entry] of entries) {
			if (!predicate(entry.key)) continue;
			entries.delete(id);
			removed += 1;
		}
		return removed;
	};

	return {
		get(key): RemoteSftpCapabilityHit<T> | undefined {
			validateKey(key);
			const id = identity(key);
			const entry = entries.get(id);
			if (entry === undefined) return undefined;
			if (entry.result.ok) {
				touch(id, entry);
				return { kind: "positive", value: entry.result.value };
			}
			if (entry.retryAt === undefined || now() < entry.retryAt) {
				touch(id, entry);
				return { kind: "negative", code: entry.result.code, retryAt: entry.retryAt ?? now() };
			}
			entries.delete(id);
			return undefined;
		},
		set(key, result): void {
			validateKey(key);
			if (!result || typeof result !== "object") throw new Error("REMOTE_SFTP_CACHE_RESULT_INVALID");
			if (!result.ok && (typeof result.code !== "string" || !STABLE_CODE.test(result.code))) throw new Error("REMOTE_SFTP_CACHE_RESULT_INVALID");
			const scope = scopeIdentity(key);
			removeWhere((entry) => scopeIdentity(entry) === scope && identity(entry) !== identity(key));
			const id = identity(key);
			entries.delete(id);
			entries.set(id, {
				key: Object.freeze({ ...key }),
				result,
				...(result.ok ? {} : { retryAt: now() + negativeTtlMs }),
			});
			while (entries.size > maxEntries) {
				const oldest = entries.keys().next().value;
				if (typeof oldest !== "string") break;
				entries.delete(oldest);
			}
		},
		invalidateHost(hostId): number {
			if (!validText(hostId, 128)) throw new Error("REMOTE_SFTP_CACHE_KEY_INVALID");
			return removeWhere((key) => key.hostId === hostId);
		},
		invalidateRoot(hostId, canonicalRoot): number {
			if (!validText(hostId, 128) || !validCanonicalRoot(canonicalRoot)) throw new Error("REMOTE_SFTP_CACHE_KEY_INVALID");
			return removeWhere((key) => key.hostId === hostId && key.canonicalRoot === canonicalRoot);
		},
		invalidateConnection(connectionId): number {
			if (!validText(connectionId, 512)) throw new Error("REMOTE_SFTP_CACHE_KEY_INVALID");
			return removeWhere((key) => key.connectionId === connectionId);
		},
		clear(): void {
			entries.clear();
		},
		size(): number {
			return entries.size;
		},
	};
}
