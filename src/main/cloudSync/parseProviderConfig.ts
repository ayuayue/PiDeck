/**
 * Provider config input parsing (pure, electron-free).
 *
 * Renderer sends `{ provider, config }`; every field is validated at the IPC
 * boundary before it reaches CloudSyncManager. Missing WebDAV authType falls
 * back to "basic" (the UI default), matching Netcatty's behavior.
 */

import type {
	CloudSyncProviderConfigInput,
	GithubGistConfig,
	GoogleDriveConfig,
	LocalFolderConfig,
	OneDriveConfig,
	S3Config,
	WebDAVConfig,
} from "../../shared/types/cloudSync.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return isRecord(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function throwType(message: string): never {
	throw new TypeError(message);
}

function isWebDAVConfig(value: unknown): value is WebDAVConfig {
	if (!isPlainObject(value)) return false;
	if (typeof value.endpoint !== "string" || value.endpoint.length === 0 || value.endpoint.length > 2048) return false;
	if (value.authType !== undefined && value.authType !== "basic" && value.authType !== "digest" && value.authType !== "token") return false;
	if (value.username !== undefined && typeof value.username !== "string") return false;
	if (value.password !== undefined && typeof value.password !== "string") return false;
	if (value.token !== undefined && typeof value.token !== "string") return false;
	return true;
}

function isS3Config(value: unknown): value is S3Config {
	if (!isPlainObject(value)) return false;
	if (typeof value.endpoint !== "string" || value.endpoint.length === 0 || value.endpoint.length > 2048) return false;
	if (typeof value.region !== "string" || value.region.length === 0) return false;
	if (typeof value.bucket !== "string" || value.bucket.length === 0) return false;
	if (typeof value.accessKeyId !== "string" || typeof value.secretAccessKey !== "string") return false;
	if (value.sessionToken !== undefined && typeof value.sessionToken !== "string") return false;
	if (value.prefix !== undefined && typeof value.prefix !== "string") return false;
	return true;
}

function isGithubGistConfig(value: unknown): value is GithubGistConfig {
	if (!isPlainObject(value)) return false;
	if (value.token !== undefined && typeof value.token !== "string") return false;
	if (value.clientId !== undefined && typeof value.clientId !== "string") return false;
	if (value.gistId !== undefined && typeof value.gistId !== "string") return false;
	return Boolean(value.token || value.clientId);
}

function isLocalFolderConfig(value: unknown): value is LocalFolderConfig {
	if (!isPlainObject(value)) return false;
	if (typeof value.folderPath !== "string" || value.folderPath.length === 0 || value.folderPath.length > 4096) return false;
	return !value.folderPath.includes("\0");
}

function isOneDriveConfig(value: unknown): value is OneDriveConfig {
	if (!isPlainObject(value)) return false;
	if (typeof value.clientId !== "string" || value.clientId.length === 0 || value.clientId.length > 128) return false;
	if (value.tenant !== undefined && typeof value.tenant !== "string") return false;
	if (value.accessToken !== undefined && typeof value.accessToken !== "string") return false;
	if (value.refreshToken !== undefined && typeof value.refreshToken !== "string") return false;
	if (value.expiresAt !== undefined && typeof value.expiresAt !== "number") return false;
	return true;
}

function isGoogleDriveConfig(value: unknown): value is GoogleDriveConfig {
	if (!isPlainObject(value)) return false;
	if (typeof value.clientId !== "string" || value.clientId.length === 0 || value.clientId.length > 128) return false;
	if (value.clientSecret !== undefined && typeof value.clientSecret !== "string") return false;
	if (value.accessToken !== undefined && typeof value.accessToken !== "string") return false;
	if (value.refreshToken !== undefined && typeof value.refreshToken !== "string") return false;
	if (value.expiresAt !== undefined && typeof value.expiresAt !== "number") return false;
	return true;
}

export function parseProviderConfigInput(value: unknown): CloudSyncProviderConfigInput {
	if (!isPlainObject(value)) throw new TypeError("Provider config must be an object");
	const provider = value.provider;
	if (provider === "webdav") {
		const config = isWebDAVConfig(value.config) ? value.config : throwType("WebDAV config is invalid");
		// authType 缺省 basic：UI 默认值，避免旧客户端漏传时误报。
		return { provider, config: { ...config, authType: config.authType ?? "basic" } };
	}
	if (provider === "s3") {
		return { provider, config: isS3Config(value.config) ? value.config : throwType("S3 config is invalid") };
	}
	if (provider === "github") {
		return { provider, config: isGithubGistConfig(value.config) ? value.config : throwType("GitHub config is invalid") };
	}
	if (provider === "local") {
		return { provider, config: isLocalFolderConfig(value.config) ? value.config : throwType("Local folder config is invalid") };
	}
	if (provider === "onedrive") {
		return { provider, config: isOneDriveConfig(value.config) ? value.config : throwType("OneDrive config is invalid") };
	}
	if (provider === "google") {
		return { provider, config: isGoogleDriveConfig(value.config) ? value.config : throwType("Google Drive config is invalid") };
	}
	throw new TypeError("Unknown cloud provider");
}
