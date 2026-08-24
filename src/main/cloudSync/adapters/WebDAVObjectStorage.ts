import { randomUUID } from "node:crypto";
import { Agent } from "node:https";
import {
	AuthType,
	createClient,
	type OAuthToken,
	type WebDAVClient,
} from "webdav";
import type { ProviderAccount, WebDAVConfig } from "../../../shared/types/cloudSync.ts";
import {
	assertSafeCloudObjectKey,
	cloudObjectKeyPath,
	type CloudSyncObjectDeleteOptions,
	type CloudSyncObjectReadResult,
	type CloudSyncObjectStorageCapabilities,
	type CloudSyncObjectWriteOptions,
	type CloudSyncObjectWriteResult,
	type PiDeckCloudObjectStorage,
} from "../objectStorage.ts";
import { CloudSyncConditionalWriteError } from "../objectStorage.ts";
import { normalizeWebDAVConfig } from "../providerConfig.ts";

type WebDAVClientLike = Pick<
	WebDAVClient,
	"exists" | "getFileContents" | "putFileContents" | "moveFile" | "deleteFile"
>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unwrapResponseData(value: unknown): unknown {
	if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, "data")) return value;
	return value.data;
}

function toBytes(value: unknown): Buffer {
	const data = unwrapResponseData(value);
	if (Buffer.isBuffer(data)) return Buffer.from(data);
	if (data instanceof Uint8Array) return Buffer.from(data);
	if (data instanceof ArrayBuffer) return Buffer.from(data);
	if (typeof data === "string") return Buffer.from(data, "utf8");
	throw new TypeError("WebDAV returned an unsupported object body");
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	return Buffer.from(left).equals(Buffer.from(right));
}

function buildAccount(config: WebDAVConfig): ProviderAccount {
	const url = new URL(config.endpoint);
	const name = config.username ? `${config.username}@${url.host}` : url.host;
	return { id: url.host, name };
}

/** Encrypted-object WebDAV storage with temp-file replacement and read-back verification. */
export class WebDAVObjectStorage implements PiDeckCloudObjectStorage {
	readonly providerId = "webdav" as const;

	private readonly config: WebDAVConfig;
	private readonly account: ProviderAccount;
	private readonly client: WebDAVClientLike;
	private connected = false;

	constructor(config: unknown, client?: WebDAVClientLike) {
		this.config = normalizeWebDAVConfig(config);
		this.account = buildAccount(this.config);
		this.client = client ?? this.createClient(this.config);
	}

	async connect(options?: { signal?: AbortSignal }): Promise<{ account: ProviderAccount }> {
		await this.client.exists("/", { signal: options?.signal });
		this.connected = true;
		return { account: { ...this.account } };
	}

	async disconnect(): Promise<void> {
		this.connected = false;
	}

	async getAccount(): Promise<ProviderAccount | null> {
		return this.connected ? { ...this.account } : null;
	}

	async getCapabilities(): Promise<CloudSyncObjectStorageCapabilities> {
		return {
			revisions: false,
			conditionalWrites: false,
			atomicReplacement: true,
		};
	}

	async readObject(key: string, options?: { signal?: AbortSignal }): Promise<CloudSyncObjectReadResult> {
		assertSafeCloudObjectKey(key);
		this.requireConnected();
		const path = cloudObjectKeyPath(key);
		const exists = await this.client.exists(path, { signal: options?.signal });
		if (!exists) return { found: false, key, bytes: null };
		const value = await this.client.getFileContents(path, {
			format: "binary",
			signal: options?.signal,
		});
		return {
			found: true,
			key,
			bytes: toBytes(value),
			contentType: "application/octet-stream",
		};
	}

	async writeObject(
		key: string,
		bytes: Uint8Array,
		options?: CloudSyncObjectWriteOptions,
	): Promise<CloudSyncObjectWriteResult> {
		assertSafeCloudObjectKey(key);
		this.requireConnected();
		if (options?.expectedRevision !== undefined) {
			throw new CloudSyncConditionalWriteError("WebDAV does not support conditional object writes");
		}

		const path = cloudObjectKeyPath(key);
		const existed = await this.client.exists(path, { signal: options?.signal });
		const temporaryPath = `${path}.tmp-${randomUUID()}`;
		const body = Buffer.from(bytes);
		try {
			await this.client.putFileContents(temporaryPath, body, {
				overwrite: true,
				signal: options?.signal,
			});
			await this.client.moveFile(temporaryPath, path, {
				overwrite: true,
				signal: options?.signal,
			});
		} catch (error) {
			// Some WebDAV servers do not implement MOVE. Direct PUT is the only
			// fallback; the mandatory read-back below still detects truncation.
			try {
				await this.client.putFileContents(path, body, {
					overwrite: true,
					signal: options?.signal,
				});
			} catch {
				throw error;
			}
		} finally {
			await this.deleteTemporaryFile(temporaryPath, options?.signal);
		}

		const stored = await this.readObject(key, options);
		if (!stored.found || !stored.bytes || !sameBytes(stored.bytes, body)) {
			throw new Error("WebDAV write verification failed");
		}
		return { created: !existed };
	}

	async deleteObject(key: string, options?: CloudSyncObjectDeleteOptions): Promise<{ deleted: boolean }> {
		assertSafeCloudObjectKey(key);
		this.requireConnected();
		if (options?.expectedRevision !== undefined) {
			throw new CloudSyncConditionalWriteError("WebDAV does not support conditional object deletes");
		}
		const path = cloudObjectKeyPath(key);
		const exists = await this.client.exists(path, { signal: options?.signal });
		if (!exists) return { deleted: false };
		await this.client.deleteFile(path, { signal: options?.signal });
		return { deleted: true };
	}

	private requireConnected(): void {
		if (!this.connected) throw new Error("WebDAV storage is not connected");
	}

	private async deleteTemporaryFile(path: string, signal?: AbortSignal): Promise<void> {
		try {
			if (await this.client.exists(path, { signal })) {
				await this.client.deleteFile(path, { signal });
			}
		} catch {
			// Cleanup is best effort and must not hide the original provider error.
		}
	}

	private createClient(config: WebDAVConfig): WebDAVClientLike {
		const transport = config.allowInsecure
			? { httpsAgent: new Agent({ rejectUnauthorized: false }) }
			: {};
		if (config.authType === "token") {
			const token: OAuthToken = {
				access_token: config.token ?? "",
				token_type: "Bearer",
			};
			return createClient(config.endpoint, {
				authType: AuthType.Token,
				token,
				...transport,
			});
		}
		return createClient(config.endpoint, {
			authType: config.authType === "digest" ? AuthType.Digest : AuthType.Password,
			username: config.username ?? "",
			password: config.password ?? "",
			...transport,
		});
	}
}
