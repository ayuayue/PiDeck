/**
 * PiDeck cloud-sync encryption primitives.
 *
 * The service stays in the main process so passwords and derived keys never
 * cross the renderer IPC boundary. PBKDF2 is asynchronous because synchronous
 * key derivation would block Electron's main event loop during unlock/sync.
 */

import {
	createCipheriv,
	createDecipheriv,
	createHash,
	pbkdf2 as pbkdf2Callback,
	randomBytes,
	timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import {
	CLOUD_SYNC_CONSTANTS,
	type CloudSyncMasterKeyConfig,
	type PiDeckSyncIndexV1,
	type SyncedFile,
} from "../../shared/types/cloudSync.ts";

const pbkdf2 = promisify(pbkdf2Callback);
const KEY_BYTES = CLOUD_SYNC_CONSTANTS.AES_KEY_LENGTH / 8;
const TAG_BYTES = CLOUD_SYNC_CONSTANTS.GCM_TAG_LENGTH / 8;
const DEFAULT_KDF_ITERATIONS: number = CLOUD_SYNC_CONSTANTS.PBKDF2_ITERATIONS;

export interface CloudSyncEncryptionResult {
	/** Ciphertext followed by the AES-GCM authentication tag. */
	ciphertext: Buffer;
	iv: Buffer;
	salt: Buffer;
	algorithm: "AES-256-GCM";
	kdf: "PBKDF2";
	kdfIterations: number;
}

export interface CloudSyncDecryptionInput {
	/** Ciphertext followed by the AES-GCM authentication tag. */
	ciphertext: Buffer;
	iv: Buffer;
	salt: Buffer;
	kdf: "PBKDF2";
	kdfIterations: number;
}

/** The unlocked key is process-local and must never be serialized or logged. */
export interface UnlockedCloudSyncKey {
	key: Buffer;
	salt: Buffer;
	unlockedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidIterations(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= CLOUD_SYNC_CONSTANTS.MIN_PBKDF2_ITERATIONS &&
		value <= CLOUD_SYNC_CONSTANTS.MAX_PBKDF2_ITERATIONS
	);
}

function assertValidIterations(iterations: number): void {
	if (!isValidIterations(iterations)) {
		throw new TypeError("PBKDF2 iteration count is invalid");
	}
}

function assertValidPassword(password: unknown): asserts password is string {
	if (typeof password !== "string" || password.length < 8) {
		throw new TypeError("Master password must contain at least 8 characters");
	}
}

function assertValidSalt(salt: Uint8Array): void {
	if (salt.byteLength !== CLOUD_SYNC_CONSTANTS.SALT_LENGTH) {
		throw new TypeError("Cloud sync salt has an invalid length");
	}
}

function assertValidKey(key: Buffer): void {
	if (key.byteLength !== KEY_BYTES) {
		throw new TypeError("Cloud sync key has an invalid length");
	}
}

function isCanonicalBase64(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0) {
		return false;
	}
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
	return Buffer.from(value, "base64").toString("base64") === value;
}

function decodeBase64(value: string, name: string): Buffer {
	if (!isCanonicalBase64(value)) {
		throw new TypeError(`${name} is not valid base64`);
	}
	return Buffer.from(value, "base64");
}

function encodeBase64(value: Uint8Array): string {
	return Buffer.from(value).toString("base64");
}

function isValidMasterKeyConfig(value: unknown): value is CloudSyncMasterKeyConfig {
	if (!isRecord(value)) return false;
	if (value.version !== CLOUD_SYNC_CONSTANTS.MASTER_KEY_CONFIG_VERSION) return false;
	if (value.kdf !== "PBKDF2" || !isValidIterations(value.kdfIterations)) return false;
	if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) return false;
	if (!isCanonicalBase64(value.salt) || !isCanonicalBase64(value.verificationHash)) return false;

	const salt = Buffer.from(value.salt, "base64");
	const verificationHash = Buffer.from(value.verificationHash, "base64");
	return salt.byteLength === CLOUD_SYNC_CONSTANTS.SALT_LENGTH && verificationHash.byteLength === 32;
}

/** Runtime validator used by the master-key and persistence boundaries. */
export function isCloudSyncMasterKeyConfig(value: unknown): value is CloudSyncMasterKeyConfig {
	return isValidMasterKeyConfig(value);
}

/** Apply the same minimum-password rule to setup and unlock paths. */
export function isValidCloudSyncPassword(value: unknown): value is string {
	return typeof value === "string" && value.length >= 8;
}

/** Generate cryptographically secure random bytes for salt/IV material. */
export function generateRandomBytes(length: number): Buffer {
	if (!Number.isSafeInteger(length) || length <= 0) {
		throw new RangeError("Random byte length must be a positive integer");
	}
	return randomBytes(length);
}

