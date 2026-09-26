import { quotePosixArgument, REMOTE_BOOTSTRAP_STAGING_PREFIX } from "./RemoteBootstrapContract";
import { REMOTE_BOOTSTRAP_BUNDLE_DIR_NAME } from "./RemoteHelperContract";

/**
 * The fixed remote command template of plan §168: the only place that turns local knowledge into a
 * command string that a remote shell will parse.
 *
 * `ssh -T host <command>` hands the words to the remote login shell, so every token is quoted with the
 * same POSIX rule the bootstrap template uses and no token is ever interpolated from user input: the
 * command is `<node> <deployRoot>/bundles/<bundleSha256>/helper.mjs`. Anything with different quoting,
 * redirection or a second command would be a second template, which is exactly what the plan forbids.
 */

const SHA256 = /^[0-9a-f]{64}$/;
/** A remote path we are willing to put in a command line: absolute, no control characters. */
const CONTROL = /[\x00-\x1f\x7f]/;

export type HelperRemoteCommandInput = {
	/** Absolute POSIX path of the node binary the helper must run under (from the connection probe). */
	nodePath: string;
	/** Absolute POSIX deploy root the bootstrap entry resolved on the remote. */
	deployRoot: string;
	/** Content address of the activated bundle. */
	bundleSha256: string;
	/** File inside the bundle; defaults to the pinned helper entry name. */
	entryName?: string;
};

/** Absolute path of the activated helper for one deploy root and bundle address. */
export function resolveHelperEntryPath(input: { deployRoot: string; bundleSha256: string; entryName: string }): string {
	const root = readRemotePath(input.deployRoot, "DEPLOY_ROOT");
	if (typeof input.bundleSha256 !== "string" || !SHA256.test(input.bundleSha256)) throw new Error("REMOTE_HELPER_COMMAND_INVALID_BUNDLE");
	return `${root}/${REMOTE_BOOTSTRAP_BUNDLE_DIR_NAME}/${input.bundleSha256}/${readEntryName(input.entryName)}`;
}

/** One segment of the activated bundle; never a path the caller can steer out of it. */
function readEntryName(value: unknown): string {
	if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) || value.includes("/") || value.includes("..")) throw new Error("REMOTE_HELPER_COMMAND_INVALID_ENTRY");
	return value;
}

/**
 * A remote path we are willing to put in a command line. Rejecting rather than normalizing is deliberate:
 * the caller either has the canonical path the bootstrap entry reported or it has a bug, and a silently
 * trimmed slash would hide it. Shell metacharacters are *allowed* here because every token is quoted for
 * a shell that will always exist on this path (unlike the SFTP upload, where quoting must not appear).
 */
function readRemotePath(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.startsWith("/") || value.length > 4096 || value === "/") throw new Error(`REMOTE_HELPER_COMMAND_INVALID_${label}`);
	if (CONTROL.test(value)) throw new Error(`REMOTE_HELPER_COMMAND_INVALID_${label}`);
	// A trailing slash would silently change the meaning of the joined path.
	if (value.endsWith("/")) throw new Error(`REMOTE_HELPER_COMMAND_INVALID_${label}`);
	return value;
}

/**
 * Build the remote command as one string of quoted tokens. The caller passes it to the launcher as a
 * single argv element after the destination, so the remote shell is the only thing that ever splits it.
 */
export function buildHelperRemoteCommand(input: HelperRemoteCommandInput): string {
	if (typeof input !== "object" || input === null) throw new Error("REMOTE_HELPER_COMMAND_INVALID_INPUT");
	const nodePath = readRemotePath(input.nodePath, "NODE");
	const entryPath = resolveHelperEntryPath({ deployRoot: input.deployRoot, bundleSha256: input.bundleSha256, entryName: input.entryName ?? "helper.mjs" });
	// Staging is never executable: a command that pointed at it would run unverified bytes.
	if (entryPath.includes(`/${REMOTE_BOOTSTRAP_STAGING_PREFIX}`)) throw new Error("REMOTE_HELPER_COMMAND_INVALID_ENTRY");
	return [quotePosixArgument(nodePath), quotePosixArgument(entryPath)].join(" ");
}
