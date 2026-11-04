/**
 * WslHelperDeploy（Wave 1a，见 `docs/wsl-project-in-distro-io-plan.md` 架构决定 3/4）。
 *
 * 要解决的事：helper 的字节必须落在**发行版自己的文件系统**里，并以档案用户身份落
 * ——root 档案的 `/root/.pideck/…` 在 Windows 侧写不进去（9P 按默认用户鉴权）。
 *
 * 为什么不复用 SSH 那套 bootstrap ceremony：那套的 staging/lock/WebCrypto 是为**不受信主机**
 * 设计的，而且它的帧里根本不带文件内容——字节是靠 scp 传进 staging 的。WSL 是本机受信 FS，
 * 一次 `node -e` 带一个 stdin JSON 载荷（文件内容 + 声明摘要）就能完成同样的保证，
 * 所以这里只保留三条不变量：内容地址目录、写前验摘要、rename 是唯一提交点。
 *
 * **bundle 身份只有一个来源**：`frozenHelperBundleManifest()`（7 个 helper 产物 + runner 入口）。
 * 这里不生成第二份清单，也不改动任何一个字节——本地重算 sha256 与 pinned 值不符就直接拒，
 * 于是「审查看到的源码」与「发行版里跑起来的源码」之间没有转换步骤。
 *
 * 目录形状不是可选项：helper 的 `readDeployFacts` 只认 `<deployRoot>/bundles/<64hex>/helper.mjs`，
 * 而 deployRoot 由 helper 自己的 `$HOME` 推导；所以部署脚本也从 `$HOME` 推导（同一个权威，
 * 不在 main 里再拼一遍），成功后把 `deployRoot`/`active` 原样交给会话层，
 * 绝对路径只在 `resolveHelperEntryPath` 一处拼装。
 *
 * 幂等与可重入：同一内容地址重复调用只校验（`reused: true`，不重写、不改已激活目录的 mode）；
 * 崩溃残留只会是一个 `.staging-<nonce>` 目录，下次换个 nonce 继续，半份内容永远不会被当成已激活；
 * 同名目录存在但内容不同是 conflict，**永不覆盖**（不可变 bundle 的意义就在这里）。
 *
 * mode 全部 0600：mode 是内容地址的一部分，而冻结清单没有声明任何可执行文件；
 * helper/runner 都由 `node <path>` 读成模块，不需要 exec 位。
 */

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { opFail, opOk, codeOf, type Op } from "../../shared/op";
import { WSL_HELPER_DEPLOY_CODE_LIST, WSL_HELPER_DEPLOY_CODES } from "../../shared/types/wslHelper";
import { assertSupportedRemoteNodeVersion, REMOTE_BOOTSTRAP_FILE_MODE } from "../remote/RemoteBootstrapContract";
import { frozenHelperBundleManifest } from "../remote/RemoteBootstrapDeployment";
import { REMOTE_BOOTSTRAP_BUNDLE_DIR_NAME } from "../remote/RemoteHelperContract";
import { REMOTE_HELPER_ARTIFACTS } from "../remote/RemoteHelperEntry";
import { REMOTE_RUNNER_ENTRY_FILE_NAME, REMOTE_RUNNER_INLINE_SOURCE } from "../remote/RemoteRunnerEntry";
import { isRemoteRunnerAbsolutePath } from "../remote/RemoteRunnerContract";
import { WSL_PI_BASE_PATH } from "./wslPiProbe";
import { getWslExe } from "./wslExe";

/** 部署的截止：一次写入 ~200KB，冷启 WSL VM 与 9P 抖动都要留余量，但不能无限挂。 */
export const WSL_HELPER_DEPLOY_TIMEOUT_MS = 60_000;

/** 固定入口标记：与脚本内的字面量同一字符串，改它等于改协议。 */
export const WSL_HELPER_DEPLOY_INLINE_ENTRY = "--pideck-wsl-deploy-v1";

/** 输出帽：脚本只写一行结果帧，stderr 里的 node 报错也不需要更多。 */
const WSL_HELPER_DEPLOY_OUTPUT_BYTES = 256 * 1024;

