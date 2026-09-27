import { execFile } from "node:child_process";
import { closeSync, constants, lstatSync, openSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { parseSshResolvedRoute } from "./SshRouteDigest";

export type SshCommandResult = { exitCode: number; stdout: string; stderr?: string };
export type SshCommandRunner = (executable: string, args: string[]) => Promise<SshCommandResult>;

/**
 * Main-owned OpenSSH client binding: absolute ssh/scp binaries from one installation plus the
 * sanitized environment every one of our SSH/SCP processes must use. Route preflight, host-key
 * enrollment and the future launcher have to share this object so `ssh -G` cannot pass against a
 * different client (or a different environment) than the process we later start.
 */
export type SshClientRuntime = {
	readonly sshPath: string;
	readonly scpPath: string;
	readonly env: Readonly<NodeJS.ProcessEnv>;
	run: SshCommandRunner;
	runScp: SshCommandRunner;
};

export type SshClientRuntimeOptions = {
	/** Explicit absolute ssh path for nonstandard installations; never resolved through PATH. */
	sshPath?: string;
	platform?: NodeJS.Platform;
	arch?: string;
	systemRoot?: string;
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
};

const MAX_COMMAND_TIMEOUT_MS = 30_000;
const MAX_CLIENT_PATH_LENGTH = 1024;

// Windows: OpenSSH needs the account/home/profile variables to read ~/.ssh/config, the system root
// for its own CRT/DLL lookup, ProgramData for the machine-wide ssh config/host keys (without it
// ssh.exe exits 255 before printing anything), PATH so a user-configured ProxyCommand can be
// executed, and the temp variables for its lock files. Everything else (Pi/PiDeck markers, model
// keys, Node and Electron options, generic proxy settings, askpass helpers) stays out.
const WINDOWS_ENV_KEYS = ["SystemRoot", "windir", "ProgramData", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "PATH", "ComSpec", "PATHEXT", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "COMPUTERNAME", "USERNAME", "SSH_AUTH_SOCK"];

// POSIX: keep the login-ish variables OpenSSH and ssh-agent need, plus a usable PATH for
// config-defined ProxyCommand executables.
const POSIX_ENV_KEYS = ["HOME", "PATH", "SHELL", "TMPDIR", "TEMP", "TMP", "USER", "LOGNAME", "LANG", "LC_ALL", "SSH_AUTH_SOCK"];

function invalidClient(): never {
	throw new Error("SSH_CLIENT_PATH_INVALID");
}

/** Allowlist-based env snapshot; unknown variables never reach OpenSSH. */
export function sanitizeSshClientEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
	const allowed = platform === "win32" ? WINDOWS_ENV_KEYS : POSIX_ENV_KEYS;
	const byLowerKey = new Map<string, string>();
	for (const key of Object.keys(env)) {
		const lower = key.toLowerCase();
		if (!byLowerKey.has(lower)) byLowerKey.set(lower, key);
	}
	const next: NodeJS.ProcessEnv = {};
	for (const key of allowed) {
		const actual = byLowerKey.get(key.toLowerCase());
		if (actual === undefined) continue;
		const value = env[actual];
		// NUL would truncate the value inside the child process; empty values only add ambiguity.
		if (typeof value !== "string" || value.length === 0 || value.includes("\0")) continue;
		next[key] = value;
	}
	// Windows environment blocks are case-insensitive but some tools read one specific spelling.
	if (platform === "win32" && next.PATH !== undefined) next.Path = next.PATH;
	return next;
}

function assertClientExecutable(filePath: string, platform: NodeJS.Platform): void {
	if (typeof filePath !== "string" || filePath.length === 0 || filePath.length > MAX_CLIENT_PATH_LENGTH || !isAbsolute(filePath) || /[\x00-\x1f\x7f]/.test(filePath)) invalidClient();
	if (/[\\/]\s*$/.test(filePath)) invalidClient();
	if (platform === "win32") {
		// A .cmd/.bat shim would be executed through cmd.exe; only a real executable is accepted.
		if (!/\.exe$/i.test(filePath)) throw new Error("SSH_CLIENT_SCRIPT_SHIM");
	} else if (/\.(?:exe|cmd|bat|ps1|sh)$/i.test(filePath)) throw new Error("SSH_CLIENT_SCRIPT_SHIM");
	let stats: ReturnType<typeof lstatSync>;
	try {
		stats = lstatSync(filePath);
	} catch {
		throw new Error("SSH_CLIENT_MISSING");
	}
	if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("SSH_CLIENT_NOT_REGULAR_FILE");
	// Existence is not executability: opening the file surfaces permission problems here instead of
	// as an opaque failure on the first real connection.
	try {
		closeSync(openSync(filePath, platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW));
	} catch {
		throw new Error("SSH_CLIENT_UNREADABLE");
	}
}

