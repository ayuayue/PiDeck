/**
 * Google Drive (Drive API v3) object storage (oauth 类).
 *
 * Mirrors the OneDrive adapter: stores already-encrypted objects in the
 * app-specific `appDataFolder` space (hidden from the user's Drive UI, no
 * folder permissions needed), keyed by a base64url-encoded object key as the
 * file name. clientId is user-supplied (Google Cloud Console → OAuth 客户端 →
 * 桌面应用, redirect http://localhost); tokens live only in the main process.
 *
 * Drive specifics handled here:
 * - File lookup by name in appDataFolder (names cannot contain "/", hence the
 *   base64url encoding of the object key).
 * - Simple upload limit is 5MB; larger objects use a resumable upload session
 *   (uploadType=resumable + ranged PUT).
 * - Revisions are Drive etags; conditional writes use If-Match on the media
 *   update; create-only checks existence first.
 * - Expired access tokens are refreshed once (offline_access) before retry.
 *
 * The HTTP layer is injectable (`fetchLike`) so tests never touch the network.
 */

import type { GoogleDriveConfig, ProviderAccount } from "../../../shared/types/cloudSync.ts";
import {
	assertSafeCloudObjectKey,
	CloudSyncConditionalWriteError,
	type CloudSyncObjectDeleteOptions,
	type CloudSyncObjectReadResult,
	type CloudSyncObjectStorageCapabilities,
	type CloudSyncObjectWriteOptions,
	type CloudSyncObjectWriteResult,
	type PiDeckCloudObjectStorage,
} from "../objectStorage.ts";
import { normalizeGoogleDriveConfig } from "../providerConfig.ts";

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
	text(): Promise<string>;
}>;

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const TOKEN_API = "https://oauth2.googleapis.com/token";
const APPDATA_PARENT = "appDataFolder";
const SIMPLE_UPLOAD_LIMIT = 5 * 1024 * 1024; // 5MB：超过走 resumable upload session
const MAX_OBJECT_BYTES = 512 * 1024 * 1024; // 与 PiDeck 会话上限一致
const REFRESH_BUFFER_MS = 60_000;
const SCOPE = "https://www.googleapis.com/auth/drive.appfolder";

