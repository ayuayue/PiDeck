import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { decodeBundleManifest, quotePosixArgument, REMOTE_BOOTSTRAP_STAGING_PREFIX } from "./RemoteBootstrapContract";
import type { BootstrapReadyFrame } from "./RemoteBootstrapTransfer";
import { REMOTE_BUNDLE_MANIFEST_SCHEMA_VERSION, REMOTE_BUNDLE_MAX_FILES, REMOTE_BUNDLE_MAX_FILE_BYTES, REMOTE_BUNDLE_MAX_TOTAL_BYTES, type RemoteBundleFile, type RemoteBundleManifest } from "./RemoteHelperContract";
import type { PinnedSshInvocation } from "./SshVerifiedConnection";

/**
 * Main-only upload half of the plan §168 bootstrap: turn a prepared local bundle directory into the
 * pinned scp call plus the finalize frames the entry expects.
 *
 * Two wire facts drive this module:
 *   - The remote staging path travels through the remote shell, so it is POSIX-quoted and never
 *     concatenated from unvalidated pieces.
 *   - scp decides "host:path" from a colon before the first separator, so source operands stay bare
 *     file names resolved against the bundle directory instead of absolute Windows paths.
 */

/** Wire definition of the content address the entry echoes and later uses as the bundle directory name. */
export const REMOTE_BUNDLE_HASH_PREFIX = "pideck-bundle-v1";
/** Locale-independent, injective encoding: names cannot contain a line break, so the separator is safe. */
export const REMOTE_BUNDLE_HASH_SEPARATOR = "\n";

export type BundleFileObservation = { name: string; sha256: string; bytes: number };

export type BundleUploadPlan = {
	manifest: RemoteBundleManifest;
	observations: readonly BundleFileObservation[];
	/** Names activated with mode 0700; everything else lands 0600. Part of the content address. */
	executableNames: readonly string[];
	/** Pinned scp call: absolute executable, argv array, sanitized env, working directory. */
	invocation: { executable: string; args: string[]; env: Readonly<NodeJS.ProcessEnv>; cwd: string; sftp: boolean };
};

const SHA256 = /^[0-9a-f]{64}$/;
const NONCE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,63}$/;
/** A single safe path segment: no separators, no traversal, no control characters. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** OpenSSH 9.0 made scp use the SFTP protocol unless `-O` asks for the legacy one. */
const SFTP_BY_DEFAULT_MAJOR = 9;

/** Major/minor of the pinned client, or null when the self-check version cannot be read. */
export function parseOpenSshVersion(version: string): { major: number; minor: number } | null {
	if (typeof version !== "string") return null;
	const trimmed = version.trim();
	// The banner is not uniform across ports: Windows ships "OpenSSH_for_Windows_9.5p2" while the
	// portable build ships "OpenSSH_9.5p2". Anything after the product name may carry a suffix, so the
	// first major.minor pair after "OpenSSH" is the version.
	if (!trimmed.startsWith("OpenSSH")) return null;
	const match = /(\d+)\.(\d+)/.exec(trimmed);
	if (match === null) return null;
	return { major: Number(match[1]), minor: Number(match[2]) };
}

/**
 * Characters a remote shell would act on. The SFTP protocol passes the path through literally, so these
 * are only dangerous if that assumption is ever wrong; refusing them keeps a wrong assumption from
 * turning a home directory into a command line.
 */
