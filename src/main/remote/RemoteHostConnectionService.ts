import { randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";
import { RemoteHostStore } from "./RemoteHostStore";
import { bootstrapPinnedHost, resolveRemoteNodeExecutable } from "./RemoteBootstrapSession";
import { createSshConnectionManager, type SshConnectionManager, type SshHelperSession } from "./SshConnectionManager";
import { createSshProcessLauncher } from "./SshProcessLauncher";
import { diagnosticCodeFromError } from "./SshConnectionDiagnostics";
import type { SshClientRuntime } from "./SshClientRuntime";
import type { SshProcessLauncher } from "./RemoteHostConnectionTypes";
import type { ConnectionMachineState } from "./RemoteHostConnectionState";

/**
 * The verified bootstrap result of one host, held for exactly as long as the store revision it was
 * produced under. A rebind, a disable or a re-verification bumps that revision, and a helper session
 * from a superseded revision may point at a retired deploy root, so it must never be reused.
 */
type HeldBootstrap = {
	revision: number;
	session: SshHelperSession;
	generation: number;
};

/** Narrow, injectable view of the coordinator so tests never touch a real SSH process. */
export type RemoteHostConnectionPorts = {
	/** Re-preflight both commands against the persisted pin, then run the frozen one-file bootstrap. */
	bootstrap: typeof bootstrapPinnedHost;
	/** Resolve the host user's own node through their login shell. */
	resolveNode: typeof resolveRemoteNodeExecutable;
	/** Build the per-host connection manager. The manager itself owns attempt lifecycles. */
	createManager: (options: { userDataDir: string; client: SshClientRuntime; launcher: SshProcessLauncher; helperSession: SshHelperSession; onStateChange?: (entry: { hostId: string; state: ConnectionMachineState }) => void }) => SshConnectionManager;
	/** Mint the bootstrap nonce; injected so tests are deterministic. */
	createNonce: () => string;
	/** Mint the login-shell probe sentinel; injected so tests are deterministic. */
	createSentinel: () => string;
};

export type RemoteHostConnectionServiceOptions = {
	userDataDir: string;
	client: SshClientRuntime;
	launcher?: SshProcessLauncher;
	/**
	 * Absolute remote Node binary, overriding discovery. Optional on purpose: the path can only be known
	 * by asking the host, so requiring it here would invert the real order of events — a caller would have
	 * to produce the answer before the connection that discovers it. Supply it only to pin a specific
	 * binary; otherwise the service resolves the host user's own node via their login shell.
	 */
	nodePath?: string;
	/** Verified workspace root the helper confines `fs.*` to. Omitted is the legal host-only session. */
	root?: string;
	/**
	 * Forwarded to each manager so the owner learns about transitions that happen after `connect()`
	 * returns — a later degradation, a reconnect, or the shutdown that follows a successful ready.
	 */
	onStateChange?: (entry: { hostId: string; state: ConnectionMachineState }) => void;
	ports?: Partial<RemoteHostConnectionPorts>;
};

/** Redacted outcome of one connect request: stable codes only, never pins or paths. */
export type RemoteHostConnectResult = { ok: true; hostId: string; state: ConnectionMachineState } | { ok: false; hostId: string; code: string };

/**
 * Which generation number a connect attempt receives. The manager fences attempts by its own
 * generation; this counter names the bootstrap attempt and the nonce lineage only, so the two
 * fences stay independent and neither module has to know the other's numbering.
 */
type HostEntry = {
	generation: number;
	held?: HeldBootstrap;
	manager?: SshConnectionManager;
	/** In-flight connect, so dispose can wait for it instead of racing the spawn. */
	inFlight?: Promise<RemoteHostConnectResult>;
};

const HOST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** 16 random bytes base64url: matches the 15–63 character nonce the frozen entry accepts. */
const DEFAULT_NONCE_BYTES = 16;
/** Nonces must stay distinguishable between attempts of the same host. */
const NONCE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,63}$/;

function defaultPorts(): RemoteHostConnectionPorts {
	return {
		bootstrap: bootstrapPinnedHost,
		resolveNode: resolveRemoteNodeExecutable,
		createManager: (options) => createSshConnectionManager(options),
		createNonce: () => randomBytes(DEFAULT_NONCE_BYTES).toString("base64url"),
		createSentinel: () => randomBytes(DEFAULT_NONCE_BYTES).toString("hex"),
	};
}

/**
 * Own the wired connection lifecycle of remote hosts: one verified bootstrap per host, held until the
 * store revision it was produced under changes, plus the manager that consumes it.
 *
 * Bootstrap and connect are deliberately separate steps. `bootstrapPinnedHost` takes no cancellation
 * parameter and only stops its own entry process in its own `finally`, so an abort can be honoured
 * *between* bootstrap and connect but never inside a running upload. Stating that here is cheaper than
 * pretending the seam is cancellable: the upload stays bounded by the coordinator's own session
 * deadline. Both fences are re-checked at every step, so a host whose profile changed mid-flight
 * never reaches the manager with a stale helper location.
 *
 * Nothing in this module is reachable in production: no IPC channel and no assembly site reference it.
 *
 * Node discovery is deliberately owned here rather than required from the caller: the remote Node binary
 * can only be known by asking the host, so demanding it as construction input would force every caller to
 * produce the answer before the connection that finds it. `options.nodePath` remains as an override for
 * pinning a specific binary.
 */