/** Derive an AES-256 key from a master password without blocking the main loop. */
export async function deriveKey(
	password: string,
	salt: Uint8Array,
	iterations = DEFAULT_KDF_ITERATIONS,
): Promise<Buffer> {
	assertValidPassword(password);
	assertValidSalt(salt);
	assertValidIterations(iterations);
	return pbkdf2(password, Buffer.from(salt), iterations, KEY_BYTES, "sha256");
}

/** Hash derived key bytes for password verification; the key itself is never stored. */
export function createVerificationHash(key: Buffer): string {
	assertValidKey(key);
	return createHash("sha256").update(key).digest("base64");
}

/** Verify a password without exposing whether any key material matched early. */
export async function verifyPassword(
	password: string,
	config: CloudSyncMasterKeyConfig,
): Promise<boolean> {
	if (!isValidCloudSyncPassword(password) || !isValidMasterKeyConfig(config)) return false;
	try {
		const key = await deriveKey(password, decodeBase64(config.salt, "salt"), config.kdfIterations);
		const expected = decodeBase64(config.verificationHash, "verificationHash");
		const actual = Buffer.from(createVerificationHash(key), "base64");
		return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual);
	} catch {
		return false;
	}
}

/** Encrypt UTF-8 text with AES-256-GCM; the returned ciphertext includes its tag. */
export function encrypt(
	plaintext: string,
	key: Buffer,
	salt: Uint8Array,
	iterations = DEFAULT_KDF_ITERATIONS,
): CloudSyncEncryptionResult {
	assertValidKey(key);
	assertValidSalt(salt);
	assertValidIterations(iterations);

	const iv = generateRandomBytes(CLOUD_SYNC_CONSTANTS.GCM_IV_LENGTH);
	const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
	const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);

	return {
		ciphertext,
		iv,
		salt: Buffer.from(salt),
		algorithm: "AES-256-GCM",
		kdf: "PBKDF2",
		kdfIterations: iterations,
	};
}

