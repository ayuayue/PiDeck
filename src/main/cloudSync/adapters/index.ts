import type { BuiltinCloudProvider } from "../../../shared/types/cloudSync.ts";
import type { PiDeckCloudObjectStorage } from "../objectStorage.ts";
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
		default:
			throw new Error(`Cloud sync provider ${provider} is not implemented in M2`);
	}
}

export { S3ObjectStorage } from "./S3ObjectStorage.ts";
export { WebDAVObjectStorage } from "./WebDAVObjectStorage.ts";
