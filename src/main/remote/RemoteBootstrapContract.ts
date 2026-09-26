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
 * - stdout: protocol frames only, one NDJSON line each (`ready`, `finalized`, `aborted`, `error`); no
 *   logs, and no frame ever carries a path other than the deploy root derived from the remote `HOME`.
 * - it resolves the deploy root from `HOME`, takes the deploy lock (`O_EXCL`, mode 0600, holder =
 *   pid + process start identity + nonce) *before* it creates the mode 0700 `.staging-<nonce>`
 *   directory, then holds stdio so main can upload into that exact directory and finalize it over the
 *   same stdin: `finalize-begin`, one `finalize-file` per declared file, then `finalize-commit`.
 * - finalize re-checks every staged file against the declaration main sent while the lock is held
 *   (regular file, no symlink, POSIX owner, sha256 and byte count) and forces the declared mode with
 *   its own chmod, because an upload coming from Windows cannot preserve a POSIX mode; it then fsyncs
 *   the files and best-effort the directories, then renames the staging directory to
 *   `<deployRoot>/bundles/<bundleSha256>`. That rename is the only commit point: an already active
 *   directory is never overwritten and must re-verify as the identical bundle, an abort that reaches
 *   the entry once the commit is underway is answered with `aborted`/`requested` without removing
 *   what was activated, and a well-formed frame outside the four frozen operations still fails
 *   closed with `BOOTSTRAP_ENTRY_OP_UNSUPPORTED` instead of silently doing nothing.
 * - abort, stdin EOF (the ssh connection died) and every failed gate release the lock and remove the
 *   staging directory, so a half upload can never look deployable.
 */