const SHA256 = /^[0-9a-f]{64}$/;
const NONCE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,63}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * 发行版内的部署脚本（冻结体）。读法同 `REMOTE_BOOTSTRAP_INLINE_SOURCE`：
 *
 * - argv：`--pideck-wsl-deploy-v1 <bundleSha256> <nonce>`，别的都不接受；
 * - stdin：一条 JSON 载荷 `{v:1,op:"deploy",bundleSha256,files:[{name,sha256,bytes,mode,data}]}`，
 *   `data` 是 base64 原文——字节只走 stdin，不拼进 argv；
 * - 验摘要 → 在 `$HOME/.pideck/remote-host/.staging-<nonce>`（0700）里逐个 `wx` 写入并 chmod、
 *   读回再算一遍 sha256 并 fsync → `rename` 到 `bundles/<bundleSha256>`（唯一提交点）；
 * - 已存在同一内容地址目录时只做只读复核：内容一致 → `reused`，不一致 → conflict，绝不覆盖；
 * - 结果只回一条 NDJSON：`{v:1,op:"deployed",deployRoot,active,bundleSha256,reused,nodeVersion}`
 *   或 `{v:1,op:"error",code}`；非零退出配合 error 帧，不裸抛堆栈；
 * - 只依赖 `node:fs` / `node:crypto`（老版本 node 也能跑到「报告版本」那一步，版本门槛由 main 判定）。
 *
 * 这个体是按「多行源码 + 折叠空白」维护的（与冻结 helper 同一手法），
 * argv 里始终是单行，换行不会成为 wsl.exe 参数切分的一部分。
 */
