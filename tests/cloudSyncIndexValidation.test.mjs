import assert from "node:assert/strict";
import test from "node:test";

import {
	decryptPayload,
	encryptPayload,
} from "../src/main/cloudSync/EncryptionService.ts";
import { buildPiDeckSyncIndex, buildCloudSyncProject } from "../src/main/cloudSync/payload.ts";

const PASSWORD = "correct horse battery staple";

function baseIndex(projects = []) {
	return buildPiDeckSyncIndex({
		deviceId: "device-a",
		deviceName: "Workstation",
		appVersion: "0.0.0-test",
		syncedAt: 123,
		projects,
	});
}

const project = {
	id: "proj-a",
	name: "Proj",
	path: "/workspace/proj",
	lastOpenedAt: 1,
	environment: "windows",
};

test("decryptPayload accepts a well-formed remote index", async () => {
	const file = await encryptPayload(baseIndex([buildCloudSyncProject(project)]), PASSWORD, "device-a", "Workstation", "0.0.0-test", 0);
	const parsed = await decryptPayload(file, PASSWORD);
	assert.equal(parsed.schemaVersion, 1);
	assert.equal(parsed.projects[0].projectId, "proj-a");
});

test("decryptPayload rejects a malicious remote index with an unsafe session path", async () => {
	const index = baseIndex([{
		...buildCloudSyncProject(project),
		sessions: [{
			sessionId: "session-1",
			scope: "project",
			projectId: "proj-a",
			relativePath: "../etc/passwd",
			size: 10,
			mtimeMs: 1,
			contentHash: "a".repeat(64),
			objectKey: "pideck-sessions/session-1.jsonl.enc",
		}],
	}]);
	// 恶意索引仍可被本地加密（encryptPayload 不校验内容），但解密端必须拒绝。
	const file = await encryptPayload(index, PASSWORD, "device-a", "Workstation", "0.0.0-test", 0);
	await assert.rejects(() => decryptPayload(file, PASSWORD), /schema is unsupported/);
});

test("decryptPayload rejects oversized or mismatched session refs", async () => {
	const badHashes = [
		"../etc/passwd",
		"../../secret",
	];
	for (const relativePath of badHashes) {
		const index = baseIndex([{
			...buildCloudSyncProject(project),
			sessions: [{
				sessionId: "session-1",
				scope: "project",
				projectId: "proj-a",
				relativePath,
				size: 10,
				mtimeMs: 1,
				contentHash: "a".repeat(64),
				objectKey: "pideck-sessions/session-1.jsonl.enc",
			}],
		}]);
		const file = await encryptPayload(index, PASSWORD, "device-a", "Workstation", "0.0.0-test", 0);
		await assert.rejects(() => decryptPayload(file, PASSWORD), /schema is unsupported/);
	}

	// 会话对象 key 与 sessionId 不匹配 → 拒绝
	const index = baseIndex([{
		...buildCloudSyncProject(project),
		sessions: [{
			sessionId: "session-1",
			scope: "project",
			projectId: "proj-a",
			relativePath: "2026/a.jsonl",
			size: 10,
			mtimeMs: 1,
			contentHash: "a".repeat(64),
			objectKey: "pideck-sessions/other-session.jsonl.enc",
		}],
	}]);
	const file = await encryptPayload(index, PASSWORD, "device-a", "Workstation", "0.0.0-test", 0);
	await assert.rejects(() => decryptPayload(file, PASSWORD), /schema is unsupported/);
});

test("decryptPayload rejects tampered ciphertext and wrong passwords", async () => {
	const file = await encryptPayload(baseIndex(), PASSWORD, "device-a", "Workstation", "0.0.0-test", 0);
	const tampered = { ...file, payload: `${file.payload.slice(0, -4)}AAAA` };
	await assert.rejects(() => decryptPayload(tampered, PASSWORD));
	await assert.rejects(() => decryptPayload(file, "wrong password!!"));
});
