/**
 * Bootstrap contract for the first remote helper deployment (plan §4.2 / §168).
 *
 * Why a contract module instead of straight deploy code: the first connection cannot assume the
 * target helper directory exists, so PiDeck has to execute one fixed remote entry and then trust
 * what the remote reports back. Everything that decides "may this be uploaded / may this be
 * activated" is a pure predicate here, so the same rules gate the command we send, the manifest we
 * decode and the pre-rename check, and all of them stay testable without a host, a shell or a file.
 *
 * Three properties are deliberate and must survive future edits:
 * 1. Pure functions only: no filesystem, no child process, no network. The fixed inline entry is a
 *    string constant that some other module runs on the remote; nothing here executes it.
 * 2. Fail closed on untrusted input: the manifest is generated locally but still decoded as
 *    untrusted data (unknown fields rejected), and remote observations are compared, never merged.
 * 3. Errors carry one stable code as their whole message. A path, a digest or a remote body never
 *    travels inside an error, because those errors end up in logs and diagnostics.
 */

import { REMOTE_BUNDLE_MANIFEST_SCHEMA_VERSION, REMOTE_BUNDLE_MAX_FILES, REMOTE_BUNDLE_MAX_FILE_BYTES, REMOTE_BUNDLE_MAX_TOTAL_BYTES, type RemoteBundleFile, type RemoteBundleManifest } from "./RemoteHelperContract";

/** Stable codes thrown by this module. The message of a thrown error is exactly one of these. */
export const REMOTE_BOOTSTRAP_ERROR_CODES = ["BOOTSTRAP_INPUT_INVALID", "BUNDLE_MANIFEST_INVALID", "BUNDLE_FILE_MISMATCH", "BUNDLE_MODE_INVALID"] as const;
export type RemoteBootstrapErrorCode = (typeof REMOTE_BOOTSTRAP_ERROR_CODES)[number];

/** Codes the fixed inline entry reports as `{"op":"error","code":...}`; main maps them by code only. */
export const REMOTE_BOOTSTRAP_ENTRY_ERROR_CODES = ["BOOTSTRAP_INPUT_INVALID", "BOOTSTRAP_DEPLOY_ROOT_INVALID", "BOOTSTRAP_STAGING_INVALID", "BOOTSTRAP_ENTRY_OP_UNSUPPORTED", "BOOTSTRAP_INTERNAL", "DEPLOY_LOCK_HELD"] as const;

/** Fixed argv token that selects the versioned inline entry. Bumping it is a protocol change. */
export const REMOTE_BOOTSTRAP_INLINE_ENTRY = "--pideck-bootstrap-inline-v1";
/** Deploy root, relative to the remote home (plan §4.2 target layout). */
export const REMOTE_BOOTSTRAP_DEPLOY_ROOT_SEGMENTS = [".pideck", "remote-host"] as const;
export const REMOTE_BOOTSTRAP_STAGING_PREFIX = ".staging-";
export const REMOTE_BOOTSTRAP_LOCK_FILE_NAME = ".deploy.lock";
/** Permission policy (plan §172): staging and entry points 0700, everything else 0600. */
export const REMOTE_BOOTSTRAP_STAGING_MODE = "0700";
export const REMOTE_BOOTSTRAP_FILE_MODE = "0600";
export const REMOTE_BOOTSTRAP_ENTRY_FILE_MODE = "0700";

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
/** Main-generated nonce: bounded, alphanumeric, and unable to look like an option or a path. */
const NONCE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,63}$/;
/** Same host id shape the host store generates (`randomUUID`) and its codec accepts. */
const HOST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** One flat, non-hidden file name: no separators, no traversal, no control bytes, no leading dot. */
const BUNDLE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const OCTAL_MODE = /^0[0-7]{3}$/;
const OWNER_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const MANIFEST_KEYS = new Set(["schemaVersion", "bundleSha256", "files"]);
const BUNDLE_FILE_KEYS = new Set(["name", "sha256", "bytes"]);
const OWNER_MODE_KEYS = new Set(["name", "mode", "owner"]);