export const WSL_HELPER_DEPLOY_INLINE_SOURCE = String.raw`"use strict";
/* PiDeck WSL in-distro bundle deployer (docs/wsl-project-in-distro-io-plan.md Wave 1a, decisions 3/4). argv: --pideck-wsl-deploy-v1 <bundleSha256> <nonce>. One JSON payload on stdin declares the whole file set with base64 bodies. It is the WSL twin of the SSH bootstrap entry minus what only an untrusted host needs: no deploy lock (one local main process, and the rename is still the only commit point) and no upload ceremony (the payload carries the bytes, so there is nothing to scp). */
/* Every byte it may activate is proven twice: the declared body must hash to the declared sha256 before it reaches the disk, and each staged file is read back and re-hashed before the rename. An already active content-addressed directory is never overwritten: it either re-verifies as the identical bundle (reused) or refuses with a conflict. */
const fs = require("node:fs"), crypto = require("node:crypto");
const ENTRY = "--pideck-wsl-deploy-v1";
const DEPLOY_SEGMENTS = [".pideck", "remote-host"];
const BUNDLE_DIR = "bundles";
const STAGING_PREFIX = ".staging-";
const SHA = /^[0-9a-f]{64}$/;
const NONCE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,63}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const MODES = { "0600": 0o600, "0700": 0o700 };
const MAX_FILES = 32, MAX_FILE_BYTES = 8388608, MAX_TOTAL_BYTES = 33554432, MAX_PAYLOAD_BYTES = 67108864, MAX_HOME = 4096;
const INPUT = "WSL_HELPER_DEPLOY_INPUT_INVALID";
const HOME_BAD = "WSL_HELPER_DEPLOY_HOME_INVALID";
const STAGING_BAD = "WSL_HELPER_DEPLOY_STAGING_INVALID";
const MISMATCH = "WSL_HELPER_DEPLOY_FILE_MISMATCH";
const CONFLICT = "WSL_HELPER_DEPLOY_ACTIVE_CONFLICT";
const INTERNAL = "WSL_HELPER_DEPLOY_INTERNAL";
let bundleSha256 = "", nonce = "", deployRoot = "", bundlesDir = "", stagingDir = "", files = [], totalBytes = 0, activated = false, stopped = false;
function out(frame) { try { process.stdout.write(JSON.stringify(frame) + "\n"); } catch {} }
function cleanup() { if (stagingDir !== "" && activated === false) { try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch {} } }
function terminalError() { const error = new Error("settled"); error.terminal = true; return error; }
/* The one writer of the terminal frame: the first caller wins and nothing is ever reported twice. */
function emit(frame, code) { if (stopped === true) return false; stopped = true; if (code === 1) cleanup(); out(frame); process.exitCode = code; return true; }
function fail(code) { emit({ v: 1, op: "error", code: code }, 1); throw terminalError(); }
function succeed(reused) { emit({ v: 1, op: "deployed", deployRoot: deployRoot, active: "./" + BUNDLE_DIR + "/" + bundleSha256, bundleSha256: bundleSha256, reused: reused, nodeVersion: process.version }, 0); throw terminalError(); }
function settle(error) { if (error !== null && typeof error === "object" && error.terminal === true) return; emit({ v: 1, op: "error", code: INTERNAL }, 1); }
function guard(fn) { return function (value) { try { fn(value); } catch (error) { settle(error); } }; }
function hashHex(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
/* Private means: a real directory (not a symlink), owned by this uid, with no group or other bit. It refuses rather than chmods a directory it did not create, exactly like the SSH entry. */
function privateDirectory(target) { let stats = null; try { stats = fs.lstatSync(target); } catch { return false; } if (stats.isDirectory() !== true || stats.isSymbolicLink() === true) return false; if (typeof process.getuid === "function") { if (stats.uid !== process.getuid()) return false; if ((stats.mode & 0o077) !== 0) return false; } return true; }
/* mode 0700 survives any umask: the argument only ever removes bits and 0700 has none outside the owner. */
function makePrivateDirectory(target) { try { fs.mkdirSync(target, { recursive: true, mode: 0o700 }); } catch { fail(HOME_BAD); } if (privateDirectory(target) !== true) fail(HOME_BAD); return target; }
function prepareRoot() { const home = process.env.HOME; if (typeof home !== "string" || home.length === 0 || home.length > MAX_HOME || home === "/" || home.charAt(0) !== "/" || CONTROL.test(home) === true) fail(HOME_BAD); const segments = home.slice(1).split("/"); for (let index = 0; index < segments.length; index += 1) { const segment = segments[index]; if (segment === "" || segment === "." || segment === "..") fail(HOME_BAD); } deployRoot = home; for (let index = 0; index < DEPLOY_SEGMENTS.length; index += 1) { deployRoot = deployRoot + "/" + DEPLOY_SEGMENTS[index]; makePrivateDirectory(deployRoot); } bundlesDir = makePrivateDirectory(deployRoot + "/" + BUNDLE_DIR); }
function activeTarget() { return bundlesDir + "/" + bundleSha256; }
function exists(target) { try { fs.lstatSync(target); return true; } catch { return false; } }
function readDeclaredFile(entry) { if (entry === null || typeof entry !== "object" || Array.isArray(entry)) fail(INPUT); const name = entry.name; if (typeof name !== "string" || NAME.test(name) === false) fail(INPUT); if (typeof entry.sha256 !== "string" || SHA.test(entry.sha256) === false) fail(INPUT); if (typeof entry.bytes !== "number" || Number.isSafeInteger(entry.bytes) === false || entry.bytes < 0 || entry.bytes > MAX_FILE_BYTES) fail(INPUT); if (typeof entry.mode !== "string" || Object.prototype.hasOwnProperty.call(MODES, entry.mode) === false) fail(INPUT); if (typeof entry.data !== "string") fail(INPUT); const bytes = Buffer.from(entry.data, "base64"); if (bytes.length !== entry.bytes || hashHex(bytes) !== entry.sha256) fail(MISMATCH); return { name: name, sha256: entry.sha256, bytes: entry.bytes, mode: MODES[entry.mode], data: bytes }; }
function readPayload(text) { let value = null; try { value = JSON.parse(text); } catch { fail(INPUT); } if (value === null || typeof value !== "object" || Array.isArray(value)) fail(INPUT); if (value.v !== 1 || value.op !== "deploy" || value.bundleSha256 !== bundleSha256) fail(INPUT); const list = value.files; if (Array.isArray(list) === false || list.length === 0 || list.length > MAX_FILES) fail(INPUT); const seen = new Set(); for (let index = 0; index < list.length; index += 1) { const entry = readDeclaredFile(list[index]); if (seen.has(entry.name)) fail(INPUT); seen.add(entry.name); totalBytes += entry.bytes; if (totalBytes > MAX_TOTAL_BYTES) fail(INPUT); files.push(entry); } }
function stageFile(entry) { const file = stagingDir + "/" + entry.name; try { fs.writeFileSync(file, entry.data, { flag: "wx", mode: entry.mode }); fs.chmodSync(file, entry.mode); } catch { fail(STAGING_BAD); } }
function fsyncFile(file) { const handle = fs.openSync(file, "r+"); try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); } }
function verifyStaged(entry) { const file = stagingDir + "/" + entry.name; let stats = null; try { stats = fs.lstatSync(file); } catch { fail(MISMATCH); } if (stats.isFile() !== true || stats.isSymbolicLink() === true || stats.size !== entry.bytes) fail(MISMATCH); if (typeof process.getuid === "function" && (stats.uid !== process.getuid() || (stats.mode & 0o777) !== entry.mode)) fail(MISMATCH); let data = null; try { data = fs.readFileSync(file); } catch { fail(MISMATCH); } if (data.length !== entry.bytes || hashHex(data) !== entry.sha256) fail(MISMATCH); try { fsyncFile(file); } catch { fail(STAGING_BAD); } }
/* Read-only look at an already active directory: nothing is written, chmodded or removed, so a deviation is a conflict to report rather than damage to repair. */
function matchesDeclaration(dir) { let present = null; try { present = fs.readdirSync(dir); } catch { return false; } if (present.length !== files.length) return false; for (let index = 0; index < files.length; index += 1) { const entry = files[index]; if (present.indexOf(entry.name) < 0) return false; const file = dir + "/" + entry.name; let stats = null; try { stats = fs.lstatSync(file); } catch { return false; } if (stats.isFile() !== true || stats.isSymbolicLink() === true || stats.size !== entry.bytes) return false; if (typeof process.getuid === "function" && (stats.uid !== process.getuid() || (stats.mode & 0o777) !== entry.mode)) return false; let data = null; try { data = fs.readFileSync(file); } catch { return false; } if (data.length !== entry.bytes || hashHex(data) !== entry.sha256) return false; } return true; }
/* Directory fsync only buys durability - the rename is the commit point - so a filesystem that refuses it must not fail an otherwise verified deployment. */
function fsyncDirectory(target) { try { const handle = fs.openSync(target, "r"); try { fs.fsyncSync(handle); } catch {} try { fs.closeSync(handle); } catch {} } catch {} }
function createStaging() { stagingDir = deployRoot + "/" + STAGING_PREFIX + nonce; try { fs.mkdirSync(stagingDir, { mode: 0o700 }); } catch { fail(STAGING_BAD); } if (privateDirectory(stagingDir) !== true) fail(STAGING_BAD); }
/* The whole directory is renamed, so an undeclared leftover would be activated unverified: the staged set must equal the declared set. */
function commit(text) { readPayload(text); prepareRoot(); const target = activeTarget(); if (exists(target) === true) { if (matchesDeclaration(target) === true) succeed(true); fail(CONFLICT); } createStaging(); for (let index = 0; index < files.length; index += 1) stageFile(files[index]); for (let index = 0; index < files.length; index += 1) verifyStaged(files[index]); let present = null; try { present = fs.readdirSync(stagingDir); } catch { fail(STAGING_BAD); } if (present.length !== files.length) fail(MISMATCH); try { fs.renameSync(stagingDir, target); } catch { if (exists(target) === true) { if (matchesDeclaration(target) === true) succeed(true); fail(CONFLICT); } fail(STAGING_BAD); } activated = true; stagingDir = ""; fsyncDirectory(bundlesDir); fsyncDirectory(deployRoot); succeed(false); }
function main() { const argv = process.argv.slice(1); if (argv.length !== 3 || argv[0] !== ENTRY) fail(INPUT); bundleSha256 = argv[1]; if (SHA.test(bundleSha256) === false) fail(INPUT); nonce = argv[2]; if (NONCE.test(nonce) === false) fail(INPUT); const chunks = []; let length = 0; process.stdin.on("data", guard(function (chunk) { length += chunk.length; if (length > MAX_PAYLOAD_BYTES) fail(INPUT); chunks.push(chunk); })); process.stdin.on("end", guard(function () { commit(Buffer.concat(chunks).toString("utf8")); })); process.stdin.on("error", guard(function () { fail(INPUT); })); }
try { main(); } catch (error) { settle(error); }`.replace(/\r?\n[\t ]*/g, "");