export const REMOTE_BOOTSTRAP_INLINE_SOURCE = String.raw`"use strict";const fs=require("node:fs"),path=require("node:path");/*Fixed first-deploy staging and finalize entry (plan 4.2/168). argv: --pideck-bootstrap-inline-v1 <protocolVersion> <bundleSha256> <nonce>. It validates every token, resolves the deploy root from HOME, takes the deploy lock before touching the staging name, creates the mode 0700 staging directory and announces it in exactly one NDJSON frame on stdout, then holds stdio: main uploads the bundle into that exact directory and finalizes it over the same stdin (finalize-begin, one finalize-file per file, finalize-commit) or aborts. The commit re-checks every staged file against the declaration that main sent while the lock is held (regular file, no symlink, POSIX owner, sha256 and byte count), forces the declared mode on it, fsyncs the files and best-effort the directories, then renames the staging directory to <deployRoot>/bundles/<bundleSha256>; that rename is the only commit point, an already active directory is never overwritten and has to re-verify as the identical bundle, and an abort that arrives once the commit point is reached is answered with aborted/requested without removing what was activated. Every failure is one error frame plus a non-zero exit, no gate falls through, stdout stays protocol-only and an inbound frame stays capped at 4096 bytes. Hashing uses the WebCrypto global, so the entry still requires nothing but node:fs and node:path.*/const ENTRY="--pideck-bootstrap-inline-v1",SHA=/^[0-9a-f]{64}$/,NONCE=/^[A-Za-z0-9][A-Za-z0-9_-]{15,63}$/,CONTROL=/[\u0000-\u001f\u007f]/,MODES=["0600","0700"],MAX_FILES=256,MAX_FILE_BYTES=33554432,MAX_NAME=128,MAX_FRAME=4096,BUNDLE_DIR="bundles";let deployRoot="",stagingDir="",lockPath="",nonce="",declared=null,entries=[],names=new Set(),committing=false,activated=false,abortRequested=false,stopped=false;function out(frame){process.stdout.write(JSON.stringify(frame)+"\n")}function stop(code,frame){if(stopped)return;stopped=true;if(frame)out(frame);process.exitCode=code;try{process.stdin.removeAllListeners();process.stdin.destroy()}catch{}}function bail(code){const err=new Error(code);err.bootstrapCode=code;throw err}function die(code){stop(1,{v:1,op:"error",code:code})}function failed(err){stop(1,{v:1,op:"error",code:err&&typeof err.bootstrapCode==="string"?err.bootstrapCode:"BOOTSTRAP_INTERNAL"})}function startId(pid){if(process.platform!=="linux")return null;try{const raw=fs.readFileSync("/proc/"+pid+"/stat","utf8");return raw.slice(raw.lastIndexOf(")")+2).split(" ")[19]||null}catch{return null}}function holderAlive(holder){if(!holder||!Number.isSafeInteger(holder.pid)||holder.pid<=1)return false;try{process.kill(holder.pid,0)}catch(err){if(!err||err.code!=="EPERM")return false}if(typeof holder.start==="string"){const live=startId(holder.pid);if(live!==null&&live!==holder.start)return false}return true}function readHolder(){try{const holder=JSON.parse(fs.readFileSync(lockPath,"utf8"));return holder&&typeof holder==="object"?holder:null}catch{return null}}function acquireLock(){for(let attempt=0;attempt<3;attempt++){let fd=null;try{fd=fs.openSync(lockPath,"wx",0o600);fs.writeSync(fd,JSON.stringify({pid:process.pid,start:startId(process.pid),nonce:nonce}));fs.fsyncSync(fd);fs.closeSync(fd);fd=null;return "acquired"}catch(err){if(fd!==null){try{fs.closeSync(fd)}catch{}try{fs.unlinkSync(lockPath)}catch{}}if(!err||err.code!=="EEXIST")return "io-error";if(holderAlive(readHolder()))return "held";try{fs.unlinkSync(lockPath)}catch{return "held"}}}return "held"}function releaseLock(){const holder=readHolder();if(holder&&holder.pid===process.pid&&holder.nonce===nonce){try{fs.unlinkSync(lockPath)}catch{}}}/*cleanup() never removes an activated bundle: after the rename the staging name is gone, and the guard states that rule for every failure path.*/function cleanup(){if(!activated&&stagingDir){try{fs.rmSync(stagingDir,{recursive:true,force:true})}catch{}}releaseLock()}try{const argv=process.argv.slice(1);if(argv.length!==4||argv[0]!==ENTRY)bail("BOOTSTRAP_INPUT_INVALID");const protocolVersion=Number(argv[1]);if(!Number.isSafeInteger(protocolVersion)||protocolVersion<1||protocolVersion>65535)bail("BOOTSTRAP_INPUT_INVALID");const bundleSha256=argv[2];if(!SHA.test(bundleSha256))bail("BOOTSTRAP_INPUT_INVALID");nonce=argv[3];if(!NONCE.test(nonce))bail("BOOTSTRAP_INPUT_INVALID");const home=process.env.HOME;if(typeof home!=="string"||home.length===0||home.length>4096||!path.isAbsolute(home)||home==="/"||CONTROL.test(home)||home.split("/").includes(".."))bail("BOOTSTRAP_DEPLOY_ROOT_INVALID");deployRoot=path.join(home,".pideck","remote-host");stagingDir=path.join(deployRoot,".staging-"+nonce);lockPath=path.join(deployRoot,".deploy.lock");try{fs.mkdirSync(deployRoot,{recursive:true,mode:0o700})}catch{bail("BOOTSTRAP_DEPLOY_ROOT_INVALID")}function assertPrivateDir(target){let st=null;try{st=fs.lstatSync(target)}catch{bail("BOOTSTRAP_DEPLOY_ROOT_INVALID")}if(!st.isDirectory()||st.isSymbolicLink())bail("BOOTSTRAP_DEPLOY_ROOT_INVALID");if(typeof process.getuid==="function"){if(st.uid!==process.getuid())bail("BOOTSTRAP_DEPLOY_ROOT_INVALID");if((st.mode&0o077)!==0)bail("BOOTSTRAP_DEPLOY_ROOT_INVALID")}}assertPrivateDir(path.join(home,".pideck"));assertPrivateDir(deployRoot);/*A platform without the WebCrypto global cannot hash staged bytes, and an unverified bundle is never activated, so refuse before the lock is taken and before main uploads anything.*/if(!globalThis.crypto||typeof globalThis.crypto.subtle!=="object"||typeof globalThis.crypto.subtle.digest!=="function")bail("BOOTSTRAP_INTERNAL");const lock=acquireLock();if(lock!=="acquired")bail(lock==="held"?"DEPLOY_LOCK_HELD":lock==="io-error"?"BOOTSTRAP_INTERNAL":"BOOTSTRAP_DEPLOY_ROOT_INVALID");try{fs.mkdirSync(stagingDir,{mode:0o700})}catch{releaseLock();bail("BOOTSTRAP_STAGING_INVALID")}try{fs.chmodSync(stagingDir,0o700)}catch{cleanup();bail("BOOTSTRAP_STAGING_INVALID")}function exact(frame,keys){const own=Object.keys(frame);return own.length===keys.length&&own.every(function(key){return keys.indexOf(key)>=0})}function badInput(){cleanup();die("BOOTSTRAP_INPUT_INVALID")}function unsupported(){cleanup();die("BOOTSTRAP_ENTRY_OP_UNSUPPORTED")}function incomplete(){cleanup();die("BOOTSTRAP_FINALIZE_INCOMPLETE")}async function hashHex(bytes){const digest=await crypto.subtle.digest("SHA-256",bytes);return Buffer.from(digest).toString("hex")}/*The verified file is opened read-write for the flush on purpose: the mode check already proved it is owner-writable (0600/0700), a read-only handle cannot be flushed on every platform (Windows refuses with EPERM), and a file that was never flushed must not be renamed into the active bundle.*/function fsyncFile(file){const fd=fs.openSync(file,"r+");try{fs.fsyncSync(fd)}finally{fs.closeSync(fd)}}/*Directory fsync buys durability only - the rename is the commit point - so a platform or filesystem that refuses it (EINVAL/ENOTSUP/EISDIR, and EPERM where a directory cannot be flushed) must not fail an otherwise verified deployment.*/function fsyncDir(dir){try{const fd=fs.openSync(dir,"r");try{fs.fsyncSync(fd)}catch{}try{fs.closeSync(fd)}catch{}}catch{}}function stagedFile(dir,entry){return path.join(dir,entry.name)}/*Permission deviations (owner, mode) are BOOTSTRAP_MODE_INVALID and every content deviation (wrong file type, symlink, unreadable, size, digest) is BOOTSTRAP_FILE_MISMATCH: those are the two frozen failure classes. The declared mode is forced instead of checked: the uploader cannot be trusted to preserve POSIX modes (Windows has no real mode at all and ships the synthetic 0644/0666 it made up, scp -p included), so demanding that the uploaded bits already match would fail every deployment coming from such a host. Forcing is safe because the staging directory is 0700 and owned by this same uid, so no other user can reach the bytes during the upload window, and it is what guarantees that the activated bundle always carries the declared least privilege. The owner must still match, and both rules are enforced where the platform can express them, i.e. on POSIX; a platform without uid and with synthesized modes has nothing to force.*/async function verifyStagedFile(entry){const file=stagedFile(stagingDir,entry);let st=null;try{st=fs.lstatSync(file)}catch{bail("BOOTSTRAP_FILE_MISMATCH")}if(!st.isFile()||st.isSymbolicLink())bail("BOOTSTRAP_FILE_MISMATCH");if(typeof process.getuid==="function"){if(st.uid!==process.getuid())bail("BOOTSTRAP_MODE_INVALID");try{fs.chmodSync(file,parseInt(entry.mode,8))}catch{bail("BOOTSTRAP_MODE_INVALID")}try{st=fs.lstatSync(file)}catch{bail("BOOTSTRAP_MODE_INVALID")}if((st.mode&0o777)!==parseInt(entry.mode,8))bail("BOOTSTRAP_MODE_INVALID")}if(st.size!==entry.bytes)bail("BOOTSTRAP_FILE_MISMATCH");let data=null;try{data=fs.readFileSync(file)}catch{bail("BOOTSTRAP_FILE_MISMATCH")}if(data.length!==entry.bytes)bail("BOOTSTRAP_FILE_MISMATCH");if((await hashHex(data))!==entry.sha256)bail("BOOTSTRAP_FILE_MISMATCH");fsyncFile(file)}async function verifyStaged(){for(const entry of entries)await verifyStagedFile(entry);/*The whole directory is renamed, so an undeclared leftover would be activated unverified and would then never match on a later idempotent run (which compares the entry count).*/let present=null;try{present=fs.readdirSync(stagingDir)}catch{bail("BOOTSTRAP_FILE_MISMATCH")}if(present.length!==entries.length)bail("BOOTSTRAP_FILE_MISMATCH");for(const entry of entries){if(present.indexOf(entry.name)<0)bail("BOOTSTRAP_FILE_MISMATCH")}fsyncDir(stagingDir)}/*Read-only re-verification of an already active bundle: that directory is never written, chmodded or removed, so it has to satisfy the declaration on its own (the entry set those modes when it activated the bundle) and any deviation is a conflict to report rather than damage to repair.*/async function activeMatches(target){let dirStat=null;try{dirStat=fs.lstatSync(target)}catch{return false}if(!dirStat.isDirectory()||dirStat.isSymbolicLink())return false;if(typeof process.getuid==="function"&&(dirStat.uid!==process.getuid()||(dirStat.mode&0o777)!==0o700))return false;let present=null;try{present=fs.readdirSync(target)}catch{return false}if(present.length!==entries.length)return false;for(const entry of entries){if(present.indexOf(entry.name)<0)return false;const file=stagedFile(target,entry);let st=null;try{st=fs.lstatSync(file)}catch{return false}if(!st.isFile()||st.isSymbolicLink())return false;if(typeof process.getuid==="function"){if(st.uid!==process.getuid())return false;if((st.mode&0o777)!==parseInt(entry.mode,8))return false}if(st.size!==entry.bytes)return false;let data=null;try{data=fs.readFileSync(file)}catch{return false}if(data.length!==entry.bytes)return false;if((await hashHex(data))!==entry.sha256)return false}return true}function pathExists(target){try{fs.lstatSync(target);return true}catch{return false}}async function activate(){const bundlesDir=path.join(deployRoot,BUNDLE_DIR);try{fs.mkdirSync(bundlesDir,{recursive:true,mode:0o700})}catch{bail("BOOTSTRAP_DEPLOY_ROOT_INVALID")}assertPrivateDir(bundlesDir);const target=path.join(bundlesDir,declared.bundleSha256);if(pathExists(target)){if(!(await activeMatches(target)))bail("BOOTSTRAP_ACTIVE_CONFLICT");cleanup();/*The bundle is in place either way, so a later abort must not be reported as "nothing was deployed".*/activated=true}else{try{fs.renameSync(stagingDir,target)}catch{bail("BOOTSTRAP_INTERNAL")}activated=true}fsyncDir(bundlesDir)}function startCommit(){committing=true;(async function(){try{await verifyStaged();if(stopped)return;await activate();if(stopped)return;releaseLock();stop(0,activated?{v:1,op:"finalized",active:"./"+BUNDLE_DIR+"/"+declared.bundleSha256,files:declared.files}:{v:1,op:"aborted",reason:"requested"})}catch(err){if(stopped)return;cleanup();failed(err)}})()}function handleFrame(frame){if(frame.op==="abort"){if(!exact(frame,["v","op"]))return badInput();if(committing){abortRequested=true;return}cleanup();return stop(0,{v:1,op:"aborted",reason:"requested"})}if(frame.op==="finalize-begin"){if(declared||!exact(frame,["v","op","files","bundleSha256"]))return badInput();const files=frame.files;if(!Number.isSafeInteger(files)||files<1||files>MAX_FILES)return badInput();const bundle=frame.bundleSha256;if(typeof bundle!=="string"||!SHA.test(bundle)||bundle!==bundleSha256)return badInput();declared={files:files,bundleSha256:bundle};return}if(frame.op==="finalize-file"){if(!declared||committing||!exact(frame,["v","op","name","sha256","bytes","mode"]))return badInput();const name=frame.name;if(typeof name!=="string"||name.length===0||name.length>MAX_NAME||name==="."||name.indexOf("..")>=0||name.indexOf("/")>=0||name.indexOf("\\")>=0||CONTROL.test(name))return badInput();if(names.has(name)||names.has(name.toLowerCase())||entries.length>=declared.files)return badInput();const sha=frame.sha256;if(typeof sha!=="string"||!SHA.test(sha))return badInput();const bytes=frame.bytes;if(!Number.isSafeInteger(bytes)||bytes<0||bytes>MAX_FILE_BYTES)return badInput();const mode=frame.mode;if(MODES.indexOf(mode)<0)return badInput();names.add(name);names.add(name.toLowerCase());entries.push({name:name,sha256:sha,bytes:bytes,mode:mode});return}if(frame.op==="finalize-commit"){if(!declared||committing||!exact(frame,["v","op"]))return badInput();if(entries.length!==declared.files)return incomplete();return startCommit()}return unsupported()}out({v:1,op:"ready",protocolVersion:protocolVersion,bundleSha256:bundleSha256,nonce:nonce,deployRoot:deployRoot,staging:".staging-"+nonce,stagingMode:"0700"});let buffered="";process.stdin.setEncoding("utf8");process.stdin.on("data",function(chunk){if(stopped)return;buffered+=chunk;/*The 4096 byte cap counts one frame without its newline, exactly like the encoder in main, and an unterminated line past the cap is refused instead of buffered.*/let index;while(!stopped&&(index=buffered.indexOf("\n"))>=0){const line=buffered.slice(0,index);buffered=buffered.slice(index+1);if(Buffer.byteLength(line,"utf8")>MAX_FRAME){cleanup();return die("BOOTSTRAP_INPUT_INVALID")}let frame=null;try{frame=JSON.parse(line)}catch{return badInput()}if(!frame||typeof frame!=="object"||Array.isArray(frame)||typeof frame.op!=="string")return badInput();if(frame.op!=="abort"&&frame.op!=="finalize-begin"&&frame.op!=="finalize-file"&&frame.op!=="finalize-commit")return unsupported();if(frame.v!==1)return badInput();handleFrame(frame)}if(!stopped&&Buffer.byteLength(buffered,"utf8")>MAX_FRAME){cleanup();return die("BOOTSTRAP_INPUT_INVALID")}});process.stdin.on("end",function(){if(committing)return;cleanup();stop(0,{v:1,op:"aborted",reason:"eof"})});process.stdin.resume()}catch(err){failed(err)}`;

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
