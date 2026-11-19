import { randomBytes } from "node:crypto";
import type { RemoteGitWriteExpectation } from "./RemoteGitService";

/** The closed set of actions a snapshot can authorize; one token authorizes exactly one kind. */
export type RemoteGitMutationKind = RemoteGitWriteExpectation["kind"];
type Entry = { senderId: number; projectId: string; expires: number; expected: RemoteGitWriteExpectation };

/** Bounded, memory-only capabilities: a snapshot grants one index action to one window/project. */
export function createRemoteGitMutationTokens(now = Date.now) {
	const entries = new Map<string, Entry>();
	/** 撤销一个窗口的全部或部分授权；给了 repository scope 就只清那个仓库（多仓并排不互相作废）。 */
	function revoke(senderId: number, projectId?: string, repoPath?: string) {
		for (const [token, entry] of entries) {
			if (entry.senderId !== senderId) continue;
			if (projectId !== undefined && entry.projectId !== projectId) continue;
			if (repoPath !== undefined && entry.expected.repoPath !== repoPath) continue;
			entries.delete(token);
		}
	}
	return {
		revoke,
		issue(senderId: number, projectId: string, expected: RemoteGitWriteExpectation) {
			// 一个快照里每个 (动作种类, 仓库) 只保留一张令牌：多仓并排时，B 仓的 stage 令牌
			// 不能把 A 仓刚签的 stage 令牌顶掉（否则两个面板会互相撤销对方的写授权）。
			for (const [token, entry] of entries) if (entry.senderId === senderId && entry.projectId === projectId && entry.expected.kind === expected.kind && entry.expected.repoPath === expected.repoPath) entries.delete(token);
			for (const [token, entry] of entries) if (entry.expires <= now()) entries.delete(token);
			while (entries.size >= 128) {
				const oldest = entries.keys().next().value;
				if (oldest !== undefined) entries.delete(oldest);
			}
			const token = randomBytes(16).toString("hex");
			entries.set(token, { senderId, projectId, expected, expires: now() + 15 * 60_000 });
			return token;
		},
		/**
		 * Consume synchronously before the caller's first await; another window cannot burn the owner's token.
		 * The repository scope is part of the grant identity (G5e): a token minted for one repository is unusable against
		 * another, exactly like a token minted for another window or project, and a mismatch never burns it. A wrong action
		 * kind stays a caller bug with its own code and also does not burn the token the user still owns.
		 */
		take(senderId: number, projectId: string, kind: RemoteGitMutationKind, repoPath: string, token: unknown): RemoteGitWriteExpectation {
			const entry = typeof token === "string" && /^[0-9a-f]{32}$/.test(token) ? entries.get(token) : undefined;
			if (!entry || entry.senderId !== senderId || entry.projectId !== projectId || entry.expected.repoPath !== repoPath) throw new Error("GIT_WRITE_SNAPSHOT_EXPIRED");
			// A token for the other action kind is a caller bug: refuse without burning the token the user still owns.
			if (entry.expected.kind !== kind) throw new Error("GIT_RESULT_INVALID");
			entries.delete(String(token));
			if (entry.expires <= now()) throw new Error("GIT_WRITE_SNAPSHOT_EXPIRED");
			return entry.expected;
		},
		clear() {
			entries.clear();
		},
	};
}