export type WslHelperDeployRequest = { bundleSha256: string; payload: string };

/**
 * 部署请求。身份取自 `frozenHelperBundleManifest()`，源码取自同一批产物表：
 * 每个文件的字节数与前缀摘要在这里再算一遍，与 pinned 值不符即 `fileMismatch`，
 * 绝不把「清单说有、源码却不是」的文件写进发行版。
 */
export function buildWslHelperDeployRequest(): WslHelperDeployRequest {
	const manifest = frozenHelperBundleManifest();
	const sources = new Map<string, string>([...REMOTE_HELPER_ARTIFACTS.map((artifact) => [artifact.name, artifact.source] as const), [REMOTE_RUNNER_ENTRY_FILE_NAME, REMOTE_RUNNER_INLINE_SOURCE] as const]);
	const files = manifest.files.map((file) => {
		const source = sources.get(file.name);
		if (source === undefined) throw new Error(WSL_HELPER_DEPLOY_CODES.fileMismatch);
		const bytes = Buffer.from(source, "utf8");
		if (bytes.length !== file.bytes || createHash("sha256").update(bytes).digest("hex") !== file.sha256) throw new Error(WSL_HELPER_DEPLOY_CODES.fileMismatch);
		return { name: file.name, sha256: file.sha256, bytes: file.bytes, mode: REMOTE_BOOTSTRAP_FILE_MODE, data: bytes.toString("base64") };
	});
	return { bundleSha256: manifest.bundleSha256, payload: JSON.stringify({ v: 1, op: "deploy", bundleSha256: manifest.bundleSha256, files }) };
}

