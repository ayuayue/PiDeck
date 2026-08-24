import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { S3ObjectStorage } from "../src/main/cloudSync/adapters/S3ObjectStorage.ts";
import { WebDAVObjectStorage } from "../src/main/cloudSync/adapters/WebDAVObjectStorage.ts";

function etag(bytes) {
	return `"${createHash("md5").update(bytes).digest("hex")}"`;
}

function createWebDAVClient({ moveFails = false } = {}) {
	const files = new Map();
	return {
		files,
		async exists(path) {
			return path === "/" || files.has(path);
		},
		async getFileContents(path) {
			return Buffer.from(files.get(path) ?? Buffer.alloc(0));
		},
		async putFileContents(path, bytes) {
			files.set(path, Buffer.from(bytes));
			return true;
		},
		async moveFile(from, to) {
			if (moveFails) throw new Error("MOVE unsupported");
			if (!files.has(from)) throw new Error("temporary object missing");
			files.set(to, files.get(from));
			files.delete(from);
		},
		async deleteFile(path) {
			files.delete(path);
		},
	};
}

const webdavConfig = {
	endpoint: "https://dav.example.test/backup",
	authType: "basic",
	username: "user",
	password: "password",
};

test("WebDAV object storage atomically writes bytes and verifies the stored body", async () => {
	const client = createWebDAVClient();
	const storage = new WebDAVObjectStorage(webdavConfig, client);
	await storage.connect();

	const bytes = Buffer.from([0, 1, 2, 255]);
	const result = await storage.writeObject("pideck-sessions/session.jsonl.enc", bytes);
	assert.equal(result.created, true);
	assert.deepEqual(
		Buffer.from((await storage.readObject("pideck-sessions/session.jsonl.enc")).bytes),
		bytes,
	);
	assert.equal([...client.files.keys()].some((key) => key.includes(".tmp-")), false);
	assert.deepEqual(
		await storage.deleteObject("pideck-sessions/session.jsonl.enc"),
		{ deleted: true },
	);
});

test("WebDAV falls back to direct PUT when MOVE is unavailable and still cleans temp data", async () => {
	const client = createWebDAVClient({ moveFails: true });
	const storage = new WebDAVObjectStorage(webdavConfig, client);
	await storage.connect();
	await storage.writeObject("pideck-index.json", Buffer.from("encrypted"));
	assert.equal(client.files.has("/pideck-index.json"), true);
	assert.equal([...client.files.keys()].some((key) => key.includes(".tmp-")), false);
});

function createS3Client() {
	const objects = new Map();
	return {
		objects,
		destroy() {},
		async send(command) {
			const name = command.constructor.name;
			const input = command.input;
			const key = input.Key;
			const current = objects.get(key);
			if (name === "HeadObjectCommand") {
				if (!current) throw Object.assign(new Error("not found"), { $metadata: { httpStatusCode: 404 } });
				return { ETag: current.etag };
			}
			if (name === "GetObjectCommand") {
				if (!current) throw Object.assign(new Error("not found"), { $metadata: { httpStatusCode: 404 } });
				return {
					ETag: current.etag,
					ContentType: "application/octet-stream",
					Body: { transformToByteArray: async () => Uint8Array.from(current.bytes) },
				};
			}
			if (name === "PutObjectCommand") {
				if (input.IfNoneMatch === "*" && current) {
					throw Object.assign(new Error("precondition"), { $metadata: { httpStatusCode: 412 } });
				}
				if (input.IfMatch && (!current || current.etag !== input.IfMatch)) {
					throw Object.assign(new Error("precondition"), { $metadata: { httpStatusCode: 412 } });
				}
				const bytes = Buffer.from(input.Body);
				const next = { bytes, etag: etag(bytes) };
				objects.set(key, next);
				return { ETag: next.etag };
			}
			if (name === "DeleteObjectCommand") {
				if (!current) throw Object.assign(new Error("not found"), { $metadata: { httpStatusCode: 404 } });
				if (input.IfMatch && current.etag !== input.IfMatch) {
					throw Object.assign(new Error("precondition"), { $metadata: { httpStatusCode: 412 } });
				}
				objects.delete(key);
				return {};
			}
			throw new Error(`unexpected command ${name}`);
		},
	};
}

const s3Config = {
	endpoint: "https://s3.example.test",
	region: "auto",
	bucket: "pideck-sync",
	accessKeyId: "access-key",
	secretAccessKey: "secret-key",
	prefix: "objects",
};

test("S3 object storage uses HEAD revisions and supports conditional writes", async () => {
	const client = createS3Client();
	const storage = new S3ObjectStorage(s3Config, client);
	await storage.connect();

	const first = await storage.writeObject("pideck-index.json", Buffer.from("one"));
	assert.equal(first.created, true);
	assert.equal(first.revision !== undefined, true);
	const read = await storage.readObject("pideck-index.json");
	assert.equal(Buffer.from(read.bytes).toString(), "one");

	await assert.rejects(
		() => storage.writeObject("pideck-index.json", Buffer.from("two"), { expectedRevision: "stale" }),
		/does not match/,
	);
	const second = await storage.writeObject("pideck-index.json", Buffer.from("two"), {
		expectedRevision: first.revision,
	});
	assert.notEqual(second.revision, first.revision);
	assert.deepEqual(await storage.deleteObject("pideck-index.json", { expectedRevision: second.revision }), { deleted: true });
});
