/**
 * OneDrive (Microsoft Graph) object storage (oauth 类).
 *
 * Stores already-encrypted objects under the app-specific special folder
 * (`special/approot`), so personal OneDrive accounts need no extra folder
 * permissions. clientId is user-supplied (Azure app with the
 * "Mobile and desktop applications" platform and an `http://localhost`
 * redirect); tokens live only in the main process and are sealed with the
 * master password.
 *
 * Graph constraints handled here:
 * - Simple PUT uploads are limited to 4MB; larger objects go through a
 *   resumable upload session (`createUploadSession` + ranged PUT).
 * - `maxObjectBytes` is 250MB (the practical Graph ceiling for v1); larger
 *   objects are rejected so the merge layer fails loudly instead of hanging.
 * - Conditional writes use the Graph eTag via If-Match / If-None-Match;
 *   412/409 map to CloudSyncConditionalWriteError like the S3 adapter.
 * - Expired access tokens are refreshed once (offline_access scope) before a
 *   request is retried.
 *
 * The HTTP layer is injectable (`fetchLike`) so tests never touch the network.
 */

import type { OneDriveConfig, ProviderAccount } from "../../../shared/types/cloudSync.ts";
import {
	assertSafeCloudObjectKey,
	CloudSyncConditionalWriteError,
	type CloudSyncObjectDeleteOptions,
	type CloudSyncObjectReadResult,
	type CloudSyncObjectStorageCapabilities,
	type CloudSyncObjectWriteOptions,
	type CloudSyncObjectWriteResult,
	type CloudSyncRotatedTokens,
	type PiDeckCloudObjectStorage,
} from "../objectStorage.ts";
import { normalizeOneDriveConfig } from "../providerConfig.ts";

type FetchLike = (input: string, init?: {
	method?: string;
	headers?: Record<string, string>;
	body?: BodyInit;
	signal?: AbortSignal;
}) => Promise<{
	status: number;
	headers: { get(name: string): string | null };
	json(): Promise<unknown>;
	arrayBuffer(): Promise<ArrayBuffer>;
}>;

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const TOKEN_BASE = "https://login.microsoftonline.com";
const SIMPLE_UPLOAD_LIMIT = 4 * 1024 * 1024; // 4MB：超过走 resumable upload session
const MAX_OBJECT_BYTES = 250 * 1024 * 1024; // 250MB：Graph 可续传实际上限（v1 边界）
const REFRESH_BUFFER_MS = 60_000;
const SCOPE = "Files.ReadWrite.AppFolder offline_access";

