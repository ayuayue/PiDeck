/**
 * Host-side adapter for the one-shot Go SFTP executor.
 *
 * The adapter never constructs SSH options. It accepts only an invocation that
 * already passed the pinned route/host-key checks, then starts the local
 * executor with a sanitized environment. One job owns one executor process, so
 * cancellation can fence a project generation without a shared mutable SFTP
 * cwd or connection pool.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute, posix, win32 } from "node:path";
import type { PinnedSshInvocation } from "./SshVerifiedConnection";

export const REMOTE_SFTP_PROTOCOL_VERSION = 1;
export const REMOTE_SFTP_DEFAULT_MAX_ENTRIES = 1000;
export const REMOTE_SFTP_MAX_ENTRIES = 10_000;
export const REMOTE_SFTP_DEFAULT_CHUNK_BYTES = 1024 * 1024;
export const REMOTE_SFTP_MIN_CHUNK_BYTES = 64 * 1024;
export const REMOTE_SFTP_MAX_CHUNK_BYTES = 4 * 1024 * 1024;

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const DEFAULT_JOB_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export type RemoteSftpOperation = "probe" | "list" | "download" | "upload";

type RemoteSftpJobBase = {
	invocation: PinnedSshInvocation;
	/** Canonical project root held by main; never renderer text. */
	root: string;
	/** Project-relative POSIX path; empty is the root itself. */
	relative?: string;
	maxEntries?: number;
	chunkBytes?: number;
	overwrite?: boolean;
};

export type RemoteSftpJobInput = (RemoteSftpJobBase & { operation: "probe" | "list"; localPath?: never }) | (RemoteSftpJobBase & { operation: "download" | "upload"; localPath: string });

export type RemoteSftpProgress = {
	operation: "download" | "upload";
	transferred: number;
	total: number;
};

export type RemoteSftpEntry = {
	name: string;
	kind: "file" | "directory" | "other";
	bytes?: number;
	mtimeMs?: number;
	isSymlink: boolean;
};

export type RemoteSftpProbe = {
	protocolVersion: number;
	root: string;
	home?: string;
	extensions: Record<string, string>;
};

export type RemoteSftpList = {
	entries: RemoteSftpEntry[];
	scanned: number;
	truncated: boolean;
};

export type RemoteSftpTransfer = {
	bytes: number;
	mtimeMs?: number;
	fsync: boolean;
	atomicRename: boolean;
};

export type RemoteSftpJobResult = { ok: true; operation: "probe"; value: RemoteSftpProbe } | { ok: true; operation: "list"; value: RemoteSftpList } | { ok: true; operation: "download" | "upload"; value: RemoteSftpTransfer } | { ok: false; code: string };