interface DriveFile {
	id?: string;
	name?: string;
	etag?: string;
	md5Checksum?: string;
	size?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDriveFile(value: unknown): value is DriveFile {
	return isRecord(value) && typeof value.id === "string";
}

/** 对象 key → Drive 文件名（base64url，Drive 文件名不允许 "/"）。 */
function fileNameForKey(key: string): string {
	assertSafeCloudObjectKey(key);
	return Buffer.from(key, "utf8").toString("base64url");
}

/** Drive 文件名 → 对象 key（逆向解码，防御性校验）。 */
function keyForFileName(name: string): string {
	try {
		const key = Buffer.from(name, "base64url").toString("utf8");
		assertSafeCloudObjectKey(key);
		return key;
	} catch {
		throw new TypeError("Google Drive object name is invalid");
	}
}

/** Drive API 查询字符串：名称单引号转义。 */
function quoteQueryValue(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export class GoogleDriveObjectStorage implements PiDeckCloudObjectStorage {
	readonly providerId = "google" as const;

	private readonly config: GoogleDriveConfig;
	private readonly fetchLike: FetchLike;
	private connected = false;
	// 内存中的 token（OAuth 刷新后更新；落盘值不变，主密钥密封的是初始值）。
	private accessToken: string | undefined;
	private refreshToken: string | undefined;
	private expiresAt: number | undefined;

	constructor(config: unknown, deps?: { fetchLike?: FetchLike }) {
		this.config = normalizeGoogleDriveConfig(config);
		this.fetchLike = deps?.fetchLike ?? (globalThis.fetch as FetchLike);
		this.accessToken = this.config.accessToken;
		this.refreshToken = this.config.refreshToken;
		this.expiresAt = this.config.expiresAt;
	}

	async connect(options?: { signal?: AbortSignal }): Promise<{ account: ProviderAccount }> {
		this.requireToken();
		// 校验 token：列出 appDataFolder（空查询）；401 触发一次刷新后重试。
		const response = await this.driveRequest("GET", `${DRIVE_API}/files?spaces=appDataFolder&pageSize=1&fields=files(id)`, { signal: options?.signal });
		if (response.status !== 200) {
			throw new Error("Google Drive authorization is invalid; reconnect the provider");
		}
		this.connected = true;
		return { account: { id: "google", name: "Google Drive" } };
	}

	async disconnect(): Promise<void> {
		this.connected = false;
	}

	async getAccount(): Promise<ProviderAccount | null> {
		return this.connected ? { id: "google", name: "Google Drive" } : null;
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
		const file = await this.findFile(key, options?.signal);
		if (!file?.id) return { found: false, key, bytes: null };
		const response = await this.driveRequest("GET", `${DRIVE_API}/files/${file.id}?alt=media`, { signal: options?.signal });
		if (response.status === 404) return { found: false, key, bytes: null };
		if (response.status !== 200) {
			throw new Error(`Google Drive read failed (HTTP ${response.status})`);
		}
		return {
			found: true,
			key,
			bytes: new Uint8Array(await response.arrayBuffer()),
			revision: file.etag,
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
			throw new Error(`Google Drive object exceeds the 512MB limit (${key})`);
		}

		const existing = await this.findFile(key, options?.signal);
		// 条件语义：create-only / 指定 revision，与 S3/OneDrive 同语义。
		if (options?.expectedRevision === null && existing) {
			throw new CloudSyncConditionalWriteError("Google Drive object already exists");
		}
		if (typeof options?.expectedRevision === "string") {
			if (!existing?.etag) {
				throw new CloudSyncConditionalWriteError("Google Drive object was deleted concurrently");
			}
			if (existing.etag !== options.expectedRevision) {
				throw new CloudSyncConditionalWriteError("Google Drive object changed concurrently");
			}
		}

		let revision: string | undefined;
		if (bytes.byteLength <= SIMPLE_UPLOAD_LIMIT) {
			revision = existing?.id
				? await this.simpleUpdate(existing.id, bytes, existing.etag, options?.signal)
				: await this.simpleCreate(key, bytes, options?.signal);
		} else {
			revision = existing?.id
				? await this.resumableUpdate(existing.id, key, bytes, options?.signal)
				: await this.resumableCreate(key, bytes, options?.signal);
		}
		return { created: !existing, revision };
	}

	async deleteObject(key: string, options?: CloudSyncObjectDeleteOptions): Promise<{ deleted: boolean }> {
		assertSafeCloudObjectKey(key);
		this.requireConnected();
		const existing = await this.findFile(key, options?.signal);
		if (!existing?.id) return { deleted: false };
		if (typeof options?.expectedRevision === "string" && existing.etag !== options.expectedRevision) {
			throw new CloudSyncConditionalWriteError("Google Drive object changed concurrently");
		}
		const headers: Record<string, string> = {};
		if (typeof options?.expectedRevision === "string" && existing.etag) headers["If-Match"] = existing.etag;
		const response = await this.driveRequest("DELETE", `${DRIVE_API}/files/${existing.id}`, { headers, signal: options?.signal });
		if (response.status === 412) {
			throw new CloudSyncConditionalWriteError("Google Drive object changed concurrently");
		}
		return { deleted: true };
	}

	// ── Drive internals ──────────────────────────────────────────────

	/** 在 appDataFolder 中按文件名查找对象。 */
	private async findFile(key: string, signal?: AbortSignal): Promise<DriveFile | null> {
		const name = fileNameForKey(key);
		const query = `name='${quoteQueryValue(name)}' and 'appDataFolder' in parents and trashed=false`;
		const response = await this.driveRequest(
			"GET",
			`${DRIVE_API}/files?spaces=appDataFolder&q=${encodeURIComponent(query)}&fields=files(id,name,etag,md5Checksum,size)`,
			{ signal },
		);
		if (response.status !== 200) {
			throw new Error(`Google Drive lookup failed (HTTP ${response.status})`);
		}
		const body = (await response.json()) as { files?: unknown[] };
		if (!Array.isArray(body.files) || body.files.length === 0) return null;
		const file = body.files.find(isDriveFile);
		if (!file) return null;
		keyForFileName(file.name ?? ""); // 防御：拒绝无法解码的命中
		return file;
	}

	/** ≤5MB 新建：先建元数据拿 id，再传内容。 */
	private async simpleCreate(key: string, bytes: Uint8Array, signal?: AbortSignal): Promise<string | undefined> {
		const metadataResponse = await this.driveRequest("POST", `${DRIVE_API}/files?fields=id,etag`, {
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: fileNameForKey(key), parents: [APPDATA_PARENT] }),
			signal,
		});
		if (metadataResponse.status !== 200) {
			throw new Error(`Google Drive create failed (HTTP ${metadataResponse.status})`);
		}
		const created = (await metadataResponse.json()) as { id?: string; etag?: string };
		if (!created.id) throw new Error("Google Drive create returned no file id");
		const updateResponse = await this.driveRequest("PATCH", `${UPLOAD_API}/files/${created.id}?uploadType=media`, {
			headers: { "Content-Type": "application/octet-stream" },
			body: Buffer.from(bytes),
			signal,
		});
		if (updateResponse.status !== 200) {
			throw new Error(`Google Drive media upload failed (HTTP ${updateResponse.status})`);
		}
		const updated = (await updateResponse.json()) as { etag?: string };
		return updated.etag ?? created.etag;
	}

	/** ≤5MB 更新：PATCH 媒体，If-Match 条件写。 */
	private async simpleUpdate(id: string, bytes: Uint8Array, etag: string | undefined, signal?: AbortSignal): Promise<string | undefined> {
		const headers: Record<string, string> = { "Content-Type": "application/octet-stream" };
		if (etag) headers["If-Match"] = etag;
		const response = await this.driveRequest("PATCH", `${UPLOAD_API}/files/${id}?uploadType=media`, {
			headers,
			body: Buffer.from(bytes),
			signal,
		});
		if (response.status === 412) {
			throw new CloudSyncConditionalWriteError("Google Drive object changed concurrently");
		}
		if (response.status !== 200) {
			throw new Error(`Google Drive media update failed (HTTP ${response.status})`);
		}
		const updated = (await response.json()) as { etag?: string };
		return updated.etag;
	}

