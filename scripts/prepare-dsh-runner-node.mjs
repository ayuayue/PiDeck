#!/usr/bin/env node
/**
 * 开发机可选：从官方 Node 二进制抽出 node.exe 到 resources/dsh-runner-node/。
 * 安装包不带这份文件。用户侧走 pack-dsh-runner-node.mjs + 当前 latest 应用 Release。
 *
 *   node scripts/prepare-dsh-runner-node.mjs [--if-missing] [--force]
 *
 * 版本钉死 NODE_SIDECAR_VERSION，与 CI setup-node 主版本对齐，避免 runner 加载
 * runtime 里给 Node 24 编的 koffi.node 时 ABI 对不上。
 *
 * 只处理 win32：mac/linux 的 electron 当 Node 跑没有 Windows GUI 子系统问题。
 */
import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, renameSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";

const NODE_SIDECAR_VERSION = "24.13.0";
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const destDir = join(projectRoot, "resources", "dsh-runner-node");
const destExe = join(destDir, "node.exe");

const argv = process.argv.slice(2);
const ifMissing = argv.includes("--if-missing");
const force = argv.includes("--force");

if (process.platform !== "win32") {
	console.log("[prepare-dsh-runner-node] skip: not win32");
	process.exit(0);
}

if (ifMissing && existsSync(destExe) && !force) {
	console.log(`[prepare-dsh-runner-node] already present: ${destExe}`);
	process.exit(0);
}

const arch = process.arch === "arm64" ? "arm64" : "x64";
const zipName = `node-v${NODE_SIDECAR_VERSION}-win-${arch}.zip`;
const url = `https://nodejs.org/dist/v${NODE_SIDECAR_VERSION}/${zipName}`;
const innerDir = `node-v${NODE_SIDECAR_VERSION}-win-${arch}`;

async function downloadZip(target) {
	const res = await fetch(url);
	if (!res.ok || !res.body) {
		throw new Error(`download failed ${res.status} ${url}`);
	}
	await pipeline(Readable.fromWeb(res.body), createWriteStream(target));
}

/**
 * 用系统 tar（Windows 10+ 自带 libarchive）只抽出 node.exe。
 * 不解压整个 zip（约 30MB 展开），避免引入 unzipper 依赖。
 */
function extractNodeExe(zipPath) {
	const result = spawnSync("tar", ["-xf", zipPath, "-C", destDir, `${innerDir}/node.exe`], { encoding: "utf8", windowsHide: true });
	if (result.status !== 0) {
		throw new Error(`tar extract failed: ${result.stderr || result.stdout || `exit ${result.status}`}`);
	}
}

mkdirSync(destDir, { recursive: true });
const tmpZip = join(destDir, zipName);
console.log(`[prepare-dsh-runner-node] downloading ${url}`);
try {
	await downloadZip(tmpZip);
	await rm(destExe, { force: true });
	extractNodeExe(tmpZip);
	const extracted = join(destDir, innerDir, "node.exe");
	if (!existsSync(extracted)) {
		throw new Error(`extract missing ${extracted}`);
	}
	renameSync(extracted, destExe);
	await rm(join(destDir, innerDir), { recursive: true, force: true });
} finally {
	await rm(tmpZip, { force: true });
}
if (!existsSync(destExe)) {
	throw new Error(`failed to place ${destExe}`);
}
console.log(`[prepare-dsh-runner-node] wrote ${destExe}`);
