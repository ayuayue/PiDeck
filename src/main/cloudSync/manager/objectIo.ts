/**
 * Cloud sync 对象 I/O 原语（纯函数，无宿主状态）。
 *
 * 从 `CloudSyncManager` 原样搬出：原子落盘、越界软链校验、DSH 会话文本编解码、
 * 对象正文的加解密信封。宿主、传输协作者与备份协作者共用同一份实现，
 * 保证云对象与 `.pideckbackup` 条目字节一致。
 */

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { gunzipSync, gzipSync, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import type { SyncedFile } from "../../../shared/types/cloudSync.ts";
import { CLOUD_SYNC_CONSTANTS } from "../../../shared/types/cloudSync.ts";
import { decrypt, deriveKey, encrypt, generateRandomBytes } from "../EncryptionService.ts";

export function encodeBase64(value: Uint8Array): string {
	return Buffer.from(value).toString("base64");
}

export function decodeBase64(value: string): Buffer {
	if (typeof value !== "string" || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
		throw new TypeError("Provider sealed payload is not valid base64");
	}
	return Buffer.from(value, "base64");
}

/** Stream a file into a SHA-256 hex digest without loading it into memory. */
export async function hashFile(filePath: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = createHash("sha256");
		const stream = createReadStream(filePath);
		stream.on("data", (chunk) => hash.update(chunk as Buffer));
		stream.on("error", reject);
		stream.on("end", () => resolve(hash.digest("hex")));
	});
}

export async function readTextBounded(filePath: string, maxBytes: number): Promise<string> {
	const buffer = await readFile(filePath);
	if (buffer.byteLength > maxBytes) {
		throw new RangeError(`File exceeds ${maxBytes} byte limit`);
	}
	return buffer.toString("utf8");
}

/**
 * Walk the path chain from the target up to the sync root and reject any
 * intermediate symlink. This blocks a remote relative path from being routed
 * through an attacker-placed junction inside the sync directory.
 */
export async function ensureNoSymlinkEscape(rootPath: string, targetPath: string): Promise<void> {
	const root = resolve(rootPath);
	const target = resolve(targetPath);
	if (target === root) return;
	let current = target;
	while (current !== root) {
		const parent = dirname(current);
		if (parent === current) break;
		const info = await lstat(parent).catch(() => null);
		if (info && info.isSymbolicLink()) {
			throw new Error(`Cloud sync refuses to write through symlink: ${parent}`);
		}
		current = parent;
	}
}

export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
	const temporary = `${filePath}.tmp-${randomUUID()}`;
	await writeFile(temporary, content, "utf8");
	await rename(temporary, filePath);
}

/** 二进制原子写（DSH 会话 .zstd 恢复用）。 */
export async function writeFileAtomicBytes(filePath: string, content: Buffer): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
	const temporary = `${filePath}.tmp-${randomUUID()}`;
	await writeFile(temporary, content);
	await rename(temporary, filePath);
}

// ── DSH 会话文本/哈希/写回（内容统一按解压后文本处理） ──────────────

/** 读 DSH 会话日志为明文文本（.zstd 解压）。 */
export async function readDshSessionText(filePath: string): Promise<string> {
	const raw = await readFile(filePath);
	if (filePath.endsWith(".zstd")) {
		return zstdDecompressSync(raw).toString("utf8");
	}
	return raw.toString("utf8");
}

/** 目标路径 DSH 会话的解压文本哈希（缺失返回 null）。 */
export async function readDshSessionTextHash(filePath: string): Promise<string | null> {
	try {
		const text = await readDshSessionText(filePath);
		return createHash("sha256").update(text, "utf8").digest("hex");
	} catch {
		return null;
	}
}

/** 写回 DSH 会话：原 .zstd 文件重新压缩后二进制写，否则明文写。 */
export async function writeDshSessionContent(target: string, text: string): Promise<void> {
	if (target.endsWith(".zstd")) {
		await writeFileAtomicBytes(target, zstdCompressSync(Buffer.from(text, "utf8")));
	} else {
		await writeFileAtomic(target, text);
	}
}

/** DSH 会话文件的解压文本 SHA-256。 */
export async function hashDshSessionText(filePath: string): Promise<string> {
	const text = await readDshSessionText(filePath);
	return createHash("sha256").update(text, "utf8").digest("hex");
}

// ── 对象正文信封（AES-256-GCM + gzip） ───────────────────────────────

/** 加密对象正文所需的宿主参数（密码、设备标识、版本）。 */
export interface ObjectEncryptSource {
	password: string;
	deviceId: string;
	deviceName: string;
	appVersion: string;
}

export async function encryptObject(source: ObjectEncryptSource, content: string): Promise<SyncedFile> {
	const salt = generateRandomBytes(CLOUD_SYNC_CONSTANTS.SALT_LENGTH);
	const key = await deriveKey(source.password, salt, CLOUD_SYNC_CONSTANTS.PBKDF2_ITERATIONS);
	// M8：对象正文先 gzip 再加密，显著压缩 JSONL/base64 图片体积。
	const compressed = gzipSync(Buffer.from(content, "utf8")).toString("base64");
	const encrypted = encrypt(compressed, key, salt);
	return {
		meta: {
			version: 1,
			updatedAt: Date.now(),
			deviceId: source.deviceId,
			deviceName: source.deviceName,
			appVersion: source.appVersion,
			iv: encodeBase64(encrypted.iv),
			salt: encodeBase64(encrypted.salt),
			algorithm: "AES-256-GCM",
			kdf: "PBKDF2",
			kdfIterations: encrypted.kdfIterations,
			compressed: "gzip",
		},
		payload: encodeBase64(encrypted.ciphertext),
	};
}

/** 用显式密码解密一个对象条目（备份导入用：先于主密码一致性校验）。 */
export async function decryptObjectWith(bytes: Uint8Array, password: string): Promise<string> {
	const raw = Buffer.from(bytes).toString("utf8");
	const file = JSON.parse(raw) as SyncedFile & { meta: { compressed?: string } };
	const { meta } = file;
	if (meta.algorithm !== "AES-256-GCM" || meta.kdf !== "PBKDF2") throw new TypeError("Unsupported object format");
	const iv = decodeBase64(meta.iv);
	const salt = decodeBase64(meta.salt);
	const key = await deriveKey(password, salt, meta.kdfIterations ?? CLOUD_SYNC_CONSTANTS.PBKDF2_ITERATIONS);
	const plain = decrypt({ ciphertext: decodeBase64(file.payload), iv, salt, kdf: "PBKDF2", kdfIterations: meta.kdfIterations ?? CLOUD_SYNC_CONSTANTS.PBKDF2_ITERATIONS }, key);
	// 旧对象无 compressed 字段：明文即 UTF-8 文本，向后兼容。
	if (meta.compressed === "gzip") {
		return gunzipSync(Buffer.from(plain, "base64")).toString("utf8");
	}
	return plain;
}

export async function decryptObject(bytes: Uint8Array, password: string): Promise<string> {
	return decryptObjectWith(bytes, password);
}
