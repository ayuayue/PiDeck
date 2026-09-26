import { quotePosixArgument, REMOTE_BOOTSTRAP_STAGING_PREFIX } from "./RemoteBootstrapContract";
import { REMOTE_HELPER_ENTRY_FILE_NAME } from "./RemoteHelperEntry";
import { REMOTE_BOOTSTRAP_BUNDLE_DIR_NAME, REMOTE_HELPER_MAX_REMOTE_COMMAND_LENGTH } from "./RemoteHelperContract";

/**
 * The fixed remote command template of plan §168: the only place that turns local knowledge into a
 * command string that a remote shell will parse.
 *
 * `ssh -T host <command>` hands the words to the remote login shell, so every token is quoted with the
 * same POSIX rule the bootstrap template uses and no token is ever interpolated from user input: the
 * command is `<node> <deployRoot>/bundles/<bundleSha256>/helper.mjs`, with `--root <absolute root>`
 * appended when the caller has one. The token order is fixed — the entry always first, the flag a literal
 * and the root one quoted path — because the helper reads the flag from argv and would otherwise have to
 * guess where its root came from. An omitted root drops the whole flag pair instead of sending an empty
 * token, because the helper reads "no flag" as the legal host-only session and an empty value as a caller
 * bug: two different states that must not be spelled the same way. Anything with different quoting,
 * redirection or a second command would be a second template, which is exactly what the plan forbids.
 */

const SHA256 = /^[0-9a-f]{64}$/;
/** A remote path we are willing to put in a command line: absolute, no control characters. */
const CONTROL = /[\x00-\x1f\x7f]/;
/** Fixed token that names the helper's confinement root; omitted together with its value when there is none. */
const ROOT_FLAG = "--root";

export type HelperRemoteCommandInput = {
	/** Absolute POSIX path of the node binary the helper must run under (from the connection probe). */
	nodePath: string;
	/** Absolute POSIX deploy root the bootstrap entry resolved on the remote. */
	deployRoot: string;
	/** Content address of the activated bundle. */
	bundleSha256: string;
	/** File inside the bundle; defaults to the pinned helper entry name. */
	entryName?: string;
	/**
	 * Absolute POSIX directory the helper confines every `fs.*` method to, or omitted for a host-only
	 * helper. A supplied value must be the canonical path the connection verified (absolute, no trailing
	 * slash, not `/`); a different spelling is refused instead of normalized, exactly like the deploy root.
	 * Omitting it is not the same thing as passing an empty root: the flag pair is dropped entirely and the
	 * helper serves `hello`/`echo`/`cancel` while refusing every `fs.*` call with PATH_OUTSIDE_ROOT.
	 */
	root?: string;
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
 * The helper's confinement root as one shell token, or null when the caller has none. It is the same
 * remote-path rule as the deploy root, plus one deliberate difference: an *omitted* root is not turned
 * into a default (the remote HOME least of all) and not into an empty token either — the whole flag pair
 * disappears and the command keeps the two tokens it always has. The helper reads that as its legal
 * host-only session: `hello`/`echo`/`cancel` are served while every `fs.*` method answers
 * PATH_OUTSIDE_ROOT, so no path is ever served outside a verified root. An empty token stays reserved for
 * a caller that really passed an empty root, which the helper refuses at startup with a ROOT_INVALID frame
 * and a non-zero exit; "no root" and "unusable root" therefore stay two states from here to the remote.
 * A root that *is* supplied but unusable still throws right here.
 */
function readHelperRoot(value: unknown): string | null {
	if (value === undefined) return null;
	return readRemotePath(value, "ROOT");
}

/**
 * Build the remote command as one string of quoted tokens. The caller passes it to the launcher as a
 * single argv element after the destination, so the remote shell is the only thing that ever splits it.
 * Two shapes exist and nothing else: the bare `<node> <entry>` pair when the caller has no root, and the
 * same pair plus `--root <quoted root>` when it has one. The flag is never emitted with an empty value,
 * because the helper would read that as an unusable root and refuse to start.
 */
export function buildHelperRemoteCommand(input: HelperRemoteCommandInput): string {
	if (typeof input !== "object" || input === null) throw new Error("REMOTE_HELPER_COMMAND_INVALID_INPUT");
	const nodePath = readRemotePath(input.nodePath, "NODE");
	const root = readHelperRoot(input.root);
	const entryPath = resolveHelperEntryPath({ deployRoot: input.deployRoot, bundleSha256: input.bundleSha256, entryName: input.entryName ?? REMOTE_HELPER_ENTRY_FILE_NAME });
	// Staging is never executable: a command that pointed at it would run unverified bytes.
	if (entryPath.includes(`/${REMOTE_BOOTSTRAP_STAGING_PREFIX}`)) throw new Error("REMOTE_HELPER_COMMAND_INVALID_ENTRY");
	const tokens = [quotePosixArgument(nodePath), quotePosixArgument(entryPath)];
	if (root !== null) tokens.push(ROOT_FLAG, quotePosixArgument(root));
	const built = tokens.join(" ");
	// The argv boundary refuses a longer command, so emitting one would only move the failure later.
	if (built.length > REMOTE_HELPER_MAX_REMOTE_COMMAND_LENGTH) throw new Error("REMOTE_HELPER_COMMAND_INVALID_LENGTH");
	return built;
}
