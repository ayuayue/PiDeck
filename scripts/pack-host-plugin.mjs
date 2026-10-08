#!/usr/bin/env node
// 把宿主插件目录打包为单个 .pideck-plugin 分发文件（NDJSON 格式，逐文件 sha256）。
// 用法: node scripts/pack-host-plugin.mjs <插件目录> [输出文件] （缺省输出 <目录名>.pideck-plugin）
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const MAX_ASSET_BYTES = 4 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 16 * 1024 * 1024;
const MAX_FILE_COUNT = 100;
const ASSET_PATTERN = /^[a-zA-Z0-9_./-]+$/;

// 与 src/main/plugins/hostPluginManifest.ts 的 isHostPluginAsset 同一标准：字符集/段规则，
// 不另加扩展名白名单——目录包允许的文件（如 NOTICE）必须能完整打包/安装/指纹。
function assertAssetPath(path) {
	if (path.length > 240 || !ASSET_PATTERN.test(path) || path.startsWith("/") || path.split("/").some((part) => !part || part === "." || part === "..")) throw new Error(`invalid asset path: ${path}`);
}

async function collect(root) {
	const files = [];
	let total = 0;
	async function visit(prefix, depth) {
		if (depth > 8) throw new Error("package too deep");
		const entries = await readdir(join(root, prefix), { withFileTypes: true });
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			const asset = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isSymbolicLink()) throw new Error(`symlink not allowed: ${asset}`);
			if (entry.isDirectory()) {
				await visit(asset, depth + 1);
				continue;
			}
			if (!entry.isFile()) throw new Error(`unsupported entry: ${asset}`);
			assertAssetPath(asset);
			if (files.length >= MAX_FILE_COUNT) throw new Error("too many files");
			const bytes = await readFile(join(root, asset));
			if (bytes.length > MAX_ASSET_BYTES) throw new Error(`file too large: ${asset}`);
			total += bytes.length;
			if (total > MAX_PACKAGE_BYTES) throw new Error("package too large");
			files.push({ path: asset, bytes });
		}
	}
	await visit("", 0);
	if (!files.some((file) => file.path === "pideck-plugin.json")) throw new Error("missing pideck-plugin.json");
	return files;
}

const [input, outputArg] = process.argv.slice(2);
if (!input) {
	console.error("Usage: node scripts/pack-host-plugin.mjs <plugin-directory> [output.pideck-plugin]");
	process.exit(1);
}
const root = resolve(input);
if (!(await lstat(root)).isDirectory()) throw new Error(`not a directory: ${root}`);
const files = await collect(root);
const lines = [JSON.stringify({ kind: "pideck-host-plugin", formatVersion: 1, files: files.length })];
for (const file of files) {
	lines.push(JSON.stringify({ kind: "file", path: file.path, sha256: createHash("sha256").update(file.bytes).digest("hex"), size: file.bytes.length, data: file.bytes.toString("base64") }));
}
const output = resolve(outputArg ?? `${basename(root)}.pideck-plugin`);
await mkdir(join(output, ".."), { recursive: true });
await writeFile(output, `${lines.join("\n")}\n`);
console.log(`✓ ${files.length} files → ${output} (${Buffer.byteLength(lines.join("\n"))} bytes)`);
