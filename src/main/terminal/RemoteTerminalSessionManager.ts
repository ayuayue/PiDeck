import { randomUUID } from "node:crypto";
import type { IPty } from "node-pty";
import { ipcChannels } from "../../shared/ipc";
import type { TerminalTab, TerminalShell } from "../../shared/types/terminal";

export type RemoteTerminalTarget = { projectId: string; hostId: string; remotePath: string };
export type RemoteTerminalResource = {
	pty: Pick<IPty, "write" | "resize" | "pause" | "resume">;
	assertCurrent(): Promise<void>;
	dispose(): void;
	/** The login shell the frozen runner selected, as reported by its START frame (main-side record only). */
	shell?: string;
};
export type RemoteTerminalOptions = {
	locator(projectId: string): { hostId: string; remotePath: string } | undefined;
	/**
	 * The SSH adapter owns ticket minting and the runner handshake; this resolves only after the runner confirmed
	 * the login shell, so a tab is published on the same evidence as before (never on a guessed prompt).
	 */
	start(target: RemoteTerminalTarget, signal: AbortSignal, callbacks: { data(data: string): void; exit(code: number): void }): Promise<RemoteTerminalResource>;
	emit(senderId: number, channel: string, payload: unknown): void;
	startupTimeoutMs?: number;
};
type Runtime = {
	tab: TerminalTab;
	senderId: number;
	target: RemoteTerminalTarget;
	controller: AbortController;
	resource?: RemoteTerminalResource;
	closed: boolean;
	published: boolean;
	timer?: ReturnType<typeof setTimeout>;
	error?: Error;
	exitEmitted?: boolean;
	queue: string;
	queueBytes: number;
	paused: boolean;
	buffer: string;
	sequence: number;
	awaiting?: number;
	operations: Promise<void>;
	inputBytes: number;
	operationsCount: number;
};
const REPLAY_LIMIT = 128 * 1024;
const QUEUE_LIMIT = 256 * 1024;
const PACKET_LIMIT = 32 * 1024;

/** Keep unexpected native errors, executable paths and SSH connection details out of IPC errors. */
function stableError(error: unknown): Error {
	const code = typeof error === "object" && error !== null && "message" in error && typeof error.message === "string" ? error.message : "";
	return new Error(/^(?:SSH_|REMOTE_|PROJECT_|TERMINAL_)[A-Z0-9_]{1,100}$/.test(code) ? code : "REMOTE_TERMINAL_START_FAILED");
}

/** Project/window-owned interactive SSH sessions; native terminal routing remains a separate domain. */
export class RemoteTerminalSessionManager {
	private readonly runtimes = new Map<string, Runtime>();
	private readonly ensuring = new Map<string, Promise<TerminalTab[]>>();
	private readonly watch: ReturnType<typeof setInterval>;
	private checking = false;
	private disposed = false;

	constructor(private readonly options: RemoteTerminalOptions) {
		this.watch = setInterval(() => {
			if (this.checking) return;
			this.checking = true;
			void Promise.all([...this.runtimes.values()].filter((r) => !r.closed && r.resource).map((r) => this.guard(r).catch(() => undefined))).finally(() => {
				this.checking = false;
			});
		}, 1000);
		this.watch.unref();
	}

	has(id: string): boolean {
		return this.runtimes.has(id);
	}

	/** Remote shells do not expose foreground process names. */
	liveCount(senderId: number): number {
		return [...this.runtimes.values()].filter((runtime) => runtime.senderId === senderId && !runtime.closed && !runtime.tab.exited).length;
	}

	list(senderId: number, projectId: string): TerminalTab[] {
		return [...this.runtimes.values()].filter((r) => r.senderId === senderId && r.target.projectId === projectId && r.published).map((r) => ({ ...r.tab, buffer: r.buffer, outputSequence: r.sequence }));
	}

	/** StrictMode mounts share one pending creation, not two SSH processes. */
	ensure(senderId: number, projectId: string): Promise<TerminalTab[]> {
		const key = `${senderId}:${projectId}`;
		const pending = this.ensuring.get(key);
		if (pending) return pending;
		const existing = this.list(senderId, projectId);
		if (existing.length) return Promise.resolve(existing);
		const task = this.create(senderId, projectId)
			.then((tab) => [tab])
			.finally(() => {
				if (this.ensuring.get(key) === task) this.ensuring.delete(key);
			});
		this.ensuring.set(key, task);
		return task;
	}

