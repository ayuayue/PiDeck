import assert from "node:assert/strict";
import test from "node:test";

import { CLOUD_SYNC_CONSTANTS } from "../src/shared/types/cloudSync.ts";
import {
	EncryptionService,
	createMasterKeyConfig,
	decryptPayload,
	encryptPayload,
	isCloudSyncMasterKeyConfig,
	verifyPassword,
	verifySyncedFile,
} from "../src/main/cloudSync/EncryptionService.ts";

const PASSWORD = "correct horse battery staple";

function createPayload() {
	return {
		schemaVersion: 1,
		meta: {
			deviceId: "device-a",
			deviceName: "Workstation",
			appVersion: "0.7.2-beta",
			syncedAt: 1_700_000_000_000,
		},
		settings: {
			theme: "dark",
		},
		projects: [
			{
				projectId: "project-a",
				name: "PiDeck",
				sessions: [],
			},
		],
		syncedAt: 1_700_000_000_000,
	};
}

test("master key config verifies the right password and rejects malformed records", async () => {
	const config = await createMasterKeyConfig(PASSWORD);

	assert.equal(config.version, CLOUD_SYNC_CONSTANTS.MASTER_KEY_CONFIG_VERSION);
	assert.equal(isCloudSyncMasterKeyConfig(config), true);
	assert.equal(await verifyPassword(PASSWORD, config), true);
	assert.equal(await verifyPassword("wrong password", config), false);
	assert.equal(
		isCloudSyncMasterKeyConfig({ ...config, kdfIterations: 1 }),
		false,
		"untrusted iteration counts must not bypass the KDF policy",
	);
	await assert.rejects(
		() => createMasterKeyConfig("short"),
		/Master password must contain at least 8 characters/,
	);
});

test("PiDeck index payload round-trips without exposing plaintext", async () => {
	const payload = createPayload();
	const file = await encryptPayload(payload, PASSWORD, "device-a", "Workstation", "0.7.2-beta");

	assert.equal(file.meta.algorithm, "AES-256-GCM");
	assert.equal(file.meta.kdf, "PBKDF2");
	assert.equal(file.meta.version, 1);
	assert.equal(JSON.stringify(file).includes("Workstation"), true, "device metadata is intentionally public");
	assert.equal(JSON.stringify(file).includes("dark"), false);
	assert.deepEqual(await decryptPayload(file, PASSWORD), payload);
	assert.equal(await verifySyncedFile(file, PASSWORD), true);
	assert.equal(await verifySyncedFile(file, "wrong password"), false);
});

test("each encrypted file gets fresh salt and IV, and tampering is rejected", async () => {
	const payload = createPayload();
	const first = await encryptPayload(payload, PASSWORD, "device-a", "Workstation", "0.7.2-beta");
	const second = await encryptPayload(payload, PASSWORD, "device-a", "Workstation", "0.7.2-beta");

	assert.notEqual(first.meta.salt, second.meta.salt);
	assert.notEqual(first.meta.iv, second.meta.iv);

	const tamperedBytes = Buffer.from(first.payload, "base64");
	tamperedBytes[0] ^= 1;
	const tampered = {
		...first,
		payload: tamperedBytes.toString("base64"),
	};
	await assert.rejects(() => decryptPayload(tampered, PASSWORD));
});

test("unlock returns process-local key material and password changes require the old password", async () => {
	const config = await createMasterKeyConfig(PASSWORD);
	const unlocked = await EncryptionService.unlockMasterKey(PASSWORD, config);
	assert.ok(unlocked);
	assert.equal(unlocked.key.byteLength, 32);
	assert.equal(unlocked.salt.byteLength, CLOUD_SYNC_CONSTANTS.SALT_LENGTH);

	assert.equal(await EncryptionService.unlockMasterKey("wrong password", config), null);
	assert.ok(await EncryptionService.changeMasterPassword(PASSWORD, "new password 123", config));
	assert.equal(await EncryptionService.changeMasterPassword("wrong password", "new password 123", config), null);
});
