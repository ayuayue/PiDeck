import type { RemoteHostConnectionState } from "../../../shared/types/remoteHost";
import { readRemoteHostStateChange, readRemoteHostStates, resolveRemoteHostConnectionTone, type RemoteHostConnectionTone } from "../utils/remoteHostIdentity";

/**
 * 「配置目标选中的 SSH 主机现在能不能用」的渲染层状态机（纯模块，无 IPC / 无 React）。
 *
 * 为什么需要它，而不是继续让远端配置面板「读失败 → 提示用户自己去主机列表连接」：
 * - 目标选择器一选中未连接的主机，面板会立刻发一次 config 读请求，而主进程按约定拒绝未就绪主机
 *   （REMOTE_CONFIG_HOST_NOT_READY）。用户看到的第一屏因此是错误，而不是「正在连接」。
 * - 连接是可以自动完成的（`remoteHosts.connect`），而且成功之后主进程的 helper 会话会留在 root 池里，
 *   后续读取复用同一条连接；所以把「确保连接」放在渲染层是正确的位置：它既决定动画，也决定重试。
 *
 * 边界：这里只信主进程的事实（list 的状态快照 + state-changed 推送 + connect 的返回值），
 * 不在本地伪造 ready；connect 失败只记稳定码，不把异常字符串带到界面。
 */

export type RemoteHostConnectionOutcome = { ok: true } | { ok: false; code: string };

export type RemoteHostConnectionSnapshot = {
	readonly states: Readonly<Record<string, RemoteHostConnectionState>>;
	/** 正在由本进程发起 connect 的主机（用于动画与去重）。 */
	readonly pending: Readonly<Record<string, true>>;
	/** 最近一次自动连接失败的稳定码。连接成功或状态推送 ready 时清除。 */
	readonly errors: Readonly<Record<string, string>>;
};

export type RemoteHostConnectionPorts = {
	/** 只读目录 + 状态快照（`remoteHosts.list`）。缺省 = 未接线：不启动任何请求。 */
	list?: () => Promise<unknown>;
	/** 唯一会启动 SSH 的方法（`remoteHosts.connect`）。缺省 = 未接线：视为「无需确保」，交给真正读请求报错。 */
	connect?: (hostId: string, password?: string) => Promise<unknown>;
	/** 主进程连接状态推送（`remoteHosts.onStateChange`）。 */
	onStateChange?: (listener: (change: unknown) => void) => () => void;
};

export type RemoteHostConnectionStore = {
	snapshot(): RemoteHostConnectionSnapshot;
	subscribe(listener: () => void): () => void;
	/** 惰性接上目录与推送；重复调用幂等。 */
	start(): void;
	/**
	 * 确保主机在线：已在线直接返回；并发调用共享同一次 connect；未接线时直接返回成功
	 * （让调用方按原路径发出读请求，由真实错误决定界面，而不是把「没有端口」当成连接失败）。
	 */
	ensureConnected(hostId: string, password?: string): Promise<RemoteHostConnectionOutcome>;
	dispose(): void;
};

const HOST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STABLE_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
const STATES: readonly RemoteHostConnectionState[] = ["disconnected", "connecting", "probing", "bootstrapping", "ready", "degraded", "reconnecting", "offline", "needs-attention"];

const EMPTY: RemoteHostConnectionSnapshot = Object.freeze({ states: Object.freeze({}), pending: Object.freeze({}), errors: Object.freeze({}) });

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readState(value: unknown): RemoteHostConnectionState | undefined {
	if (typeof value !== "string") return undefined;
	return STATES.find((candidate) => candidate === value);
}

/** connect 的返回值是主进程输入边界之一：形状不对就不落状态，绝不把「未知回复」当成功。 */
function readConnectResult(raw: unknown): { ok: true; state: RemoteHostConnectionState } | { ok: false; code: string } | undefined {
	if (!isRecord(raw)) return undefined;
	if (raw.ok === true) return { ok: true, state: readState(raw.state) ?? "ready" };
	if (raw.ok === false && typeof raw.code === "string" && STABLE_CODE.test(raw.code)) return { ok: false, code: raw.code };
	return undefined;
}

function isHealthy(state: RemoteHostConnectionState | undefined): boolean {
	return state === "ready" || state === "degraded";
}

/** 状态点语义：pending 优先（动画），其次健康/失败码，最后才是推送的机器状态。 */
export function remoteHostTone(snapshot: RemoteHostConnectionSnapshot, hostId: string): RemoteHostConnectionTone {
	if (snapshot.pending[hostId] === true) return "connecting";
	const tone = resolveRemoteHostConnectionTone(snapshot.states[hostId]);
	if (tone !== "offline" && tone !== "error") return tone;
	return snapshot.errors[hostId] === undefined ? tone : "error";
}

