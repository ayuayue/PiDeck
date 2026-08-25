/**
 * PiDeck backup container (`.pideckbackup`): a single-file, streaming-friendly
 * envelope for offline export/import.
 *
 * Layout (all integers little-endian):
 *
 *   magic          "PIDECKBACKUP" (12 bytes, ASCII)
 *   formatVersion  u32            (1)
 *   headerLength   u32
 *   header         encrypted manifest JSON (SyncedFile envelope stringified)
 *   entries…       repeated:
 *                    nameLength  u16
 *                    name        UTF-8 object key (e.g. pideck-sessions/<id>.jsonl.enc)
 *                    size        u64
 *                    bytes       encrypted object payload (same bytes as cloud objects)
 *
 * The header carries the PiDeck index + entry manifest; entries are the
 * already-encrypted session/resource objects, byte-identical to what cloud
 * providers store, so export/import and cloud sync share one decryption path.
 *
 * Size bounds mirror the sync limits: header ≤ 16MB, single entry ≤ 512MB,
 * entry name ≤ 512 bytes. All bounds are enforced on read so a corrupt or
 * hostile file cannot exhaust memory.
 */

import { open, type FileHandle } from "node:fs/promises";
import type { PiDeckSyncIndexV1 } from "../../shared/types/cloudSync.ts";

export const BACKUP_MAGIC = "PIDECKBACKUP";
export const BACKUP_FORMAT_VERSION = 1;
export const BACKUP_MAX_HEADER_BYTES = 16 * 1024 * 1024;
export const BACKUP_MAX_ENTRY_BYTES = 512 * 1024 * 1024;
export const BACKUP_MAX_NAME_BYTES = 512;

const MAGIC_BYTES = Buffer.from(BACKUP_MAGIC, "ascii");
const PREFIX_BYTES = MAGIC_BYTES.length + 4 + 4;

export interface BackupEntry {
	name: string;
	bytes: Uint8Array;
}

/** Encrypted header payload: sync index + entry manifest. */
export interface PiDeckBackupManifestV1 {
	schemaVersion: 1;
	createdAt: number;
	deviceId: string;
	deviceName?: string;
	appVersion?: string;
	index: PiDeckSyncIndexV1;
	entries: Array<{ name: string; hash: string; size: number }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate the decrypted manifest with the same bounded, defensive style as the index validator. */
export function parseBackupManifest(raw: string): PiDeckBackupManifestV1 {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new TypeError("Backup manifest is not valid JSON");
	}
	if (!isRecord(parsed)) throw new TypeError("Backup manifest is invalid");
	if (parsed.schemaVersion !== 1) throw new TypeError("Backup manifest schema is unsupported");
	if (typeof parsed.createdAt !== "number" || !Number.isFinite(parsed.createdAt)) {
		throw new TypeError("Backup manifest created-at is invalid");
	}
	if (typeof parsed.deviceId !== "string" || parsed.deviceId.length === 0) {
		throw new TypeError("Backup manifest device id is invalid");
	}
	if (!isRecord(parsed.index) || !Array.isArray(parsed.index.projects)) {
		throw new TypeError("Backup manifest index is invalid");
	}
	if (!Array.isArray(parsed.entries)) throw new TypeError("Backup manifest entries are invalid");
	const entries: PiDeckBackupManifestV1["entries"] = [];
	for (const entry of parsed.entries) {
		if (
			!isRecord(entry) ||
			typeof entry.name !== "string" ||
			entry.name.length === 0 ||
			entry.name.length > BACKUP_MAX_NAME_BYTES ||
			typeof entry.hash !== "string" ||
			entry.hash.length !== 64 ||
			typeof entry.size !== "number" ||
			!Number.isSafeInteger(entry.size) ||
			entry.size < 0 ||
			entry.size > BACKUP_MAX_ENTRY_BYTES
		) {
			throw new TypeError("Backup manifest entry is invalid");
		}
		entries.push({ name: entry.name, hash: entry.hash, size: entry.size });
	}
	return {
		schemaVersion: 1,
		createdAt: parsed.createdAt,
		deviceId: parsed.deviceId,
		...(typeof parsed.deviceName === "string" ? { deviceName: parsed.deviceName } : {}),
		...(typeof parsed.appVersion === "string" ? { appVersion: parsed.appVersion } : {}),
		index: parsed.index as unknown as PiDeckSyncIndexV1,
		entries,
	};
}

export interface ParsedBackupContainer {
	formatVersion: number;
	headerBytes: Uint8Array;
	entries: BackupEntry[];
}