const REMOTE_SHELL_METACHARACTERS = /[$`;&|<>(){}\\!*?~\n\r]/;
/** A host alias is one argv element handed to both scp and ssh; keep it to the shape ssh accepts. */
const HOST_ALIAS = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

function usableDeployRoot(value: unknown): value is string {
	if (typeof value !== "string" || !value.startsWith("/") || value.length > 4096) return false;
	if (/[\x00-\x1f\x7f]/.test(value) || REMOTE_SHELL_METACHARACTERS.test(value)) return false;
	if (value === "/") return false;
	return !value.split("/").includes("..");
}

function invalid(): never {
	throw new Error("BOOTSTRAP_INPUT_INVALID");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Content address of one declared file set: the tag, then `name`, `sha256`, `bytes` and the mode policy
 * of every file in name order. Names cannot contain a newline, so this encoding cannot be confused with
 * another set. The mode policy is part of the address because the entry refuses to rewrite an already
 * activated directory whose modes disagree: the same bytes with a different executable set is therefore a
 * different deployment, not a repeat of this one.
 */
export function bundleContentHash(observed: readonly BundleFileObservation[], options: { executableNames?: readonly string[] } = {}): string {
	const executableNames = readExecutableNames(options.executableNames);
	const declared = new Set(observed.filter(isPlainObject).map((entry) => entry.name));
	if (executableNames.some((name) => !declared.has(name))) invalid();
	const digest = createHash("sha256");
	digest.update(`${REMOTE_BUNDLE_HASH_PREFIX}${REMOTE_BUNDLE_HASH_SEPARATOR}`, "utf8");
	for (const entry of [...observed].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
		// Out-of-contract input (a name carrying the separator) would make this encoding ambiguous.
		if (!isPlainObject(entry) || typeof entry.name !== "string" || entry.name.length === 0 || entry.name.includes(REMOTE_BUNDLE_HASH_SEPARATOR)) invalid();
		digest.update(`${entry.name}${REMOTE_BUNDLE_HASH_SEPARATOR}${entry.sha256}${REMOTE_BUNDLE_HASH_SEPARATOR}${entry.bytes}${REMOTE_BUNDLE_HASH_SEPARATOR}${modeFor(entry.name, executableNames)}${REMOTE_BUNDLE_HASH_SEPARATOR}`, "utf8");
	}
	return digest.digest("hex");
}

/**
 * The executable set decides which files are activated with mode 0700, so it is validated against the
 * declared names here: a typo would otherwise deploy the entry point as 0600 and only fail at exec time.
 */
function readExecutableNames(value: readonly string[] | undefined): string[] {
	const names = value ?? [];
	if (!Array.isArray(names) || names.some((name) => typeof name !== "string")) invalid();
	if (new Set(names).size !== names.length) invalid();
	return [...names];
}

function modeFor(name: string, executableNames: readonly string[]): "0600" | "0700" {
	return executableNames.includes(name) ? "0700" : "0600";
}

/**
 * Build the manifest for a set of already-hashed files. The name rules are not duplicated here: the
 * manifest is decoded again below, so `decodeBundleManifest` stays the single authority for them.
 */
export function buildBundleManifest(observed: readonly BundleFileObservation[], options: { executableNames?: readonly string[] } = {}): RemoteBundleManifest {
	if (!Array.isArray(observed) || observed.length === 0 || observed.length > REMOTE_BUNDLE_MAX_FILES) invalid();
	let total = 0;
	for (const entry of observed) {
		if (!isPlainObject(entry) || typeof entry.name !== "string" || typeof entry.sha256 !== "string" || !SHA256.test(entry.sha256)) invalid();
		if (typeof entry.bytes !== "number" || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > REMOTE_BUNDLE_MAX_FILE_BYTES) invalid();
		total += entry.bytes;
		if (total > REMOTE_BUNDLE_MAX_TOTAL_BYTES) invalid();
	}
	const executableNames = readExecutableNames(options.executableNames);
	const declared = new Set(observed.map((entry) => entry.name));
	if (executableNames.some((name) => !declared.has(name))) invalid();
	const files: RemoteBundleFile[] = [...observed].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)).map((entry) => ({ name: entry.name, sha256: entry.sha256, bytes: entry.bytes }));
	// Round trip through the codec: duplicate names, case collisions and unsafe segments fail closed here.
	return decodeBundleManifest({ schemaVersion: REMOTE_BUNDLE_MANIFEST_SCHEMA_VERSION, bundleSha256: bundleContentHash(observed, { executableNames }), files });
}

/**
 * Hash the files of one prepared bundle directory. Each name must resolve to a regular, non-symlink
 * file directly inside `directory`, so a link or directory can never stand in for a declared file.
 */
export async function observeBundleFiles(directory: string, names: readonly string[]): Promise<BundleFileObservation[]> {
	if (typeof directory !== "string" || directory.length === 0 || /[\x00-\x1f\x7f]/.test(directory) || !isAbsolute(directory)) invalid();
	if (!Array.isArray(names) || names.length === 0 || names.length > REMOTE_BUNDLE_MAX_FILES) invalid();
	const observed: BundleFileObservation[] = [];
	for (const name of names) {
		if (typeof name !== "string" || !SEGMENT.test(name) || name === "." || name === "..") invalid();
		const path = join(directory, name);
		const stats = await lstat(path).catch(() => null);
		if (stats === null || !stats.isFile() || stats.isSymbolicLink()) throw new Error("BUNDLE_FILE_MISMATCH");
		if (stats.size > REMOTE_BUNDLE_MAX_FILE_BYTES) throw new Error("BUNDLE_FILE_MISMATCH");
		const bytes = await readFile(path).catch(() => null);
		if (bytes === null || bytes.length !== stats.size) throw new Error("BUNDLE_FILE_MISMATCH");
		observed.push({ name, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length });
	}
	return observed;
}

/**
 * Pinned scp call for one upload. Options come from the preflighted invocation and stay in front of the
 * `--` terminator, so a source name that begins with a dash can never be read as an option; batch mode
 * keeps a missing key from turning into an interactive prompt.
 *
 * The remote path is formatted for the protocol this client will actually speak. OpenSSH 9.0 and later
 * run scp over SFTP, where the path reaches the server literally and quoting would become part of the
 * directory name; older clients keep the legacy protocol, where the path is handed to the remote shell
 * and therefore has to be POSIX-quoted. Guessing wrong either uploads into a quoted name or lets the
 * remote shell split a path that contains a space.
 *
 * `-p` is deliberately absent: it would preserve the *local* mode, which on Windows is synthetic, and
 * the entry enforces the declared mode itself after the upload.
 */
export function buildUploadInvocation(input: { connection: PinnedSshInvocation; ready: BootstrapReadyFrame; directory: string; names: readonly string[] }): BundleUploadPlan["invocation"] {
	if (!isPlainObject(input)) invalid();
	const connection = input.connection as PinnedSshInvocation | undefined;
	const ready = input.ready as BootstrapReadyFrame | undefined;
	const directory = input.directory;
	const names = input.names;
	if (!isPlainObject(connection) || typeof connection.executable !== "string" || connection.executable.length === 0 || /[\x00-\x1f\x7f]/.test(connection.executable)) invalid();
	if (!Array.isArray(connection.args) || connection.args.some((arg) => typeof arg !== "string" || /[\x00\n\r]/.test(arg))) invalid();
	// The alias becomes the scp destination and is then forwarded to ssh as its host operand, so it has to
	// be the shape ssh itself accepts; an IPv6 literal or an option-looking alias must not slip through.
	if (typeof connection.destination !== "string" || !HOST_ALIAS.test(connection.destination) || connection.destination.length > 255) invalid();
	const version = parseOpenSshVersion(connection.openSshVersion);
	// An unreadable version means the protocol is unknown, and the two protocols need different paths.
	if (version === null) invalid();
	if (!isPlainObject(ready)) invalid();
	// The staging identity is validated rather than trusted: it decides where the bytes land remotely.
	if (!usableDeployRoot(ready.deployRoot)) invalid();
	if (typeof ready.nonce !== "string" || !NONCE.test(ready.nonce)) invalid();
	if (ready.staging !== `${REMOTE_BOOTSTRAP_STAGING_PREFIX}${ready.nonce}`) invalid();
	if (typeof directory !== "string" || directory.length === 0 || /[\x00-\x1f\x7f]/.test(directory) || !isAbsolute(directory)) invalid();
	if (!Array.isArray(names) || names.length === 0 || names.length > REMOTE_BUNDLE_MAX_FILES) invalid();
	for (const name of names) {
		if (typeof name !== "string" || !SEGMENT.test(name) || name === "." || name === "..") invalid();
	}
	const remotePath = ready.deployRoot.endsWith("/") ? `${ready.deployRoot}${ready.staging}` : `${ready.deployRoot}/${ready.staging}`;
	const sftp = version.major >= SFTP_BY_DEFAULT_MAJOR;
	const formatted = sftp ? remotePath : quotePosixArgument(remotePath);
	const target = `${connection.destination}:${formatted}`;
	return { executable: connection.executable, args: [...connection.args, "-q", "-B", "--", ...names, target], env: connection.env, cwd: directory, sftp };
}

/**
 * One upload step's inputs: the observed files, the manifest that pins them, the pinned scp call and the
 * finalize frames to send once the transfer reported success. The manifest hash is compared with the hash
 * the entry was started with before anything is transferred: a ready frame from another run would
 * otherwise move the whole bundle and only be refused by the entry afterwards.
 */
export async function planBundleUpload(input: { connection: PinnedSshInvocation; ready: BootstrapReadyFrame; directory: string; names: readonly string[]; executableNames?: readonly string[] }): Promise<BundleUploadPlan> {
	const observations = await observeBundleFiles(input.directory, input.names);
	const executableNames = readExecutableNames(input.executableNames);
	const manifest = buildBundleManifest(observations, { executableNames });
	if (input.ready?.bundleSha256 !== manifest.bundleSha256) throw new Error("BUNDLE_MANIFEST_INVALID");
	const invocation = buildUploadInvocation(input);
	return { manifest, observations, invocation, executableNames };
}
