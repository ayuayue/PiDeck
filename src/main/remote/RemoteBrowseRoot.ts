import { buildPinnedSshInvocation } from "./SshVerifiedConnection";
import { quotePosixArgument } from "./RemoteBootstrapContract";
import type { SshClientRuntime } from "./SshClientRuntime";

/**
 * Browse root resolution: turn the directory a user typed into the canonical directory that will actually
 * be confined to, and prove it is a directory before anyone is asked to confirm it.
 *
 * Why this must run before confirmation: the helper canonicalizes its `--root` at startup (realpath) and
 * reports the result in `hello`, and the handshake refuses a mismatch. So a path that reaches the helper as
 * a symlink can never become a working session — the user would confirm a path that is then rejected, with
 * no way to tell why. Resolving here means the value that is shown to the user, stored, and passed on is
 * already the canonical one, and the handshake then agrees with it.
 *
 * Two requirements on the value itself, both enforced here rather than trusted downward:
 * - it is an absolute POSIX path with no control bytes and no traversal segment, and
 * - it resolves to a directory (not a file, not a link that is broken).
 *
 * The probe runs through the same pinned-and-preflighted invocation every other remote command uses, with
 * each argument POSIX-quoted, so a path cannot become a second shell word or a new option.
 */

/** Bounded remote path length; the helper's own `--root` ceiling, kept equal on purpose. */
const MAX_REMOTE_PATH = 4096;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export const REMOTE_BROWSE_ROOT_CODES = {
	invalidPath: "REMOTE_BROWSE_ROOT_INVALID",
	notAbsolute: "REMOTE_BROWSE_ROOT_NOT_ABSOLUTE",
	notADirectory: "REMOTE_BROWSE_ROOT_NOT_A_DIRECTORY",
	unresolved: "REMOTE_BROWSE_ROOT_UNRESOLVED",
	probeFailed: "REMOTE_BROWSE_ROOT_PROBE_FAILED",
} as const;

export type RemoteBrowseRootCode = (typeof REMOTE_BROWSE_ROOT_CODES)[keyof typeof REMOTE_BROWSE_ROOT_CODES];

/** A canonical remote directory, ready to be confirmed and then passed as the helper's `--root`. */
export type ResolvedRemoteBrowseRoot = { canonicalPath: string };

/**
 * The remote command that resolves a path and classifies it in one round trip.
 *
 * `readlink -f` is the portable spelling of "canonicalize, following every component". Its exit status is
 * the two failures apart: it fails when a **parent** component does not exist (exit 3 here), while a missing
 * leaf simply resolves to itself, so the directory test is what rejects it (exit 5). A symlink to a
 * directory is therefore accepted as its target while a symlink to a file is not. Both are reported
 * separately because they need different words in the UI.
 */
export function buildResolveBrowseRootCommand(userPath: string): string {
	assertProbePath(userPath);
	// `--` ends option parsing: a path that begins with `-` is a path, never a flag.
	return `target=$(readlink -f -- ${quotePosixArgument(userPath)}) || exit 3; [ -n "$target" ] || exit 4; [ -d "$target" ] || exit 5; printf '%s\\n' "$target"`;
}

/** Reject anything that must not reach the remote shell, before it is quoted into a command. */
function assertProbePath(value: unknown): asserts value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_REMOTE_PATH) throw new Error(REMOTE_BROWSE_ROOT_CODES.invalidPath);
	if (CONTROL_CHARS.test(value)) throw new Error(REMOTE_BROWSE_ROOT_CODES.invalidPath);
	if (!value.startsWith("/")) throw new Error(REMOTE_BROWSE_ROOT_CODES.notAbsolute);
	if (value === "/") throw new Error(REMOTE_BROWSE_ROOT_CODES.invalidPath);
	// A trailing separator is refused for the same reason the helper refuses one: it makes the boundary
	// string ambiguous against its own children.
	if (value.endsWith("/")) throw new Error(REMOTE_BROWSE_ROOT_CODES.invalidPath);
	const segments = value.slice(1).split("/");
	if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) throw new Error(REMOTE_BROWSE_ROOT_CODES.invalidPath);
}

/**
 * Validate the canonical path the remote reported.
 *
 * Checked independently of the input because it comes back from the remote: a canonical path must still be
 * absolute, bounded, free of traversal segments and non-root. Reusing the same gate on both sides keeps one
 * definition of "an acceptable boundary".
 */
export function readCanonicalBrowseRoot(value: unknown): ResolvedRemoteBrowseRoot {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_REMOTE_PATH) throw new Error(REMOTE_BROWSE_ROOT_CODES.unresolved);
	const trimmed = value.endsWith("\n") ? value.slice(0, -1) : value;
	if (trimmed.includes("\n") || CONTROL_CHARS.test(trimmed)) throw new Error(REMOTE_BROWSE_ROOT_CODES.unresolved);
	if (!trimmed.startsWith("/") || trimmed === "/" || trimmed.endsWith("/")) throw new Error(REMOTE_BROWSE_ROOT_CODES.unresolved);
	const segments = trimmed.slice(1).split("/");
	if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) throw new Error(REMOTE_BROWSE_ROOT_CODES.unresolved);
	return { canonicalPath: trimmed };
}

/**
 * Resolve one user-supplied remote directory through a pinned, preflighted SSH invocation.
 *
 * The exit codes are the remote command's own, mapped to distinct codes so "does not exist" and "is a file"
 * stay tellable apart: they need different words in the UI, and collapsing them would leave the user
 * guessing which mistake they made.
 */
export async function resolveRemoteBrowseRoot(input: { userDataDir: string; hostId: string; client: SshClientRuntime; userPath: string }): Promise<ResolvedRemoteBrowseRoot> {
	const command = buildResolveBrowseRootCommand(input.userPath);
	const invocation = await buildPinnedSshInvocation(input.userDataDir, input.hostId, "ssh-batch", { client: input.client, remoteCommand: command });
	let result: { exitCode: number; stdout: string };
	try {
		result = await input.client.run(invocation.executable, invocation.args);
	} catch {
		throw new Error(REMOTE_BROWSE_ROOT_CODES.probeFailed);
	}
	if (result.exitCode === 3 || result.exitCode === 4) throw new Error(REMOTE_BROWSE_ROOT_CODES.unresolved);
	if (result.exitCode === 5) throw new Error(REMOTE_BROWSE_ROOT_CODES.notADirectory);
	if (result.exitCode !== 0) throw new Error(REMOTE_BROWSE_ROOT_CODES.probeFailed);
	return readCanonicalBrowseRoot(result.stdout);
}