function fail(code: RemoteBootstrapErrorCode): never {
	throw new Error(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(record: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
	return Object.keys(record).every((key) => keys.has(key));
}

function requireString(value: unknown): string {
	if (typeof value !== "string") fail("BOOTSTRAP_INPUT_INVALID");
	return value;
}

function requireSha256(value: unknown): string {
	if (typeof value !== "string" || !SHA256_HEX.test(value)) fail("BUNDLE_MANIFEST_INVALID");
	return value;
}

/**
 * Quote one token for a POSIX shell: single quotes preserve every byte except `'`, which becomes
 * `'\''` (close quote, escaped quote, reopen).
 *
 * Control characters are refused rather than quoted. A NUL cannot appear in an argument vector at
 * all, and an embedded newline or escape byte means the value did not come from one of the verified
 * fields §168 allows in the template, so quoting it would only hide a bad input.
 */
export function quotePosixArgument(value: string): string {
	if (typeof value !== "string" || CONTROL_CHARS.test(value)) fail("BOOTSTRAP_INPUT_INVALID");
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Deploy root for a verified remote home. Pure string math on purpose: joining with `node:path`
 * would inherit Windows separator rules for a path that only ever exists on a POSIX host.
 */
export function resolveBootstrapDeployRoot(home: string): string {
	const value = requireString(home);
	if (value.length === 0 || value.length > 4096 || !value.startsWith("/") || CONTROL_CHARS.test(value)) fail("BOOTSTRAP_INPUT_INVALID");
	const trimmed = value.length > 1 && value.endsWith("/") ? value.slice(0, -1) : value;
	const segments = trimmed.slice(1).split("/");
	if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) fail("BOOTSTRAP_INPUT_INVALID");
	return `/${[...segments, ...REMOTE_BOOTSTRAP_DEPLOY_ROOT_SEGMENTS].join("/")}`;
}

/**
 * The fixed inline bootstrap entry, byte-frozen by the test suite. It is the only remote code that
 * runs before any bundle exists, so it is written to be auditable without opening a file:
 *
 * - argv: `--pideck-bootstrap-inline-v1 <protocolVersion> <bundleSha256> <nonce>` (nothing else).
 * - stdout: protocol frames only, one NDJSON line each (`ready`, `aborted`, `error`); no logs, and
 *   no frame ever carries a path other than the deploy root derived from the remote `HOME`.
 * - it resolves the deploy root from `HOME`, takes the deploy lock (`O_EXCL`, mode 0600, holder =
 *   pid + process start identity + nonce) *before* it creates the mode 0700 `.staging-<nonce>`
 *   directory, then holds stdio so main can upload into that exact directory and later ask the same
 *   entry to finalize while the lock is held. Until that finalize phase lands, every other stdin
 *   frame fails closed with `BOOTSTRAP_ENTRY_OP_UNSUPPORTED` instead of silently doing nothing.
 * - abort, stdin EOF (the ssh connection died) and every failed gate release the lock and remove the
 *   staging directory, so a half upload can never look deployable.
 */
export const REMOTE_BOOTSTRAP_INLINE_SOURCE = String.raw`"use strict";const fs=require("node:fs"),path=require("node:path");/*Fixed first-deploy staging entry (plan 4.2/168). argv: --pideck-bootstrap-inline-v1 <protocolVersion> <bundleSha256> <nonce>. It validates every token, resolves the deploy root from HOME, takes the deploy lock before touching the staging name, creates the mode 0700 staging directory and announces it in exactly one NDJSON frame on stdout, then holds stdio for the upload and for the finalize request that a later phase adds to this same entry. Every failure is one error frame plus a non-zero exit, and no gate falls through.*/const ENTRY="--pideck-bootstrap-inline-v1",SHA=/^[0-9a-f]{64}$/,NONCE=/^[A-Za-z0-9][A-Za-z0-9_-]{15,63}$/,CONTROL=/[\u0000-\u001f\u007f]/;let deployRoot="",stagingDir="",lockPath="",nonce="";function out(frame){process.stdout.write(JSON.stringify(frame)+"\n")}function stop(code,frame){if(frame)out(frame);process.exitCode=code;try{process.stdin.removeAllListeners();process.stdin.destroy()}catch{}}function bail(code){const err=new Error(code);err.bootstrapCode=code;throw err}function die(code){stop(1,{v:1,op:"error",code:code})}function failed(err){stop(1,{v:1,op:"error",code:err&&typeof err.bootstrapCode==="string"?err.bootstrapCode:"BOOTSTRAP_INTERNAL"})}function startId(pid){if(process.platform!=="linux")return null;try{const raw=fs.readFileSync("/proc/"+pid+"/stat","utf8");return raw.slice(raw.lastIndexOf(")")+2).split(" ")[19]||null}catch{return null}}function holderAlive(holder){if(!holder||!Number.isSafeInteger(holder.pid)||holder.pid<=1)return false;try{process.kill(holder.pid,0)}catch(err){if(!err||err.code!=="EPERM")return false}if(typeof holder.start==="string"){const live=startId(holder.pid);if(live!==null&&live!==holder.start)return false}return true}function readHolder(){try{const holder=JSON.parse(fs.readFileSync(lockPath,"utf8"));return holder&&typeof holder==="object"?holder:null}catch{return null}}function acquireLock(){for(let attempt=0;attempt<3;attempt++){try{const fd=fs.openSync(lockPath,"wx",0o600);fs.writeSync(fd,JSON.stringify({pid:process.pid,start:startId(process.pid),nonce:nonce}));fs.fsyncSync(fd);fs.closeSync(fd);return "acquired"}catch(err){if(!err||err.code!=="EEXIST")return "root-invalid";if(holderAlive(readHolder()))return "held";try{fs.unlinkSync(lockPath)}catch{return "held"}}}return "held"}function releaseLock(){const holder=readHolder();if(holder&&holder.pid===process.pid&&holder.nonce===nonce){try{fs.unlinkSync(lockPath)}catch{}}}function cleanup(){if(stagingDir){try{fs.rmSync(stagingDir,{recursive:true,force:true})}catch{}}releaseLock()}try{const argv=process.argv.slice(1);if(argv.length!==4||argv[0]!==ENTRY)bail("BOOTSTRAP_INPUT_INVALID");const protocolVersion=Number(argv[1]);if(!Number.isSafeInteger(protocolVersion)||protocolVersion<1||protocolVersion>65535)bail("BOOTSTRAP_INPUT_INVALID");const bundleSha256=argv[2];if(!SHA.test(bundleSha256))bail("BOOTSTRAP_INPUT_INVALID");nonce=argv[3];if(!NONCE.test(nonce))bail("BOOTSTRAP_INPUT_INVALID");const home=process.env.HOME;if(typeof home!=="string"||home.length===0||home.length>4096||!path.isAbsolute(home)||home==="/"||CONTROL.test(home)||home.split("/").includes(".."))bail("BOOTSTRAP_DEPLOY_ROOT_INVALID");deployRoot=path.join(home,".pideck","remote-host");stagingDir=path.join(deployRoot,".staging-"+nonce);lockPath=path.join(deployRoot,".deploy.lock");try{fs.mkdirSync(deployRoot,{recursive:true,mode:0o700})}catch{bail("BOOTSTRAP_DEPLOY_ROOT_INVALID")}function assertPrivateDir(target){let st;try{st=fs.lstatSync(target)}catch{bail("BOOTSTRAP_DEPLOY_ROOT_INVALID")}if(!st.isDirectory()||st.isSymbolicLink())bail("BOOTSTRAP_DEPLOY_ROOT_INVALID");if(typeof process.getuid==="function"){if(st.uid!==process.getuid())bail("BOOTSTRAP_DEPLOY_ROOT_INVALID");if((st.mode&0o077)!==0)bail("BOOTSTRAP_DEPLOY_ROOT_INVALID")}}assertPrivateDir(path.join(home,".pideck"));assertPrivateDir(deployRoot);const lock=acquireLock();if(lock!=="acquired")bail(lock==="held"?"DEPLOY_LOCK_HELD":"BOOTSTRAP_DEPLOY_ROOT_INVALID");try{fs.mkdirSync(stagingDir,{mode:0o700})}catch{releaseLock();bail("BOOTSTRAP_STAGING_INVALID")}try{fs.chmodSync(stagingDir,0o700)}catch{cleanup();bail("BOOTSTRAP_STAGING_INVALID")}out({v:1,op:"ready",protocolVersion:protocolVersion,bundleSha256:bundleSha256,nonce:nonce,deployRoot:deployRoot,staging:".staging-"+nonce,stagingMode:"0700"});let buffered="";process.stdin.setEncoding("utf8");process.stdin.on("data",function(chunk){buffered+=chunk;if(buffered.length>4096){cleanup();return die("BOOTSTRAP_INPUT_INVALID")}let index;while((index=buffered.indexOf("\n"))>=0){const line=buffered.slice(0,index);buffered=buffered.slice(index+1);let frame=null;try{frame=JSON.parse(line)}catch{cleanup();return die("BOOTSTRAP_INPUT_INVALID")}if(frame&&frame.op==="abort"){cleanup();return stop(0,{v:1,op:"aborted",reason:"requested"})}cleanup();return die("BOOTSTRAP_ENTRY_OP_UNSUPPORTED")}});process.stdin.on("end",function(){cleanup();stop(0,{v:1,op:"aborted",reason:"eof"})});process.stdin.resume()}catch(err){failed(err)}`;

/** One already-verified remote Node executable, plus the fixed bootstrap parameters. */
export type BootstrapCommandInput = {
	nodeExecutable: string;
	protocolVersion: number;
	bundleSha256: string;
	nonce: string;
};

/**
 * The template may carry exactly one path: the already-verified remote `node`. It must be absolute,
 * traversal-free and end in `node`, so a shell, a project file or a PATH lookup cannot be smuggled
 * in as "the executable". Other oddities (spaces, quotes) are handled by POSIX quoting, not by
 * widening this gate.
 */
function requireNodeExecutable(value: unknown): string {
	if (typeof value !== "string" || value.length === 0 || value.length > 4096) fail("BOOTSTRAP_INPUT_INVALID");
	if (!value.startsWith("/") || CONTROL_CHARS.test(value) || value.endsWith("/")) fail("BOOTSTRAP_INPUT_INVALID");
	const segments = value.slice(1).split("/");
	if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) fail("BOOTSTRAP_INPUT_INVALID");
	if (segments[segments.length - 1] !== "node") fail("BOOTSTRAP_INPUT_INVALID");
	return value;
}

function requireProtocolVersion(value: unknown): number {
	// A number, never a version string: a string would put free text back into the template.
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 65535) fail("BOOTSTRAP_INPUT_INVALID");
	return value;
}

