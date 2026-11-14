import { createHash } from "node:crypto";
import { getAppLogger } from "../logging/sharedLogger";
import { writeRemoteSecurityPolicySnapshot } from "./RemoteSecurityPolicyArtifact";
import { HOST_ID } from "./remoteHostConnectionGuards";
import type { SshHelperSession } from "./SshConnectionManager";
import type { SshClientRuntime } from "./SshClientRuntime";
import type { SshProcessLauncher } from "./RemoteHostConnectionTypes";

/**
 * 安全策略快照推送：等级变更要能热推，但推送本身不得与同主机其它读操作交错。
 *
 * 与 facts/扩展快照同一个主机锁与同一种「按需建立 held session」语义；`securityPolicySha256`
 * 仍是宿主 `HostEntry` 上的字段（`discard()` 一并清掉，下一次重推），这里只读写，不新增写者。
 */

/** 宿主 `HostEntry` 的窄切片：本域只碰 held（读）与已推内容指纹（读写）。 */
export type SecurityPolicyEntry = {
	held?: {
		readonly generation: number;
		readonly session: Pick<SshHelperSession, "nodePath" | "deployRoot">;
	};
	securityPolicySha256?: string;
};

export type SecurityPolicySnapshotDeps = {
	userDataDir: string;
	launcher: SshProcessLauncher;
	/** 注入点：bootstrap nonce 生成器（与连接路径同一个）。 */
	createNonce: () => string;
	entryFor: (hostId: string) => SecurityPolicyEntry;
	connectLocked: (hostId: string) => Promise<{ ok: true } | { ok: false; code: string }>;
	operationLock: { run<T>(hostId: string, work: () => Promise<T>): Promise<T> };
	clientFor: (hostId: string) => SshClientRuntime;
	/** 当前仍持有 held session 的主机（广播目标）。 */
	hostIdsWithHeld: () => string[];
};

export function createRemoteSecurityPolicySnapshot(deps: SecurityPolicySnapshotDeps) {
	const { userDataDir, launcher, createNonce, entryFor, connectLocked, operationLock, clientFor, hostIdsWithHeld } = deps;

	/**
	 * Write one security policy snapshot into this host's deploy root (atomic replace).
	 *
	 * 失败抛稳定码，由调用方决定是否降级。
	 */
	const pushSnapshot = async (hostId: string, bytes: Buffer | Uint8Array): Promise<void> => {
		if (typeof hostId !== "string" || !HOST_ID.test(hostId)) throw new Error("SSH_HOST_ID_INVALID");
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		await operationLock.run(hostId, async () => {
			const entry = entryFor(hostId);
			// 内容没变就不再来一轮 ssh（同一次 held session 内等级只变几次，但 spawn 可能很多次）。
			if (entry.securityPolicySha256 === sha256) return;
			if (entry.held === undefined) {
				const result = await connectLocked(hostId);
				if (!result.ok) throw new Error(result.code);
			}
			const held = entry.held;
			if (held === undefined) throw new Error("SSH_HOST_NOT_READY");
			await writeRemoteSecurityPolicySnapshot({
				userDataDir,
				hostId,
				generation: held.generation,
				nodePath: held.session.nodePath,
				deployRoot: held.session.deployRoot,
				bytes,
				client: clientFor(hostId),
				launcher,
				nonce: createNonce(),
			});
			entry.securityPolicySha256 = sha256;
		});
	};

	return {
		pushSnapshot,
		/**
		 * 广播一份快照到当前仍有 held session 的主机（安全等级热更新）。
		 *
		 * 尽力而为：单台失败只记 warn（下一次 prepare 会在该主机重新推送），不把一次设置变更变成错误。
		 */
		async pushSnapshotToReadyHosts(bytes: Buffer | Uint8Array): Promise<void> {
			const targets = hostIdsWithHeld();
			for (const hostId of targets) {
				try {
					await pushSnapshot(hostId, bytes);
				} catch (error) {
					const message = typeof error === "object" && error !== null && "message" in error ? (error as { message?: unknown }).message : undefined;
					void getAppLogger()?.warn("remote", "Remote security snapshot push failed", { hostId, code: typeof message === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(message) ? message : "SECURITY_SNAPSHOT_PUSH_FAILED" });
				}
			}
		},
	};
}