/** Decrypt and authenticate AES-256-GCM text; tampering rejects through final(). */
export function decrypt(input: CloudSyncDecryptionInput, key: Buffer): string {
	assertValidKey(key);
	assertValidSalt(input.salt);
	assertValidIterations(input.kdfIterations);
	if (input.kdf !== "PBKDF2") throw new TypeError("Unsupported cloud sync KDF");
	if (input.iv.byteLength !== CLOUD_SYNC_CONSTANTS.GCM_IV_LENGTH) {
		throw new TypeError("Cloud sync IV has an invalid length");
	}
	if (input.ciphertext.byteLength <= TAG_BYTES) {
		throw new TypeError("Cloud sync ciphertext is too short");
	}

	const body = input.ciphertext.subarray(0, -TAG_BYTES);
	const authTag = input.ciphertext.subarray(-TAG_BYTES);
	const decipher = createDecipheriv("aes-256-gcm", key, input.iv, { authTagLength: TAG_BYTES });
	decipher.setAuthTag(authTag);
	return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

/** Create a local master-key record containing only salt and a verification hash. */
export async function createMasterKeyConfig(password: string): Promise<CloudSyncMasterKeyConfig> {
	assertValidPassword(password);
	const salt = generateRandomBytes(CLOUD_SYNC_CONSTANTS.SALT_LENGTH);
	const key = await deriveKey(password, salt);
	return {
		version: CLOUD_SYNC_CONSTANTS.MASTER_KEY_CONFIG_VERSION,
		verificationHash: createVerificationHash(key),
		salt: encodeBase64(salt),
		kdf: "PBKDF2",
		kdfIterations: DEFAULT_KDF_ITERATIONS,
		createdAt: Date.now(),
	};
}

/** Unlock a master key into process memory after verifying the password. */
export async function unlockMasterKey(
	password: string,
	config: CloudSyncMasterKeyConfig,
): Promise<UnlockedCloudSyncKey | null> {
	if (!(await verifyPassword(password, config))) return null;
	const salt = decodeBase64(config.salt, "salt");
	return {
		key: await deriveKey(password, salt, config.kdfIterations),
		salt,
		unlockedAt: Date.now(),
	};
}

/** Re-key future writes after verifying the old password; existing objects need migration. */
export async function changeMasterPassword(
	oldPassword: string,
	newPassword: string,
	config: CloudSyncMasterKeyConfig,
): Promise<CloudSyncMasterKeyConfig | null> {
	if (!(await verifyPassword(oldPassword, config))) return null;
	return createMasterKeyConfig(newPassword);
}

function isSafeText(value: unknown, maxLength: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(value);
}

function isSafeRelativePath(value: unknown): value is string {
	if (!isSafeText(value, 4096) || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false;
	const parts = value.split("/");
	return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

function isSafeSessionId(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9_][A-Za-z0-9._-]{0,255}$/.test(value);
}

function isSha256(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isBoundedRecord(value: unknown, maxKeys = 5000): value is Record<string, unknown> {
	return isRecord(value) && Object.keys(value).length <= maxKeys;
}

function isValidSyncFileBundle(value: unknown): boolean {
	if (!isRecord(value) || !isSafeRelativePath(value.relativePath) || !isSha256(value.contentHash)) return false;
	const content = value.content;
	const hasContent = typeof content === "string";
	const objectKey = value.objectKey;
	const hasObjectKey = typeof objectKey === "string";
	if (hasContent && content.length > 256 * 1024) return false;
	if (hasObjectKey && (!isSafeText(objectKey, 1024) || !objectKey.startsWith("pideck-files/"))) return false;
	return hasContent !== hasObjectKey;
}

function isValidSyncSessionRef(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (!isSafeSessionId(value.sessionId) || !isSafeRelativePath(value.relativePath) || !isSha256(value.contentHash)) return false;
	if (value.scope !== "global" && value.scope !== "project") return false;
	if (value.scope === "global" && value.projectId !== undefined) return false;
	if (value.scope === "project" && (!isSafeSessionId(value.projectId) || value.projectId === "__global__")) return false;
	const size = value.size;
	if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 || size > 512 * 1024 * 1024) return false;
	const mtimeMs = value.mtimeMs;
	if (typeof mtimeMs !== "number" || !Number.isFinite(mtimeMs) || mtimeMs < 0) return false;
	return value.objectKey === `pideck-sessions/${value.sessionId}.jsonl.enc`;
}

function isValidSyncProject(value: unknown): boolean {
	if (!isRecord(value) || !isSafeSessionId(value.projectId) || !isSafeText(value.name, 512)) return false;
	if (value.kind !== undefined && value.kind !== "normal" && value.kind !== "chat" && value.kind !== "external") return false;
	if (value.environment !== undefined && value.environment !== "windows" && value.environment !== "wsl") return false;
	if (value.pathHint !== undefined && !isSafeText(value.pathHint, 4096)) return false;
	if (value.resources !== undefined) {
		if (!isRecord(value.resources)) return false;
		for (const key of ["prompts", "skills", "localExtensions"] as const) {
			const bundles = value.resources[key];
			if (bundles !== undefined && (!Array.isArray(bundles) || bundles.length > 2000 || !bundles.every(isValidSyncFileBundle))) return false;
		}
		if (value.resources.piSettings !== undefined && !isBoundedRecord(value.resources.piSettings)) return false;
		if (value.resources.extensionSources !== undefined && (
			!Array.isArray(value.resources.extensionSources) ||
			value.resources.extensionSources.length > 500 ||
			!value.resources.extensionSources.every((source) => (
				isRecord(source) && isSafeText(source.source, 2048) &&
				(source.scope === "user" || source.scope === "project") &&
				(source.version === undefined || isSafeText(source.version, 512)) &&
				(source.lockContent === undefined || typeof source.lockContent === "string")
			))
		)) return false;
	}
	if (value.sessions !== undefined && (
		!Array.isArray(value.sessions) || value.sessions.length > 5000 || !value.sessions.every(isValidSyncSessionRef)
	)) return false;
	if (value.catalogEntries !== undefined && (
		!Array.isArray(value.catalogEntries) || value.catalogEntries.length > 5000 ||
		!value.catalogEntries.every((entry) => isBoundedRecord(entry, 128))
	)) return false;
	return true;
}

export function isPiDeckSyncIndexV1(value: unknown): value is PiDeckSyncIndexV1 {
	if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.meta)) return false;
	if (!isSafeText(value.meta.deviceId, 256) || !isSafeText(value.meta.appVersion, 256)) return false;
	if (value.meta.deviceName !== undefined && !isSafeText(value.meta.deviceName, 256)) return false;
	if (typeof value.meta.syncedAt !== "number" || !Number.isFinite(value.meta.syncedAt)) return false;
	if (typeof value.syncedAt !== "number" || !Number.isFinite(value.syncedAt)) return false;
	if (value.settings !== undefined && !isBoundedRecord(value.settings)) return false;
	if (value.pi !== undefined && !isRecord(value.pi)) return false;
	if (value.dsh !== undefined && !isRecord(value.dsh)) return false;
	if (value.projects !== undefined && (
		!Array.isArray(value.projects) || value.projects.length > 500 || !value.projects.every(isValidSyncProject)
	)) return false;
	if (value.imageGen !== undefined && !isRecord(value.imageGen)) return false;
	if (value.extensionState !== undefined && !isRecord(value.extensionState)) return false;
	return true;
}


