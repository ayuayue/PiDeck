/**
 * GitHub Gist object storage for cloud sync.
 *
 * Auth uses the OAuth Device Flow (no client secret needed). The token is
 * sealed by CloudSyncManager at rest and passed here at connect time; the
 * renderer never sees it. Storage is a single private Gist whose files are
 * the encrypted objects — GitHub Gist fits small objects only (see the plan:
 * large sessions route through WebDAV/S3).
 *
 * The HTTP layer is injectable so tests can run without network.
 */

import type {
	GithubGistConfig,
	ProviderAccount,
} from "../../../shared/types/cloudSync.ts";
import {
	assertSafeCloudObjectKey,
	CloudSyncConditionalWriteError,
	cloudObjectKeyPath,
	type CloudSyncObjectDeleteOptions,
	type CloudSyncObjectReadResult,
	type CloudSyncObjectStorageCapabilities,
	type CloudSyncObjectWriteOptions,
	type CloudSyncObjectWriteResult,
	type PiDeckCloudObjectStorage,
} from "../objectStorage.ts";
import { normalizeGithubGistConfig } from "../providerConfig.ts";

export type CloudSyncHttpFetch = (
	url: string,
	init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; json(): Promise<unknown>; text(): Promise<string> }>;

const GITHUB_API = "https://api.github.com";
const GIST_DESCRIPTION = "PiDeck cloud sync (end-to-end encrypted)";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface GithubDeviceFlowStart {
	deviceCode: string;
	userCode: string;
	verificationUrl: string;
	expiresIn: number;
	interval: number;
}

export interface GithubDeviceFlowToken {
	accessToken: string;
	error?: string;
	errorDescription?: string;
	/** 服务端最新建议的轮询间隔（秒）；RFC 8628 允许在 token 响应中下发。 */
	interval?: number;
}

/** 发起 GitHub Device Flow：返回用户需访问的验证 URL 与一次性 code。 */
export async function startGithubDeviceFlow(
	clientId: string,
	fetchImpl: CloudSyncHttpFetch = fetch as unknown as CloudSyncHttpFetch,
): Promise<GithubDeviceFlowStart> {
	if (!clientId.trim()) throw new TypeError("GitHub client id is required");
	const response = await fetchImpl("https://github.com/login/device/code", {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json" },
		body: JSON.stringify({ client_id: clientId, scope: "gist" }),
	});
	const data = (await response.json()) as Record<string, unknown>;
	if (response.status < 200 || response.status >= 300 || typeof data.device_code !== "string" || typeof data.user_code !== "string") {
		const detail = typeof data.error_description === "string" ? data.error_description : `HTTP ${response.status}`;
		throw new Error(`GitHub device flow failed: ${detail}`);
	}
	return {
		deviceCode: data.device_code,
		userCode: data.user_code,
		verificationUrl: typeof data.verification_uri === "string" ? data.verification_uri : "https://github.com/login/device",
		expiresIn: typeof data.expires_in === "number" ? data.expires_in : 900,
		interval: typeof data.interval === "number" ? data.interval : 5,
	};
}

/** 轮询 GitHub Device Flow 换取 access token；未授权完成时返回 error: "authorization_pending"。 */
export async function pollGithubDeviceFlow(
	clientId: string,
	deviceCode: string,
	fetchImpl: CloudSyncHttpFetch = fetch as unknown as CloudSyncHttpFetch,
): Promise<GithubDeviceFlowToken> {
	const response = await fetchImpl("https://github.com/login/oauth/access_token", {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json" },
		body: JSON.stringify({
			client_id: clientId,
			device_code: deviceCode,
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
		}),
	});
	const data = (await response.json()) as Record<string, unknown>;
	if (typeof data.access_token === "string") {
		return { accessToken: data.access_token };
	}
	return {
		accessToken: "",
		error: typeof data.error === "string" ? data.error : "unknown_error",
		errorDescription: typeof data.error_description === "string" ? data.error_description : undefined,
		interval: typeof data.interval === "number" && data.interval > 0 ? data.interval : undefined,
	};
}

function gistFileContent(files: unknown, key: string): string | null {
	if (!isRecord(files)) return null;
	const entry = files[key];
	if (!isRecord(entry) || typeof entry.content !== "string") return null;
	return entry.content;
}

/**
 * GitHub Gist 加密对象存储：一个私有 Gist 的多文件承载多个对象。
 * 条件写（并发保护）用 gist updated_at 作为 revision 近似。
 */
export class GithubGistObjectStorage implements PiDeckCloudObjectStorage {
	readonly providerId = "github" as const;

	private readonly config: GithubGistConfig;
	private readonly fetchImpl: CloudSyncHttpFetch;
	private gistId: string | null = null;
	private account: ProviderAccount | null = null;

	constructor(
		config: unknown,
		fetchImpl: CloudSyncHttpFetch = fetch as unknown as CloudSyncHttpFetch,
	) {
		this.config = normalizeGithubGistConfig(config);
		this.fetchImpl = fetchImpl;
	}

	async connect(): Promise<{ account: ProviderAccount }> {
		this.requireToken();
		const gist = await this.ensureGist();
		this.gistId = gist.id;
		this.account = { id: gist.id, name: "GitHub Gist" };
		return { account: { ...this.account } };
	}

	async disconnect(): Promise<void> {
		this.gistId = null;
		this.account = null;
	}