function windowsSshCandidates(systemRoot: string, arch: string): string[] {
	const openSsh = join(systemRoot, "System32", "OpenSSH", "ssh.exe");
	// A 32-bit process sees System32 through WOW64 redirection and must use Sysnative instead.
	return arch === "ia32" ? [join(systemRoot, "Sysnative", "OpenSSH", "ssh.exe"), openSsh] : [openSsh];
}

function resolveWindowsSshPath(options: SshClientRuntimeOptions, env: NodeJS.ProcessEnv): string {
	const systemRoot = options.systemRoot ?? env.SystemRoot ?? env.windir ?? "C:\\Windows";
	const candidates = windowsSshCandidates(systemRoot, options.arch ?? process.arch);
	for (const candidate of candidates) {
		try {
			lstatSync(candidate);
			return candidate;
		} catch {
			// Try the next candidate; a missing installation is reported as SSH_CLIENT_MISSING below.
		}
	}
	throw new Error("SSH_CLIENT_MISSING");
}

function mapProcessError(error: { code?: unknown; killed?: boolean } | null): Error | null {
	if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return new Error("SSH_HOST_COMMAND_OUTPUT_TOO_LARGE");
	if (error?.code === "ETIMEDOUT" || error?.killed) return new Error("SSH_HOST_COMMAND_TIMEOUT");
	if (error?.code === "ENOENT" || error?.code === "EACCES") return new Error("SSH_CLIENT_UNAVAILABLE");
	return null;
}

function createRunner(executable: string, env: NodeJS.ProcessEnv, timeoutMs: number): SshCommandRunner {
	return (target, args) => {
		if (target !== executable) throw new Error("SSH_CLIENT_EXECUTABLE_MISMATCH");
		if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) throw new Error("SSH_CLIENT_ARGUMENT_INVALID");
		return new Promise((resolve, reject) => {
			execFile(executable, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 256 * 1024, windowsHide: true, shell: false, env }, (error, stdout, stderr) => {
				const mapped = mapProcessError(error);
				if (mapped) return reject(mapped);
				resolve({ exitCode: error ? (typeof error.code === "number" ? error.code : -1) : 0, stdout, stderr });
			});
		});
	};
}

/**
 * Resolve the OpenSSH installation and snapshot its environment. Never resolves `ssh` through PATH:
 * a hostile PATH entry could otherwise supply the client that answers our `-G` checks.
 */
export function createSshClientRuntime(options: SshClientRuntimeOptions = {}): SshClientRuntime {
	const platform = options.platform ?? process.platform;
	const env = sanitizeSshClientEnv(options.env ?? process.env, platform);
	const timeoutMs = Math.min(Math.max(options.timeoutMs ?? MAX_COMMAND_TIMEOUT_MS, 1000), MAX_COMMAND_TIMEOUT_MS);
	// Non-Windows clients are not validated yet; an explicit override keeps that gate honest instead
	// of pretending an untested platform is supported.
	if (options.sshPath === undefined && platform !== "win32") {
		// A POSIX client can be used, but only after discovery proves the one we found is usable. Callers
		// that already know the path pass it explicitly; for everyone else the caller performs the probe
		// (`resolvePosixSshClient`) and passes the verified result, so an unverified platform is never
		// silently trusted. This keeps the refusal explicit instead of pretending any POSIX ssh works.
		throw new Error("SSH_CLIENT_UNSUPPORTED_PLATFORM");
	}
	const sshPath = options.sshPath ?? resolveWindowsSshPath(options, env);
	assertClientExecutable(sshPath, platform);
	const scpPath = join(dirname(sshPath), platform === "win32" ? "scp.exe" : "scp");
	assertClientExecutable(scpPath, platform);
	return Object.freeze({
		sshPath,
		scpPath,
		env: Object.freeze({ ...env }),
		run: createRunner(sshPath, env, timeoutMs),
		runScp: createRunner(scpPath, env, timeoutMs),
	});
}

/** Minimum OpenSSH release that supports every option our argv relies on. */
const MIN_OPENSSH_MAJOR = 8;

