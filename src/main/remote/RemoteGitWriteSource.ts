import { REMOTE_GIT_HISTORY_SOURCE } from "./RemoteGitHistorySource";
/**
 * Managed Git writes, deployed as their own bundle file (git-write.mjs) and imported by git-read.mjs: native Git
 * runs in an owned private metadata context, never with live hooks/filters.
 *
 * The frozen body keeps one-line invariants only (its ceiling is 96 KiB). The long-form rules behind them:
 *
 * - every write takes the official `.git/index.lock`, verifies the caller's confirmed fingerprint, and runs in a
 *   scratch metadata context (`GIT_DIR`/`GIT_INDEX_FILE`/`GIT_WORK_TREE`/`GIT_OBJECT_DIRECTORY` plus
 *   `GIT_CONFIG_NOSYSTEM`/`GIT_CONFIG_GLOBAL=/dev/null`) whose configuration is frozen and whose hooks directory
 *   is empty; effective hooks/filter/signing requirements are refused before AND after, and no gate is bypassed;
 * - `git.stage`/`git.unstage` publish validated, path-scoped index bytes only; `git.commit` publishes no index bytes
 *   at all (the confirmed index already describes the next HEAD) and moves the ref with a native CAS;
 * - `git.createBranch` is a create-only CAS on `refs/heads/<name>` that can never move HEAD; a name is asked of
 *   Git first (`check-ref-format --branch`) and then held to the protocol's own rules; `git.switchBranch` runs
 *   native `git switch`, where a conflicting worktree is refused rather than forced, and a post-checkout hook is a refusal;
 * - `git.discard` is the recoverable one: the file's raw bytes (`hash-object -w --no-filters` writes them
 *   verbatim and runs no clean filter) go into a create-only `refs/pideck/recovery/<stamp>` ref authored by a
 *   fixed PiDeck identity, read back before the file is touched - so a failure before that leaves it alone and
 *   any failure after it is unconfirmed. A `" D"` resource needs no snapshot; nothing prunes those refs;
 * - scratch directories are 0700 with random names, unwound only while their identities match; unknown artifacts stay;
 * - an unreaped native writer keeps its lock, which is why cleanup waits for killed children first.
 */