	async getAccount(): Promise<ProviderAccount | null> {
		return this.account ? { ...this.account } : null;
	}

	async getCapabilities(): Promise<CloudSyncObjectStorageCapabilities> {
		return {
			revisions: true,
			conditionalWrites: false,
			atomicReplacement: true,
			// Gist 单文件 API 上限 1MB；大对象请走 WebDAV/S3。
			maxObjectBytes: 1024 * 1024,
		};
	}

	async readObject(key: string): Promise<CloudSyncObjectReadResult> {
		assertSafeCloudObjectKey(key);
		this.requireConnected();
		const gist = await this.getGist();
		const content = gistFileContent(gist.files, key);
		if (content === null) return { found: false, key, bytes: null };
		return {
			found: true,
			key,
			bytes: Buffer.from(content, "utf8"),
			revision: gist.updatedAt,
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
		if (bytes.byteLength > 1024 * 1024) {
			throw new RangeError("Gist files are limited to 1MB; use WebDAV/S3 for large objects");
		}
		if (options?.expectedRevision !== undefined) {
			throw new CloudSyncConditionalWriteError("GitHub Gist does not support conditional writes");
		}
		const gist = await this.getGist();
		const existed = gistFileContent(gist.files, key) !== null;
		const body = {
			files: {
				[key]: { content: Buffer.from(bytes).toString("base64") },
			},
		};
		await this.request(`/gists/${encodeURIComponent(gist.id)}`, "PATCH", body);
		const updated = await this.getGist();
		return { created: !existed, revision: updated.updatedAt };
	}

	async deleteObject(key: string, options?: CloudSyncObjectDeleteOptions): Promise<{ deleted: boolean }> {
		assertSafeCloudObjectKey(key);
		this.requireConnected();
		if (options?.expectedRevision !== undefined) {
			throw new CloudSyncConditionalWriteError("GitHub Gist does not support conditional deletes");
		}
		const gist = await this.getGist();
		if (gistFileContent(gist.files, key) === null) return { deleted: false };
		await this.request(`/gists/${encodeURIComponent(gist.id)}`, "PATCH", {
			files: { [key]: null },
		});
		return { deleted: true };
	}

	private requireToken(): void {
		if (!this.config.token) throw new Error("GitHub token is not configured");
	}

	private requireConnected(): void {
		if (!this.gistId) throw new Error("GitHub Gist storage is not connected");
	}

	private async ensureGist(): Promise<{ id: string; files: unknown; updatedAt?: string }> {
		if (this.config.gistId) {
			return this.getGist(this.config.gistId);
		}
		// 复用已有 PiDeck Gist（按描述识别），否则创建。
		const existing = await this.findExistingGist();
		if (existing) {
			this.config.gistId = existing.id;
			return existing;
		}
		const created = await this.request("/gists", "POST", {
			description: GIST_DESCRIPTION,
			public: false,
			files: { "pideck-index.json": { content: "" } },
		});
		if (!isRecord(created) || typeof created.id !== "string" || !created.id) {
			throw new Error("GitHub failed to create the sync gist");
		}
		this.config.gistId = created.id;
		return { id: created.id, files: created.files, updatedAt: typeof created.updated_at === "string" ? created.updated_at : undefined };
	}

	private async findExistingGist(): Promise<{ id: string; files: unknown; updatedAt?: string } | null> {
		const data = (await this.request("/gists?per_page=100", "GET")) as unknown;
		if (!Array.isArray(data)) return null;
		for (const gist of data) {
			if (!isRecord(gist) || gist.description !== GIST_DESCRIPTION || typeof gist.id !== "string") continue;
			if (gistFileContent(gist.files, "pideck-index.json") === null) continue;
			return { id: gist.id, files: gist.files, updatedAt: typeof gist.updated_at === "string" ? gist.updated_at : undefined };
		}
		return null;
	}

	private async getGist(gistId?: string): Promise<{ id: string; files: unknown; updatedAt?: string }> {
		const id = gistId ?? this.gistId;
		if (!id) throw new Error("GitHub Gist is not connected");
		const data = (await this.request(`/gists/${encodeURIComponent(id)}`, "GET")) as Record<string, unknown>;
		if (typeof data.id !== "string") throw new Error("GitHub gist lookup failed");
		return {
			id: data.id,
			files: data.files,
			updatedAt: typeof data.updated_at === "string" ? data.updated_at : undefined,
		};
	}

	private async request(
		path: string,
		method: string,
		body?: Record<string, unknown>,
	): Promise<unknown> {
		this.requireToken();
		const response = await this.fetchImpl(`${GITHUB_API}${path}`, {
			method,
			headers: {
				authorization: `Bearer ${this.config.token}`,
				accept: "application/vnd.github+json",
				...(body ? { "content-type": "application/json" } : {}),
			},
			...(body ? { body: JSON.stringify(body) } : {}),
		});
		if (response.status < 200 || response.status >= 300) {
			const detail = await response.text().catch(() => "");
			throw new Error(`GitHub API ${response.status}: ${detail.slice(0, 200)}`);
		}
		if (response.status === 204) return null;
		return response.json();
	}
}

/** Object keys are gist file names; validate before use. */
export function githubObjectFileName(key: string): string {
	assertSafeCloudObjectKey(key);
	return cloudObjectKeyPath(key).slice(1);
}