	/** >5MB 新建：resumable upload session。 */
	private async resumableCreate(key: string, bytes: Uint8Array, signal?: AbortSignal): Promise<string | undefined> {
		const sessionResponse = await this.driveRequest("POST", `${UPLOAD_API}/files?uploadType=resumable`, {
			headers: { "Content-Type": "application/json", "X-Upload-Content-Length": String(bytes.byteLength) },
			body: JSON.stringify({ name: fileNameForKey(key), parents: [APPDATA_PARENT] }),
			signal,
		});
		if (sessionResponse.status !== 200) {
			throw new Error(`Google Drive resumable session failed (HTTP ${sessionResponse.status})`);
		}
		const sessionUrl = sessionResponse.headers.get("Location");
		if (!sessionUrl) throw new Error("Google Drive resumable session returned no Location");
		return this.uploadToSession(sessionUrl, bytes, signal);
	}

	/** >5MB 更新：resumable session（条件语义已在 findFile 阶段完成）。 */
	private async resumableUpdate(_id: string, _key: string, bytes: Uint8Array, signal?: AbortSignal): Promise<string | undefined> {
		// Drive resumable session 无法带 If-Match；条件语义在 writeObject 的 findFile 比对已覆盖。
		const sessionResponse = await this.driveRequest("POST", `${UPLOAD_API}/files/${_id}?uploadType=resumable`, {
			headers: { "Content-Type": "application/json", "X-Upload-Content-Length": String(bytes.byteLength) },
			body: JSON.stringify({}),
			signal,
		});
		if (sessionResponse.status !== 200) {
			throw new Error(`Google Drive resumable update session failed (HTTP ${sessionResponse.status})`);
		}
		const sessionUrl = sessionResponse.headers.get("Location");
		if (!sessionUrl) throw new Error("Google Drive resumable session returned no Location");
		return this.uploadToSession(sessionUrl, bytes, signal);
	}

	private async uploadToSession(sessionUrl: string, bytes: Uint8Array, signal?: AbortSignal): Promise<string | undefined> {
		const total = bytes.byteLength;
		const response = await this.fetchLike(sessionUrl, {
			method: "PUT",
			headers: { "Content-Range": `bytes 0-${total - 1}/${total}`, "Content-Length": String(total) },
			body: Buffer.from(bytes),
			signal,
		});
		if (response.status !== 200 && response.status !== 201) {
			throw new Error(`Google Drive resumable upload failed (HTTP ${response.status})`);
		}
		const body = (await response.json()) as { etag?: string };
		return body.etag;
	}

	/** 带 token 的 Drive 请求：过期/401 时刷新一次后重试。 */
	private async driveRequest(
		method: string,
		url: string,
		options?: { headers?: Record<string, string>; body?: BodyInit; signal?: AbortSignal },
	): Promise<{ status: number; headers: { get(name: string): string | null }; json(): Promise<unknown>; arrayBuffer(): Promise<ArrayBuffer>; text(): Promise<string> }> {
		await this.ensureFreshToken(options?.signal);
		const response = await this.rawDriveRequest(method, url, options);
		if (response.status === 401) {
			await this.refreshAccessToken(options?.signal);
			return this.rawDriveRequest(method, url, options);
		}
		return response;
	}

	private async rawDriveRequest(
		method: string,
		url: string,
		options?: { headers?: Record<string, string>; body?: BodyInit; signal?: AbortSignal },
	): Promise<{ status: number; headers: { get(name: string): string | null }; json(): Promise<unknown>; arrayBuffer(): Promise<ArrayBuffer>; text(): Promise<string> }> {
		this.requireToken();
		return this.fetchLike(url, {
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
		if (!this.refreshToken) throw new Error("Google Drive refresh token is missing; reconnect the provider");
		const params = new URLSearchParams({
			client_id: this.config.clientId,
			grant_type: "refresh_token",
			refresh_token: this.refreshToken,
		});
		if (this.config.clientSecret) params.set("client_secret", this.config.clientSecret);
		const response = await this.fetchLike(TOKEN_API, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: params,
			signal,
		});
		if (response.status !== 200) {
			throw new Error("Google Drive token refresh failed; reconnect the provider");
		}
		const token = (await response.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
		if (typeof token.access_token !== "string" || token.access_token.length === 0) {
			throw new Error("Google Drive token refresh returned no access token");
		}
		this.accessToken = token.access_token;
		if (typeof token.refresh_token === "string" && token.refresh_token.length > 0) {
			this.refreshToken = token.refresh_token;
		}
		this.expiresAt = typeof token.expires_in === "number" ? Date.now() + token.expires_in * 1000 : undefined;
	}

	private requireToken(): void {
		if (!this.accessToken) throw new Error("Google Drive is not authorized; connect via browser first");
	}

	private requireConnected(): void {
		if (!this.connected) throw new Error("Google Drive storage is not connected");
	}
}
