import { createHash } from "node:crypto";
import { isHostPluginAsset } from "./hostPluginManifest";

/**
 * `.pideck-plugin` 分发格式（v1）：NDJSON，首行 header，随后每文件一行。
 * 选择自描述行格式而非 zip：Node 运行时无内置 zip 依赖，逐行解析天然带预算上限，
 * 且每文件 sha256 与体积校验内建在格式里，避免为不可信输入引入第三方解压依赖。
 * header:   {"kind":"pideck-host-plugin","formatVersion":1,"files":N}
 * file line: {"kind":"file","path":"app.html","sha256":"<hex>","size":123,"data":"<base64>"}
 */
const MAX_ARCHIVE_BYTES = 24 * 1024 * 1024; // 展开后 16MiB 包上限 + base64 膨胀 + header 余量
const MAX_ARCHIVE_FILE_BYTES = 4 * 1024 * 1024;
const MAX_ARCHIVE_FILE_COUNT = 100;
const MAX_ARCHIVE_EXPANDED_BYTES = 16 * 1024 * 1024;
const MAX_ARCHIVE_LINE_BYTES = MAX_ARCHIVE_FILE_BYTES + 64 * 1024; // 单行 = base64 数据 + JSON 壳

export type HostPluginArchiveFile = { path: string; bytes: Buffer };
export type HostPluginArchive = { formatVersion: number; files: HostPluginArchiveFile[] };

function archiveFilePath(value: unknown): string {
	if (typeof value !== "string" || !isHostPluginAsset(value)) throw new Error("archive-path-invalid");
	return value;
}

/** 解析不可信归档：全部预算（总体积/单文件/数量/行宽）与逐文件 sha256 都在这里收口。 */
export function parseHostPluginArchive(bytes: Buffer): HostPluginArchive {
	if (bytes.length === 0 || bytes.length > MAX_ARCHIVE_BYTES) throw new Error("archive-too-large");
	const text = bytes.toString("utf8");
	if (text.startsWith("\uFEFF")) throw new Error("archive-invalid");
	const lines = text.split("\n");
	if (lines.length > MAX_ARCHIVE_FILE_COUNT + 2 || lines[lines.length - 1] !== "") throw new Error("archive-invalid");
	lines.pop();
	const headerLine = lines.shift();
	if (headerLine === undefined) throw new Error("archive-invalid");
	let header: unknown;
	try {
		header = JSON.parse(headerLine);
	} catch {
		throw new Error("archive-invalid");
	}
	if (typeof header !== "object" || header === null || (header as Record<string, unknown>).kind !== "pideck-host-plugin" || (header as Record<string, unknown>).formatVersion !== 1 || (header as Record<string, unknown>).files !== lines.length) throw new Error("archive-invalid");
	const files: HostPluginArchiveFile[] = [];
	const seen = new Set<string>();
	let expanded = 0;
	for (const line of lines) {
		if (line.length > MAX_ARCHIVE_LINE_BYTES) throw new Error("archive-line-too-long");
		if (line.endsWith("\r")) throw new Error("archive-invalid");
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			throw new Error("archive-invalid");
		}
		const record = entry as Record<string, unknown>;
		const path = archiveFilePath(record.path);
		const sha256 = typeof record.sha256 === "string" && /^[a-f0-9]{64}$/.test(record.sha256) ? record.sha256 : null;
		const size = typeof record.size === "number" && Number.isSafeInteger(record.size) && record.size >= 0 && record.size <= MAX_ARCHIVE_FILE_BYTES ? record.size : null;
		if (record.kind !== "file" || typeof record.data !== "string" || !sha256 || size === null || seen.has(path)) throw new Error("archive-invalid");
		const bytes = Buffer.from(record.data, "base64");
		// 宽松 base64 解码丢字节会被 sha256 拦截；长度先行拒绝明显谎报的 size。
		if (bytes.length !== size) throw new Error("archive-size-mismatch");
		if (createHash("sha256").update(bytes).digest("hex") !== sha256) throw new Error("archive-hash-mismatch");
		seen.add(path);
		expanded += size;
		if (expanded > MAX_ARCHIVE_EXPANDED_BYTES) throw new Error("archive-expanded-too-large");
		files.push({ path, bytes });
	}
	if (files.length === 0 || !seen.has("pideck-plugin.json")) throw new Error("archive-missing-manifest");
	return { formatVersion: 1, files };
}

/** 开发者侧打包（scripts/pack-host-plugin.mjs 与测试复用）。顺序稳定以便输出可复现。 */
export function buildHostPluginArchive(files: HostPluginArchiveFile[]): Buffer {
	if (files.length === 0 || files.length > MAX_ARCHIVE_FILE_COUNT) throw new Error("archive-invalid");
	const seen = new Set<string>();
	const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	let expanded = 0;
	const lines = [JSON.stringify({ kind: "pideck-host-plugin", formatVersion: 1, files: sorted.length })];
	for (const file of sorted) {
		const path = archiveFilePath(file.path);
		if (seen.has(path)) throw new Error("archive-duplicate-path");
		if (file.bytes.length > MAX_ARCHIVE_FILE_BYTES) throw new Error("archive-file-too-large");
		seen.add(path);
		expanded += file.bytes.length;
		if (expanded > MAX_ARCHIVE_EXPANDED_BYTES) throw new Error("archive-expanded-too-large");
		lines.push(JSON.stringify({ kind: "file", path, sha256: createHash("sha256").update(file.bytes).digest("hex"), size: file.bytes.length, data: file.bytes.toString("base64") }));
	}
	if (!seen.has("pideck-plugin.json")) throw new Error("archive-missing-manifest");
	return Buffer.from(`${lines.join("\n")}\n`, "utf8");
}
