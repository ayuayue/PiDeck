/**
 * 冻结 Git worker 的「提交图谱写动词」半段（cherry-pick / revert / reset / drop），与 `RemoteGitWriteSource.ts`
 * 拼成同一份 git-write.mjs。与另外两半一样：这一整个模板字面量在运行时被压成一行，所以正文里不能出现反引号、
 * `${` 或裸制表符，改动任何字符都会让 REMOTE_HELPER_GIT_WRITE_SHA256 对不上。
 *
 * 写在这里而不是塞进 `RemoteGitWriteSource.ts`，是因为文件体量门禁：存量巨文件只准降不准升。
 */
export const REMOTE_GIT_HISTORY_SOURCE = String.raw`/* History write face: the four commit-graph verbs the panel already has locally. Each runs natively in the same
private metadata context as every other managed write, so no hook, filter or signing configuration can run and the
committer identity is passed explicitly instead of being read from a global config this context hides. A pick or a
rewrite that stops on a conflict is aborted before the answer: the remote side has no way to resolve a sequencer
state, and leaving one behind would block every later managed write. The caller still gets Git's own stderr, so the
reason is as readable as it is locally. */
export function createGitHistoryProgram(fs, port, gates, identityOf) {
	const fail = port.failure, HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
	function utf8(bytes) { try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw fail("GIT_RESULT_INVALID"); } }
	function sha(value) { if (typeof value !== "string" || !HASH.test(value)) throw fail("GIT_RESULT_INVALID"); return value; }
	async function probe(ctx, args) { const result = await port.execute(ctx, args, 256, [1, 128]); return result.exitCode === 0 ? utf8(result.bytes).trim() : null; }
	/* A sequencer left by any earlier operation is a state this program refuses to start from, and never leaves. */
	function pending(ctx) { for (const name of ["CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-apply", "rebase-merge", "sequencer"]) { try { fs.lstatSync(ctx.cwd + "/.git/" + name); return true; } catch (error) { if (error.code === "ENOENT") continue; throw error; } } return false; }
	async function abort(ctx, verb) { if (!pending(ctx)) return; try { await port.execute(ctx, [verb, "--abort"], 65536); } catch { /* The post-check decides: a HEAD that did not move back is unconfirmed. */ } }
	async function run(ctx, params, first, firstHead) {
		const hash = sha(params.hash), method = params.method;
		if (typeof params.expectedHead !== "string" || !HASH.test(params.expectedHead)) throw fail("GIT_RESULT_INVALID");
		if (firstHead.head !== params.expectedHead) throw fail("GIT_COMMIT_HEAD_CHANGED");
		if (pending(ctx)) throw fail("GIT_WRITE_UNSUPPORTED");
		if (await probe(ctx, ["rev-parse", "--verify", "--quiet", hash + "^{commit}"]) !== hash) throw fail("GIT_OBJECT_NOT_FOUND");
		let args, verb = null;
		if (method === "git.cherryPick") { args = ["cherry-pick", hash]; verb = "cherry-pick"; }
		else if (method === "git.revert") { args = ["revert", "--no-edit", hash]; verb = "revert"; }
		else if (method === "git.reset") {
			const mode = params.mode;
			if (mode !== "soft" && mode !== "mixed" && mode !== "hard") throw fail("GIT_RESULT_INVALID");
			args = ["reset", "--" + mode, hash];
		} else if (method === "git.drop") {
			/* The commit before the dropped one: a root commit has no parent and cannot be dropped this way. */
			const parent = await probe(ctx, ["rev-parse", "--verify", "--quiet", hash + "^"]);
			if (parent === null || !HASH.test(parent)) throw fail("GIT_WRITE_UNSUPPORTED");
			args = ["rebase", "--onto", parent, hash]; verb = "rebase";
		} else throw fail("GIT_RESULT_INVALID");
		const configured = await gates(ctx);
		if (port.snapshot(ctx) !== first) throw fail("GIT_RESOURCE_CHANGED");
		/* The three verbs that write commits carry the confirmed identity; reset moves refs only. */
		if (verb !== null) {
			const who = identityOf(ctx);
			args = ["-c", "user.name=" + who.name, "-c", "user.email=" + who.email].concat(args);
		}
		try { await port.execute(ctx, args, 65536); }
		catch (error) {
			if (verb !== null) await abort(ctx, verb);
			const after = await port.head(ctx);
			/* HEAD back where it was means the dispatch changed nothing observable: the mapped failure is honest. */
			if (after.head !== firstHead.head || after.branch !== firstHead.branch) throw fail("GIT_WRITE_RESULT_UNCONFIRMED");
			if (pending(ctx)) throw fail("GIT_WRITE_RESULT_UNCONFIRMED");
			throw error;
		}
		const after = await port.head(ctx);
		if (after.branch !== firstHead.branch) throw fail("GIT_WRITE_RESULT_UNCONFIRMED");
		if (method === "git.reset") { if (after.head !== hash) throw fail("GIT_WRITE_RESULT_UNCONFIRMED"); }
		else if (after.head === firstHead.head) throw fail("GIT_WRITE_RESULT_UNCONFIRMED");
		if (pending(ctx)) throw fail("GIT_WRITE_RESULT_UNCONFIRMED");
		/* A pick or a revert lands exactly on top of the confirmed head; anything else is not the answer we describe. */
		if (verb === "cherry-pick" || verb === "revert") {
			if (await probe(ctx, ["rev-parse", "--verify", "--quiet", "HEAD^"]) !== firstHead.head) throw fail("GIT_WRITE_RESULT_UNCONFIRMED");
		}
		if (method === "git.reset" && params.mode === "hard") {
			const status = await port.rawStatus(ctx);
			if (status.resources.length !== 0) throw fail("GIT_WRITE_RESULT_UNCONFIRMED");
		}
		if (JSON.stringify(await gates(ctx)) !== JSON.stringify(configured)) throw fail("GIT_RESOURCE_CHANGED");
		ctx.check();
		return { applied: true, head: after.head };
	}
	return { run: run };
}
`.replace(/\r?\n[\t ]*/g, "");
