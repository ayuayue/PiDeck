import assert from "node:assert/strict";
import test from "node:test";

import {
	assertSafeCloudObjectKey,
	isCloudSyncConditionalWriteError,
} from "../src/main/cloudSync/objectStorage.ts";
import {
	normalizeS3Config,
	normalizeWebDAVConfig,
} from "../src/main/cloudSync/providerConfig.ts";

const webdavBase = {
	endpoint: "dav.example.test/backup",
	authType: "basic",
	username: "sync-user",
	password: "sync-secret",
};

const s3Base = {
	endpoint: "https://s3.example.test",
	region: "auto",
	bucket: "pideck-sync",
	accessKeyId: "access-key",
	secretAccessKey: "secret-key",
};

test("provider config normalizers canonicalize endpoints without exposing credentials", () => {
	const webdav = normalizeWebDAVConfig(webdavBase);
	assert.equal(webdav.endpoint, "https://dav.example.test/backup");
	assert.equal(webdav.authType, "basic");
	assert.equal(webdav.password, "sync-secret");

	const s3 = normalizeS3Config({ ...s3Base, prefix: "/pideck/objects/" });
	assert.equal(s3.endpoint, "https://s3.example.test");
	assert.equal(s3.prefix, "pideck/objects");
	assert.equal(s3.forcePathStyle, true);
});

test("provider config rejects insecure or ambiguous connection input", () => {
	assert.throws(
		() => normalizeWebDAVConfig({ ...webdavBase, endpoint: "http://dav.example.test" }),
		/allowInsecure=true/,
	);
	assert.throws(
		() => normalizeS3Config({ ...s3Base, endpoint: "https://user:password@s3.example.test" }),
		/credentials or query parameters/,
	);
	assert.throws(
		() => normalizeS3Config({ ...s3Base, prefix: "pideck/../escape" }),
		/unsafe path segment/,
	);
	assert.throws(
		() => normalizeWebDAVConfig({ ...webdavBase, authType: "bearer" }),
		/auth type is invalid/,
	);
});

test("cloud object keys cannot escape the provider namespace", () => {
	assert.doesNotThrow(() => assertSafeCloudObjectKey("pideck-index.json"));
	assert.doesNotThrow(() => assertSafeCloudObjectKey("pideck-sessions/session-1.jsonl.enc"));
	for (const key of ["/absolute", "../escape", "safe/../../escape", "safe\\escape", "safe//empty"]) {
		assert.throws(() => assertSafeCloudObjectKey(key), /Cloud sync object key/);
	}
});

test("conditional-write errors are identifiable without depending on provider SDK types", () => {
	const error = new Error("revision mismatch");
	error.name = "CloudSyncConditionalWriteError";
	assert.equal(isCloudSyncConditionalWriteError(error), true);
	assert.equal(isCloudSyncConditionalWriteError(new Error("other")), false);
});
