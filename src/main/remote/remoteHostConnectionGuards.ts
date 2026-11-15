import { randomBytes } from "node:crypto";
import type { SshConnectionManager } from "./SshConnectionManager";

/**
 * `RemoteHostConnectionService` 的无状态守卫与纯辅助。
 *
 * 全部是本模块级的纯函数/常量：不读写连接状态，入参就是全部依赖，所以可以从工厂闭包里原样搬出来。
 * 连接状态机（connect/reconnect/degrade/teardown）刻意不在这里——那些函数互相读写同一批状态。
 */

/**
 * States in which the host is already working on its own connection: an attempt is in flight or the manager
 * is healing itself. A read must report them rather than rebuild — a rebuild would race that attempt.
 */
export const TRANSIENT_SESSION_STATES: ReadonlySet<string> = new Set(["connecting", "probing", "bootstrapping", "reconnecting", "degraded", "needs-attention"]);

export const HOST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** 16 random bytes base64url: matches the 15–63 character nonce the frozen entry accepts. */
export const DEFAULT_NONCE_BYTES = 16;
/** Nonces must stay distinguishable between attempts of the same host. */
export const NONCE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,63}$/;

/**
 * 生成一个**必定符合 NONCE 契约**的引导 nonce。
 *
 * 契约（与冻结的 helper bundle 共用）要求首字符是字母数字，而 `randomBytes(n).toString("base64url")`
 * 的首字符有 2/64 ≈ 3.1% 的概率是 `-` 或 `_` —— 曾经的实现正好用它，于是服务**自己生成、自己校验**
 * 时会偶发抛 `REMOTE_CONNECTION_NONCE_INVALID`，表现为「有时连得上、有时一按连接就失败」。
 * 真机 e2e 抓到了这一次（第 5 次运行卡在连接步骤）。hex 恒满足契约，且同样不透明、同样 128 位熵。
 * 不修契约是因为它同时约束远端 helper（改契约要 bump bundle 版本与 sha）。
 */
export function createBootstrapNonce(): string {
	return randomBytes(DEFAULT_NONCE_BYTES).toString("hex");
}
/** Control bytes must never survive in a path handed on to another module. */
const CONTROL_BYTES = /[\u0000-\u001f\u007f]/;
/** Upper bound of a remote HOME, matching the helper contract's own ceiling. */
const MAX_REMOTE_HOME_LENGTH = 4096;

/**
 * Re-validate a remote HOME on the way out of this service.
 *
 * The manager stores only what its own shape check accepted, but this value is still remote input: it
 * arrives in a helper handshake, and callers join it into remote session paths. The egress check is
 * therefore repeated here (non-empty, absolute POSIX, no control bytes, bounded length) instead of trusting
 * an upstream filter, and a value that does not pass is reported as "unknown" rather than partially used.
 */
export function readRemoteHome(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_REMOTE_HOME_LENGTH) return undefined;
	if (value.charAt(0) !== "/" || CONTROL_BYTES.test(value)) return undefined;
	return value;
}

/**
 * 扩展快照部署失败的稳定码。
 *
 * 只认「整条消息就是一个码」的错误（本域所有失败都是这么约定的），其它一律折成固定码：既不能把
 * 通用 SSH 失败伪装成「扩展问题」，也不能把半句路径/命令带进日志与 UI。
 */
export function extensionDeployCodeOf(error: unknown): string {
	const message = typeof error === "object" && error !== null && "message" in error ? (error as { message?: unknown }).message : undefined;
	return typeof message === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(message) ? message : "REMOTE_EXTENSIONS_DEPLOY_FAILED";
}

/**
 * Stable code for "this attempt was cancelled". Reuses the existing disconnect code instead of minting a
 * new public one: the renderer already renders it as "not connected", which is exactly the outcome.
 */
export function throwIfCancelled(signal: AbortSignal | undefined): void {
	if (signal?.aborted === true) throw new Error("SSH_HOST_DISCONNECTED");
}

/**
 * Opaque identity for one live manager instance (see `RemoteProjectSession.connectionId`).
 *
 * A manager object is replaced on every root switch/rebind, so object identity already distinguishes those;
 * the caller appends the machine generation to distinguish a reconnect on the same manager. Kept as a
 * WeakMap so a discarded manager cannot be retained by this bookkeeping.
 */
const managerTokens = new WeakMap<object, number>();
let managerTokenCounter = 0;
export function managerToken(manager: object): number {
	const existing = managerTokens.get(manager);
	if (existing !== undefined) return existing;
	managerTokenCounter += 1;
	managerTokens.set(manager, managerTokenCounter);
	return managerTokenCounter;
}

/** 会话身份：manager 实例 + 连接代数；换 manager、重连、换代都会换值。 */
export function pooledConnectionId(hostId: string, manager: SshConnectionManager): string {
	return `${hostId}#${managerToken(manager)}#${manager.getState(hostId).generation}`;
}