/**
 * Candidate absolute paths for a POSIX OpenSSH client, in preference order.
 *
 * Fixed paths only, never PATH: a hostile PATH entry could otherwise hand us the very client that
 * answers our `-G` checks, which is the trust anchor for the whole connection. These are the standard
 * locations on the supported distributions.
 */
const POSIX_SSH_CANDIDATES = ["/usr/bin/ssh", "/bin/ssh", "/usr/local/bin/ssh", "/opt/homebrew/bin/ssh"];

/**
 * Discover and verify a POSIX OpenSSH client, so "supported platform" becomes a measured fact
 * instead of an assumption about the operating system.
 *
 * What actually has to hold for our route checks to mean anything is that the client's `-G` output is
 * shaped the way the strict parser expects. A platform name is only a proxy for that, and a coarse one:
 * it rejects capable clients and admits incapable ones. So this probes the real binary and validates a
 * real `-G` result through the same parser the connection path uses:
 *
 *   1. the binaries exist as regular executable files (reusing the same checks as the Windows path);
 *   2. `ssh -V` reports OpenSSH >= 8 (the same self-check the Windows path runs);
 *   3. a throwaway `-G` query yields a route the strict parser accepts.
 *
 * Any failure is reported as a stable code; nothing here falls back to an unverified client.
 */
export async function resolvePosixSshClient(options: { candidates?: string[]; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {}): Promise<SshClientRuntime> {
	const platform = options.platform ?? process.platform;
	if (platform === "win32") throw new Error("SSH_CLIENT_UNSUPPORTED_PLATFORM");
	const candidates = options.candidates ?? POSIX_SSH_CANDIDATES;
	let lastError: string = "SSH_CLIENT_MISSING";
	for (const candidate of candidates) {
		let client: SshClientRuntime;
		try {
			// Construct first: this enforces the executable/regular-file/scp-in-same-directory checks.
			client = createSshClientRuntime({ ...options, platform, sshPath: candidate });
		} catch (error) {
			lastError = errorCode(error) ?? "SSH_CLIENT_UNAVAILABLE";
			continue;
		}
		try {
			await runSshClientSelfCheck(client);
			await assertClientCanResolveRoute(client);
		} catch (error) {
			lastError = errorCode(error) ?? "SSH_CLIENT_UNAVAILABLE";
			continue;
		}
		return client;
	}
	throw new Error(lastError);
}

/**
 * Prove the client's `-G` output is shaped the way the strict parser requires.
 *
 * The query names a syntax that cannot resolve locally: `-F /dev/null` drops the user's config (so a
 * match block, an Include or a ProxyCommand cannot influence the result) and the host name is
 * deliberately not a real one. `ssh -G` performs no network I/O, so this is an offline shape probe,
 * not a connection attempt.
 */
async function assertClientCanResolveRoute(client: SshClientRuntime): Promise<void> {
	const result = await client.run(client.sshPath, ["-G", "-F", "/dev/null", "pideck-client-probe.invalid"]);
	if (result.exitCode !== 0) throw new Error("SSH_CLIENT_PROBE_FAILED");
	// The real parser, not a loosened copy: if it changes, this check changes with it.
	try {
		parseSshResolvedRoute(result);
	} catch {
		throw new Error("SSH_CLIENT_ROUTE_UNSUPPORTED");
	}
}

function errorCode(error: unknown): string | undefined {
	const message = typeof error === "object" && error !== null && "message" in error ? (error as { message?: unknown }).message : undefined;
	return typeof message === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(message) ? message : undefined;
}

/** Probe `ssh -V` (OpenSSH prints its banner on stderr) through the bound runner; returns a redacted version. */
export async function runSshClientSelfCheck(client: SshClientRuntime, options: { run?: SshCommandRunner } = {}): Promise<{ version: string }> {
	if (!client || typeof client.sshPath !== "string" || typeof client.run !== "function") throw new Error("SSH_CLIENT_CONTEXT_REQUIRED");
	const run = options.run ?? client.run;
	const result = await run(client.sshPath, ["-V"]);
	const banner = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
	if (result.exitCode !== 0 || !banner) throw new Error("SSH_CLIENT_VERSION_UNSUPPORTED");
	const match = /^OpenSSH(?:[-_](?:for[-_]Windows[-_])?)(\d+)\.(\d+)(p\d+)?/.exec(banner);
	if (!match) throw new Error("SSH_CLIENT_VERSION_UNSUPPORTED");
	if (Number(match[1]) < MIN_OPENSSH_MAJOR) throw new Error("SSH_CLIENT_VERSION_UNSUPPORTED");
	return { version: match[0] };
}