function assertEntryName(name: string): Buffer {
	const encoded = Buffer.from(name, "utf8");
	if (encoded.length === 0 || encoded.length > BACKUP_MAX_NAME_BYTES) {
		throw new TypeError("Backup entry name is invalid");
	}
	return encoded;
}

function assertEntrySize(size: number): void {
	if (!Number.isSafeInteger(size) || size < 0 || size > BACKUP_MAX_ENTRY_BYTES) {
		throw new TypeError("Backup entry size is invalid");
	}
}

/** Encode a whole container in memory (tests and small exports). */
export function encodeBackupContainer(headerBytes: Uint8Array, entries: BackupEntry[]): Uint8Array {
	if (headerBytes.byteLength > BACKUP_MAX_HEADER_BYTES) {
		throw new TypeError("Backup header is too large");
	}
	const parts: Buffer[] = [
		MAGIC_BYTES,
		writeU32LE(BACKUP_FORMAT_VERSION),
		writeU32LE(headerBytes.byteLength),
		Buffer.from(headerBytes),
	];
	for (const entry of entries) {
		const name = assertEntryName(entry.name);
		assertEntrySize(entry.bytes.byteLength);
		parts.push(writeU16LE(name.byteLength), name, writeU64LE(entry.bytes.byteLength), Buffer.from(entry.bytes));
	}
	return Buffer.concat(parts);
}

/** Parse a whole container in memory with the same bounds as the streaming reader. */
export function parseBackupContainer(data: Uint8Array): ParsedBackupContainer {
	const buffer = Buffer.from(data);
	if (buffer.byteLength < PREFIX_BYTES) {
		throw new Error("Backup file is truncated");
	}
	if (!buffer.subarray(0, MAGIC_BYTES.length).equals(MAGIC_BYTES)) {
		throw new Error("Not a PiDeck backup file");
	}
	const formatVersion = buffer.readUInt32LE(MAGIC_BYTES.length);
	if (formatVersion !== BACKUP_FORMAT_VERSION) {
		throw new Error(`Unsupported backup format version ${formatVersion}`);
	}
	const headerLength = buffer.readUInt32LE(MAGIC_BYTES.length + 4);
	if (headerLength > BACKUP_MAX_HEADER_BYTES) {
		throw new Error("Backup header is too large");
	}
	let offset = PREFIX_BYTES;
	if (offset + headerLength > buffer.byteLength) {
		throw new Error("Backup file is truncated");
	}
	const headerBytes = buffer.subarray(offset, offset + headerLength);
	offset += headerLength;

	const entries: BackupEntry[] = [];
	while (offset < buffer.byteLength) {
		if (offset + 2 > buffer.byteLength) {
			throw new Error("Backup entry header is truncated");
		}
		const nameLength = buffer.readUInt16LE(offset);
		offset += 2;
		if (nameLength === 0 || nameLength > BACKUP_MAX_NAME_BYTES) {
			throw new Error("Backup entry name is invalid");
		}
		if (offset + nameLength > buffer.byteLength) {
			throw new Error("Backup entry name is truncated");
		}
		const name = buffer.subarray(offset, offset + nameLength).toString("utf8");
		offset += nameLength;
		const size = Number(buffer.readBigUInt64LE(offset));
		offset += 8;
		assertEntrySize(size);
		if (offset + size > buffer.byteLength) {
			throw new Error("Backup entry is truncated");
		}
		entries.push({ name, bytes: buffer.subarray(offset, offset + size) });
		offset += size;
	}
	return { formatVersion, headerBytes, entries };
}

/** Streaming writer: header first, then entries, then close. */
export class BackupFileWriter {
	private readonly handle: FileHandle;
	private position = 0;

	private constructor(handle: FileHandle) {
		this.handle = handle;
	}

	static async create(filePath: string): Promise<BackupFileWriter> {
		const handle = await open(filePath, "w");
		return new BackupFileWriter(handle);
	}

	async writeHeader(headerBytes: Uint8Array): Promise<void> {
		if (headerBytes.byteLength > BACKUP_MAX_HEADER_BYTES) {
			throw new TypeError("Backup header is too large");
		}
		const prefix = Buffer.concat([
			MAGIC_BYTES,
			writeU32LE(BACKUP_FORMAT_VERSION),
			writeU32LE(headerBytes.byteLength),
		]);
		await this.writeAt(prefix);
		await this.writeAt(Buffer.from(headerBytes));
	}

	async writeEntry(entry: BackupEntry): Promise<void> {
		const name = assertEntryName(entry.name);
		assertEntrySize(entry.bytes.byteLength);
		const head = Buffer.concat([writeU16LE(name.byteLength), name, writeU64LE(entry.bytes.byteLength)]);
		await this.writeAt(head);
		await this.writeAt(Buffer.from(entry.bytes));
	}