	/** Publish only after the launcher confirmed the runner consumed its ticket and reached the login shell. */
	async create(senderId: number, projectId: string, shell?: TerminalShell): Promise<TerminalTab> {
		if (this.disposed) throw new Error("REMOTE_TERMINAL_CLOSED");
		if (!Number.isSafeInteger(senderId) || senderId < 1) throw new Error("REMOTE_TERMINAL_OWNER_MISMATCH");
		if (shell !== undefined && shell !== "sh") throw new Error("REMOTE_TERMINAL_SHELL_UNSUPPORTED");
		const locator = this.options.locator(projectId);
		if (!locator) throw new Error("PROJECT_NOT_FOUND");
		const owned = [...this.runtimes.values()].filter((r) => r.senderId === senderId);
		if (this.runtimes.size >= 32 || owned.length >= 16 || owned.filter((r) => r.target.projectId === projectId).length >= 4) throw new Error("REMOTE_TERMINAL_LIMIT");
		const r: Runtime = {
			tab: { id: randomUUID(), agentId: "", ownerKey: `project:${projectId}`, title: `SSH ${owned.filter((r) => r.target.projectId === projectId).length + 1}`, shell: "sh", location: "ssh", createdAt: Date.now() },
			senderId,
			target: { projectId, hostId: locator.hostId, remotePath: locator.remotePath },
			controller: new AbortController(),
			closed: false,
			published: false,
			queue: "",
			queueBytes: 0,
			paused: false,
			buffer: "",
			sequence: 0,
			awaiting: 0,
			operations: Promise.resolve(),
			inputBytes: 0,
			operationsCount: 0,
		};
		this.runtimes.set(r.tab.id, r);
		r.timer = setTimeout(() => this.finish(r, "REMOTE_TERMINAL_START_TIMEOUT"), this.options.startupTimeoutMs ?? 30_000);
		try {
			const cancelled = new Promise<never>((_resolve, reject) => r.controller.signal.addEventListener("abort", () => reject(r.error ?? new Error("REMOTE_TERMINAL_CLOSED")), { once: true }));
			const starting = this.options.start(r.target, r.controller.signal, { data: (data) => this.receive(r, data), exit: (code) => this.finish(r, r.published ? undefined : "REMOTE_TERMINAL_START_FAILED", code) }).then((resource) => {
				// A timed-out bootstrap may finish later: observe it and release, never publish a late PTY.
				if (r.closed) resource.dispose();
				return resource;
			});
			r.resource = await Promise.race([starting, cancelled]);
			if (r.closed) {
				r.resource.dispose();
				throw r.error ?? new Error("REMOTE_TERMINAL_CLOSED");
			}
			await this.guard(r);
			if (r.timer) clearTimeout(r.timer);
			r.published = true;
			this.flow(r);
			return { ...r.tab, buffer: r.buffer, outputSequence: r.sequence };
		} catch (error) {
			if (!r.closed) this.finish(r, stableError(error).message);
			throw r.error ?? stableError(error);
		}
	}

	private owned(senderId: number, id: string): Runtime {
		const r = this.runtimes.get(id);
		if (!r || r.senderId !== senderId) throw new Error("REMOTE_TERMINAL_OWNER_MISMATCH");
		return r;
	}

	/** Check immediately before each side effect; helper root switches do not invalidate an independent PTY. */
	private async guard(r: Runtime): Promise<void> {
		if (r.closed) throw r.error ?? new Error("REMOTE_TERMINAL_CLOSED");
		try {
			const current = this.options.locator(r.target.projectId);
			if (!current || current.hostId !== r.target.hostId || current.remotePath !== r.target.remotePath) throw new Error("REMOTE_TERMINAL_TARGET_CHANGED");
			await r.resource?.assertCurrent();
			const after = this.options.locator(r.target.projectId);
			if (!after || after.hostId !== r.target.hostId || after.remotePath !== r.target.remotePath) throw new Error("REMOTE_TERMINAL_TARGET_CHANGED");
			if (r.closed) throw r.error ?? new Error("REMOTE_TERMINAL_CLOSED");
		} catch (error) {
			const failure = stableError(error);
			this.finish(r, failure.message);
			throw failure;
		}
	}

	private async operation(senderId: number, id: string, bytes: number, task: (r: Runtime) => void): Promise<void> {
		const r = this.owned(senderId, id);
		if (r.inputBytes + bytes > 64 * 1024 || r.operationsCount >= 32) throw new Error("REMOTE_TERMINAL_INPUT_LIMIT");
		r.inputBytes += bytes;
		r.operationsCount++;
		const pending = r.operations.then(async () => {
			await this.guard(r);
			try {
				task(r);
			} catch (error) {
				const failure = stableError(error);
				this.finish(r, failure.message);
				throw failure;
			}
		});
		r.operations = pending.catch(() => undefined);
		try {
			await pending;
		} finally {
			r.inputBytes -= bytes;
			r.operationsCount--;
		}
	}