/** 一次新的部署标识；staging 目录名只由它决定，所以每次调用都不会撞上上一次的残留。 */
export function newWslHelperDeployNonce(): string {
	return randomUUID().replace(/-/g, "");
}

/**
 * `wsl.exe` argv：与 `buildWslPiExecArgs` 同一口径——`-e` 直接 exec（不经 shell 二次解析），
 * `env PATH=<node bin>:<系统目录>` 让 `node` 找得到（版本管理器装在非默认位置也不受影响）。
 */
export function buildWslHelperDeployArgs(input: { distro: string; user: string; nodeBinDir: string; nonce: string; bundleSha256: string }): string[] {
	const { distro, user, nonce, bundleSha256 } = input;
	if (typeof distro !== "string" || distro.length === 0 || CONTROL_CHARS.test(distro)) throw new Error(WSL_HELPER_DEPLOY_CODES.inputInvalid);
	if (typeof user !== "string" || user.length === 0 || CONTROL_CHARS.test(user)) throw new Error(WSL_HELPER_DEPLOY_CODES.inputInvalid);
	if (typeof nonce !== "string" || !NONCE.test(nonce)) throw new Error(WSL_HELPER_DEPLOY_CODES.inputInvalid);
	if (typeof bundleSha256 !== "string" || !SHA256.test(bundleSha256)) throw new Error(WSL_HELPER_DEPLOY_CODES.inputInvalid);
	if (!isAbsoluteLinuxPath(input.nodeBinDir)) throw new Error(WSL_HELPER_DEPLOY_CODES.inputInvalid);
	const pathValue = input.nodeBinDir === "/" ? WSL_PI_BASE_PATH : `${input.nodeBinDir}:${WSL_PI_BASE_PATH}`;
	return ["-d", distro, "-u", user, "-e", "/usr/bin/env", `PATH=${pathValue}`, "node", "-e", WSL_HELPER_DEPLOY_INLINE_SOURCE, "--", WSL_HELPER_DEPLOY_INLINE_ENTRY, bundleSha256, nonce];
}