interface GraphItem {
	eTag?: string;
	name?: string;
	error?: { code?: string; message?: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGraphItem(value: unknown): value is GraphItem {
	return isRecord(value) && typeof value.eTag === "string";
}

/** 对象 key → Graph 路径（`approot:/<key>`），每段 encodeURIComponent。 */
function driveItemPath(key: string): string {
	assertSafeCloudObjectKey(key);
	const encoded = key.split("/").map((segment) => encodeURIComponent(segment)).join("/");
	return `/me/drive/special/approot:/${encoded}`;
}

export class OneDriveObjectStorage implements PiDeckCloudObjectStorage {
	readonly providerId = "onedrive" as const;

	private readonly config: OneDriveConfig;
	private readonly fetchLike: FetchLike;
	private connected = false;
	// 内存中的 token（OAuth 刷新后更新；落盘值不变，主密钥密封的是初始值）。
	private accessToken: string | undefined;
	private refreshToken: string | undefined;
	private expiresAt: number | undefined;
	/** token 轮换回调：刷新成功后通知持有者持久化（Microsoft consumer 每次刷新轮换并作废旧 token）。 */
	private onTokensRefreshed: ((tokens: CloudSyncRotatedTokens) => void) | null = null;

	constructor(config: unknown, deps?: { fetchLike?: FetchLike }) {
		this.config = normalizeOneDriveConfig(config);
		this.fetchLike = deps?.fetchLike ?? (globalThis.fetch as FetchLike);
		this.accessToken = this.config.accessToken;
		this.refreshToken = this.config.refreshToken;
		this.expiresAt = this.config.expiresAt;
	}

	async connect(options?: { signal?: AbortSignal }): Promise<{ account: ProviderAccount }> {
		this.requireToken();
		// 校验 token：GET approot 根元数据；401 触发一次刷新后重试。
		const response = await this.graphRequest("GET", "/me/drive/special/approot", { signal: options?.signal });
		if (!isGraphItem(await response.json())) {
			throw new Error("OneDrive authorization is invalid; reconnect the provider");
		}
		this.connected = true;
		return { account: { id: "onedrive", name: "OneDrive" } };
	}

	async disconnect(): Promise<void> {
		this.connected = false;
	}

	async getAccount(): Promise<ProviderAccount | null> {
		return this.connected ? { id: "onedrive", name: "OneDrive" } : null;
	}

	async getCapabilities(): Promise<CloudSyncObjectStorageCapabilities> {
		return {
			revisions: true,
			conditionalWrites: true,
			atomicReplacement: false,
			maxObjectBytes: MAX_OBJECT_BYTES,
		};
	}

	async readObject(key: string, options?: { signal?: AbortSignal }): Promise<CloudSyncObjectReadResult> {
		assertSafeCloudObjectKey(key);
		this.requireConnected();
		const response = await this.graphRequest("GET", `${driveItemPath(key)}:/content`, { signal: options?.signal });
		if (response.status === 404) return { found: false, key, bytes: null };
		if (response.status !== 200) {
			throw new Error(`OneDrive read failed (HTTP ${response.status})`);
		}
		const bytes = new Uint8Array(await response.arrayBuffer());
		return {
			found: true,
			key,
			bytes,
			revision: response.headers.get("ETag") ?? undefined,
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
		if (bytes.byteLength > MAX_OBJECT_BYTES) {
			throw new Error(`OneDrive object exceeds the 250MB limit (${key})`);
		}

		const metadata = await this.getMetadata(key, options?.signal);
		// 条件语义：create-only / 指定 revision，与 S3 适配器同语义。
		if (options?.expectedRevision === null && metadata) {
			throw new CloudSyncConditionalWriteError("OneDrive object already exists");
		}
		if (typeof options?.expectedRevision === "string") {
			if (!metadata?.eTag) {
				throw new CloudSyncConditionalWriteError("OneDrive object was deleted concurrently");
			}
			if (metadata.eTag !== options.expectedRevision) {
				throw new CloudSyncConditionalWriteError("OneDrive object changed concurrently");
			}
		}

		let revision: string | undefined;
		if (bytes.byteLength <= SIMPLE_UPLOAD_LIMIT) {
			const headers: Record<string, string> = { "Content-Type": "application/octet-stream" };
			if (options?.expectedRevision === null) headers["If-None-Match"] = "*";
			else if (typeof options?.expectedRevision === "string" && metadata?.eTag) headers["If-Match"] = metadata.eTag;
			const response = await this.graphRequest("PUT", `${driveItemPath(key)}:/content`, {
				headers,
				body: Buffer.from(bytes),
				signal: options?.signal,
			});
			if (response.status === 409 || response.status === 412) {
				throw new CloudSyncConditionalWriteError("OneDrive object changed concurrently");
			}
			if (response.status !== 200 && response.status !== 201) {
				throw new Error(`OneDrive upload failed (HTTP ${response.status})`);
			}
			revision = response.headers.get("ETag") ?? undefined;
		} else {
			revision = await this.resumableUpload(driveItemPath(key), bytes, options?.signal);
		}

		if (!revision) {
			const stored = await this.getMetadata(key, options?.signal);
			revision = stored?.eTag;
		}
		return { created: !metadata, revision };
	}

	async deleteObject(key: string, options?: CloudSyncObjectDeleteOptions): Promise<{ deleted: boolean }> {
		assertSafeCloudObjectKey(key);
		this.requireConnected();
		const metadata = await this.getMetadata(key, options?.signal);
		if (!metadata) return { deleted: false };
		if (typeof options?.expectedRevision === "string" && metadata.eTag !== options.expectedRevision) {
			throw new CloudSyncConditionalWriteError("OneDrive object changed concurrently");
		}
		const headers: Record<string, string> = {};
		if (typeof options?.expectedRevision === "string" && metadata.eTag) headers["If-Match"] = metadata.eTag;
		const response = await this.graphRequest("DELETE", driveItemPath(key), { headers, signal: options?.signal });
		if (response.status === 412) {
			throw new CloudSyncConditionalWriteError("OneDrive object changed concurrently");
		}
		return { deleted: true };
	}

	// ── Graph internals ──────────────────────────────────────────────

	private async getMetadata(key: string, signal?: AbortSignal): Promise<GraphItem | null> {
		const response = await this.graphRequest("GET", driveItemPath(key), { signal });
		if (response.status === 404) return null;
		if (response.status !== 200) {
			throw new Error(`OneDrive metadata read failed (HTTP ${response.status})`);
		}
		const body: unknown = await response.json();
		return isGraphItem(body) ? body : null;
	}

	/** >4MB 走 Graph resumable upload session（一次分段 PUT 全量传输）。 */
	private async resumableUpload(path: string, bytes: Uint8Array, signal?: AbortSignal): Promise<string | undefined> {
		const createResponse = await this.graphRequest("POST", `${path}:/createUploadSession`, {
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": "replace" } }),
			signal,
		});
		if (createResponse.status !== 200 && createResponse.status !== 201) {
			throw new Error(`OneDrive upload session failed (HTTP ${createResponse.status})`);
		}
		const session = (await createResponse.json()) as { uploadUrl?: string };
		if (!session.uploadUrl) throw new Error("OneDrive upload session returned no upload URL");
		const total = bytes.byteLength;
		const response = await this.fetchLike(session.uploadUrl, {
			method: "PUT",
			headers: { "Content-Range": `bytes 0-${total - 1}/${total}`, "Content-Length": String(total) },
			body: Buffer.from(bytes),
			signal,
		});
		if (response.status !== 200 && response.status !== 201) {
			// 上传失败清理会话；清理失败不掩盖原始错误。
			await this.fetchLike(session.uploadUrl, { method: "DELETE", signal }).catch(() => undefined);
			throw new Error(`OneDrive resumable upload failed (HTTP ${response.status})`);
		}
		return response.headers.get("ETag") ?? undefined;
	}

	/**
	 * 带 token 的 Graph 请求：过期/401 时刷新一次后重试。
	 * 返回 { status, headers, json }；json 为懒解析（只有需要时才调用）。
	 */
	private async graphRequest(
		method: string,
		urlPath: string,
		options?: { headers?: Record<string, string>; body?: BodyInit; signal?: AbortSignal },
	): Promise<{ status: number; headers: { get(name: string): string | null }; json(): Promise<unknown>; arrayBuffer(): Promise<ArrayBuffer> }> {
		await this.ensureFreshToken(options?.signal);
		const response = await this.rawGraphRequest(method, urlPath, options);
		if (response.status === 401) {
			await this.refreshAccessToken(options?.signal);
			return this.rawGraphRequest(method, urlPath, options);
		}
		return response;
	}

	private async rawGraphRequest(
		method: string,
		urlPath: string,
		options?: { headers?: Record<string, string>; body?: BodyInit; signal?: AbortSignal },
	): Promise<{ status: number; headers: { get(name: string): string | null }; json(): Promise<unknown>; arrayBuffer(): Promise<ArrayBuffer> }> {
		this.requireToken();
		return this.fetchLike(`${GRAPH_BASE}${urlPath}`, {
			method,
			headers: { Authorization: `Bearer ${this.accessToken}`, ...options?.headers },
			...(options?.body !== undefined ? { body: options.body } : {}),
			...(options?.signal ? { signal: options.signal } : {}),
		});
	}

	private async ensureFreshToken(signal?: AbortSignal): Promise<void> {
		if (this.refreshToken && this.expiresAt !== undefined && Date.now() + REFRESH_BUFFER_MS > this.expiresAt) {
			await this.refreshAccessToken(signal);
		}
	}

	private async refreshAccessToken(signal?: AbortSignal): Promise<void> {
		if (!this.refreshToken) throw new Error("OneDrive refresh token is missing; reconnect the provider");
		const tenant = this.config.tenant ?? "consumers";
		const body = new URLSearchParams({
			client_id: this.config.clientId,
			grant_type: "refresh_token",
			refresh_token: this.refreshToken,
			scope: SCOPE,
		});
		const response = await this.fetchLike(`${TOKEN_BASE}/${tenant}/oauth2/v2.0/token`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body,
			signal,
		});
		if (response.status !== 200) {
			throw new Error("OneDrive token refresh failed; reconnect the provider");
		}
		const token = (await response.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
		if (typeof token.access_token !== "string" || token.access_token.length === 0) {
			throw new Error("OneDrive token refresh returned no access token");
		}
		this.accessToken = token.access_token;
		if (typeof token.refresh_token === "string" && token.refresh_token.length > 0) {
			this.refreshToken = token.refresh_token;
		}
		this.expiresAt = typeof token.expires_in === "number" ? Date.now() + token.expires_in * 1000 : undefined;
		// 轮换后的 token 必须持久化，否则重启后旧 refresh token 失效 → 被迫重新授权。
		this.onTokensRefreshed?.({
			accessToken: this.accessToken,
			...(this.refreshToken ? { refreshToken: this.refreshToken } : {}),
			...(this.expiresAt !== undefined ? { expiresAt: this.expiresAt } : {}),
		});
	}

	/** 注册 token 轮换回调（持有者 = CloudSyncManager，负责密封落盘）。 */
	setOnTokensRefreshed(callback: (tokens: CloudSyncRotatedTokens) => void): void {
		this.onTokensRefreshed = callback;
	}

	private requireToken(): void {
		if (!this.accessToken) throw new Error("OneDrive is not authorized; connect via browser first");
	}

	private requireConnected(): void {
		if (!this.connected) throw new Error("OneDrive storage is not connected");
	}
}
