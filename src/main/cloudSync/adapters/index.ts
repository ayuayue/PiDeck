import type { BuiltinCloudProvider } from "../../../shared/types/cloudSync.ts";
import type { PiDeckCloudObjectStorage } from "../objectStorage.ts";
import { GithubGistObjectStorage } from "./GithubGistObjectStorage.ts";
import { LocalFolderObjectStorage } from "./LocalFolderObjectStorage.ts";
import { OneDriveObjectStorage } from "./OneDriveObjectStorage.ts";
import { S3ObjectStorage } from "./S3ObjectStorage.ts";
import { WebDAVObjectStorage } from "./WebDAVObjectStorage.ts";

/** Construct a provider adapter only after the caller has selected a built-in provider. */
export function createCloudSyncObjectStorage(
	provider: BuiltinCloudProvider,
	config: unknown,
): PiDeckCloudObjectStorage {
	switch (provider) {
		case "webdav":
			return new WebDAVObjectStorage(config);
		case "s3":
			return new S3ObjectStorage(config);
		case "github":
			return new GithubGistObjectStorage(config);
		case "local":
			return new LocalFolderObjectStorage(config);
		case "onedrive":
			return new OneDriveObjectStorage(config);
		default:
			// Google Drive 需要 OAuth 客户端凭据与独立桥接，暂未实现。
			throw new Error(`Cloud sync provider ${provider} is not implemented yet`);
	}
}

export { GithubGistObjectStorage } from "./GithubGistObjectStorage.ts";
export { LocalFolderObjectStorage } from "./LocalFolderObjectStorage.ts";
export { OneDriveObjectStorage } from "./OneDriveObjectStorage.ts";
export { S3ObjectStorage } from "./S3ObjectStorage.ts";
export { WebDAVObjectStorage } from "./WebDAVObjectStorage.ts";