function requireBundleSha256(value: unknown): string {
	if (typeof value !== "string" || !SHA256_HEX.test(value)) fail("BOOTSTRAP_INPUT_INVALID");
	return value;
}

function requireNonce(value: unknown): string {
	if (typeof value !== "string" || !NONCE.test(value)) fail("BOOTSTRAP_INPUT_INVALID");
	return value;
}

/**
 * Build the single remote command that starts the fixed inline entry (plan §168).
 *
 * Every token is validated here and then quoted individually, never concatenated into a larger
 * shell word, so a host profile, a project path or renderer text has no slot to land in: the
 * executable is the verified `node`, `-e` takes the frozen entry source, `--` ends node's own
 * option parsing (without it a leading `--…` argument is rejected as a bad node option), and the
 * remaining tokens are a bounded protocol integer, a 64-char lowercase hex bundle hash and a
 * main-generated nonce.
 */
export function buildBootstrapCommand(input: BootstrapCommandInput): string {
	const nodeExecutable = requireNodeExecutable(input?.nodeExecutable);
	const protocolVersion = requireProtocolVersion(input?.protocolVersion);
	const bundleSha256 = requireBundleSha256(input?.bundleSha256);
	const nonce = requireNonce(input?.nonce);
	return [quotePosixArgument(nodeExecutable), quotePosixArgument("-e"), quotePosixArgument(REMOTE_BOOTSTRAP_INLINE_SOURCE), quotePosixArgument("--"), quotePosixArgument(REMOTE_BOOTSTRAP_INLINE_ENTRY), quotePosixArgument(String(protocolVersion)), quotePosixArgument(bundleSha256), quotePosixArgument(nonce)].join(" ");
}

