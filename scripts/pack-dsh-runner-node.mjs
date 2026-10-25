#!/usr/bin/env node
/**
 * 打包 Windows DSH 沙箱用的 Node 24（不进安装包）。
 *
 *   node scripts/pack-dsh-runner-node.mjs [--out <dir>] [--arch x64|arm64] [--force]
 *
 * 从官方 nodejs.org 拉 zip，计算 sha256，写出：
 *   dist-runtime/dsh-runner-node/node-v24.13.0-win-<arch>.zip
 *   dist-runtime/dsh-runner-node/dsh-runner-node-releases.json
 *
 * 索引里的 url 先写官方包地址作占位；挂到当前 latest 应用 Release（vX.Y.Z）后
 * 由客户端按 updateSource 改写为 latest 资产地址。禁止独立 sidecar tag（会抢走
 * GitHub /releases/latest）。客户端永不直连 nodejs.org。
 *
 * 只在 win32 CI / 维护者本机跑；mac/linux 跳过（沙箱不需要 CUI sidecar）。
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";

const NODE_SIDECAR_VERSION = "24.13.0";
const INDEX_FILE = "dsh-runner-node-releases.json";
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const force = argv.includes("--force");
const outIndex = argv.indexOf("--out");
const outDir = outIndex >= 0 ? resolve(argv[outIndex + 1]) : join(projectRoot, "dist-runtime", "dsh-runner-node");
const archArgIndex = argv.indexOf("--arch");
const archArg = archArgIndex >= 0 ? argv[archArgIndex + 1] : undefined;

function zipName(version, arch) {
	return `node-v${version}-win-${arch}.zip`;
}

function officialUrl(version, arch) {
	return `https://nodejs.org/dist/v${version}/${zipName(version, arch)}`;
}

function targetArches() {
	if (archArg === "x64" || archArg === "arm64") return [archArg];
	if (process.platform !== "win32") return ["x64", "arm64"];
	return [process.arch === "arm64" ? "arm64" : "x64"];
}

async function download(url, dest) {
	const res = await fetch(url);
	if (!res.ok || !res.body) {
		throw new Error(`download failed ${res.status} ${url}`);
	}
	await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

async function sha256OfFile(filePath) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(filePath)) hash.update(chunk);
	return hash.digest("hex");
}

mkdirSync(outDir, { recursive: true });
const releases = [];
for (const arch of targetArches()) {
	const name = zipName(NODE_SIDECAR_VERSION, arch);
	const dest = join(outDir, name);
	const url = officialUrl(NODE_SIDECAR_VERSION, arch);
	if (!existsSync(dest) || force) {
		console.log(`[pack-dsh-runner-node] downloading ${url}`);
		await download(url, dest);
	} else {
		console.log(`[pack-dsh-runner-node] reuse ${dest}`);
	}
	const sha256 = await sha256OfFile(dest);
	const size = statSync(dest).size;
	releases.push({
		version: NODE_SIDECAR_VERSION,
		arch,
		url,
		sha256,
		size,
	});
	console.log(`[pack-dsh-runner-node] ${name} ${size} bytes sha256=${sha256}`);
}

const indexPath = join(outDir, INDEX_FILE);
const merged = new Map();
if (existsSync(indexPath)) {
	try {
		const previous = JSON.parse(readFileSync(indexPath, "utf8"));
		for (const entry of previous?.releases ?? []) {
			if (entry?.arch && entry?.version) merged.set(`${entry.version}:${entry.arch}`, entry);
		}
	} catch {
		/* 损坏索引整份重写 */
	}
}
for (const entry of releases) merged.set(`${entry.version}:${entry.arch}`, entry);
const index = { schemaVersion: 1, releases: [...merged.values()] };
writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
console.log(`[pack-dsh-runner-node] wrote ${indexPath}`);
console.log("[pack-dsh-runner-node] 上传到当前 latest 应用 Release（vX.Y.Z）后客户端即可按需下载");