export const REMOTE_GIT_WRITE_SOURCE = (
	String.raw`export function createGitWriteProgram(fs, port) {
	const crypto = port.crypto;
	const fail = port.failure, MAX_INDEX = 16777216, MAX_TEXT = 262144;
	const CONFIG = "^(core\\.(hookspath|attributesfile|excludesfile|repositoryformatversion|filemode|ignorecase|autocrlf|eol|safecrlf|symlinks|ignorestat|trustctime|checkstat|protecthfs|protectntfs|quotepath)|commit\\.gpgsign|index\\.version|extensions\\.objectformat|status\\.renames|diff\\.(renames|renamelimit))$";
	function utf8(bytes) { try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw fail("GIT_RESULT_INVALID"); } }
	function optional(base, name, limit) { try { return port.readFile(base, name, limit); } catch (error) { if (error.message === "PATH_NOT_FOUND") return null; throw error; } }
	function identity(stats) { return [stats.dev, stats.ino, stats.uid, stats.gid].map(String).join(":"); }
	function owned(path, expected) { try { const stats = fs.lstatSync(path, { bigint: true }); return stats.isFile() && !stats.isSymbolicLink() && identity(stats) === expected; } catch { return false; } }
	function fingerprint(ctx, first, head, status) { return crypto.createHash("sha256").update(JSON.stringify([ctx.rootIdentity, ctx.gitIdentity, first, head, status.bytes.toString("base64")])).digest("hex"); }
	async function gates(ctx) {
		for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "BISECT_START", "rebase-apply", "rebase-merge", "sequencer"]) {
			try { fs.lstatSync(ctx.cwd + "/.git/" + name); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
			throw fail("GIT_WRITE_UNSUPPORTED");
		}
		for (const name of [".git/info/sparse-checkout"]) { try { fs.lstatSync(ctx.cwd + "/" + name); } catch (error) { if (error.code === "ENOENT") continue; throw error; } throw fail("GIT_WRITE_UNSUPPORTED"); }
		const metadata = fs.opendirSync(ctx.cwd + "/.git");
		try { let entry; while ((entry = metadata.readSync()) !== null) if (entry.name.startsWith("sharedindex.")) throw fail("GIT_WRITE_UNSUPPORTED"); } finally { metadata.closeSync(); }
		const flags = utf8((await port.execute(ctx, ["ls-files", "-v", "-z"], MAX_INDEX)).bytes);
		for (const entry of flags.split("\0")) if (entry && !entry.startsWith("H ")) throw fail("GIT_WRITE_UNSUPPORTED");
		const hooks = ctx.cwd + "/.git/hooks";
		try {
			const directory = fs.opendirSync(hooks);
			try { let entry, count = 0; while ((entry = directory.readSync()) !== null) { if (++count > 4096) throw fail("RESULT_TOO_LARGE"); const stats = fs.lstatSync(hooks + "/" + entry.name); if (!entry.name.endsWith(".sample") && (!stats.isFile() || (stats.mode & 73) !== 0)) throw fail("GIT_WRITE_UNSUPPORTED"); } } finally { directory.closeSync(); }
		} catch (error) { if (error.code !== "ENOENT") throw error; }
		const result = await port.execute(ctx, ["config", "--null", "--get-regexp", CONFIG], 65536, [1]);
		const raw = utf8(result.bytes), config = [];
		for (const field of raw.split("\0")) {
			if (!field) continue;
			const at = field.indexOf("\n"), key = field.slice(0, at).toLowerCase(), value = field.slice(at + 1);
			if (at < 1 || /^(?:core\.(?:hookspath|attributesfile|excludesfile))$/.test(key)) throw fail("GIT_WRITE_UNSUPPORTED");
			if (key === "commit.gpgsign") { if (!/^(?:false|no|off|0)$/i.test(value)) throw fail("GIT_WRITE_UNSUPPORTED"); continue; }
			if (!/^[a-z0-9 .+-]{0,64}$/i.test(value)) throw fail("GIT_WRITE_UNSUPPORTED");
			const dot = key.indexOf("."); config.push("[" + key.slice(0, dot) + "]\n" + key.slice(dot + 1) + " = " + JSON.stringify(value) + "\n");
		}
		return { raw: raw, config: config.join("") };
	}
	async function entries(ctx) {
		const bytes = (await port.execute(ctx, ["ls-files", "--stage", "-z"], MAX_INDEX)).bytes;
		const value = utf8(bytes), result = new Map();
		for (const field of value.split("\0")) {
			if (!field) continue;
			const parsed = /^([0-7]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-3])\t(.+)$/.exec(field);
			if (!parsed || parsed[3] !== "0") throw fail("GIT_WRITE_UNSUPPORTED");
			result.set(port.relative(parsed[4]), field);
		}
		return result;
	}
	function worktree(ctx, paths) {
		const result = [];
		for (const name of paths) {
			const bytes = optional(ctx.cwd, name, MAX_TEXT);
			if (bytes !== null) port.text(bytes);
			let meta = null;
			if (bytes !== null) meta = port.metadata(fs.lstatSync(ctx.cwd + "/" + name, { bigint: true }));
			result.push([name, bytes === null ? null : bytes.toString("base64"), meta]);
		}
		return JSON.stringify(result);
	}
	function attributes(ctx, target) {
		const parts = target.split("/"); if (parts.length > 32) throw fail("RESULT_TOO_LARGE");
		const names = [".git/info/attributes", ".gitattributes"]; let prefix = "";
		for (const part of parts.slice(0, -1)) { prefix += part + "/"; names.push(prefix + ".gitattributes"); }
		let total = 0;
		return JSON.stringify(names.map(function (name) { const value = optional(ctx.cwd, name, MAX_TEXT); total += value === null ? 0 : value.length; if (total > 1048576) throw fail("RESULT_TOO_LARGE"); return [name, value === null ? null : value.toString("base64")]; }));
	}
	/* Wait for killed native processes before touching their scratch; an unreaped writer leaves its lock for inspection. */
	async function reaped(ctx) {
		if (ctx.children.size === 0) return true;
		let timer;
		try { return await Promise.race([Promise.all(Array.from(ctx.children, function (child) { return new Promise(function (resolve) { child.once("close", resolve); }); })).then(function () { return true; }), new Promise(function (resolve) { timer = setTimeout(function () { resolve(false); }, 1000); })]); } finally { clearTimeout(timer); }
	}
	async function run(ctx, params, first, firstHead) {
		const configured = await gates(ctx);
		const gitFd = fs.openSync(ctx.cwd + "/.git", fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
		const base = "/proc/" + process.pid + "/fd/" + gitFd;
		let lockFd = null, lockIdentity = null, scratch = null, scratchIdentity = null, published = false, safeCleanup = true;
		const files = new Map(), directories = [];
		function put(name, bytes) { const file = scratch + "/" + name; const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 384); try { fs.writeFileSync(fd, bytes); files.set(name, identity(fs.fstatSync(fd, { bigint: true }))); } finally { fs.closeSync(fd); } }
		function directory(name) { fs.mkdirSync(scratch + "/" + name, { mode: 448 }); directories.push(name); }
		function held() { if (lockFd === null || !owned(base + "/index.lock", lockIdentity) || identity(fs.fstatSync(lockFd, { bigint: true })) !== lockIdentity) throw fail("GIT_RESOURCE_CHANGED"); }
		try {
			if ([fs.fstatSync(gitFd, { bigint: true }).dev, fs.fstatSync(gitFd, { bigint: true }).ino].map(String).join(":") !== ctx.gitIdentity) throw fail("GIT_RESOURCE_CHANGED");
			try { lockFd = fs.openSync(base + "/index.lock", fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 384); } catch (error) { if (error.code === "EEXIST") throw fail("GIT_INDEX_LOCKED"); throw error; }
			const lockStats = fs.fstatSync(lockFd, { bigint: true }); lockIdentity = identity(lockStats);
			const source = optional(base, "index", MAX_INDEX), sourceStats = source === null ? null : fs.lstatSync(base + "/index", { bigint: true });
			if (sourceStats !== null && (sourceStats.uid !== lockStats.uid || sourceStats.gid !== lockStats.gid || (sourceStats.mode & 3584n) !== 0n)) throw fail("GIT_WRITE_UNSUPPORTED");
			if (port.snapshot(ctx) !== first) throw fail("GIT_RESOURCE_CHANGED");
			scratch = base + "/pideck-index-" + crypto.randomBytes(16).toString("hex"); fs.mkdirSync(scratch, { mode: 448 }); scratchIdentity = identity(fs.lstatSync(scratch, { bigint: true }));
			directory("refs"); directory("objects"); directory("info"); directory("hooks");
			put("HEAD", firstHead.head === null ? "ref: refs/heads/pideck-shadow\n" : firstHead.head + "\n");
			put("config", configured.config + "[core]\nbare = false\nfsmonitor = false\nuntrackedCache = false\n");
			const attrs = attributes(ctx, params.path);
			if (source !== null) put("index", source);
			const info = optional(ctx.cwd, ".git/info/attributes", MAX_TEXT); if (info !== null) put("info/attributes", info);
			/* The private metadata context has no executable hooks/filters; real hooks/config are refused before AND after, and no gate is bypassed. */
			const env = Object.assign({}, ctx.env, { GIT_DIR: scratch, GIT_INDEX_FILE: scratch + "/index", GIT_WORK_TREE: ctx.cwd, GIT_OBJECT_DIRECTORY: base + "/objects", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" });
			const shadow = Object.assign({}, ctx, { env: env });
			const status = await port.rawStatus(shadow);
			if (fingerprint(ctx, first, firstHead, status) !== params.expectedRevision) throw fail("GIT_RESOURCE_CHANGED");
			if (status.resources.some(function (entry) { return ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(entry.xy); })) throw fail("GIT_WRITE_UNSUPPORTED");
			const resource = status.resources.find(function (entry) { return entry.path === params.path && port.belongs(entry, params.group); });
			if (!resource) throw fail("GIT_RESOURCE_CHANGED");
			const paths = [resource.path]; if ((params.method === "git.unstage" || /[RC]/.test(resource.xy[1])) && resource.oldPath && !paths.includes(resource.oldPath)) paths.push(resource.oldPath);
			const before = await entries(shadow), tree = worktree(ctx, paths);
			for (const name of paths) if (before.has(name) && !/^100(?:644|755) /.test(before.get(name))) throw fail("GIT_WRITE_UNSUPPORTED");
			const args = params.method === "git.stage" ? ["add", "--"].concat(paths) : firstHead.head === null ? ["rm", "--cached", "--ignore-unmatch", "--"].concat(paths) : ["reset", "-q", firstHead.head, "--"].concat(paths);
			await port.execute(shadow, args, 65536);
			const after = await entries(shadow);
			for (const name of new Set(Array.from(before.keys()).concat(Array.from(after.keys())))) {
				if (!paths.includes(name) && before.get(name) !== after.get(name)) throw fail("GIT_RESOURCE_CHANGED");
				if (paths.includes(name) && after.has(name) && !/^100(?:644|755) /.test(after.get(name))) throw fail("GIT_WRITE_UNSUPPORTED");
				if (paths.includes(name) && after.has(name)) port.text((await port.execute(shadow, ["show", "--no-ext-diff", "--no-textconv", ":" + name], MAX_TEXT)).bytes);
			}
			if (!paths.some(function (name) { return before.get(name) !== after.get(name); }) && !(params.method === "git.stage" && resource.xy === " A")) throw fail("GIT_RESOURCE_CHANGED");
			const updated = port.readFile(scratch, "index", MAX_INDEX); files.set("index", identity(fs.lstatSync(scratch + "/index", { bigint: true })));
			if (port.snapshot(ctx) !== first) throw fail("GIT_RESOURCE_CHANGED");
			await port.validateConfiguration(ctx);
			const finalConfig = await gates(ctx), finalHead = await port.head(ctx);
			if (finalConfig.raw !== configured.raw || port.snapshot(ctx) !== first || JSON.stringify(finalHead) !== JSON.stringify(firstHead) || worktree(ctx, paths) !== tree || attributes(ctx, params.path) !== attrs) throw fail("GIT_RESOURCE_CHANGED");
			held(); ctx.check();
			if (fs.fstatSync(lockFd, { bigint: true }).size !== 0n) throw fail("GIT_RESOURCE_CHANGED");
			let offset = 0; while (offset < updated.length) { const count = fs.writeSync(lockFd, updated, offset, updated.length - offset, offset); if (!count) throw fail("IO_ERROR"); offset += count; }
			fs.fchmodSync(lockFd, sourceStats === null ? 384 : Number(sourceStats.mode & 511n)); fs.fsyncSync(lockFd);
			held(); if (!port.readFile(base, "index.lock", MAX_INDEX).equals(updated) || port.snapshot(ctx) !== first) throw fail("GIT_RESOURCE_CHANGED");
			ctx.check(); fs.renameSync(base + "/index.lock", base + "/index"); published = true; fs.fsyncSync(gitFd);
			if (!owned(base + "/index", lockIdentity) || !port.readFile(base, "index", MAX_INDEX).equals(updated)) throw fail("GIT_WRITE_RESULT_UNCONFIRMED");
			ctx.check(); return { applied: true };
		} catch (error) { if (published) throw fail("GIT_WRITE_RESULT_UNCONFIRMED"); throw error; }
		finally {
			safeCleanup = await reaped(ctx);
			if (safeCleanup && scratch !== null) {
				try {
					const stats = fs.lstatSync(scratch, { bigint: true });
					if (stats.isDirectory() && !stats.isSymbolicLink() && identity(stats) === scratchIdentity) {
						for (const pair of files) if (owned(scratch + "/" + pair[0], pair[1])) fs.unlinkSync(scratch + "/" + pair[0]);
						for (const name of directories.reverse()) { try { fs.rmdirSync(scratch + "/" + name); } catch {} }
						try { fs.rmdirSync(scratch); } catch {}
					}
				} catch { /* Unknown or externally replaced artifacts are retained, never recursively removed. */ }
			}
			if (safeCleanup && lockFd !== null && !published && owned(base + "/index.lock", lockIdentity)) { try { fs.unlinkSync(base + "/index.lock"); } catch {} }
			if (lockFd !== null) fs.closeSync(lockFd); fs.closeSync(gitFd);
		}
	}
	return { run: run, fingerprint: fingerprint, gates: gates, entries: entries, reaped: reaped };
}
/* Managed commit: verified index tree plus a native ref CAS; failures after it are unconfirmed and identity is read-only. */
export function createGitCommitProgram(fs, port, shared, identityOf) {
	const fail = port.failure, MAX_INDEX = 16777216, MAX_TEXT = 262144, ZERO = "0".repeat(40), HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
	function utf8(bytes) { try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw fail("GIT_RESULT_INVALID"); } }
	function optional(base, name, limit) { try { return port.readFile(base, name, limit); } catch (error) { if (error.message === "PATH_NOT_FOUND") return null; throw error; } }
	function identity(stats) { return [stats.dev, stats.ino, stats.uid, stats.gid].map(String).join(":"); }
	function owned(path, expected) { try { const stats = fs.lstatSync(path, { bigint: true }); return stats.isFile() && !stats.isSymbolicLink() && identity(stats) === expected; } catch { return false; } }
	function reflogLine(message) { return "commit: " + message.split("\n")[0].replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 80); }
	/* One run: gates, verified index copy, write-tree, commit-tree, ref CAS, read-back. */
	async function run(ctx, params, first, firstHead) {
		const message = params.message;
		if (typeof message !== "string" || message.length === 0 || message.trim().length === 0 || message.indexOf("\u0000") >= 0 || Buffer.byteLength(message, "utf8") > 4096) throw fail("GIT_COMMIT_MESSAGE_EMPTY");
		const configured = await shared.gates(ctx);
		const gitFd = fs.openSync(ctx.cwd + "/.git", fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
		const base = "/proc/" + process.pid + "/fd/" + gitFd;
		let lockFd = null, lockIdentity = null, scratch = null, scratchIdentity = null, moved = false, safeCleanup = true;
		const files = new Map(), directories = [];
		function put(name, bytes) { const file = scratch + "/" + name; const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 384); try { fs.writeFileSync(fd, bytes); files.set(name, identity(fs.fstatSync(fd, { bigint: true }))); } finally { fs.closeSync(fd); } }
		function directory(name) { fs.mkdirSync(scratch + "/" + name, { mode: 448 }); directories.push(name); }
		function held() { if (lockFd === null || !owned(base + "/index.lock", lockIdentity) || identity(fs.fstatSync(lockFd, { bigint: true })) !== lockIdentity) throw fail("GIT_RESOURCE_CHANGED"); }
		try {
			if ([fs.fstatSync(gitFd, { bigint: true }).dev, fs.fstatSync(gitFd, { bigint: true }).ino].map(String).join(":") !== ctx.gitIdentity) throw fail("GIT_RESOURCE_CHANGED");
			try { lockFd = fs.openSync(base + "/index.lock", fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 384); } catch (error) { if (error.code === "EEXIST") throw fail("GIT_INDEX_LOCKED"); throw error; }
			const lockStats = fs.fstatSync(lockFd, { bigint: true }); lockIdentity = identity(lockStats);
			/* The index is only read here: the confirmed index already describes the tree that is about to become HEAD, so no index bytes are published. */
			const source = optional(base, "index", MAX_INDEX), sourceStats = source === null ? null : fs.lstatSync(base + "/index", { bigint: true });
			if (sourceStats !== null && (sourceStats.uid !== lockStats.uid || sourceStats.gid !== lockStats.gid || (sourceStats.mode & 3584n) !== 0n)) throw fail("GIT_WRITE_UNSUPPORTED");
			if (port.snapshot(ctx) !== first) throw fail("GIT_RESOURCE_CHANGED");
			scratch = base + "/pideck-index-" + port.crypto.randomBytes(16).toString("hex"); fs.mkdirSync(scratch, { mode: 448 }); scratchIdentity = identity(fs.lstatSync(scratch, { bigint: true }));
			directory("refs"); directory("objects"); directory("info"); directory("hooks");
			put("HEAD", firstHead.head === null ? "ref: refs/heads/pideck-shadow\n" : firstHead.head + "\n");
			put("config", configured.config + "[core]\nbare = false\nfsmonitor = false\nuntrackedCache = false\n");
			if (source !== null) put("index", source);
			const attributes = optional(ctx.cwd, ".git/info/attributes", MAX_TEXT); if (attributes !== null) put("info/attributes", attributes);
			put("message", Buffer.from(message, "utf8"));
			const env = Object.assign({}, ctx.env, { GIT_DIR: scratch, GIT_INDEX_FILE: scratch + "/index", GIT_WORK_TREE: ctx.cwd, GIT_OBJECT_DIRECTORY: base + "/objects", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" });
			const shadow = Object.assign({}, ctx, { env: env });
			const status = await port.rawStatus(shadow);
			if (shared.fingerprint(ctx, first, firstHead, status) !== params.expectedRevision) throw fail("GIT_RESOURCE_CHANGED");
			if (status.resources.some(function (entry) { return ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(entry.xy); })) throw fail("GIT_WRITE_UNSUPPORTED");
			const before = await shared.entries(shadow);
			if (firstHead.head === null && before.size === 0) throw fail("GIT_COMMIT_NOTHING_STAGED");
			const tree = utf8((await port.execute(shadow, ["write-tree"], 256)).bytes).trim();
			if (!HASH.test(tree)) throw fail("GIT_RESULT_INVALID");
			/* write-tree gives the owned index copy a new inode; re-recording it is what lets cleanup remove that file instead of retaining the scratch directory. */
			files.set("index", identity(fs.lstatSync(scratch + "/index", { bigint: true })));
			if (firstHead.head !== null) {
				const headTree = utf8((await port.execute(shadow, ["rev-parse", firstHead.head + "^{tree}"], 256)).bytes).trim();
				if (!HASH.test(headTree)) throw fail("GIT_RESULT_INVALID");
				if (headTree === tree) throw fail("GIT_COMMIT_NOTHING_STAGED");
			}
			const target = firstHead.branch === null ? "HEAD" : "refs/heads/" + firstHead.branch;
			if (firstHead.branch !== null && (await port.execute(shadow, ["check-ref-format", target], 256, [1])).exitCode !== 0) throw fail("GIT_RESULT_INVALID");
			/* Identity is only needed once there is something to commit: a missing identity never masks "nothing staged". */
			const person = await identityOf(ctx);
			const commitEnv = Object.assign({}, env, { GIT_AUTHOR_NAME: person.name, GIT_AUTHOR_EMAIL: person.email, GIT_COMMITTER_NAME: person.name, GIT_COMMITTER_EMAIL: person.email });
			const commitCtx = Object.assign({}, ctx, { env: commitEnv });
			const args = firstHead.head === null ? ["commit-tree", tree, "-F", scratch + "/message"] : ["commit-tree", tree, "-p", firstHead.head, "-F", scratch + "/message"];
			const head = utf8((await port.execute(commitCtx, args, 256)).bytes).trim();
			if (!HASH.test(head)) throw fail("GIT_RESULT_INVALID");
			/* The commit we just created must be a child of exactly the HEAD the user confirmed. */
			const line = utf8((await port.execute(shadow, ["rev-list", "--parents", "-n", "1", head], 256)).bytes).trim().split(" ");
			const parents = firstHead.head === null ? [head] : [head, firstHead.head];
			if (line.length !== parents.length || line[0] !== head || (firstHead.head !== null && line[1] !== firstHead.head)) throw fail("GIT_RESULT_INVALID");
			/* Native compare-and-swap on the real ref: only a ref that still equals the confirmed value moves. */
			try { await port.execute(ctx, ["update-ref", "-m", reflogLine(message), target, head, firstHead.head === null ? ZERO : firstHead.head], 65536); }
			catch (error) {
				/* A killed process may have moved the ref anyway: read the real ref instead of guessing. */
				const now = await port.head(ctx);
				if (now.head === head) { moved = true; throw fail("GIT_WRITE_RESULT_UNCONFIRMED"); }
				if (error.message !== "GIT_COMMAND_FAILED") throw error;
				throw fail(now.head === firstHead.head && now.branch === firstHead.branch ? "GIT_WRITE_UNSUPPORTED" : "GIT_COMMIT_HEAD_CHANGED");
			}
			moved = true;
			const finalHead = await port.head(ctx);
			if (finalHead.head !== head || finalHead.branch !== firstHead.branch) throw fail("GIT_WRITE_RESULT_UNCONFIRMED");
			ctx.check();
			return { applied: true, head: head, tree: tree };
		} catch (error) { if (moved) throw fail("GIT_WRITE_RESULT_UNCONFIRMED"); throw error; }
		finally {
			safeCleanup = await shared.reaped(ctx);
			if (safeCleanup && scratch !== null) {
				try {
					const stats = fs.lstatSync(scratch, { bigint: true });
					if (stats.isDirectory() && !stats.isSymbolicLink() && identity(stats) === scratchIdentity) {
						for (const pair of files) if (owned(scratch + "/" + pair[0], pair[1])) fs.unlinkSync(scratch + "/" + pair[0]);
						for (const name of directories.reverse()) { try { fs.rmdirSync(scratch + "/" + name); } catch {} }
						try { fs.rmdirSync(scratch); } catch {}
					}
				} catch { /* Unknown or externally replaced artifacts are retained, never recursively removed. */ }
			}
			/* Unlike a stage, a successful commit never renames this lock onto the real index: it is simply released. */
			if (safeCleanup && lockFd !== null && owned(base + "/index.lock", lockIdentity)) { try { fs.unlinkSync(base + "/index.lock"); } catch {} }
			if (lockFd !== null) fs.closeSync(lockFd); fs.closeSync(gitFd);
		}
	}
	return { run: run };
}
/* Branch write face: create is a create-only CAS that cannot move HEAD, with the name checked by Git and then by our own rules; switch runs native git switch, refuses a conflicting worktree and treats a post-checkout hook as a refusal. */
export function createGitBranchProgram(fs, port, gates) {
	const fail = port.failure, HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
	function utf8(bytes) { try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw fail("GIT_RESULT_INVALID"); } }
	function validName(value) {
		if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 1024 || /[\u0000-\u001f\u007f\\]/.test(value) || value === "@" || value.indexOf("@{") >= 0) throw fail("GIT_RESULT_INVALID");
		return value;
	}
	/* A branch name must be accepted by Git and must not read as a full ref, an object id or a revision. */
	async function checked(ctx, value) {
		/* Measured: git answers 1 or 128 for a name it refuses; both mean an invalid name, refused before any ref exists. */
		const result = await port.execute(ctx, ["check-ref-format", "--branch", value], 1024, [1, 128]);
		if (result.exitCode !== 0) throw fail("GIT_RESULT_INVALID");
		if (/^(?:HEAD|FETCH_HEAD|ORIG_HEAD)$/.test(value) || value.indexOf("refs/") === 0 || HASH.test(value)) throw fail("GIT_RESULT_INVALID");
		return value;
	}
	async function branchHead(ctx, target) {
		const probe = await port.execute(ctx, ["rev-parse", "--verify", "--quiet", target], 256, [1, 128]);
		if (probe.exitCode !== 0) return null;
		const oid = utf8(probe.bytes).trim();
		if (!HASH.test(oid)) throw fail("GIT_RESULT_INVALID");
		return oid;
	}
	async function run(ctx, params, first, firstHead) {
		const name = await checked(ctx, validName(params.name));
		if (params.expectedHead !== null && !HASH.test(String(params.expectedHead))) throw fail("GIT_RESULT_INVALID");
		const expected = params.expectedHead;
		/* A caller that confirmed nothing claims an unborn repository: true only when there is really no HEAD, and never a state a switch starts from. */
		if (expected === null && params.method === "git.createBranch") throw fail("GIT_COMMIT_HEAD_CHANGED");
		if (params.method === "git.createBranch") {
			if (expected !== null && firstHead.head !== expected) throw fail("GIT_COMMIT_HEAD_CHANGED");
			const target = "refs/heads/" + name;
			if (await branchHead(ctx, target)) throw fail("GIT_REF_EXISTS");
			const configured = await gates(ctx);
			if (port.snapshot(ctx) !== first) throw fail("GIT_RESOURCE_CHANGED");
			/* Zero old value: create-only, so a branch that appeared meanwhile is refused by Git itself. */
			try { await port.execute(ctx, ["update-ref", "-m", "branch: created " + name, target, expected, "0".repeat(40)], 65536); }
			catch (error) {
				const now = await branchHead(ctx, target);
				if (now === expected) throw fail("GIT_WRITE_RESULT_UNCONFIRMED");
				if (now !== null) throw fail("GIT_REF_EXISTS");
				const after = await port.head(ctx);
				if (after.head !== firstHead.head || after.branch !== firstHead.branch) throw fail("GIT_COMMIT_HEAD_CHANGED");
				throw error.message === "GIT_COMMAND_FAILED" ? fail("GIT_WRITE_UNSUPPORTED") : error;
			}
			if ((await branchHead(ctx, target)) !== expected) throw fail("GIT_WRITE_RESULT_UNCONFIRMED");
			const finalHead = await port.head(ctx);
			if (finalHead.head !== firstHead.head || finalHead.branch !== firstHead.branch) throw fail("GIT_WRITE_RESULT_UNCONFIRMED");
			if (JSON.stringify(await gates(ctx)) !== JSON.stringify(configured)) throw fail("GIT_RESOURCE_CHANGED");
			ctx.check();
			return { applied: true, branch: name };
		}
		const target = "refs/heads/" + name;
		const existing = await branchHead(ctx, target);
		if (existing === null) throw fail("GIT_REF_NOT_FOUND");
		/* Existence is answered first (an unborn repository has no branch); a confirmed null with a real HEAD is as stale as a wrong oid. */
		if (firstHead.head !== expected) throw fail("GIT_COMMIT_HEAD_CHANGED");
		const current = await port.head(ctx);
		if (current.branch === name) return { applied: true, branch: name, head: existing };
		if (port.snapshot(ctx) !== first) throw fail("GIT_RESOURCE_CHANGED");
		/* Hooks/config first: a real switch runs post-checkout, so such a repository is refused, never run with hooks skipped. */
		await gates(ctx);
		/* Native switch: a conflicting worktree is refused by Git (rc != 0) and nothing is forced. */
		try { await port.execute(ctx, ["switch", "--", name], 65536); }
		catch (error) {
			const after = await port.head(ctx);
			if (after.branch === name && after.head === existing) throw fail("GIT_WRITE_RESULT_UNCONFIRMED");
			if (after.branch !== firstHead.branch || after.head !== firstHead.head) throw fail("GIT_WRITE_RESULT_UNCONFIRMED");
			if (error.message !== "GIT_COMMAND_FAILED") throw error;
			throw fail("GIT_SWITCH_CONFLICT");
		}
		const after = await port.head(ctx);
		if (after.branch !== name || after.head !== existing) throw fail("GIT_WRITE_RESULT_UNCONFIRMED");
		/* The working tree is re-read through Git itself: whatever the checkout produced must be the branch's tree. */
		const status = await port.rawStatus(ctx);
		if (status.resources.some(function (entry) { return ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(entry.xy); })) throw fail("GIT_WRITE_RESULT_UNCONFIRMED");
		if ((await port.execute(ctx, ["diff", "--quiet", "--no-ext-diff", "--no-textconv", "HEAD", "--"], 1024, [1])).exitCode !== 0) throw fail("GIT_WRITE_RESULT_UNCONFIRMED");
		ctx.check();
		return { applied: true, branch: name, head: existing };
	}
	return { run: run };
}
/* Discard: raw bytes (hash-object --no-filters) go into a create-only refs/pideck/recovery ref and are read back BEFORE the file is touched. */
export function createGitDiscardProgram(fs, port, gates, identity) {
	const fail = port.failure, crypto = port.crypto, MAX_DISCARD = 8388608, ZERO = "0".repeat(40), HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
	function fingerprint(stats) { return [stats.dev, stats.ino, stats.uid, stats.gid].map(String).join(":"); }
	function owned(path, expected) { try { const stats = fs.lstatSync(path, { bigint: true }); return stats.isFile() && !stats.isSymbolicLink() && fingerprint(stats) === expected; } catch { return false; } }
	function utf8(bytes) { try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw fail("GIT_RESULT_INVALID"); } }
	async function run(ctx, params, first, firstHead) {
		const configured = await gates(ctx);
		const status = await port.rawStatus(ctx);
		if (port.fingerprint(ctx, first, firstHead, status) !== params.expectedRevision) throw fail("GIT_RESOURCE_CHANGED");
		const resource = status.resources.find(function (entry) { return entry.path === params.path && port.belongs(entry, params.group); });
		if (!resource) throw fail("GIT_RESOURCE_CHANGED");
		const absolute = ctx.cwd + "/" + params.path;
		const staged = params.group === "workingTree" ? (await port.entries(ctx)).get(params.path) : null;
		if (params.group === "workingTree" && (!staged || !/^100(?:644|755) /.test(staged))) throw fail("GIT_WRITE_UNSUPPORTED");
		let present = null;
		try { present = fs.lstatSync(absolute, { bigint: true }); } catch (error) { if (error.code !== "ENOENT") throw error; }
		let bytes = null, mode = "100644";
		if (present !== null) {
			if (!present.isFile() || present.isSymbolicLink()) throw fail("GIT_WRITE_UNSUPPORTED");
			mode = (present.mode & 73n) !== 0n ? "100755" : "100644";
			bytes = port.readFile(ctx.cwd, params.path, MAX_DISCARD);
			if (bytes.length !== Number(present.size)) throw fail("GIT_RESOURCE_CHANGED");
		} else if (params.group === "untracked") throw fail("GIT_RESOURCE_CHANGED");
		/* A " D" resource has no bytes left to preserve: discarding it recreates the index version, so it needs no snapshot and cannot lose anything. */
		const gitFd = fs.openSync(ctx.cwd + "/.git", fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
		const base = "/proc/" + process.pid + "/fd/" + gitFd;
		let lockFd = null, lockIdentity = null, scratch = null, scratchIdentity = null, ref = null, touched = false, safeCleanup = true;
		const files = new Map(), directories = [];
		function put(name, value) { const file = scratch + "/" + name; const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 384); try { fs.writeFileSync(fd, value); files.set(name, fingerprint(fs.fstatSync(fd, { bigint: true }))); } finally { fs.closeSync(fd); } }
		function directory(name) { fs.mkdirSync(scratch + "/" + name, { mode: 448 }); directories.push(name); }
		function held() { if (lockFd === null || !owned(base + "/index.lock", lockIdentity) || fingerprint(fs.fstatSync(lockFd, { bigint: true })) !== lockIdentity) throw fail("GIT_RESOURCE_CHANGED"); }
		try {
			const gitStats = fs.fstatSync(gitFd, { bigint: true });
			if ([gitStats.dev, gitStats.ino].map(String).join(":") !== ctx.gitIdentity) throw fail("GIT_RESOURCE_CHANGED");
			try { lockFd = fs.openSync(base + "/index.lock", fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 384); } catch (error) { if (error.code === "EEXIST") throw fail("GIT_INDEX_LOCKED"); throw error; }
			lockIdentity = fingerprint(fs.fstatSync(lockFd, { bigint: true }));
			if (port.snapshot(ctx) !== first) throw fail("GIT_RESOURCE_CHANGED");
			scratch = base + "/pideck-index-" + crypto.randomBytes(16).toString("hex");
			fs.mkdirSync(scratch, { mode: 448 });
			scratchIdentity = fingerprint(fs.lstatSync(scratch, { bigint: true }));
			/* restore refreshes the index, so it works on an owned copy: the real index is never written. */
			const realIndex = (function () { try { return port.readFile(base, "index", 16777216); } catch (error) { if (error.message !== "PATH_NOT_FOUND") throw error; return null; } })();
			if (params.group === "workingTree" && realIndex === null) throw fail("GIT_WRITE_UNSUPPORTED");
			if (realIndex !== null) put("worktree-index", realIndex);
			/* Both contexts run inside the scratch metadata directory. */
			const env = Object.assign({}, ctx.env, { GIT_DIR: scratch, GIT_INDEX_FILE: scratch + "/index", GIT_WORK_TREE: ctx.cwd, GIT_OBJECT_DIRECTORY: base + "/objects", GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email, GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" });
			const shadow = Object.assign({}, ctx, { env: env });
			const restoreCtx = Object.assign({}, ctx, { env: Object.assign({}, env, { GIT_INDEX_FILE: scratch + "/worktree-index" }) });
			/* restore needs a repository layout, so the scratch metadata exists even when nothing is snapshotted (a " D" resource). */
			directory("refs"); directory("objects"); directory("info"); directory("hooks");
			put("HEAD", firstHead.head === null ? "ref: refs/heads/pideck-shadow\n" : firstHead.head + "\n");
			put("config", configured.config + "[core]\nbare = false\nfsmonitor = false\nuntrackedCache = false\n");
			if (realIndex !== null) {
				/* Copying the index bytes would copy its stat cache, and a cached entry that happens to look current makes
				git restore skip the write - measured: a rare "diff says changed, status says clean" state where the user's
				bytes were still on disk. The shadow index is therefore rebuilt from the index's own tree, which keeps every
				mode and object and drops all stat data, so a checkout always writes. */
				const realTree = utf8((await port.execute(restoreCtx, ["write-tree"], 256)).bytes).trim();
				if (!HASH.test(realTree)) throw fail("GIT_WRITE_UNSUPPORTED");
				await port.execute(restoreCtx, ["read-tree", realTree], 65536);
				/* read-tree rewrote the owned copy, so record its new identity or cleanup would leave it behind. */
				files.set("worktree-index", fingerprint(fs.lstatSync(scratch + "/worktree-index", { bigint: true })));
			}
			if (bytes !== null) {
				put("blob", bytes);
				const blob = utf8((await port.execute(ctx, ["hash-object", "-w", "--no-filters", "--", scratch + "/blob"], 256)).bytes).trim();
				if (!HASH.test(blob)) throw fail("GIT_RESULT_INVALID");
				await port.execute(shadow, ["read-tree", "--empty"], 65536);
				await port.execute(shadow, ["update-index", "--add", "--cacheinfo", mode + "," + blob + "," + params.path], 65536);
				const tree = utf8((await port.execute(shadow, ["write-tree"], 256)).bytes).trim();
				/* read-tree/write-tree rewrote this file inside our scratch: re-record it so cleanup can remove it. */
				files.set("index", fingerprint(fs.lstatSync(scratch + "/index", { bigint: true })));
				if (!HASH.test(tree)) throw fail("GIT_RESULT_INVALID");
				const commit = utf8((await port.execute(shadow, ["commit-tree", tree, "-m", "discard: " + params.path], 256)).bytes).trim();
				if (!HASH.test(commit)) throw fail("GIT_RESULT_INVALID");
				for (let attempt = 0; attempt < 2 && ref === null; attempt += 1) {
					const candidate = "refs/pideck/recovery/" + new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14) + "-" + crypto.randomBytes(4).toString("hex");
					try { await port.execute(ctx, ["update-ref", "--create-reflog", "-m", "discard: " + params.path, candidate, commit, ZERO], 65536); ref = candidate; }
					catch (error) { if (error.message !== "GIT_COMMAND_FAILED") throw error; }
				}
				/* A reference that does not read our bytes back is not a snapshot, so the file is left alone. */
				if (ref === null) throw fail("GIT_WRITE_UNSUPPORTED");
				if (utf8((await port.execute(ctx, ["rev-parse", ref + ":" + params.path], 256)).bytes).trim() !== blob) throw fail("GIT_WRITE_RESULT_UNCONFIRMED");
			}
			if (params.group === "untracked" && present !== null && !owned(absolute, fingerprint(present))) throw fail("GIT_RESOURCE_CHANGED");
			held();
			touched = true;
			if (params.group === "workingTree") { try { await port.execute(restoreCtx, ["restore", "--worktree", "--", params.path], 65536); } catch (error) { try { process.stderr.write("[discard] restore failed: " + String(error && error.message ? error.message : error) + "\n"); } catch {} throw error; } /* restore rewrote the owned index copy, so record its new identity before cleanup. */ files.set("worktree-index", fingerprint(fs.lstatSync(scratch + "/worktree-index", { bigint: true }))); }
			else fs.unlinkSync(absolute);
			if (params.group === "workingTree") {
				/* The restored file must be the checkout form of the staged version. The comparison runs against the
				stat-free shadow index: a copied stat cache can make git skip or misreport a checkout, while a raw byte
				comparison would be wrong for repositories whose text/eol attributes are supposed to convert the file. */
				if ((await port.execute(restoreCtx, ["diff", "--quiet", "--no-ext-diff", "--no-textconv", "--", params.path], 1024, [1])).exitCode !== 0) {
					try { process.stderr.write("[discard] restored file is not the staged version\n"); } catch {}
					throw fail("GIT_WRITE_RESULT_UNCONFIRMED");
				}
				/* restore rewrites the index stat cache, so the invariant is the staged content, not the index bytes. */
				if ((await port.entries(ctx)).get(params.path) !== staged) { try { process.stderr.write("[discard] staged changed\n"); } catch {} throw fail("GIT_WRITE_RESULT_UNCONFIRMED"); }
			} else if (fs.existsSync(absolute)) throw fail("GIT_WRITE_RESULT_UNCONFIRMED");
			if (JSON.stringify(await port.head(ctx)) !== JSON.stringify(firstHead)) { try { process.stderr.write("[discard] head changed\n"); } catch {} throw fail("GIT_WRITE_RESULT_UNCONFIRMED"); }
			if (JSON.stringify(await gates(ctx)) !== JSON.stringify(configured)) { try { process.stderr.write("[discard] gates changed\n"); } catch {} throw fail("GIT_WRITE_RESULT_UNCONFIRMED"); }
			ctx.check();
			return { applied: true, recoveryRef: ref, path: params.path, mode: params.group === "workingTree" ? "restored" : "removed" };
		} catch (error) { if (touched) { try { process.stderr.write("[discard] after-touch: " + String(error && error.stack ? error.stack : error) + "\n"); } catch {} throw fail("GIT_WRITE_RESULT_UNCONFIRMED"); } throw error; }
		finally {
			safeCleanup = await port.reaped(ctx);
			if (safeCleanup && scratch !== null) {
				try {
					const stats = fs.lstatSync(scratch, { bigint: true });
					if (stats.isDirectory() && !stats.isSymbolicLink() && fingerprint(stats) === scratchIdentity) {
						for (const pair of files) if (owned(scratch + "/" + pair[0], pair[1])) fs.unlinkSync(scratch + "/" + pair[0]);
						for (const name of directories.reverse()) { try { fs.rmdirSync(scratch + "/" + name); } catch {} }
						try { fs.rmdirSync(scratch); } catch {}
					}
				} catch { /* Unknown or externally replaced artifacts are retained, never recursively removed. */ }
			}
			if (safeCleanup && lockFd !== null && owned(base + "/index.lock", lockIdentity)) { try { fs.unlinkSync(base + "/index.lock"); } catch {} }
			if (lockFd !== null) fs.closeSync(lockFd); fs.closeSync(gitFd);
		}
	}
	return { run: run };
}
/* G4b recovery store. The snapshots G4a wrote are listed, restored and (only explicitly) dropped here. Listing is
read-only; restore overwrites nothing that the user changed since - a path whose worktree content differs from the
index version is a refusal - and drop is a native compare-and-swap delete, so the only copy of a discarded change
disappears exactly when the user asked for that specific commit. */
export function createGitRecoveryProgram(fs, port, gates) {
	const fail = port.failure, MAX_ENTRIES = 64, MAX_RESTORE = 8388608, HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
	const RECOVERY_REF = /^refs\/pideck\/recovery\/[A-Za-z0-9._-]+$/;
	function utf8(bytes) { try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw fail("GIT_RESULT_INVALID"); } }
	function nulText(bytes) { try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw fail("GIT_RESULT_INVALID"); } }
	function lines(value) { return value.length === 0 ? [] : value.replace(/\n$/, "").split("\n"); }
	function recoveryRef(value) { if (typeof value !== "string" || !RECOVERY_REF.test(value)) throw fail("GIT_RESULT_INVALID"); return value; }
	/* A recovery commit holds exactly one file in its tree; anything else in this namespace is not ours. */
	function records(raw) {
		const tokens = raw.length === 0 ? [] : raw.split("\u0000");
		if (tokens.length > 0 && tokens[tokens.length - 1] === "") tokens.pop();
		return tokens.map(function (token) {
			const tab = token.indexOf("\t"), meta = tab < 0 ? null : token.slice(0, tab).trim().split(/\s+/);
			if (!meta || (meta.length !== 3 && meta.length !== 4) || !/^100(?:644|755)$/.test(meta[0]) || meta[1] !== "blob" || !HASH.test(meta[2]) || (meta.length === 4 && !/^\d+\+?$/.test(meta[3]))) throw fail("GIT_RESULT_INVALID");
			return { mode: meta[0], path: port.relative(token.slice(tab + 1)), size: meta.length === 4 ? meta[3].replace("+", "") : "" };
		});
	}
	async function resolve(ctx, ref) {
		const commit = utf8((await port.execute(ctx, ["rev-parse", "--verify", "--quiet", ref + "^{commit}"], 256, [1])).bytes).trim();
		if (!HASH.test(commit)) throw fail("GIT_RECOVERY_ENTRY_NOT_FOUND");
		const files = records(nulText((await port.execute(ctx, ["ls-tree", "-r", "-z", commit], 65536)).bytes));
		return { commit: commit, files: files };
	}
	/* The namespace is writable by anyone with repository access, so a listing skips what is not one of ours. */
	async function optional(ctx, ref) {
		try { return await resolve(ctx, ref); } catch (error) { if (error.message === "GIT_RECOVERY_ENTRY_NOT_FOUND" || error.message === "GIT_RESULT_INVALID") return null; throw error; }
	}
	/* Read-only: one listing of our own namespace, newest first, labelled when it is longer than the bound. */
	async function list(ctx) {
		/* One call gives every ref with its commit and date; one ls-tree -l per entry then gives the single path and its
		size. That is two processes per entry instead of the four a naive version needs, which matters at the bound. */
		const listed = lines(utf8((await port.execute(ctx, ["for-each-ref", "--sort=-creatordate", "--format=%(refname)%09%(objectname)%09%(creatordate:unix)", "refs/pideck/recovery"], 65536)).bytes)).filter(function (line) { return RECOVERY_REF.test(line.split("\t")[0]); });
		const entries = [];
		for (const line of listed.slice(0, MAX_ENTRIES)) {
			const fields = line.split("\t");
			if (fields.length !== 3 || !HASH.test(fields[1])) continue;
			const seconds = Number(fields[2]);
			let files;
			try { files = records(nulText((await port.execute(ctx, ["ls-tree", "-l", "-r", "-z", fields[1]], 65536)).bytes)); }
			catch (error) { if (error.message === "GIT_RESULT_INVALID" || error.message === "GIT_COMMAND_FAILED") continue; throw error; }
			if (files.length !== 1 || !Number.isSafeInteger(seconds) || seconds < 0) continue;
			const bytes = Number(files[0].size);
			if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_RESTORE) continue;
			entries.push({ ref: fields[0], oid: fields[1], path: files[0].path, bytes: bytes, at: seconds });
		}
		return { entries: entries, truncated: listed.length > MAX_ENTRIES };
	}
	/* One lock, one fingerprint check, one file written only where nothing uncommitted can be lost. */
	async function restore(ctx, params, first, firstHead) {
		const ref = recoveryRef(params.ref);
		const configured = await gates(ctx);
		const gitFd = fs.openSync(ctx.cwd + "/.git", fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
		const base = "/proc/" + process.pid + "/fd/" + gitFd;
		let lockFd = null, lockIdentity = null, touched = false, scratch = null, scratchIdentity = null, statFree = null, safeCleanup = true;
		const files = new Map(), directories = [];
		function owned(path, expected) { try { const stats = fs.lstatSync(path, { bigint: true }); return stats.isFile() && !stats.isSymbolicLink() && [stats.dev, stats.ino, stats.uid, stats.gid].map(String).join(":") === expected; } catch { return false; } }
		function fingerprint(stats) { return [stats.dev, stats.ino, stats.uid, stats.gid].map(String).join(":"); }
		function put(name, value) { const file = scratch + "/" + name; const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 384); try { fs.writeFileSync(fd, value); files.set(name, fingerprint(fs.fstatSync(fd, { bigint: true }))); } finally { fs.closeSync(fd); } }
		function held() { if (lockFd === null || !owned(base + "/index.lock", lockIdentity)) throw fail("GIT_RESOURCE_CHANGED"); }
		/* A scratch repository plus a copy of the index rebuilt from its own tree: every mode and object, no stat data, so
		git must compare content and nothing can look "already checked out" by accident. */
		async function statFreeIndex() {
			scratch = base + "/pideck-index-" + port.crypto.randomBytes(16).toString("hex");
			fs.mkdirSync(scratch, { mode: 448 });
			scratchIdentity = fingerprint(fs.lstatSync(scratch, { bigint: true }));
			fs.mkdirSync(scratch + "/refs", { mode: 448 });
			fs.mkdirSync(scratch + "/objects", { mode: 448 });
			fs.mkdirSync(scratch + "/info", { mode: 448 });
			fs.mkdirSync(scratch + "/hooks", { mode: 448 });
			directories.push("refs", "objects", "info", "hooks");
			put("HEAD", firstHead.head === null ? "ref: refs/heads/pideck-shadow\n" : firstHead.head + "\n");
			put("config", "[core]\nbare = false\nfsmonitor = false\nuntrackedCache = false\n");
			const source = (function () { try { return port.readFile(base, "index", 16777216); } catch (error) { if (error.message === "PATH_NOT_FOUND") return null; throw error; } })();
			if (source === null) throw fail("GIT_WRITE_UNSUPPORTED");
			put("index", source);
			/* Objects stay in the real object database: write-tree validates the entries it rebuilds, so a scratch object store with nothing in it cannot answer. */
			statFree = Object.assign({}, ctx, { env: Object.assign({}, ctx.env, { GIT_DIR: scratch, GIT_INDEX_FILE: scratch + "/index", GIT_WORK_TREE: ctx.cwd, GIT_OBJECT_DIRECTORY: base + "/objects" }) });
			const tree = utf8((await port.execute(statFree, ["write-tree"], 256)).bytes).trim();
			if (!HASH.test(tree)) throw fail("GIT_WRITE_UNSUPPORTED");
			await port.execute(statFree, ["read-tree", tree], 65536);
			files.set("index", fingerprint(fs.lstatSync(scratch + "/index", { bigint: true })));
		}
		try {
			const gitStats = fs.fstatSync(gitFd, { bigint: true });
			if ([gitStats.dev, gitStats.ino].map(String).join(":") !== ctx.gitIdentity) throw fail("GIT_RESOURCE_CHANGED");
			const status = await port.rawStatus(ctx);
			if (port.fingerprint(ctx, first, firstHead, status) !== params.expectedRevision) throw fail("GIT_RESOURCE_CHANGED");
			await statFreeIndex();
			const resolved = await resolve(ctx, ref);
			if (resolved.commit !== params.oid) throw fail("GIT_RECOVERY_ENTRY_NOT_FOUND");
			const file = resolved.files.length === 1 && resolved.files[0].path === params.path ? resolved.files[0] : null;
			if (file === null) throw fail("GIT_RESULT_INVALID");
			const bytes = (await port.execute(ctx, ["cat-file", "blob", ref + ":" + params.path], MAX_RESTORE)).bytes;
			const absolute = ctx.cwd + "/" + params.path;
			let present = null;
			try { present = fs.lstatSync(absolute, { bigint: true }); } catch (error) { if (error.code !== "ENOENT") throw error; }
			if (present !== null) {
				if (!present.isFile() || present.isSymbolicLink()) throw fail("GIT_WRITE_UNSUPPORTED");
				/* A path the user edited since the discard is never overwritten. The verdict is git's own worktree-vs-index
				comparison, but against a stat-free copy of the index: a copied stat cache could report a modified file as
				clean - and that verdict here decides whether user data survives - while a raw byte comparison would be
				wrong wherever text/eol attributes convert the file. A path with no index entry is never a restore target. */
				if ((await port.execute(ctx, ["cat-file", "-e", ":" + params.path], 256, [1, 128])).exitCode !== 0) throw fail("GIT_RESTORE_CONFLICT");
				if (scratch === null || statFree === null) throw fail("GIT_WRITE_UNSUPPORTED");
				if ((await port.execute(statFree, ["diff", "--quiet", "--no-ext-diff", "--no-textconv", "--", params.path], 1024, [1])).exitCode !== 0) throw fail("GIT_RESTORE_CONFLICT");
				/* That diff may have refreshed the shadow index, so its identity is recorded again or cleanup would keep it. */
				files.set("index", fingerprint(fs.lstatSync(scratch + "/index", { bigint: true })));
			} else if (params.path.indexOf("/") > 0) {
				const parent = params.path.slice(0, params.path.lastIndexOf("/"));
				try { const stats = fs.lstatSync(ctx.cwd + "/" + parent, { bigint: true }); if (!stats.isDirectory() || stats.isSymbolicLink()) throw fail("GIT_RESTORE_CONFLICT"); } catch (error) { if (error.code !== "ENOENT") throw error; throw fail("GIT_RESTORE_CONFLICT"); }
			}
			try { lockFd = fs.openSync(base + "/index.lock", fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 384); } catch (error) { if (error.code === "EEXIST") throw fail("GIT_INDEX_LOCKED"); throw error; }
			lockIdentity = fingerprint(fs.fstatSync(lockFd, { bigint: true }));
			held();
			touched = true;
			const fd = fs.openSync(absolute, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, file.mode === "100755" ? 493 : 420);
			try {
				let offset = 0;
				while (offset < bytes.length) { const written = fs.writeSync(fd, bytes, offset, bytes.length - offset, offset); if (!written) throw fail("IO_ERROR"); offset += written; }
				fs.fsyncSync(fd);
			} finally { fs.closeSync(fd); }
			fs.chmodSync(absolute, file.mode === "100755" ? 493 : 420);
			/* The bytes that came back must be the bytes that were stored: read the file again, do not assume. */
			if (!port.readFile(ctx.cwd, params.path, MAX_RESTORE).equals(bytes)) throw fail("GIT_WRITE_RESULT_UNCONFIRMED");
			if (JSON.stringify(await port.head(ctx)) !== JSON.stringify(firstHead)) { try { process.stderr.write("[discard] head changed\n"); } catch {} throw fail("GIT_WRITE_RESULT_UNCONFIRMED"); }
			if (JSON.stringify(await gates(ctx)) !== JSON.stringify(configured)) { try { process.stderr.write("[discard] gates changed\n"); } catch {} throw fail("GIT_WRITE_RESULT_UNCONFIRMED"); }
			ctx.check();
			return { applied: true, path: params.path, bytes: bytes.length };
		} catch (error) { if (touched) throw fail("GIT_WRITE_RESULT_UNCONFIRMED"); throw error; }
		finally {
			safeCleanup = await port.reaped(ctx);
			if (safeCleanup && scratch !== null) {
				try {
					const stats = fs.lstatSync(scratch, { bigint: true });
					if (stats.isDirectory() && !stats.isSymbolicLink() && fingerprint(stats) === scratchIdentity) {
						for (const pair of files) if (owned(scratch + "/" + pair[0], pair[1])) fs.unlinkSync(scratch + "/" + pair[0]);
						for (const name of directories.reverse()) { try { fs.rmdirSync(scratch + "/" + name); } catch {} }
						try { fs.rmdirSync(scratch); } catch { }
					}
				} catch { /* Unknown or externally replaced artifacts are retained, never recursively removed. */ }
			}
			if (safeCleanup && lockFd !== null && owned(base + "/index.lock", lockIdentity)) { try { fs.unlinkSync(base + "/index.lock"); } catch {} }
			if (lockFd !== null) fs.closeSync(lockFd);
			fs.closeSync(gitFd);
		}
	}
	/* CAS delete: only the commit the panel listed can make this ref disappear. */
	async function drop(ctx, params, first, firstHead) {
		const ref = recoveryRef(params.ref);
		await gates(ctx);
		const gitFd = fs.openSync(ctx.cwd + "/.git", fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
		const base = "/proc/" + process.pid + "/fd/" + gitFd;
		let lockFd = null, lockIdentity = null;
		function owned(path, expected) { try { const stats = fs.lstatSync(path, { bigint: true }); return stats.isFile() && !stats.isSymbolicLink() && [stats.dev, stats.ino, stats.uid, stats.gid].map(String).join(":") === expected; } catch { return false; } }
		function fingerprint(stats) { return [stats.dev, stats.ino, stats.uid, stats.gid].map(String).join(":"); }
		try {
			const status = await port.rawStatus(ctx);
			if (port.fingerprint(ctx, first, firstHead, status) !== params.expectedRevision) throw fail("GIT_RESOURCE_CHANGED");
			try { lockFd = fs.openSync(base + "/index.lock", fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 384); } catch (error) { if (error.code === "EEXIST") throw fail("GIT_INDEX_LOCKED"); throw error; }
			lockIdentity = fingerprint(fs.fstatSync(lockFd, { bigint: true }));
			try { await port.execute(ctx, ["update-ref", "-d", ref, params.oid], 65536); }
			catch (error) {
				if (error.message !== "GIT_COMMAND_FAILED") throw error;
				const now = utf8((await port.execute(ctx, ["rev-parse", "--verify", "--quiet", ref], 256, [1])).bytes).trim();
				if (now === params.oid) throw fail("GIT_WRITE_RESULT_UNCONFIRMED");
				throw fail("GIT_RECOVERY_ENTRY_NOT_FOUND");
			}
			const remaining = utf8((await port.execute(ctx, ["rev-parse", "--verify", "--quiet", ref], 256, [1])).bytes).trim();
			if (remaining === params.oid) throw fail("GIT_WRITE_RESULT_UNCONFIRMED");
			ctx.check();
			return { applied: true };
		}
		finally {
			if (await port.reaped(ctx)) {
				if (lockFd !== null && owned(base + "/index.lock", lockIdentity)) { try { fs.unlinkSync(base + "/index.lock"); } catch {} }
			}
			if (lockFd !== null) fs.closeSync(lockFd);
			fs.closeSync(gitFd);
		}
	}
	return { list: list, restore: restore, drop: drop };
}
/* Init: the only write that runs before a repository exists, so it is dispatched before the repository checks. The
preconditions are read from disk (.git absent in any form, no governing repository above the root) and the result is
confirmed on disk (.git is a real directory, a lock was not left behind, the canonical root is unchanged) before the
branch is read natively. A failure after the command was dispatched is unconfirmed, never retried and never rolled
back; a definitive absence of .git after the failure means nothing was written, so the mapped error is reported. */
export function createGitInitProgram(fs, root, port) {
	const fail = port.failure, MAX_PROBE = 65536;
	function absent(name) { try { fs.lstatSync(name); return false; } catch (error) { if (error.code === "ENOENT") return true; throw error; } }
	async function run(ctx) {
		/* Preconditions, all before dispatch: no .git in any form at the root, and no repository governing it. */
		if (!absent(ctx.cwd + "/.git")) throw fail("GIT_REPO_EXISTS");
		const probe = await port.execute(ctx, ["rev-parse", "--git-dir"], MAX_PROBE, [1, 128]);
		if (probe.exitCode === 0) throw fail("GIT_REPO_EXISTS");
		ctx.check();
		/* Fixed argv through the sanitized write executor: no template, no config override, no network, no hook/filter. */
		let dispatchedError = null;
		try { await port.execute(ctx, ["init", "--quiet"], MAX_PROBE); } catch (error) { dispatchedError = error; }
		/* The post-condition is read from disk: a directory inside the root, never a link or a gitfile. */
		let present = false;
		try { const stats = fs.lstatSync(ctx.cwd + "/.git", { bigint: true }); present = stats.isDirectory() && !stats.isSymbolicLink(); } catch (error) { if (error.code !== "ENOENT") throw fail("GIT_WRITE_RESULT_UNCONFIRMED"); }
		if (!present) {
			/* A definitive absence means the dispatch changed nothing: the mapped failure is the honest answer. */
			if (dispatchedError !== null && absent(ctx.cwd + "/.git")) throw dispatchedError;
			throw fail("GIT_WRITE_RESULT_UNCONFIRMED");
		}
		if (dispatchedError !== null) throw fail("GIT_WRITE_RESULT_UNCONFIRMED");
		try {
			/* Root identity must still be the canonical directory this run opened, and .git must resolve inside it. */
			if (fs.realpathSync(root) !== root) throw fail("GIT_WRITE_RESULT_UNCONFIRMED");
			const rootStats = fs.lstatSync(root, { bigint: true });
			if (!rootStats.isDirectory() || rootStats.isSymbolicLink() || [rootStats.dev, rootStats.ino].map(String).join(":") !== ctx.rootIdentity) throw fail("GIT_WRITE_RESULT_UNCONFIRMED");
			if (fs.realpathSync(ctx.cwd + "/.git") !== root + "/.git") throw fail("GIT_WRITE_RESULT_UNCONFIRMED");
			if (!absent(ctx.cwd + "/.git/index.lock")) throw fail("GIT_WRITE_RESULT_UNCONFIRMED");
			const current = await port.head(ctx);
			ctx.check();
			return { branch: current.branch };
		} catch (error) { throw fail("GIT_WRITE_RESULT_UNCONFIRMED"); }
	}
	return { run: run };
}
` + REMOTE_GIT_HISTORY_SOURCE
).replace(/\r?\n[\t ]*/g, "");