export type RemoteSftpAdapterDependencies = {
	spawnFn?: typeof spawn;
	timeoutMs?: number;
	onProgress?: (progress: RemoteSftpProgress) => void;
	signal?: AbortSignal;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeInteger(value: unknown, minimum = 0): value is number {
	return Number.isSafeInteger(value) && (value as number) >= minimum;
}

function validErrorCode(value: unknown): value is string {
	return typeof value === "string" && /^[A-Z][A-Z0-9_]{2,127}$/.test(value);
}

function killChildTree(child: ChildProcessWithoutNullStreams): void {
	if (child.killed || child.exitCode !== null) return;
	const fallback = (): void => {
		try {
			child.kill();
		} catch {
			// A child that already closed its handle is already gone for our purposes.
		}
	};
	if (process.platform === "win32") {
		if (!Number.isSafeInteger(child.pid)) {
			fallback();
			return;
		}
		const systemRoot = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
		try {
			const killer = spawn(win32.join(systemRoot, "System32", "taskkill.exe"), ["/pid", String(child.pid), "/t", "/f"], {
				shell: false,
				windowsHide: true,
				stdio: "ignore",
			});
			killer.once("error", fallback);
			killer.once("close", (code) => {
				if (code !== 0) fallback();
			});
			return;
		} catch {
			fallback();
			return;
		}
	}
	if (Number.isSafeInteger(child.pid)) {
		try {
			process.kill(-(child.pid as number), "SIGTERM");
			return;
		} catch {
			// Fall back to the executor process if it was not the process-group leader.
		}
	}
	fallback();
}

function validText(value: unknown, maximum: number, allowEmpty = false): value is string {
	return typeof value === "string" && value.length <= maximum && (allowEmpty || value.length > 0) && !/[\u0000-\u001f\u007f]/.test(value);
}

function validRemoteRoot(value: unknown): value is string {
	if (!validText(value, 4096) || !value.startsWith("/") || value === "/") return false;
	const segments = value.slice(1).split("/");
	return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function validRelative(value: unknown): value is string {
	if (value === "") return true;
	if (!validText(value, 4096) || value.startsWith("/") || value.endsWith("/")) return false;
	const segments = value.split("/");
	return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function validInvocation(value: unknown): value is PinnedSshInvocation {
	if (!isRecord(value) || !validText(value.executable, 1024) || !isAbsolute(value.executable) || !Array.isArray(value.args)) return false;
	if (value.args.length > 256 || !value.args.every((arg) => typeof arg === "string" && arg.length <= 64 * 1024 && !arg.includes("\0"))) return false;
	if (!isRecord(value.env) || !Object.entries(value.env).every(([key, item]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && (item === undefined || (typeof item === "string" && !item.includes("\0"))))) return false;
	return value.cwd === undefined || (validText(value.cwd, 4096) && isAbsolute(value.cwd));
}

function requestFor(input: RemoteSftpJobInput): Record<string, unknown> | undefined {
	if (!isRecord(input) || !["probe", "list", "download", "upload"].includes(input.operation)) return undefined;
	if (!validInvocation(input.invocation) || !validRemoteRoot(input.root)) return undefined;
	const relative = input.relative ?? "";
	if (!validRelative(relative)) return undefined;
	if ((input.operation === "download" || input.operation === "upload") && (!validText(input.localPath, 4096) || !isAbsolute(input.localPath))) return undefined;
	const maxEntries = input.maxEntries ?? REMOTE_SFTP_DEFAULT_MAX_ENTRIES;
	if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > REMOTE_SFTP_MAX_ENTRIES) return undefined;
	const chunkBytes = input.chunkBytes ?? REMOTE_SFTP_DEFAULT_CHUNK_BYTES;
	if (!Number.isInteger(chunkBytes) || chunkBytes < REMOTE_SFTP_MIN_CHUNK_BYTES || chunkBytes > REMOTE_SFTP_MAX_CHUNK_BYTES) return undefined;
	if (input.overwrite === true) return undefined;
	const request: Record<string, unknown> = {
		version: REMOTE_SFTP_PROTOCOL_VERSION,
		operation: input.operation,
		ssh: {
			executable: input.invocation.executable,
			args: [...input.invocation.args],
			env: Object.fromEntries(Object.entries(input.invocation.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
			...(input.invocation.cwd === undefined ? {} : { cwd: input.invocation.cwd }),
		},
		root: input.root,
		relative,
		maxEntries,
		chunkBytes,
	};
	if (input.operation === "download" || input.operation === "upload") request.localPath = input.localPath;
	return request;
}

function parseFrame(line: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(line);
		return isRecord(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function readProbe(value: unknown, expectedRoot: string): RemoteSftpProbe | undefined {
	if (!isRecord(value) || value.protocolVersion !== REMOTE_SFTP_PROTOCOL_VERSION || value.root !== expectedRoot || !isRecord(value.extensions)) return undefined;
	const extensions: Record<string, string> = {};
	for (const [key, item] of Object.entries(value.extensions)) {
		if (!validText(key, 256) || !validText(item, 256)) return undefined;
		extensions[key] = item;
	}
	if (value.home !== undefined && !validText(value.home, 4096)) return undefined;
	return {
		protocolVersion: value.protocolVersion,
		root: value.root,
		extensions,
		...(value.home === undefined ? {} : { home: value.home }),
	};
}

function readList(value: unknown, maxEntries: number): RemoteSftpList | undefined {
	if (!isRecord(value) || !Array.isArray(value.entries) || value.entries.length > maxEntries || !safeInteger(value.scanned) || typeof value.truncated !== "boolean") return undefined;
	const entries: RemoteSftpEntry[] = [];
	for (const item of value.entries) {
		if (!isRecord(item) || !validText(item.name, 4096) || !["file", "directory", "other"].includes(item.kind as string) || typeof item.isSymlink !== "boolean") return undefined;
		if (item.bytes !== undefined && !safeInteger(item.bytes)) return undefined;
		if (item.mtimeMs !== undefined && !safeInteger(item.mtimeMs)) return undefined;
		entries.push({
			name: item.name,
			kind: item.kind as RemoteSftpEntry["kind"],
			isSymlink: item.isSymlink,
			...(item.bytes === undefined ? {} : { bytes: item.bytes }),
			...(item.mtimeMs === undefined ? {} : { mtimeMs: item.mtimeMs }),
		});
	}
	return { entries, scanned: value.scanned, truncated: value.truncated };
}

function readTransfer(value: unknown): RemoteSftpTransfer | undefined {
	if (!isRecord(value) || !safeInteger(value.bytes) || typeof value.fsync !== "boolean" || typeof value.atomicRename !== "boolean") return undefined;
	if (value.mtimeMs !== undefined && !safeInteger(value.mtimeMs)) return undefined;
	return {
		bytes: value.bytes,
		fsync: value.fsync,
		atomicRename: value.atomicRename,
		...(value.mtimeMs === undefined ? {} : { mtimeMs: value.mtimeMs }),
	};
}

function validateResult(input: RemoteSftpJobInput, result: unknown): RemoteSftpJobResult {
	if (input.operation === "probe") {
		const value = readProbe(result, input.root);
		return value === undefined ? { ok: false, code: "SFTP_RESULT_INVALID" } : { ok: true, operation: "probe", value };
	}
	if (input.operation === "list") {
		const value = readList(result, input.maxEntries ?? REMOTE_SFTP_DEFAULT_MAX_ENTRIES);
		return value === undefined ? { ok: false, code: "SFTP_RESULT_INVALID" } : { ok: true, operation: "list", value };
	}
	const value = readTransfer(result);
	return value === undefined ? { ok: false, code: "SFTP_RESULT_INVALID" } : { ok: true, operation: input.operation, value };
}

/**
 * Resolve the native executor in development and packaged builds. The caller
 * must still treat a missing binary as an unsupported capability.
 */
export function resolveRemoteSftpBinaryPath(input: { packaged: boolean; resourcesPath: string; appPath: string; platform?: NodeJS.Platform }): string {
	const platform = input.platform ?? process.platform;
	const name = platform === "win32" ? "remote-sftp.exe" : "remote-sftp";
	const path = platform === "win32" ? win32 : posix;
	return input.packaged ? path.join(input.resourcesPath, "remote-sftp", name) : path.join(input.appPath, "resources", "remote-sftp", "bin", name);
}

/**
 * Run one transfer job. Failures are stable results rather than exceptions so
 * the project service can map them to capability/result codes.
 */
export async function runRemoteSftpJob(binaryPath: string, input: RemoteSftpJobInput, dependencies: RemoteSftpAdapterDependencies = {}): Promise<RemoteSftpJobResult> {
	if (!validText(binaryPath, 4096) || !isAbsolute(binaryPath) || !validInvocation(input?.invocation)) return { ok: false, code: "SFTP_REQUEST_INVALID" };
	const body = requestFor(input);
	if (body === undefined) return { ok: false, code: "SFTP_REQUEST_INVALID" };
	const serialized = JSON.stringify(body);
	if (Buffer.byteLength(serialized, "utf8") > MAX_REQUEST_BYTES) return { ok: false, code: "SFTP_REQUEST_INVALID" };
	if (dependencies.signal?.aborted === true) return { ok: false, code: "SFTP_JOB_CANCELLED" };

	const spawnFn = dependencies.spawnFn ?? spawn;
	const timeoutMs = Number.isSafeInteger(dependencies.timeoutMs) && (dependencies.timeoutMs ?? 0) > 0 ? (dependencies.timeoutMs as number) : DEFAULT_JOB_TIMEOUT_MS;
	let child: ChildProcessWithoutNullStreams;
	try {
		child = spawnFn(binaryPath, [], {
			shell: false,
			windowsHide: true,
			detached: process.platform !== "win32",
			env: Object.fromEntries(Object.entries(input.invocation.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
			stdio: ["pipe", "pipe", "pipe"],
		}) as ChildProcessWithoutNullStreams;
	} catch {
		return { ok: false, code: "SFTP_BINARY_START_FAILED" };
	}

	return await new Promise<RemoteSftpJobResult>((resolve) => {
		let settled = false;
		let result: RemoteSftpJobResult | undefined;
		let stdoutBuffer = "";
		let stderrBytes = 0;
		const timer = setTimeout(() => finish({ ok: false, code: "SFTP_JOB_TIMEOUT" }), timeoutMs);
		const abort = (): void => finish({ ok: false, code: "SFTP_JOB_CANCELLED" });

		const finish = (value: RemoteSftpJobResult): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			dependencies.signal?.removeEventListener("abort", abort);
			if (!child.killed && child.exitCode === null) {
				killChildTree(child);
			}
			resolve(value);
		};

		const consumeLine = (line: string): void => {
			if (settled || line.trim() === "") return;
			const frame = parseFrame(line);
			if (frame?.type === "progress") {
				const operation = input.operation;
				if ((operation === "download" || operation === "upload") && frame.operation === operation && safeInteger(frame.transferred) && safeInteger(frame.total) && frame.transferred <= frame.total) {
					try {
						dependencies.onProgress?.({ operation, transferred: frame.transferred, total: frame.total });
					} catch {
						// A UI observer must not corrupt the transport state machine.
					}
				}
				return;
			}
			if (frame?.type !== "result") return;
			if (frame.ok === true) {
				result = validateResult(input, frame.result);
			} else {
				result = { ok: false, code: validErrorCode(frame.code) ? frame.code : "SFTP_JOB_FAILED" };
			}
		};

		child.stdout.on("data", (chunk: Buffer | string) => {
			const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
			stdoutBuffer += text;
			if (Buffer.byteLength(stdoutBuffer) > MAX_FRAME_BYTES) {
				finish({ ok: false, code: "SFTP_OUTPUT_TOO_LARGE" });
				return;
			}
			for (;;) {
				const index = stdoutBuffer.indexOf("\n");
				if (index < 0) break;
				const line = stdoutBuffer.slice(0, index);
				stdoutBuffer = stdoutBuffer.slice(index + 1);
				consumeLine(line);
			}
		});
		child.stdin.on("error", () => finish({ ok: false, code: "SFTP_REQUEST_WRITE_FAILED" }));
		child.stdout.on("error", () => finish({ ok: false, code: "SFTP_JOB_FAILED" }));
		child.stderr.on("data", (chunk: Buffer | string) => {
			stderrBytes += Buffer.byteLength(chunk);
			if (stderrBytes > MAX_STDERR_BYTES * 4) child.stderr.destroy();
		});
		child.stderr.on("error", () => {
			// Stderr is diagnostic-only; its read-side failure cannot change the job result.
		});
		child.on("error", () => finish({ ok: false, code: "SFTP_BINARY_START_FAILED" }));
		child.on("close", (code) => {
			if (stdoutBuffer.trim() !== "") consumeLine(stdoutBuffer);
			if (code !== 0 && result?.ok === true) {
				finish({ ok: false, code: "SFTP_JOB_FAILED" });
				return;
			}
			finish(result ?? { ok: false, code: "SFTP_JOB_FAILED" });
		});
		dependencies.signal?.addEventListener("abort", abort, { once: true });
		if (dependencies.signal?.aborted === true) {
			abort();
			return;
		}
		try {
			child.stdin.end(`${serialized}\n`);
		} catch {
			finish({ ok: false, code: "SFTP_REQUEST_WRITE_FAILED" });
		}
	});
}
