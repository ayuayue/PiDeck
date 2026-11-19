/**
 * The four commit-graph verbs the local panel already had, now part of the same managed write face.
 *
 * They live in their own module because `RemoteHelperContract.ts` is already at its line ceiling: the rules that
 * need to be written down are the verb set and the confirmed head, and neither belongs in a file that must not grow.
 *
 * - `git.cherryPick` and `git.revert` write a commit on top of `expectedHead`; the helper passes the confirmed
 *   identity explicitly, because its private metadata context hides the global configuration a committer would come
 *   from. A pick or revert that stops on a conflict is aborted before the answer, since the remote side cannot
 *   resolve a sequencer state and one left behind blocks every later managed write. The caller still receives Git's
 *   own stderr, so the reason reads exactly as it does locally.
 * - `git.reset` moves the current branch to `hash` under a mode whitelist. `--hard` also rewrites the working tree,
 *   so it is only confirmed when the tree is clean afterwards.
 * - `git.drop` is the local `rebase --onto <parent> <hash>`: the commit is removed from the branch and everything
 *   after it is replayed. A root commit has no parent and is refused.
 *
 * Every verb refuses a `expectedHead` that is not the head the read confirmed, refuses to start while a sequencer is
 * present, and reports an unconfirmed result rather than a denial when the dispatch may have changed HEAD.
 */
export const REMOTE_GIT_HISTORY_METHODS = ["git.cherryPick", "git.revert", "git.reset", "git.drop"] as const;

export type RemoteGitHistoryMethod = (typeof REMOTE_GIT_HISTORY_METHODS)[number];

/** The only reset modes the helper accepts; anything else is `GIT_RESULT_INVALID` before a command runs. */
export const REMOTE_GIT_RESET_MODES = ["soft", "mixed", "hard"] as const;

export type RemoteGitResetMode = (typeof REMOTE_GIT_RESET_MODES)[number];

export const REMOTE_HELPER_METHOD_GIT_CHERRY_PICK = "git.cherryPick";
export const REMOTE_HELPER_METHOD_GIT_REVERT = "git.revert";
export const REMOTE_HELPER_METHOD_GIT_RESET = "git.reset";
export const REMOTE_HELPER_METHOD_GIT_DROP = "git.drop";

/** `expectedHead` is the head the caller confirmed; `mode` exists only on `git.reset`. */
export type RemoteGitHistoryParams = { hash: string; expectedHead: string; mode?: RemoteGitResetMode };

/** The head the branch ended on: for a pick or revert it is a new commit, for a reset it is `hash`. */
export type RemoteGitHistoryResult = { applied: true; head: string };