	async input(senderId: number, id: string, data: string): Promise<void> {
		if (typeof data !== "string" || Buffer.byteLength(data, "utf8") > 16 * 1024) throw new Error("REMOTE_TERMINAL_INPUT_LIMIT");
		return this.operation(senderId, id, Buffer.byteLength(data), (r) => r.resource?.pty.write(data));
	}

	async resize(senderId: number, id: string, cols: number, rows: number): Promise<void> {
		if (![cols, rows].every((value) => Number.isSafeInteger(value) && value >= 1 && value <= 1000)) throw new Error("INVALID_TERMINAL_SIZE");
		return this.operation(senderId, id, 0, (r) => r.resource?.pty.resize(cols, rows));
	}

	/** One outstanding packet per tab. A hidden/unmounted viewer cannot create an unbounded IPC queue. */
	ack(senderId: number, id: string, sequence: number): void {
		const r = this.owned(senderId, id);
		if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > r.sequence) throw new Error("INVALID_TERMINAL_SEQUENCE");
		if (r.error || sequence !== r.awaiting) return;
		r.awaiting = undefined;
		this.flow(r);
	}

	private receive(r: Runtime, data: string): void {
		if (r.closed) return;
		r.queue += data;
		r.queueBytes += Buffer.byteLength(data);
		if (r.queueBytes > QUEUE_LIMIT) {
			this.finish(r, "REMOTE_TERMINAL_OUTPUT_LIMIT");
			return;
		}
		this.flow(r);
	}

	private flow(r: Runtime): void {
		if (r.error || !r.resource) return;
		if (!r.closed && r.queueBytes >= REPLAY_LIMIT && !r.paused) {
			r.resource.pty.pause();
			r.paused = true;
		}
		if (!r.closed && r.paused && r.queueBytes <= REPLAY_LIMIT / 2) {
			r.resource.pty.resume();
			r.paused = false;
		}
		if (!r.published || r.awaiting !== undefined) return;
		if (!r.queue.length) {
			this.emitExit(r);
			return;
		}
		let end = Math.min(Math.floor(PACKET_LIMIT / 3), r.queue.length); // UTF-8 packet bytes remain <=32KiB, including non-ASCII text.
		if (end < r.queue.length && /[\uD800-\uDBFF]/.test(r.queue[end - 1])) end--;
		const data = r.queue.slice(0, end);
		r.queue = r.queue.slice(end);
		r.queueBytes -= Buffer.byteLength(data);
		r.buffer = (r.buffer + data).slice(-REPLAY_LIMIT);
		r.awaiting = ++r.sequence;
		this.options.emit(r.senderId, ipcChannels.terminalData, { tabId: r.tab.id, data, sequence: r.sequence });
		if (!r.closed && r.paused && r.queueBytes <= REPLAY_LIMIT / 2) {
			r.resource.pty.resume();
			r.paused = false;
		}
	}

	private finish(r: Runtime, reason?: string, exitCode?: number): void {
		if (r.closed) return;
		r.closed = true;
		r.error = reason ? new Error(reason) : undefined;
		r.controller.abort();
		if (r.timer) clearTimeout(r.timer);
		r.tab = { ...r.tab, exited: true, exitCode, exitReason: reason };
		if (reason) {
			r.queue = "";
			r.queueBytes = 0;
			r.awaiting = undefined;
		}
		r.resource?.dispose();
		if (r.published) {
			if (reason) this.emitExit(r);
			else this.flow(r);
		} else this.runtimes.delete(r.tab.id);
	}

	/** Natural process exit waits for its final output packet instead of silently dropping test results. */
	private emitExit(r: Runtime): void {
		if (!r.closed || r.exitEmitted) return;
		r.exitEmitted = true;
		this.options.emit(r.senderId, ipcChannels.terminalExit, { tabId: r.tab.id, exitCode: r.tab.exitCode, reason: r.tab.exitReason });
	}

	close(senderId: number, id: string): void {
		const r = this.owned(senderId, id);
		this.finish(r, "REMOTE_TERMINAL_CLOSED");
		this.runtimes.delete(id);
	}
	closeHost(hostId: string): void {
		for (const r of this.runtimes.values()) if (r.target.hostId === hostId) this.finish(r, "SSH_HOST_DISCONNECTED");
	}
	releaseSender(senderId: number): void {
		for (const r of this.runtimes.values())
			if (r.senderId === senderId) {
				r.published = false;
				this.finish(r, "REMOTE_TERMINAL_CLOSED");
				this.runtimes.delete(r.tab.id);
			}
	}
	closeAll(): void {
		this.disposed = true;
		clearInterval(this.watch);
		for (const r of this.runtimes.values()) this.finish(r, "REMOTE_TERMINAL_CLOSED");
		this.runtimes.clear();
	}
}
