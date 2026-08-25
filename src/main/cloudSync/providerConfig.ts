import { isAbsolute } from "node:path";
import type { GithubGistConfig, LocalFolderConfig, S3Config, WebDAVAuthType, WebDAVConfig } from "../../shared/types/cloudSync.ts";

const MAX_ENDPOINT_LENGTH = 2048;
const MAX_CREDENTIAL_LENGTH = 16_384;
const MAX_S3_PREFIX_LENGTH = 512;
const MAX_FOLDER_PATH_LENGTH = 4096;
const SAFE_AUTH_TYPES = new Set<string>(["basic", "digest", "token"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWebDAVAuthType(value: unknown): value is WebDAVAuthType {
	return typeof value === "string" && SAFE_AUTH_TYPES.has(value);
}

function requiredString(record: Record<string, unknown>, key: string, maxLength: number): string {
	const value = record[key];
	if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
		throw new TypeError(`Cloud sync ${key} is invalid`);
	}
	return value;
}

function optionalString(record: Record<string, unknown>, key: string, maxLength: number): string | undefined {
	const value = record[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length > maxLength) {
		throw new TypeError(`Cloud sync ${key} is invalid`);
	}
	return value.length > 0 ? value : undefined;
}

function normalizeEndpoint(value: unknown, allowInsecure: boolean): string {
	if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_ENDPOINT_LENGTH) {
		throw new TypeError("Cloud sync endpoint is invalid");
	}
	const withScheme = /^https?:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`;
	let url: URL;
	try {
		url = new URL(withScheme);
	} catch {
		throw new TypeError("Cloud sync endpoint is invalid");
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new TypeError("Cloud sync endpoint must use HTTP or HTTPS");
	}
	if (url.username || url.password || url.search || url.hash) {
		throw new TypeError("Cloud sync endpoint must not contain credentials or query parameters");
	}
	if (url.protocol === "http:" && !allowInsecure) {
		throw new TypeError("HTTP cloud sync endpoints require allowInsecure=true");
	}
	return url.toString().replace(/\/$/, "");
}

function assertSafeRelativePath(value: string, label: string, maxLength: number): string {
	if (value.length > maxLength || value.includes("\\") || value.includes("\0") || /[\u0000-\u001f\u007f]/.test(value)) {
		throw new TypeError(`Cloud sync ${label} is invalid`);
	}
	const normalized = value.replace(/^\/+|\/+$/g, "");
	if (normalized.length === 0) return "";
	if (normalized.split("/").some((segment) => segment === "." || segment === ".." || segment.length === 0)) {
		throw new TypeError(`Cloud sync ${label} contains an unsafe path segment`);
	}
	return normalized;
}

/** Validate and normalize untrusted WebDAV configuration at the IPC boundary. */
export function normalizeWebDAVConfig(value: unknown): WebDAVConfig {
	if (!isRecord(value)) throw new TypeError("WebDAV config is invalid");
	const allowInsecure = value.allowInsecure === true;
	const authType = value.authType;
	if (!isWebDAVAuthType(authType)) {
		throw new TypeError("WebDAV auth type is invalid");
	}
	const config: WebDAVConfig = {
		endpoint: normalizeEndpoint(value.endpoint, allowInsecure),
		authType,
	};
	if (allowInsecure) config.allowInsecure = true;

	if (authType === "token") {
		config.token = requiredString(value, "token", MAX_CREDENTIAL_LENGTH);
	} else {
		config.username = requiredString(value, "username", MAX_CREDENTIAL_LENGTH);
		config.password = requiredString(value, "password", MAX_CREDENTIAL_LENGTH);
	}
	return config;
}

/** Validate S3-compatible settings without ever logging credentials. */
export function normalizeS3Config(value: unknown): S3Config {
	if (!isRecord(value)) throw new TypeError("S3 config is invalid");
	const allowInsecure = value.allowInsecure === true;
	const prefix = optionalString(value, "prefix", MAX_S3_PREFIX_LENGTH);
	const config: S3Config = {
		endpoint: normalizeEndpoint(value.endpoint, allowInsecure),
		region: requiredString(value, "region", 128),
		bucket: requiredString(value, "bucket", 63),
		accessKeyId: requiredString(value, "accessKeyId", MAX_CREDENTIAL_LENGTH),
		secretAccessKey: requiredString(value, "secretAccessKey", MAX_CREDENTIAL_LENGTH),
		forcePathStyle: value.forcePathStyle !== false,
	};
	if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket)) {
		throw new TypeError("S3 bucket name is invalid");
	}
	if (value.sessionToken !== undefined) {
		config.sessionToken = requiredString(value, "sessionToken", MAX_CREDENTIAL_LENGTH);
	}
	if (prefix !== undefined) {
		const normalizedPrefix = assertSafeRelativePath(prefix, "prefix", MAX_S3_PREFIX_LENGTH);
		if (normalizedPrefix) config.prefix = normalizedPrefix;
	}
	if (allowInsecure) config.allowInsecure = true;
	return config;
}

/** Validate GitHub Gist config; the token is sealed at rest and never logged. */
export function normalizeGithubGistConfig(value: unknown): GithubGistConfig {
	if (!isRecord(value)) throw new TypeError("GitHub config is invalid");
	const config: GithubGistConfig = {};
	if (value.token !== undefined) {
		config.token = requiredString(value, "token", MAX_CREDENTIAL_LENGTH);
	}
	if (value.clientId !== undefined) {
		config.clientId = requiredString(value, "clientId", 128);
	}
	if (value.gistId !== undefined) {
		config.gistId = requiredString(value, "gistId", 128);
	}
	if (!config.token && !config.clientId) {
		throw new TypeError("GitHub config requires a token or a client id");
	}
	return config;
}

/**
 * Validate the local sync-folder config.
 *
 * folderPath must be an absolute path (the folder may not exist yet — it is
 * created on connect). Control characters are rejected to keep object writes
 * inside the folder; the adapter additionally guards against path traversal.
 */
export function normalizeLocalFolderConfig(value: unknown): LocalFolderConfig {
	if (!isRecord(value)) throw new TypeError("Local folder config is invalid");
	const folderPath = requiredString(value, "folderPath", MAX_FOLDER_PATH_LENGTH);
	if (folderPath.includes("\0") || /[\u0000-\u001f\u007f]/.test(folderPath)) {
		throw new TypeError("Local folder path contains control characters");
	}
	if (!isAbsolute(folderPath)) {
		throw new TypeError("Local folder path must be absolute");
	}
	return { folderPath };
}