function isAbsoluteLinuxPath(value: unknown): value is string {
	return typeof value === "string" && value.startsWith("/") && !CONTROL_CHARS.test(value) && value.length <= 4096;
}

export type WslHelperDeployment = {
	/** helper 从自己的 `$HOME` 解析出的部署根（绝对 POSIX 路径）。 */
	deployRoot: string;
	/** 已激活的内容地址目录，相对部署根，形如 `./bundles/<64hex>`。 */
	active: string;
	bundleSha256: string;
	/** true = 发行版里已有同一 bundle，本次没有写任何字节。 */
	reused: boolean;
	/** 运行部署脚本的 node 版本（`process.version`）；门槛判定在 main 侧用与 SSH 同一个函数。 */
	nodeVersion: string;
};

export type WslHelperDeployExecInput = { args: readonly string[]; stdin: string; timeoutMs: number };
export type WslHelperDeployExecOutput = { code: number; stdout: Buffer | string };
/** 可注入执行端口：单测用它证明 argv/stdin 形状与退出码映射，不真跑 wsl.exe。 */
export type WslHelperDeployExec = (input: WslHelperDeployExecInput) => Promise<WslHelperDeployExecOutput>;

export type WslHelperDeployDeps = {
	exec?: WslHelperDeployExec;
	platform?: NodeJS.Platform;
	nonce?: string;
	timeoutMs?: number;
};

const defaultExec: WslHelperDeployExec = (input) =>
	new Promise((resolve, reject) => {
		const exe = getWslExe();
		// shell 回退会把 argv 里的字符变成命令语法：宁可失败，也不经 shell。
		if (exe.shell || (isAbsolute(exe.command) && !existsSync(exe.command))) {
			reject(new Error(WSL_HELPER_DEPLOY_CODES.unavailable));
			return;
		}
		const child = execFile(exe.command, [...input.args], { timeout: input.timeoutMs, windowsHide: true, shell: false, encoding: "utf8", maxBuffer: WSL_HELPER_DEPLOY_OUTPUT_BYTES }, (error, stdout) => {
			if (error === null) {
				resolve({ code: 0, stdout });
				return;
			}
			const status = (error as NodeJS.ErrnoException & { code?: number | string }).code;
			// 非零退出是协议的一部分（脚本会先写 error 帧再退出），带已写出的 stdout 一起回。
			if (typeof status === "number") resolve({ code: status, stdout });
			else reject(error);
		});
		// `execFile` 没有 `input` 选项（那是 `execSync` 的）：不显式 end，脚本会永远等 stdin EOF
		// 直到超时。脚本早退（如 INPUT_INVALID）时管道关闭报 EPIPE，属于预期，吞掉即可。
		child.stdin?.on("error", () => undefined);
		child.stdin?.end(input.stdin, "utf8");
	});