export type StagingIdentityInput = { hostId: string; runtimeGeneration: number; nonce: string };
/** `directory` is relative to the deploy root on purpose: main never sends an absolute remote path. */
export type StagingIdentity = { directory: string; mode: "0700" };

/**
 * Name the staging directory for one bootstrap run (plan §168).
 *
 * `hostId` and `runtimeGeneration` are validated so a malformed identity can never reach the remote
 * artifact namespace, but they stay out of the name: they are only unique inside one PiDeck store
 * (plan §171) and two instances sharing a remote account would collide. The nonce is the collision
 * defence, and it is also what lets the deploy lock and the staging directory be matched up.
 */
export function buildStagingIdentity(input: StagingIdentityInput): StagingIdentity {
	if (!isRecord(input)) fail("BOOTSTRAP_INPUT_INVALID");
	const hostId = input.hostId;
	if (typeof hostId !== "string" || !HOST_ID.test(hostId)) fail("BOOTSTRAP_INPUT_INVALID");
	const runtimeGeneration = input.runtimeGeneration;
	if (typeof runtimeGeneration !== "number" || !Number.isSafeInteger(runtimeGeneration) || runtimeGeneration < 0) fail("BOOTSTRAP_INPUT_INVALID");
	return { directory: `${REMOTE_BOOTSTRAP_STAGING_PREFIX}${requireNonce(input.nonce)}`, mode: REMOTE_BOOTSTRAP_STAGING_MODE };
}

