/**
 * Frozen sync program, deployed as its own bundle file (git-sync.mjs) and imported by git-read.mjs:
 * the only network-facing code in the helper.
 *
 * Two chains must never be conflated, and this file is where that is enforced in code: the PiDeck-to-host SSH
 * connection (a pinned endpoint, its own key and known-hosts policy) is the *transport* that runs this helper,
 * while the Git verbs below authenticate with the remote account's own identity - whatever its agent, store or
 * configuration provides. Nothing here injects `GIT_SSH`, `GIT_SSH_COMMAND`, `GIT_ASKPASS` or any credential
 * setting, never writes a remote URL or a Git config value, and never disables host-key verification.
 * `GIT_TERMINAL_PROMPT=0` comes from the fixed executor: a verb that would need interactive authentication fails
 * fast instead of hanging, and the panel tells the user to authenticate in a terminal.
 *
 * Side effects are bounded per verb and verified afterwards: `fetch` may only move `refs/remotes/<remote>/*`,
 * `push` may only move the remote repository (plus the remote-tracking ref Git updates for it), and `pull` is
 * the one verb allowed to rewrite HEAD and the worktree - which is why it refuses a dirty tree before it starts
 * and never picks a merge strategy for the user.
 */
export const REMOTE_GIT_SYNC_SOURCE = String.raw`export function createGitSyncProgram(fs, port, gates) {
	const fail = port.failure, MAX_REMOTES = 64, MAX_COUNT = 10000000;
	function utf8(bytes) { try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw fail("GIT_RESULT_INVALID"); } }
	function lines(value) { return value.length === 0 ? [] : value.replace(/\n$/, "").split("\n"); }
	function remoteName(value) { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw fail("GIT_RESULT_INVALID"); return value; }
	function branchName(value) { if (typeof value !== "string" || value.length === 0 || value.length > 1024 || /[\u0000-\u001f\u007f\\]/.test(value) || value === "@" || value.startsWith("-") || value.includes("@{") || value.startsWith("refs/")) throw fail("GIT_RESULT_INVALID"); return value; }
	async function remotes(ctx) {
		const names = lines(utf8((await port.execute(ctx, ["remote"], 4096)).bytes)).filter(function (name) { return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name); });
		if (names.length > MAX_REMOTES) throw fail("RESULT_TOO_LARGE");
		return names;
	}
	async function known(ctx, remote) { if (!(await remotes(ctx)).includes(remote)) throw fail("GIT_SYNC_REMOTE_UNKNOWN"); return remote; }
	async function upstream(ctx, branch) {
		/* --symbolic-full-name without --abbrev-ref gives the fully qualified upstream (measured: refs/remotes/origin/master). */
		const probe = await port.execute(ctx, ["rev-parse", "--symbolic-full-name", branch + "@{upstream}"], 1024, [1, 128]);
		if (probe.exitCode !== 0) return null;
		const name = utf8(probe.bytes).trim();
		return name.length > 0 && name.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(name) ? name : null;
	}
	async function counts(ctx, branch) {
		const probe = await port.execute(ctx, ["rev-list", "--left-right", "--count", branch + "...@{upstream}"], 1024, [1, 128]);
		if (probe.exitCode !== 0) return { ahead: 0, behind: 0 };
		const fields = utf8(probe.bytes).trim().split(/\s+/);
		if (fields.length !== 2) throw fail("GIT_RESULT_INVALID");
		const ahead = Number(fields[0]), behind = Number(fields[1]);
		if (!Number.isSafeInteger(ahead) || ahead < 0 || ahead > MAX_COUNT || !Number.isSafeInteger(behind) || behind < 0 || behind > MAX_COUNT) throw fail("GIT_RESULT_INVALID");
		return { ahead: ahead, behind: behind };
	}
	async function tracking(ctx, remote) {
		return lines(utf8((await port.execute(ctx, ["for-each-ref", "--format=%(refname)%09%(objectname)", "refs/remotes/" + remote], 65536)).bytes));
	}
	function parseTracking(entries) { const map = new Map(); for (const line of entries) { const fields = line.split("\t"); if (fields.length === 2) map.set(fields[0], fields[1]); } return map; }
	/* Only tracked modifications make a pull unsafe: untracked files are the user's, and a pull does not touch them. */
	function dirty(status) { return status.resources.some(function (entry) { return entry.xy !== "??"; }); }
	async function configured(ctx, key) { return (await port.execute(ctx, ["config", "--get", key], 1024, [1, 128])).exitCode === 0; }
	/* The local repository must be exactly what the caller confirmed, before and after a verb that may not touch it. */
	async function assertConfirmed(ctx, params, first, firstHead) {
		if (port.fingerprint(ctx, first, firstHead, await port.rawStatus(ctx)) !== params.expectedRevision) throw fail("GIT_RESOURCE_CHANGED");
	}
	async function assertUntouched(ctx, params, first, firstHead) {
		/* The fingerprint embeds the index hash, HEAD and the status bytes, so this is the whole local state. */
		if (port.fingerprint(ctx, first, firstHead, await port.rawStatus(ctx)) !== params.expectedRevision) throw fail("GIT_WRITE_RESULT_UNCONFIRMED");
		if (JSON.stringify(await port.head(ctx)) !== JSON.stringify(firstHead)) throw fail("GIT_WRITE_RESULT_UNCONFIRMED");
	}
	async function facts(ctx) {
		const current = await port.head(ctx);
		const upstreamName = current.branch === null ? null : await upstream(ctx, current.branch);
		const value = upstreamName === null ? { ahead: 0, behind: 0 } : await counts(ctx, current.branch);
		return { branch: current.branch, upstream: upstreamName, ahead: value.ahead, behind: value.behind, remotes: await remotes(ctx) };
	}
	/* Fetch never prunes and never follows tags: the remote-tracking refs it moves are the whole local effect. */
	async function network(ctx, args) {
		try { await port.execute(ctx, args, 65536); }
		catch (error) { if (error.message === "GIT_COMMAND_FAILED") throw fail("GIT_SYNC_FAILED"); throw error; }
	}
	async function fetch(ctx, params, first, firstHead) {
		await gates(ctx);
		const remote = await known(ctx, remoteName(params.remote));
		await assertConfirmed(ctx, params, first, firstHead);
		const before = parseTracking(await tracking(ctx, remote));
		await network(ctx, ["fetch", "--no-tags", remote]);
		const after = parseTracking(await tracking(ctx, remote));
		const updated = [];
		for (const pair of after) {
			const previous = before.has(pair[0]) ? before.get(pair[0]) : null;
			if (previous !== pair[1]) updated.push({ ref: pair[0], before: previous, after: pair[1] });
		}
		await assertUntouched(ctx, params, first, firstHead);
		return { applied: true, upToDate: updated.length === 0, updated: updated };
	}
	/* Push is never forced and never sets an upstream: the argv carries no '+', no --force and no config write. */
	/* Push is never forced: the argv carries no '+', no --force and no config write. An explicit remote names exactly
	   <remote> <branch>; without one it follows the branch's configured upstream / push.default, like plain git push. */
	async function push(ctx, params, first, firstHead) {
		await gates(ctx);
		const explicit = params.remote !== null, current = await port.head(ctx);
		const remote = explicit ? await known(ctx, remoteName(params.remote)) : null;
		const branch = explicit ? branchName(params.branch) : current.branch;
		if (branch === null || current.branch !== branch) throw fail("GIT_RESULT_INVALID");
		await assertConfirmed(ctx, params, first, firstHead);
		/* Upstream mode still refuses a branch with no upstream before any network verb: that is a configuration
		   fact, not a transient failure, and local git would refuse it too. */
		if (!explicit && (await upstream(ctx, branch)) === null) throw fail("GIT_SYNC_REMOTE_UNKNOWN");
		const result = await port.execute(ctx, explicit ? ["push", "--porcelain", remote, branch] : ["push", "--porcelain"], 65536, [1]);
		const output = utf8(result.bytes);
		if (result.exitCode !== 0) {
			for (const line of lines(output)) {
				/* Measured wordings: a rewritten remote says (non-fast-forward), an advanced one says (fetch first), a
				force-only situation says (needs force); every other rejection is the remote's own refusal. */
				if (line.startsWith("!") && line.includes("[rejected]")) throw fail(/non-fast-forward|fetch first|needs force/.test(line) ? "GIT_PUSH_REJECTED" : "GIT_PUSH_REMOTE_REFUSED");
			}
			throw fail("GIT_SYNC_FAILED");
		}
		let outcome = null, refspec = null;
		const localRef = "refs/heads/" + branch + ":refs/heads/";
		for (const line of lines(output)) {
			const fields = line.split("\t");
			if (fields.length < 3 || !/^[ =*+-]$/.test(fields[0])) continue;
			/* The pushed side is the local branch; the remote-side name may differ when an upstream rename is configured. */
			if (fields[1].indexOf(localRef) !== 0 || !/^[A-Za-z0-9._/-]{1,1024}$/.test(fields[1].slice(localRef.length))) continue;
			refspec = fields[1];
			outcome = fields[0] === "=" ? "up-to-date" : fields[0] === "*" ? "new" : "pushed";
		}
		await assertUntouched(ctx, params, first, firstHead);
		if (outcome === null || refspec === null) throw fail("GIT_WRITE_RESULT_UNCONFIRMED");
		return { applied: true, outcome: outcome, refspec: refspec };
	}
	/* Pull fetches first, then decides: a divergence without a configured strategy is refused, never guessed. */
	async function pull(ctx, params, first, firstHead) {
		await gates(ctx, "native-pull");
		const explicit = params.remote !== null, before = await port.head(ctx);
		const remote = explicit ? await known(ctx, remoteName(params.remote)) : null;
		const branch = explicit ? branchName(params.branch) : before.branch;
		await assertConfirmed(ctx, params, first, firstHead);
		const current = await port.head(ctx);
		if (branch === null || current.branch !== branch || current.head === null) throw fail("GIT_RESULT_INVALID");
		const tracking = await upstream(ctx, branch);
		if (tracking === null) throw fail("GIT_SYNC_REMOTE_UNKNOWN");
		if (explicit && tracking !== "refs/remotes/" + remote + "/" + branch) throw fail("GIT_SYNC_REMOTE_UNKNOWN");
		if (dirty(await port.rawStatus(ctx))) throw fail("GIT_SYNC_DIRTY");
		await network(ctx, explicit ? ["fetch", "--no-tags", remote] : ["fetch", "--no-tags"]);
		await assertConfirmed(ctx, params, first, firstHead);
		const value = await counts(ctx, branch);
		if (value.ahead > 0 && value.behind > 0 && !(await configured(ctx, "pull.rebase")) && !(await configured(ctx, "pull.ff"))) throw fail("GIT_PULL_STRATEGY_REQUIRED");
		const probe = await port.execute(ctx, ["rev-parse", branch + "@{upstream}"], 1024, [1, 128]);
		const upstreamRef = probe.exitCode === 0 ? utf8(probe.bytes).trim() : null;
		/* No lock of ours here: git pull writes the index itself, and our own lock would block it. Git's index lock
		protects the rewrite, and the confirmed revision was checked before the fetch and after it. */
		const result = await port.execute(ctx, explicit ? ["pull", "--no-edit", remote, branch] : ["pull", "--no-edit"], 65536, [1]);
		if (result.exitCode !== 0) {
			let conflicted = false;
			try { fs.lstatSync(ctx.cwd + "/.git/MERGE_HEAD"); conflicted = true; } catch (error) { if (error.code !== "ENOENT") throw error; }
			if (!conflicted) conflicted = (await port.rawStatus(ctx)).resources.some(function (entry) { return ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(entry.xy); });
			throw fail(conflicted ? "GIT_PULL_CONFLICTS" : "GIT_SYNC_FAILED");
		}
		const after = await port.head(ctx);
		if (after.head === null || after.branch !== branch) throw fail("GIT_WRITE_RESULT_UNCONFIRMED");
		const mode = after.head === firstHead.head ? "up-to-date" : after.head === upstreamRef ? "fast-forward" : "merge";
		ctx.check();
		return { applied: true, mode: mode, head: after.head };
	}

	return { facts: facts, fetch: fetch, push: push, pull: pull };
}`.replace(/\r?\n[\t ]*/g, "");