function readSyncedFileMeta(file: SyncedFile): {
	iv: Buffer;
	salt: Buffer;
	version: number;
	kdfIterations: number;
} {
	const candidate: unknown = file;
	if (!isRecord(candidate) || !isRecord(candidate.meta) || typeof candidate.payload !== "string") {
		throw new TypeError("Cloud sync file has an invalid shape");
	}
	const meta = candidate.meta;
	if (meta.algorithm !== "AES-256-GCM" || meta.kdf !== "PBKDF2") {
		throw new TypeError("Unsupported cloud sync encryption format");
	}
	if (typeof meta.version !== "number" || !Number.isSafeInteger(meta.version) || meta.version < 1) {
		throw new TypeError("Cloud sync file version is invalid");
	}
	const kdfIterations = meta.kdfIterations === undefined
		? DEFAULT_KDF_ITERATIONS
		: meta.kdfIterations;
	if (!isValidIterations(kdfIterations)) {
		throw new TypeError("Cloud sync file KDF iterations are invalid");
	}
	if (typeof meta.iv !== "string" || typeof meta.salt !== "string") {
		throw new TypeError("Cloud sync file encryption metadata is incomplete");
	}

	const iv = decodeBase64(meta.iv, "iv");
	const salt = decodeBase64(meta.salt, "salt");
	if (iv.byteLength !== CLOUD_SYNC_CONSTANTS.GCM_IV_LENGTH) {
		throw new TypeError("Cloud sync IV has an invalid length");
	}
	if (salt.byteLength !== CLOUD_SYNC_CONSTANTS.SALT_LENGTH) {
		throw new TypeError("Cloud sync salt has an invalid length");
	}
	return {
		iv,
		salt,
		version: meta.version,
		kdfIterations,
	};
}

/** Encrypt the PiDeck index payload into the provider-neutral file envelope. */
export async function encryptPayload(
	payload: PiDeckSyncIndexV1,
	password: string,
	deviceId: string,
	deviceName: string,
	appVersion: string,
	existingVersion = 0,
): Promise<SyncedFile> {
	assertValidPassword(password);
	if (!Number.isSafeInteger(existingVersion) || existingVersion < 0) {
		throw new RangeError("Existing cloud sync version is invalid");
	}

	const salt = generateRandomBytes(CLOUD_SYNC_CONSTANTS.SALT_LENGTH);
	const key = await deriveKey(password, salt);
	const encrypted = encrypt(JSON.stringify(payload), key, salt);
	return {
		meta: {
			version: existingVersion + 1,
			updatedAt: Date.now(),
			deviceId,
			deviceName,
			appVersion,
			iv: encodeBase64(encrypted.iv),
			salt: encodeBase64(encrypted.salt),
			algorithm: "AES-256-GCM",
			kdf: "PBKDF2",
			kdfIterations: encrypted.kdfIterations,
		},
		payload: encodeBase64(encrypted.ciphertext),
	};
}

/** Decrypt and minimally validate a remote PiDeck index payload. */
export async function decryptPayload(
	syncedFile: SyncedFile,
	password: string,
): Promise<PiDeckSyncIndexV1> {
	assertValidPassword(password);
	const meta = readSyncedFileMeta(syncedFile);
	const candidate: unknown = syncedFile;
	if (!isRecord(candidate) || typeof candidate.payload !== "string") {
		throw new TypeError("Cloud sync payload is invalid");
	}
	const ciphertext = decodeBase64(candidate.payload, "payload");
	const key = await deriveKey(password, meta.salt, meta.kdfIterations);
	const plaintext = decrypt(
		{
			ciphertext,
			iv: meta.iv,
			salt: meta.salt,
			kdf: "PBKDF2",
			kdfIterations: meta.kdfIterations,
		},
		key,
	);
	const parsed: unknown = JSON.parse(plaintext);
	if (!isPiDeckSyncIndexV1(parsed)) {
		throw new TypeError("Cloud sync payload schema is unsupported");
	}
	return parsed;
}

/** Check a remote file without leaking decryption errors to the caller. */
export async function verifySyncedFile(
	syncedFile: SyncedFile,
	password: string,
): Promise<boolean> {
	try {
		await decryptPayload(syncedFile, password);
		return true;
	} catch {
		return false;
	}
}

/** Stateless facade used by future cloud-sync manager code. */
export class EncryptionService {
	static deriveKey = deriveKey;
	static encrypt = encrypt;
	static decrypt = decrypt;
	static encryptPayload = encryptPayload;
	static decryptPayload = decryptPayload;
	static createMasterKeyConfig = createMasterKeyConfig;
	static unlockMasterKey = unlockMasterKey;
	static changeMasterPassword = changeMasterPassword;
	static verifyPassword = verifyPassword;
	static verifySyncedFile = verifySyncedFile;
	static createVerificationHash = createVerificationHash;
	static generateRandomBytes = generateRandomBytes;
}

export default EncryptionService;