function decodeBundleFile(value: unknown, names: Set<string>): RemoteBundleFile {
	if (!isRecord(value) || !onlyKeys(value, BUNDLE_FILE_KEYS)) fail("BUNDLE_MANIFEST_INVALID");
	const name = value.name;
	// One flat, non-hidden name: `x/y`, `../x`, `/x`, `x\0y`, `-x` and `.x` are all rejected before a
	// remote path is ever built from the manifest.
	if (typeof name !== "string" || !BUNDLE_FILE_NAME.test(name)) fail("BUNDLE_MANIFEST_INVALID");
	// Case-insensitive duplicates are rejected too: on a case-insensitive remote filesystem (default
	// APFS, Windows) two manifest entries would collapse onto one physical file and the exact-coverage
	// invariant would silently stop holding.
	if (names.has(name) || names.has(name.toLowerCase())) fail("BUNDLE_MANIFEST_INVALID");
	names.add(name);
	names.add(name.toLowerCase());
	const bytes = value.bytes;
	if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > REMOTE_BUNDLE_MAX_FILE_BYTES) fail("BUNDLE_MANIFEST_INVALID");
	return { name, sha256: requireSha256(value.sha256), bytes };
}

/**
 * Strictly decode a bundle manifest. The manifest is generated locally, but it is the input that
 * decides which files are uploaded and which bytes are expected on the remote, so it is parsed like
 * untrusted data: unknown fields, a different schema version, an out-of-range file set, unsafe file
 * names, duplicate names and bad digests all fail closed. The returned value is a fresh copy, so a
 * later mutation of the caller's object cannot change an already verified manifest.
 */
export function decodeBundleManifest(value: unknown): RemoteBundleManifest {
	if (!isRecord(value) || !onlyKeys(value, MANIFEST_KEYS)) fail("BUNDLE_MANIFEST_INVALID");
	if (value.schemaVersion !== REMOTE_BUNDLE_MANIFEST_SCHEMA_VERSION) fail("BUNDLE_MANIFEST_INVALID");
	const files = value.files;
	if (!Array.isArray(files) || files.length === 0 || files.length > REMOTE_BUNDLE_MAX_FILES) fail("BUNDLE_MANIFEST_INVALID");
	const names = new Set<string>();
	const decoded: RemoteBundleFile[] = [];
	let totalBytes = 0;
	for (const entry of files) {
		const file = decodeBundleFile(entry, names);
		totalBytes += file.bytes;
		if (totalBytes > REMOTE_BUNDLE_MAX_TOTAL_BYTES) fail("BUNDLE_MANIFEST_INVALID");
		decoded.push(file);
	}
	return { schemaVersion: REMOTE_BUNDLE_MANIFEST_SCHEMA_VERSION, bundleSha256: requireSha256(value.bundleSha256), files: decoded };
}

/** What the remote reported for one staged file. Compared against the manifest, never trusted. */
export type RemoteBundleObservation = { name: string; sha256: string; bytes: number };

/**
 * Compare the manifest with what the remote actually has, file by file.
 *
 * The manifest is the expectation, so the comparison is set-based and order-insensitive: a missing
 * file, an unexpected extra file, a duplicate report, a different digest or a different byte count
 * all fail closed with `BUNDLE_FILE_MISMATCH`. The manifest is decoded again here on purpose, so a
 * caller that hand-built one cannot skip the rules above.
 */
