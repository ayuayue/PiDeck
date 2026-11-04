import type {
	CloudProvider,
	ProviderAccount,
	S3Config,
	WebDAVConfig,
} from "../../shared/types/cloudSync.ts";

export interface CloudSyncObjectStorageCapabilities {
	revisions: boolean;
	conditionalWrites: boolean;
	atomicReplacement: boolean;
	maxObjectBytes?: number;
	maxObjects?: number;
}

export interface CloudSyncObjectReadResult {
	found: boolean;
	key: string;
	bytes: Uint8Array | null;
	revision?: string;
	contentType?: string;
}

export interface CloudSyncObjectWriteResult {
	created: boolean;
	revision?: string;
}

export interface CloudSyncObjectWriteOptions {
	/** `null` means the object must not exist yet. */
	expectedRevision?: string | null;
	signal?: AbortSignal;
}

export interface CloudSyncObjectDeleteOptions {
	expectedRevision?: string;
	signal?: AbortSignal;
}

/** OAuth provider 的 token 轮换回调载荷（刷新成功后由持有者持久化落盘）。 */
export interface CloudSyncRotatedTokens {
	accessToken: string;
	refreshToken?: string;
	expiresAt?: number;
}

/** Provider-neutral storage for already-encrypted bytes. */
export interface PiDeckCloudObjectStorage {
	readonly providerId: CloudProvider;
	connect(options?: { signal?: AbortSignal }): Promise<{ account: ProviderAccount }>;
	disconnect(options?: { signal?: AbortSignal }): Promise<void>;
	getAccount(options?: { signal?: AbortSignal }): Promise<ProviderAccount | null>;
	getCapabilities(options?: { signal?: AbortSignal }): Promise<CloudSyncObjectStorageCapabilities>;
	readObject(key: string, options?: { signal?: AbortSignal }): Promise<CloudSyncObjectReadResult>;
	writeObject(
		key: string,
		bytes: Uint8Array,
		options?: CloudSyncObjectWriteOptions,
	): Promise<CloudSyncObjectWriteResult>;
	deleteObject(key: string, options?: CloudSyncObjectDeleteOptions): Promise<{ deleted: boolean }>;
	/**
	 * OAuth providers：access/refresh token 轮换时回调，供持有者持久化
	 * （Microsoft consumer / Google 的 refresh token 每次刷新会轮换并作废旧值，
	 * 不持久化新值会导致重启后刷新失败、被迫重新授权——Netcatty #1189 教训）。
	 */
	setOnTokensRefreshed?(callback: (tokens: CloudSyncRotatedTokens) => void): void;
}

export type CloudSyncProviderConfig = WebDAVConfig | S3Config;

export class CloudSyncConditionalWriteError extends Error {
	readonly code = "conditional_write_conflict";

	constructor(message = "Cloud sync conditional write was rejected") {
		super(message);
		this.name = "CloudSyncConditionalWriteError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isCloudSyncConditionalWriteError(error: unknown): boolean {
	if (error instanceof CloudSyncConditionalWriteError) return true;
	if (!isRecord(error)) return false;
	return (
		error.code === "conditional_write_conflict" ||
		error.name === "CloudSyncConditionalWriteError"
	);
}

/** Object keys are relative provider paths, never arbitrary URLs or filesystem paths. */
export function assertSafeCloudObjectKey(key: string): void {
	if (typeof key !== "string" || key.length < 1 || key.length > 1024) {
		throw new TypeError("Cloud sync object key is invalid");
	}
	if (key.includes("\\") || key.includes("\0") || /[\u0000-\u001f\u007f]/.test(key)) {
		throw new TypeError("Cloud sync object key contains control characters");
	}
	const segments = key.split("/");
	if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
		throw new TypeError("Cloud sync object key contains an unsafe path segment");
	}
}

export function cloudObjectKeyPath(key: string): string {
	assertSafeCloudObjectKey(key);
	return `/${key}`;
}