	async close(): Promise<void> {
		await this.handle.close();
	}

	private async writeAt(buffer: Buffer): Promise<void> {
		const { bytesWritten } = await this.handle.write(buffer, 0, buffer.byteLength, this.position);
		if (bytesWritten !== buffer.byteLength) {
			throw new Error("Backup write failed (short write)");
		}
		this.position += bytesWritten;
	}
}

/** Streaming reader: read the header, then iterate entries one at a time. */
export class BackupFileReader {
	private readonly handle: FileHandle;
	private position = 0;
	private header: { formatVersion: number; headerBytes: Uint8Array } | null = null;

	private constructor(handle: FileHandle) {
		this.handle = handle;
	}

	static async open(filePath: string): Promise<BackupFileReader> {
		const handle = await open(filePath, "r");
		return new BackupFileReader(handle);
	}

	async readHeader(): Promise<{ formatVersion: number; headerBytes: Uint8Array }> {
		if (this.header) return this.header;
		const prefix = Buffer.alloc(PREFIX_BYTES);
		const read = await this.readFull(prefix, 0, PREFIX_BYTES);
		if (read < PREFIX_BYTES) {
			throw new Error("Backup file is truncated");
		}
		if (!prefix.subarray(0, MAGIC_BYTES.length).equals(MAGIC_BYTES)) {
			throw new Error("Not a PiDeck backup file");
		}
		const formatVersion = prefix.readUInt32LE(MAGIC_BYTES.length);
		if (formatVersion !== BACKUP_FORMAT_VERSION) {
			throw new Error(`Unsupported backup format version ${formatVersion}`);
		}
		const headerLength = prefix.readUInt32LE(MAGIC_BYTES.length + 4);
		if (headerLength > BACKUP_MAX_HEADER_BYTES) {
			throw new Error("Backup header is too large");
		}
		const headerBytes = Buffer.alloc(headerLength);
		const readHeader = await this.readFull(headerBytes, 0, headerLength);
		if (readHeader < headerLength) {
			throw new Error("Backup header is truncated");
		}
		this.header = { formatVersion, headerBytes };
		return this.header;
	}

	async *entries(): AsyncGenerator<BackupEntry> {
		await this.readHeader();
		for (;;) {
			// 布局：nameLength(u16) + name + size(u64) + bytes —— name 在中间，必须分段读。
			const nameLengthBuffer = Buffer.alloc(2);
			const readLength = await this.readFull(nameLengthBuffer, 0, 2);
			if (readLength === 0) return; // clean EOF
			if (readLength < 2) {
				throw new Error("Backup entry header is truncated");
			}
			const nameLength = nameLengthBuffer.readUInt16LE(0);
			if (nameLength === 0 || nameLength > BACKUP_MAX_NAME_BYTES) {
				throw new Error("Backup entry name is invalid");
			}
			const nameBuffer = Buffer.alloc(nameLength);
			const readName = await this.readFull(nameBuffer, 0, nameLength);
			if (readName < nameLength) {
				throw new Error("Backup entry name is truncated");
			}
			const sizeBuffer = Buffer.alloc(8);
			const readSize = await this.readFull(sizeBuffer, 0, 8);
			if (readSize < 8) {
				throw new Error("Backup entry size is truncated");
			}
			const size = Number(sizeBuffer.readBigUInt64LE(0));
			assertEntrySize(size);
			const bytes = Buffer.alloc(size);
			const readBytes = await this.readFull(bytes, 0, size);
			if (readBytes < size) {
				throw new Error("Backup entry is truncated");
			}
			yield { name: nameBuffer.toString("utf8"), bytes };
		}
	}

	async close(): Promise<void> {
		await this.handle.close();
	}

	private async readFull(buffer: Buffer, offset: number, length: number): Promise<number> {
		let total = 0;
		while (total < length) {
			const { bytesRead } = await this.handle.read(buffer, offset + total, length - total, this.position + total);
			if (bytesRead === 0) break;
			total += bytesRead;
		}
		this.position += total;
		return total;
	}
}

function writeU16LE(value: number): Buffer {
	const buffer = Buffer.alloc(2);
	buffer.writeUInt16LE(value, 0);
	return buffer;
}

function writeU32LE(value: number): Buffer {
	const buffer = Buffer.alloc(4);
	buffer.writeUInt32LE(value, 0);
	return buffer;
}

function writeU64LE(value: number): Buffer {
	const buffer = Buffer.alloc(8);
	buffer.writeBigUInt64LE(BigInt(value), 0);
	return buffer;
}