export function verifyBundleFiles(manifest: RemoteBundleManifest, observed: ReadonlyArray<RemoteBundleObservation>): void {
	const expected = decodeBundleManifest(manifest);
	if (!Array.isArray(observed) || observed.length > REMOTE_BUNDLE_MAX_FILES) fail("BUNDLE_FILE_MISMATCH");
	const expectedByName = new Map(expected.files.map((file) => [file.name, file]));
	const seen = new Set<string>();
	for (const entry of observed) {
		if (!isRecord(entry) || !onlyKeys(entry, BUNDLE_FILE_KEYS)) fail("BUNDLE_FILE_MISMATCH");
		const name = entry.name;
		if (typeof name !== "string" || seen.has(name)) fail("BUNDLE_FILE_MISMATCH");
		seen.add(name);
		const expectedFile = expectedByName.get(name);
		if (!expectedFile || entry.sha256 !== expectedFile.sha256 || entry.bytes !== expectedFile.bytes) fail("BUNDLE_FILE_MISMATCH");
	}
	if (seen.size !== expected.files.length) fail("BUNDLE_FILE_MISMATCH");
}

export type RemoteBundleOwnerMode = { name: string; mode: string; owner: string };
export type ActivationPreconditionsInput = {
	manifest: RemoteBundleManifest;
	observed: ReadonlyArray<RemoteBundleObservation>;
	ownerMode: ReadonlyArray<RemoteBundleOwnerMode>;
	expectedOwner: string;
	/** Entry points are the only files allowed to be executable (plan §172); everything else is 0600. */
	executableNames?: readonly string[];
};

function requireOwner(value: unknown): string {
	if (typeof value !== "string" || !OWNER_ID.test(value)) fail("BUNDLE_MODE_INVALID");
	return value;
}

function requireExecutableNames(value: unknown, manifest: RemoteBundleManifest): ReadonlySet<string> {
	if (value === undefined) return new Set<string>();
	if (!Array.isArray(value) || value.length > manifest.files.length) fail("BUNDLE_MODE_INVALID");
	const known = new Set(manifest.files.map((file) => file.name));
	const names = new Set<string>();
	for (const name of value) {
		if (typeof name !== "string" || !known.has(name) || names.has(name)) fail("BUNDLE_MODE_INVALID");
		names.add(name);
	}
	return names;
}

/**
 * Last gate before the atomic rename (plan §168): every file must match the manifest by bytes and
 * sha256, its owner must be the expected account, its mode must be the policy mode, and the report
 * must cover exactly the manifest — nothing missing, nothing extra, nothing reported twice.
 *
 * `mode` is an octal string (`"0600"`, `"0700"`), not a number: a numeric mode would hide a base
 * mistake such as `384`, and group/other bits or setuid differences must be visible to this check.
 * Any deviation fails closed with `BUNDLE_MODE_INVALID`; a manifest that does not verify first
 * fails with `BUNDLE_FILE_MISMATCH`, because an unverified file set must never be activated.
 */
export function assertActivationPreconditions(input: ActivationPreconditionsInput): void {
	if (!isRecord(input)) fail("BOOTSTRAP_INPUT_INVALID");
	verifyBundleFiles(input.manifest, input.observed);
	const manifest = decodeBundleManifest(input.manifest);
	const expectedOwner = requireOwner(input.expectedOwner);
	const executableNames = requireExecutableNames(input.executableNames, manifest);
	const ownerMode = input.ownerMode;
	if (!Array.isArray(ownerMode) || ownerMode.length !== manifest.files.length) fail("BUNDLE_MODE_INVALID");
	const known = new Map(manifest.files.map((file) => [file.name, file]));
	const seen = new Set<string>();
	for (const entry of ownerMode) {
		if (!isRecord(entry) || !onlyKeys(entry, OWNER_MODE_KEYS)) fail("BUNDLE_MODE_INVALID");
		const name = entry.name;
		if (typeof name !== "string" || seen.has(name)) fail("BUNDLE_MODE_INVALID");
		seen.add(name);
		if (!known.has(name)) fail("BUNDLE_MODE_INVALID");
		if (entry.owner !== expectedOwner) fail("BUNDLE_MODE_INVALID");
		// Shape first, policy second: `384`, `"644"` or `"0777"` must be rejected as not-an-octal-mode
		// string before the policy comparison can accidentally accept one of them.
		if (typeof entry.mode !== "string" || !OCTAL_MODE.test(entry.mode)) fail("BUNDLE_MODE_INVALID");
		if (entry.mode !== (executableNames.has(name) ? REMOTE_BOOTSTRAP_ENTRY_FILE_MODE : REMOTE_BOOTSTRAP_FILE_MODE)) fail("BUNDLE_MODE_INVALID");
	}
	if (seen.size !== manifest.files.length) fail("BUNDLE_MODE_INVALID");
}