export function createRemoteHostConnectionService(options: RemoteHostConnectionServiceOptions) {
	if (typeof options?.userDataDir !== "string" || !isAbsolute(options.userDataDir) || typeof options.client?.run !== "function") throw new Error("REMOTE_CONNECTION_SERVICE_OPTIONS_INVALID");
	// An override must still look like an absolute path; a bad one is a wiring bug, not a host condition.
	if (options.nodePath !== undefined && (typeof options.nodePath !== "string" || options.nodePath.length === 0 || !isAbsolute(options.nodePath))) throw new Error("REMOTE_CONNECTION_SERVICE_OPTIONS_INVALID");
	const ports: RemoteHostConnectionPorts = { ...defaultPorts(), ...options.ports };
	const launcher = options.launcher ?? createSshProcessLauncher();
	const hosts = new Map<string, HostEntry>();
	/**
	 * Per-host workspace root, overriding the construction option.
	 *
	 * The root is not a read-time filter: it is the helper's `--root` at session start, so a session that
	 * started without one serves no path at all (`fs.*` is refused with PATH_OUTSIDE_ROOT). Confirming a
	 * browse root therefore has to reach the connection and invalidate any session that was established
	 * without it, which is why this lives here rather than only in the IPC layer that asked for it.
	 */
	const workspaceRoots = new Map<string, string>();
	let disposed = false;
	let disposing: Promise<void> | undefined;

	/** Read the current store revision, so a held bootstrap can be tied to the profile it came from. */
	async function readRevision(): Promise<number> {
		return (await RemoteHostStore.open(options.userDataDir)).getSnapshot().revision;
	}

	function entryFor(hostId: string): HostEntry {
		const existing = hosts.get(hostId);
		if (existing !== undefined) return existing;
		const created: HostEntry = { generation: 0 };
		hosts.set(hostId, created);
		return created;
	}

	/** Drop every resource of one host. The manager owns its attempts, so it is disposed first. */
	function discard(entry: HostEntry): void {
		entry.held = undefined;
		const manager = entry.manager;
		entry.manager = undefined;
		if (manager !== undefined) void manager.dispose().catch(() => undefined);
	}

	/**
	 * Produce (or reuse) the verified helper session of one host.
	 *
	 * The store revision is read *after* any bootstrap, never before one, and a held session is only
	 * reused when it still matches the revision on disk. Ordering it the other way round would make a
	 * rebind that lands between two connects look like ordinary progress: the caller would read the new
	 * revision first, find nothing held under it, and bootstrap a second time while the manager built
	 * on the previous deploy root stayed alive. Reading the revision first and comparing afterwards
	 * means any disagreement invalidates the held session instead of blessing it.
	 */
	async function ensureHeld(entry: HostEntry, hostId: string): Promise<HeldBootstrap> {
		const current = await readRevision();
		if (entry.held !== undefined) {
			if (entry.held.revision === current) return entry.held;
			// A rebind/disable/re-verification superseded this helper location: the deploy root it names
			// may have been retired, so drop both the session and the manager that was built on it.
			discard(entry);
		}
		const generation = entry.generation;
		const nonce = ports.createNonce();
		if (!NONCE.test(nonce)) throw new Error("REMOTE_CONNECTION_NONCE_INVALID");
		// Resolve the node before bootstrapping. An explicit override skips discovery; otherwise the host
		// user's own node is found via their login shell. Only a fresh bootstrap pays for discovery — a
		// revision that already has a held session returns above without reaching here.
		const nodePath = options.nodePath ?? (await ports.resolveNode({ userDataDir: options.userDataDir, hostId, client: options.client, sentinel: ports.createSentinel() })).nodePath;
		const prepared = await ports.bootstrap({ userDataDir: options.userDataDir, hostId, generation, nonce, nodePath, client: options.client, launcher });
		// Re-read after the await: a rebind during the upload invalidates this result instead of
		// publishing a helper location that the profile no longer describes.
		const after = await readRevision();
		if (after !== current) throw new Error("SSH_HOST_NOT_READY");
		// Read the effective root after any await: a confirmation that landed while this bootstrap was in
		// flight must not be published under a session that started without it.
		const effectiveRoot = workspaceRoots.get(hostId) ?? options.root;
		const held: HeldBootstrap = {
			revision: after,
			generation,
			session: { nodePath, deployRoot: prepared.deployRoot, bundleSha256: prepared.bundleSha256, ...(effectiveRoot !== undefined ? { root: effectiveRoot } : {}) },
		};
		entry.held = held;
		return held;
	}

	async function connect(hostId: string): Promise<RemoteHostConnectResult> {
		if (disposed) return { ok: false, hostId, code: "REMOTE_CONNECTION_SERVICE_DISPOSED" };
		if (!HOST_ID.test(hostId)) return { ok: false, hostId, code: "REMOTE_CONNECTION_HOST_ID_INVALID" };
		const entry = entryFor(hostId);
		entry.generation += 1;
		try {
			const held = await ensureHeld(entry, hostId);
			if (disposed) return { ok: false, hostId, code: "REMOTE_CONNECTION_SERVICE_DISPOSED" };
			const manager = entry.manager ?? ports.createManager({ userDataDir: options.userDataDir, client: options.client, launcher, helperSession: held.session, ...(options.onStateChange === undefined ? {} : { onStateChange: options.onStateChange }) });
			entry.manager = manager;
			const state = await manager.connect(hostId);
			return { ok: true, hostId, state };
		} catch (error) {
			// A failed connect must not leave a helper session behind that the next attempt would trust.
			discard(entry);
			return { ok: false, hostId, code: diagnosticCodeFromError(error) };
		}
	}

	return {
		/**
		 * The verified client this service drives.
		 *
		 * Exposed to main-only consumers that must run their own pinned command against the same client the
		 * connection uses — resolving a browse root, for instance. Sharing the instance is the point: a second
		 * client could resolve through a different environment than the one the session was verified with.
		 */
		client: options.client,
		/** Bootstrap-then-connect one host. Every failure is a stable code, never a thrown message. */
		async connect(hostId: string): Promise<RemoteHostConnectResult> {
			const entry = entryFor(hostId);
			const run = connect(hostId);
			entry.inFlight = run;
			try {
				return await run;
			} finally {
				if (entry.inFlight === run) entry.inFlight = undefined;
			}
		},
		/**
		 * Point this host's next session at a confirmed workspace root.
		 *
		 * Discards the held session and its manager: the running helper was started with a different `--root`
		 * (possibly none), and the root is fixed for the life of a helper process, so nothing about that
		 * session can be reused. The caller reconnects; the next bootstrap carries the new root.
		 */
		setWorkspaceRoot(hostId: string, root: string | undefined): void {
			if (root === undefined) workspaceRoots.delete(hostId);
			else workspaceRoots.set(hostId, root);
			const entry = hosts.get(hostId);
			if (entry !== undefined) discard(entry);
		},
		/** The root this host's sessions are currently established with, if any. */
		getWorkspaceRoot(hostId: string): string | undefined {
			return workspaceRoots.get(hostId) ?? options.root;
		},
		/** Release the live session of one host without forgetting its verified bootstrap. */
		async disconnect(hostId: string, reason: "abort" | "shutdown"): Promise<void> {
			const entry = hosts.get(hostId);
			const manager = entry?.manager;
			if (manager !== undefined) await manager.disconnect(hostId, reason).catch(() => undefined);
		},
		listDiagnostics(hostId?: string) {
			if (hostId !== undefined) return hosts.get(hostId)?.manager?.listDiagnostics(hostId) ?? [];
			return [...hosts.values()].flatMap((entry) => entry.manager?.listDiagnostics() ?? []);
		},
		/**
		 * Send one helper request on a ready host.
		 *
		 * Forwarded rather than reimplemented so the workspace reader can treat this service as its transport
		 * port: the reader then owns the method-level contract (which `fs.*` calls exist, how chunks are
		 * reassembled, what the read ceiling is) and the service keeps owning the session. The manager
		 * already refuses anything but a ready host with a live protocol client.
		 */
		request(hostId: string, method: string, params?: unknown, options?: { timeoutMs?: number; onRequestId?: (requestId: string) => void }): Promise<unknown> {
			const manager = hosts.get(hostId)?.manager;
			if (manager === undefined) return Promise.reject(new Error("SSH_HOST_NOT_READY"));
			return manager.request(hostId, method, params, options);
		},
		/** Withdraw a request a ready host is still holding, by the id `request` reported. */
		cancel(hostId: string, requestId: string, options?: { timeoutMs?: number }): Promise<unknown> {
			const manager = hosts.get(hostId)?.manager;
			if (manager === undefined) return Promise.reject(new Error("SSH_HOST_NOT_READY"));
			return manager.cancel(hostId, requestId, options);
		},
		/**
		 * Stop every host. Waits for in-flight connects so a bootstrap that is still uploading cannot
		 * publish a helper session into a disposed service; idempotent, because quit paths run twice.
		 */
		dispose(): Promise<void> {
			disposing ??= (async () => {
				disposed = true;
				const entries = [...hosts.values()];
				const pending = entries.flatMap((entry) => (entry.inFlight === undefined ? [] : [entry.inFlight.catch(() => undefined)]));
				await Promise.all(pending);
				await Promise.all(
					entries.map(async (entry) => {
						discard(entry);
					}),
				);
				hosts.clear();
			})();
			return disposing;
		},
	};
}

export type RemoteHostConnectionService = ReturnType<typeof createRemoteHostConnectionService>;