export function createRemoteHostConnectionStore(ports: RemoteHostConnectionPorts): RemoteHostConnectionStore {
	let snapshot = EMPTY;
	let started = false;
	let disposed = false;
	let unsubscribe: (() => void) | undefined;
	const listeners = new Set<() => void>();
	const inFlight = new Map<string, Promise<RemoteHostConnectionOutcome>>();

	const publish = (next: RemoteHostConnectionSnapshot): void => {
		if (next === snapshot) return;
		snapshot = next;
		for (const listener of [...listeners]) {
			try {
				listener();
			} catch {
				// 观察者抛错不能反过来破坏连接状态机（与主进程对状态 sink 的处理同口径）。
			}
		}
	};

	const setState = (hostId: string, state: RemoteHostConnectionState): void => publish({ ...snapshot, states: { ...snapshot.states, [hostId]: state } });

	const setPending = (hostId: string, pending: boolean): void => {
		if ((snapshot.pending[hostId] === true) === pending) return;
		const next = { ...snapshot.pending };
		if (pending) next[hostId] = true;
		else delete next[hostId];
		publish({ ...snapshot, pending: next });
	};

	const setError = (hostId: string, code: string | undefined): void => {
		const current = snapshot.errors[hostId];
		if (code === undefined ? current === undefined : current === code) return;
		const next = { ...snapshot.errors };
		if (code === undefined) delete next[hostId];
		else next[hostId] = code;
		publish({ ...snapshot, errors: next });
	};

	const runConnect = async (hostId: string, password: string | undefined, connect: NonNullable<RemoteHostConnectionPorts["connect"]>): Promise<RemoteHostConnectionOutcome> => {
		setPending(hostId, true);
		setState(hostId, "connecting");
		try {
			const result = readConnectResult(await connect(hostId, password));
			if (result === undefined) {
				setError(hostId, "REMOTE_CONNECTION_INVALID_RESULT");
				setState(hostId, "offline");
				return { ok: false, code: "REMOTE_CONNECTION_INVALID_RESULT" };
			}
			if (!result.ok) {
				// 失败不猜在线：显式落离线，界面据此给「重试 / 需要密码」，而不是继续显示旧的成功态。
				setError(hostId, result.code);
				setState(hostId, "offline");
				return result;
			}
			setError(hostId, undefined);
			setState(hostId, result.state);
			return { ok: true };
		} catch {
			// 跨 IPC 的异常文本不可信也不稳定：只上报本层的稳定码。
			setError(hostId, "REMOTE_CONNECTION_FAILED");
			setState(hostId, "offline");
			return { ok: false, code: "REMOTE_CONNECTION_FAILED" };
		} finally {
			setPending(hostId, false);
		}
	};

	const ensureConnected: RemoteHostConnectionStore["ensureConnected"] = (hostId, password) => {
		if (disposed) return Promise.resolve({ ok: false, code: "REMOTE_CONNECTION_SERVICE_DISPOSED" });
		if (!HOST_ID.test(hostId)) return Promise.resolve({ ok: false, code: "REMOTE_HOST_ID_INVALID" });
		const existing = inFlight.get(hostId);
		if (existing !== undefined) return existing;
		const connect = ports.connect;
		// 未接线（测试 / 预览 / 非 Electron）：不制造状态，让读请求自己失败并给出真实稳定码。
		if (typeof connect !== "function") return Promise.resolve({ ok: true });
		if (remoteHostTone(snapshot, hostId) === "online") {
			setError(hostId, undefined);
			return Promise.resolve({ ok: true });
		}
		const task = runConnect(hostId, password, connect);
		inFlight.set(hostId, task);
		void task.then(() => {
			if (inFlight.get(hostId) === task) inFlight.delete(hostId);
		});
		return task;
	};

	return {
		snapshot: () => snapshot,
		ensureConnected,
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		start() {
			if (started || disposed) return;
			started = true;
			if (typeof ports.onStateChange === "function") {
				try {
					unsubscribe = ports.onStateChange((change) => {
						const parsed = readRemoteHostStateChange(change);
						if (parsed === undefined) return;
						setState(parsed.hostId, parsed.state);
						if (isHealthy(parsed.state)) setError(parsed.hostId, undefined);
					});
				} catch {
					unsubscribe = undefined;
				}
			}
			if (typeof ports.list === "function") {
				void (async () => {
					let raw: unknown;
					try {
						raw = await ports.list?.();
					} catch {
						return;
					}
					if (disposed) return;
					// 列表只补「还没有任何事实」的主机：更晚的推送/connect 结果不能被一次迟到的列表覆盖。
					for (const [hostId, state] of Object.entries(readRemoteHostStates(raw))) {
						if (snapshot.states[hostId] === undefined) setState(hostId, state);
					}
				})();
			}
		},
		dispose() {
			disposed = true;
			started = false;
			try {
				unsubscribe?.();
			} catch {
				/* 解绑失败不影响已决定的状态 */
			}
			unsubscribe = undefined;
			listeners.clear();
			inFlight.clear();
		},
	};
}