function parseFrame(line: string): Record<string, unknown> | null {
	try {
		const value: unknown = JSON.parse(line);
		return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/**
 * 解析脚本输出。取**最后一条**可解析的帧：stdout 只该有协议行，但极端情况（node 警告）也不该让
 * 一条噪音遮住真正的结果。返回值是「脚本的结论」而不是「HTTP 语义」——退出码由调用方再核对。
 */
export function parseWslHelperDeployOutput(stdout: string): { status: "deployed"; deployment: WslHelperDeployment } | { status: "error"; code: string } | { status: "unknown" } {
	const lines = String(stdout ?? "").split(/\r?\n/);
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index].trim();
		if (line === "" || !line.startsWith("{")) continue;
		const frame = parseFrame(line);
		if (frame === null || frame.v !== 1) continue;
		if (frame.op === "error") {
			const code = typeof frame.code === "string" && (WSL_HELPER_DEPLOY_CODE_LIST as readonly string[]).includes(frame.code) ? frame.code : WSL_HELPER_DEPLOY_CODES.unavailable;
			return { status: "error", code };
		}
		if (frame.op !== "deployed") continue;
		const deployRoot = frame.deployRoot;
		const bundleSha256 = frame.bundleSha256;
		const active = frame.active;
		const reused = frame.reused;
		const nodeVersion = frame.nodeVersion;
		if (!isRemoteRunnerAbsolutePath(deployRoot)) return { status: "error", code: WSL_HELPER_DEPLOY_CODES.internal };
		if (typeof bundleSha256 !== "string" || !SHA256.test(bundleSha256) || typeof active !== "string" || active !== `./${REMOTE_BOOTSTRAP_BUNDLE_DIR_NAME}/${bundleSha256}`) return { status: "error", code: WSL_HELPER_DEPLOY_CODES.internal };
		if (typeof reused !== "boolean" || typeof nodeVersion !== "string") return { status: "error", code: WSL_HELPER_DEPLOY_CODES.internal };
		return { status: "deployed", deployment: { deployRoot, active, bundleSha256, reused, nodeVersion } };
	}
	return { status: "unknown" };
}

/**
 * 把 helper bundle 部署进发行版。
 *
 * 失败语义全部是 `rejected`：部署是内容地址化的幂等写入，没有任何一条失败会让调用方需要「去核对」。
 * node 版本不足沿用 SSH 的 `REMOTE_NODE_VERSION_UNSUPPORTED`（同一个判定函数），
 * 不用 WSL 专属码另立一套门槛。
 */
export async function deployWslHelperBundle(input: { distro: string; user: string; nodeBinDir: string }, deps: WslHelperDeployDeps = {}): Promise<Op<WslHelperDeployment>> {
	if ((deps.platform ?? process.platform) !== "win32") return opFail(WSL_HELPER_DEPLOY_CODES.unavailable);
	if (!isAbsoluteLinuxPath(input?.nodeBinDir)) return opFail(WSL_HELPER_DEPLOY_CODES.inputInvalid);
	let request: WslHelperDeployRequest;
	try {
		request = buildWslHelperDeployRequest();
	} catch (error) {
		return opFail(codeOf(error, WSL_HELPER_DEPLOY_CODES.fileMismatch));
	}
	let args: string[];
	try {
		args = buildWslHelperDeployArgs({ ...input, nonce: deps.nonce ?? newWslHelperDeployNonce(), bundleSha256: request.bundleSha256 });
	} catch (error) {
		return opFail(codeOf(error, WSL_HELPER_DEPLOY_CODES.inputInvalid));
	}
	const run = deps.exec ?? defaultExec;
	let output: WslHelperDeployExecOutput;
	try {
		output = await run({ args, stdin: request.payload, timeoutMs: deps.timeoutMs ?? WSL_HELPER_DEPLOY_TIMEOUT_MS });
	} catch (error) {
		return opFail(codeOf(error, WSL_HELPER_DEPLOY_CODES.unavailable));
	}
	const parsed = parseWslHelperDeployOutput(Buffer.isBuffer(output.stdout) ? output.stdout.toString("utf8") : String(output.stdout ?? ""));
	if (parsed.status === "error") return opFail(parsed.code);
	// 只有「退出 0 + deployed 帧」才算成功：这两个事实描述的是同一件事，缺一不可。
	if (output.code !== 0 || parsed.status !== "deployed") return opFail(WSL_HELPER_DEPLOY_CODES.unavailable);
	try {
		assertSupportedRemoteNodeVersion(parsed.deployment.nodeVersion);
	} catch (error) {
		return opFail(codeOf(error, WSL_HELPER_DEPLOY_CODES.unavailable));
	}
	return opOk(parsed.deployment);
}
