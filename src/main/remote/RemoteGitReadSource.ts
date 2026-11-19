/**
 * Frozen Git worker, deployed as its own bundle file (git-read.mjs) and imported by helper.mjs; no Git engine or
 * runtime dependency is shipped. It owns the read batch and drives the write programs, which live in the sibling
 * module git-write.mjs and are imported here.
 *
 * The comments inside the frozen body are deliberately one-line invariants: the frozen source is the audited
 * artifact and its ceiling is 96 KiB (see tests/remoteHelperEntry.test.mjs). The long-form rationale lives here:
 *
 * - the canonical root is resolved once with realpath, so every later containment check compares that exact
 *   string; a root that is itself a symlink is resolved before it becomes the boundary;
 * - containment is decided on canonical values (equality admits the root itself, and the separator keeps a
 *   sibling such as "/srv/root-other" from passing a prefix test);
 * - the read batch never follows a link: `fs.stat` walks the path component by component, so a link above the
 *   entry refuses the whole path, and the entry itself is described as itself (a link is "other", never its
 *   target's kind or size);
 * - `fs.list` detects its entry cap by reading one entry past it and refuses as RESULT_TOO_LARGE; it reaches the
 *   directory the way stat does, keeps link entries as "other", sorts by name in code-unit order and carries
 *   bytes for regular files only;
 * - `fs.searchNames` visits at most SEARCH_SLICE entries per slice and only enqueues directories below the depth
 *   ceiling, so the directory sitting at the ceiling is never entered;
 * - a read is published only while the identity it was answered from is still on disk (`unchangedRead`);
 * - the configuration gate reads repository-local scope only (`git config --local`): a repo whose own config carries
 *   filters/extensions/partial-clone settings is refused, while host-wide tooling config - the system-level
 *   `filter.lfs.*` that `git lfs install --system` writes on CI runners and many remote hosts - stays out of the
 *   decision. Read-only commands (`show`/`status`/`diff`/`ls-files`) never smudge or clean, so a host filter cannot
 *   change what a read returns; treating the whole scope as repository configuration made every remote Git read fail
 *   with GIT_CONFIG_UNSUPPORTED on those hosts;
 * - the refs compare defaults to the direct tree diff of the two commits the refs resolved to (two-dot); its
 *   optional `mode: "threeDot"` instead resolves one merge base, reports it with ahead/behind and diffs
 *   merge-base..head, which is the semantics the local panel's compare already uses. Whichever mode runs names
 *   the same OIDs in the answer, so the list and the per-file read cannot disagree even if a ref moves after the
 *   compare. Both inputs are full local ref names (`refs/heads/*`,
 *   `refs/tags/*`) because those are exactly what `git.refs` returns and because a full name can never be
 *   mistaken for an option; the frozen `readRef` re-implements the check-ref-format rules and additionally
 *   refuses the shapes Git itself accepts but this protocol does not use (a component starting with `-`, an
 *   `@` component, and `{}` which would collide with the `^{commit}` argument that follows the name);
 * - `git.init` is dispatched before the repository checks because it is the one write whose precondition is the
 *   absence of `.git`: any existing repository - including a parent repository that governs the root - is a
 *   GIT_REPO_EXISTS refusal with no disk change, and a repository the dispatch cannot fully confirm is reported
 *   as GIT_WRITE_RESULT_UNCONFIRMED instead of guessed at.
 * - nested repository scope (G5d): an optional per-request `repo` path (project-relative POSIX, empty is the root)
 *   is accepted only by the read batch. The scope is anchored by walking from the already anchored root fd with
 *   lstat no-follow and opening each segment O_RDONLY|O_DIRECTORY|O_NOFOLLOW, so a link segment, a missing
 *   directory or a non-directory is GIT_NOT_REPOSITORY before any Git child; the final fd becomes ctx.cwd and is
 *   closed with the request. The write batch accepts the same scope (G5e); init and repos refuse a non-empty scope
 *   (GIT_RESULT_INVALID).
 * - repository discovery (G5d): `git.repos` walks the project root with the same bounded, link-free rules the local
 *   walker uses (depth 4, 50 repositories, 512 visited directories, fixed skip names plus hidden directories) and
 *   answers project-relative POSIX paths; it runs before the .git existence checks because a project without a root
 *   repository may still contain nested ones. `truncated` is set only when a cap really cut the walk.
 * - `git.log` (1.32.0) takes an optional `ref` or `all` filter and an optional `withCount`; the page and its
 *   total are derived from one filter expression, so a count can never describe a different list, and a total
 *   that was not asked for is absent instead of a fake 0.
 * - `git.commitDetail` (1.32.0) reads one commit twice under the same snapshot: `--name-status` names the files
 *   and `--numstat` numbers them. A binary record's `-` is an absent count, never 0, and the short stat sums only
 *   what was actually read.
 * - `git.stagedDiff` (1.32.0) is the bounded staged text: once the answer is provably past the 100 KiB text
 *   limit the child is stopped, so a huge staged diff costs one bounded read instead of a failed request.
 * - nested write scope (G5e): every existing write program accepts the same optional `repo`, because each one already roots
 *   every check (repository metadata, official index lock, scratch context, restore, ref CAS, witness) at `ctx.cwd` and
 *   `run()` keeps the root canonical/identity checks in front of all of them. The anchor is therefore reused verbatim: a link
 *   segment or a missing directory is still GIT_NOT_REPOSITORY before a Git child, and the only repository a write can reach
 *   is the one the frame named. `git.init` and `git.repos` stay root-only. Nothing about hooks/filter/signing/in-progress
 *   gates, budgets, cancellation, cleanup or unconfirmed-result semantics changes for a nested write.
 */
import { REMOTE_GIT_READ_HISTORY_SOURCE } from "./RemoteGitReadHistorySource";

export const REMOTE_GIT_READ_SOURCE = (
	String.raw`import{createGitWriteProgram,createGitCommitProgram,createGitBranchProgram,createGitDiscardProgram,createGitRecoveryProgram,createGitInitProgram,createGitHistoryProgram}from"./git-write.mjs";import{createGitSyncProgram}from"./git-sync.mjs";export function createGitReadProgram(root, fs, path) {
	const cp = process.getBuiltinModule("node:child_process");
	const crypto = process.getBuiltinModule("node:crypto");
	const MAX_STATUS = 1048576, MAX_RESOURCES = 4096, MAX_TEXT = 262144, MAX_STDERR = 65536;
	/* check-ignore output for 64 relative paths: one NUL-terminated entry each, capped well above any legal input. */
	const MAX_CHECK_IGNORE = 262144;
	const MAX_INDEX = 16777216, MAX_METADATA = 20000, MAX_DEPTH = 32, MAX_PATH = 4096;
	const MAX_REPOS = 50, MAX_REPO_DEPTH = 4, MAX_REPO_VISITED = 512;
	const scopes = new Set();
	const stable = new Set(["PATH_OUTSIDE_ROOT", "PATH_NOT_FOUND", "NOT_A_FILE", "PERMISSION_DENIED", "IO_ERROR", "RESULT_TOO_LARGE", "REQUEST_TIMEOUT", "REQUEST_CANCELLED", "REMOTE_CONNECTION_LOST", "GIT_NOT_FOUND", "GIT_VERSION_UNSUPPORTED", "GIT_NOT_REPOSITORY", "GIT_REPO_EXISTS", "GIT_UNSUPPORTED_REPOSITORY", "GIT_PLATFORM_UNSUPPORTED", "GIT_CONFIG_UNSUPPORTED", "GIT_COMMAND_FAILED", "GIT_RESULT_INVALID", "GIT_RESOURCE_CHANGED", "GIT_NOT_TEXT", "GIT_INDEX_LOCKED", "GIT_WRITE_UNSUPPORTED", "GIT_WRITE_RESULT_UNCONFIRMED", "GIT_COMMIT_NOTHING_STAGED", "GIT_COMMIT_MESSAGE_EMPTY", "GIT_COMMIT_IDENTITY_REQUIRED", "GIT_COMMIT_HEAD_CHANGED", "GIT_OBJECT_NOT_FOUND", "GIT_REF_EXISTS", "GIT_REF_NOT_FOUND", "GIT_SWITCH_CONFLICT", "GIT_RESTORE_CONFLICT", "GIT_RECOVERY_ENTRY_NOT_FOUND", "GIT_SYNC_REMOTE_UNKNOWN", "GIT_SYNC_DIRTY", "GIT_PULL_STRATEGY_REQUIRED", "GIT_PULL_CONFLICTS", "GIT_PUSH_REJECTED", "GIT_PUSH_REMOTE_REFUSED", "GIT_SYNC_FAILED", "GIT_WRITE_RESULT_UNCONFIRMED"]);
	const control = /[\x00-\x1f\x7f]/;
	/* The last command's stderr, bounded: a refused write must explain itself the way local git does. */
	let lastStderr = "";
	function failure(code) { const error = new Error(code); if (lastStderr.length > 0) error.detail = lastStderr; return error; }
	function code(error) {
		if (error && stable.has(error.message)) return error.message;
		if (error && (error.code === "EACCES" || error.code === "EPERM")) return "PERMISSION_DENIED";
		if (error && error.code === "ELOOP") return "GIT_UNSUPPORTED_REPOSITORY";
		return "IO_ERROR";
	}
	function relative(value) {
		if (typeof value !== "string" || !value || Buffer.byteLength(value) > MAX_PATH || control.test(value) || value.startsWith("-") || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value) || /%2e|%2f|%5c/i.test(value) || value.split("/").some(function (part) { return !part || part === "." || part === ".."; })) throw failure("PATH_OUTSIDE_ROOT");
		return value;
	}
	/* Reads and managed writes may name a repository other than the project root; git.init and git.repos stay root-only. */
	const READ_REPO = new Set(["git.status", "git.workspaceDiff", "git.log", "git.commitDetail", "git.refs", "git.refFileDiff", "git.compare", "git.stagedDiff", "git.recoveryList", "git.syncFacts", "git.checkIgnore"]);
	/* Every write program already runs entirely from ctx.cwd, so the same anchored scope can carry a write to a nested repository. */
	const WRITE_REPO = new Set(["git.stage", "git.unstage", "git.commit", "git.createBranch", "git.switchBranch", "git.discard", "git.recoveryRestore", "git.recoveryDrop", "git.fetch", "git.push", "git.pull", "git.cherryPick", "git.revert", "git.reset", "git.drop"]);
	/* The optional scope: absent or empty is the root; any other shape is refused before a walk, a link check or a Git child. */
	function readRepo(value) {
		if (value === undefined || value === "") return "";
		if (typeof value !== "string" || Buffer.byteLength(value) > MAX_PATH || control.test(value) || value.charAt(0) === "-" || value.charAt(0) === "/" || value.indexOf("\\") >= 0 || /^[A-Za-z]:/.test(value) || /%2e|%2f|%5c/i.test(value) || value.split("/").some(function (part) { return !part || part === "." || part === ".." || /^\.git$/i.test(part) || part.endsWith(".lock"); })) throw failure("GIT_RESULT_INVALID");
		return value;
	}
	/* The scope is anchored the way every other path is: walk from the already anchored root fd, refuse a link or a non-directory segment, keep the final directory as an fd for the rest of the request. */
	function anchorRepository(ctx, repo) {
		if (repo === "") return;
		const parts = repo.split("/");
		let current = ctx.cwd;
		for (let index = 0; index < parts.length; index += 1) {
			ctx.check();
			const candidate = current + "/" + parts[index];
			let stats;
			try { stats = fs.lstatSync(candidate); } catch (error) { if (error.code === "ENOENT" || error.code === "ENOTDIR") throw failure("GIT_NOT_REPOSITORY"); if (error.code === "EACCES" || error.code === "EPERM") throw failure("PERMISSION_DENIED"); throw error; }
			if (stats.isSymbolicLink() || !stats.isDirectory()) throw failure("GIT_NOT_REPOSITORY");
			let fd;
			try { fd = fs.openSync(candidate, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW); } catch (error) { if (error.code === "ELOOP" || error.code === "ENOENT" || error.code === "ENOTDIR") throw failure("GIT_NOT_REPOSITORY"); if (error.code === "EACCES" || error.code === "EPERM") throw failure("PERMISSION_DENIED"); throw error; }
			if (ctx.repoFd !== null) { try { fs.closeSync(ctx.repoFd); } catch {} }
			ctx.repoFd = fd;
			current = "/proc/" + process.pid + "/fd/" + fd;
		}
		ctx.cwd = current;
	}
	/* Discovery mirrors the local walker: fixed skip names plus every hidden directory, no symlink is descended, .git is an entry-name claim in any form. */
	const REPO_SKIP = new Set(["node_modules", ".git", "dist", "out", "build", ".next", "target", "vendor", "__pycache__", ".venv", "venv", "coverage"]);
	function isRepoDirectory(directory, entry) {
		if (entry.isDirectory()) return true;
		if (entry.isFile() || entry.isSymbolicLink()) return false;
		try { return fs.lstatSync(directory + "/" + entry.name).isDirectory(); } catch { return false; }
	}
	function repoName(relativeValue) {
		if (relativeValue !== "") return relativeValue.slice(relativeValue.lastIndexOf("/") + 1);
		return root.slice(root.lastIndexOf("/") + 1);
	}
	/* Bounded, side-effect-free discovery: no Git child, no write, and truncated is only set when a cap really cut the walk. */
	async function repositories(ctx) {
		const queue = [{ absolute: ctx.cwd, relative: "", depth: 0 }];
		const repos = [];
		let visited = 0, truncated = false;
		for (let next = 0; next < queue.length; next += 1) {
			ctx.check();
			if (visited >= MAX_REPO_VISITED) { truncated = true; break; }
			visited += 1;
			if (visited % 64 === 0) { await new Promise(function (resolve) { setImmediate(resolve); }); ctx.check(); }
			const directory = queue[next];
			let handle;
			try { handle = fs.opendirSync(directory.absolute); } catch (error) { if (["EACCES", "EPERM", "ENOENT", "ENOTDIR"].includes(error.code)) continue; throw error; }
			const children = [];
			let hasGit = false;
			try {
				let entry;
				while ((entry = handle.readSync()) !== null) {
					if (entry.name === ".git") hasGit = true;
					else if (!REPO_SKIP.has(entry.name) && !entry.name.startsWith(".") && isRepoDirectory(directory.absolute, entry)) children.push(entry.name);
				}
			} finally { handle.closeSync(); }
			if (hasGit) {
				if (repos.length >= MAX_REPOS) truncated = true;
				else repos.push({ path: directory.relative, name: repoName(directory.relative) });
			}
			if (directory.depth >= MAX_REPO_DEPTH) continue;
			children.sort(function (left, right) { return left < right ? -1 : left > right ? 1 : 0; });
			for (const child of children) queue.push({ absolute: directory.absolute + "/" + child, relative: directory.relative === "" ? child : directory.relative + "/" + child, depth: directory.depth + 1 });
		}
		repos.sort(function (left, right) { if (left.path === right.path) return 0; if (left.path === "") return -1; if (right.path === "") return 1; return left.path < right.path ? -1 : 1; });
		return { repos: repos, truncated: truncated };
	}
	function metadata(stats) { return [stats.dev, stats.ino, stats.mode, stats.size, stats.mtimeNs, stats.ctimeNs].map(String).join(":"); }
	function kill(child) {
		if (child.pid === undefined) return;
		try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
	}
	function executable() {
		for (const directory of (process.env.PATH || "").split(":")) {
			if (!directory.startsWith("/") || control.test(directory)) continue;
			const candidate = path.join(directory, "git");
			try {
				const resolved = fs.realpathSync(candidate);
				if (root !== null && (resolved === root || resolved.startsWith(root + "/"))) continue;
				if (!fs.statSync(resolved).isFile()) continue;
				fs.accessSync(resolved, fs.constants.X_OK);
				return resolved;
			} catch {}
		}
		throw failure("GIT_NOT_FOUND");
	}
	/* Only the fixed executor controls Git environment overrides; renderer parameters never do. */
	function environment() {
		const env = {};
		for (const key of Object.keys(process.env)) if (!key.startsWith("GIT_") && !["PAGER", "LESS", "LD_PRELOAD", "LD_LIBRARY_PATH", "NODE_OPTIONS"].includes(key)) env[key] = process.env[key];
		env.GIT_OPTIONAL_LOCKS = "0"; env.GIT_TERMINAL_PROMPT = "0"; env.GIT_PAGER = "cat"; env.GIT_EXTERNAL_DIFF = "";
		return env;
	}
	function checkedPath(base, value) {
		let current = base;
		const parts = value.split("/");
		for (let i = 0; i < parts.length; i += 1) {
			current += "/" + parts[i];
			let stats;
			try { stats = fs.lstatSync(current); } catch (error) { if (error.code === "ENOENT") throw failure("PATH_NOT_FOUND"); throw error; }
			if (stats.isSymbolicLink()) throw failure("NOT_A_FILE");
			if (i < parts.length - 1 && !stats.isDirectory()) throw failure("NOT_A_FILE");
		}
		return current;
	}
	function readFile(base, value, limit) {
		const absolute = checkedPath(base, value);
		const initial = fs.lstatSync(absolute, { bigint: true });
		if (!initial.isFile()) throw failure("NOT_A_FILE");
		/* NONBLOCK prevents a raced FIFO replacement from blocking the helper event loop before fstat. */
		const fd = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
		try {
			const before = fs.fstatSync(fd, { bigint: true });
			if (!before.isFile()) throw failure("NOT_A_FILE");
			if (metadata(initial) !== metadata(before)) throw failure("GIT_RESOURCE_CHANGED");
			if (before.size > BigInt(limit)) throw failure("RESULT_TOO_LARGE");
			const buffer = Buffer.alloc(Number(before.size) + 1);
			let offset = 0;
			while (offset < buffer.length) { const bytes = fs.readSync(fd, buffer, offset, buffer.length - offset, offset); if (!bytes) break; offset += bytes; }
			if (offset > limit) throw failure("RESULT_TOO_LARGE");
			const after = fs.fstatSync(fd, { bigint: true });
			if (metadata(before) !== metadata(after) || metadata(after) !== metadata(fs.lstatSync(absolute, { bigint: true }))) throw failure("GIT_RESOURCE_CHANGED");
			return buffer.subarray(0, offset);
		} finally { fs.closeSync(fd); }
	}
	function text(buffer) {
		if (buffer.includes(0)) throw failure("GIT_NOT_TEXT");
		try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer); } catch { throw failure("GIT_NOT_TEXT"); }
	}
	/* Metadata is walked with a streaming directory cursor, not an unbounded readdir array. */
	async function inspectMetadata(ctx) {
		const queue = [{ absolute: ctx.cwd + "/.git", depth: 0 }];
		let count = 0;
		for (let next = 0; next < queue.length; next += 1) {
			ctx.check();
			const directory = queue[next];
			if (directory.depth > MAX_DEPTH) throw failure("RESULT_TOO_LARGE");
			const handle = fs.opendirSync(directory.absolute);
			try {
				let entry;
				while ((entry = handle.readSync()) !== null) {
					count += 1;
					if (count > MAX_METADATA) throw failure("RESULT_TOO_LARGE");
					const absolute = directory.absolute + "/" + entry.name;
					const stats = fs.lstatSync(absolute);
					if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile()) || entry.name.endsWith(".promisor")) throw failure("GIT_UNSUPPORTED_REPOSITORY");
					if (stats.isDirectory()) queue.push({ absolute: absolute, depth: directory.depth + 1 });
					if (count % 64 === 0) { await new Promise(function (resolve) { setImmediate(resolve); }); ctx.check(); }
				}
			} finally { handle.closeSync(); }
		}
		for (const forbidden of [".git/commondir", ".git/objects/info/alternates", ".git/objects/info/http-alternates", ".git/shallow", ".gitmodules"]) {
			try { fs.lstatSync(ctx.cwd + "/" + forbidden); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
			throw failure("GIT_UNSUPPORTED_REPOSITORY");
		}
	}
	function snapshot(ctx) {
		ctx.check();
		if (fs.realpathSync(root) !== root || metadata(fs.lstatSync(root, { bigint: true })).split(":").slice(0, 2).join(":") !== ctx.rootIdentity) throw failure("GIT_RESOURCE_CHANGED");
		if (metadata(fs.lstatSync(ctx.cwd + "/.git", { bigint: true })).split(":").slice(0, 2).join(":") !== ctx.gitIdentity) throw failure("GIT_RESOURCE_CHANGED");
		try {
			const stats = fs.lstatSync(ctx.cwd + "/.git/index", { bigint: true });
			const bytes = readFile(ctx.cwd, ".git/index", MAX_INDEX);
			return metadata(stats) + ":" + crypto.createHash("sha256").update(bytes).digest("hex");
		} catch (error) { if (error.message === "PATH_NOT_FOUND" || error.code === "ENOENT") return null; throw error; }
	}
	function execute(ctx, args, limit, allowed, keepPathspecMagic, cutoff) {
		lastStderr = "";
		ctx.check();
		/* check-ignore refuses --literal-pathspecs outright (git 2.34: "magic pathspec prefix not supported"),
		   so that one command keeps the default pathspec parsing. Its inputs cannot become magic: the path rule
		   below refuses a leading "-" and the caller refuses a leading ":", which is the only way a pathspec
		   becomes a revision or a magic expression. */
		const prefix = keepPathspecMagic ? ["--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "color.ui=false"] : ["--no-pager", "--no-optional-locks", "--literal-pathspecs", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "color.ui=false"];
		return new Promise(function (resolve, reject) {
			let child;
			try { child = cp.spawn(ctx.executable, prefix.concat(args), { cwd: ctx.cwd, env: ctx.env, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] }); } catch { reject(failure("GIT_COMMAND_FAILED")); return; }
			ctx.children.add(child);
			let settled = false, bytes = 0, errors = 0;
			const chunks = [];
			function finish(error, result) { if (settled) return; settled = true; ctx.rejectors.delete(abort); if (error) reject(error); else resolve(result); }
			function abort(reason) { kill(child); finish(failure(reason)); }
			ctx.rejectors.add(abort);
			child.stdout.on("data", function (chunk) { bytes += chunk.length; if (bytes > limit) abort("RESULT_TOO_LARGE"); else if (!settled) { chunks.push(chunk); if (cutoff !== undefined && bytes > cutoff) { kill(child); finish(null, { bytes: Buffer.concat(chunks, bytes), exitCode: 0, cut: true }); } } });
			child.stderr.on("data", function (chunk) { errors += chunk.length; if (errors > MAX_STDERR) abort("RESULT_TOO_LARGE"); if (lastStderr.length < 4096) lastStderr += chunk.toString("utf8").slice(0, 4096 - lastStderr.length); });
			child.once("error", function () { finish(failure("GIT_COMMAND_FAILED")); });
			child.once("close", function (exitCode) { ctx.children.delete(child); if (settled) return; if (exitCode !== 0 && !(allowed || []).includes(exitCode)) finish(failure("GIT_COMMAND_FAILED")); else finish(null, { bytes: Buffer.concat(chunks, bytes), exitCode: exitCode }); });
		});
	}
	/* Porcelain v1 -z is parsed only enough to validate paths and select the requested SCM group. */
	function resources(buffer) {
		let raw;
		try { raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer); } catch { throw failure("GIT_RESULT_INVALID"); }
		if (raw && !raw.endsWith("\0")) throw failure("GIT_RESULT_INVALID");
		const fields = raw ? raw.slice(0, -1).split("\0") : [];
		const result = [];
		for (let i = 0; i < fields.length; i += 1) {
			const line = fields[i];
			if (line.length < 4 || line[2] !== " " || !/^[ MADRCUT?!]{2}$/.test(line.slice(0, 2))) throw failure("GIT_RESULT_INVALID");
			const xy = line.slice(0, 2), value = relative(line.slice(3).replace(/\/$/, ""));
			const oldPath = /[RC]/.test(xy) ? relative(fields[++i]) : null;
			result.push({ xy: xy, path: value, oldPath: oldPath });
			if (result.length > MAX_RESOURCES) throw failure("RESULT_TOO_LARGE");
		}
		return result;
	}
	async function head(ctx) {
		const commit = await execute(ctx, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], 256, [1]);
		const oid = commit.exitCode === 1 ? null : text(commit.bytes).trim();
		if (oid !== null && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) throw failure("GIT_RESULT_INVALID");
		const ref = await execute(ctx, ["symbolic-ref", "--quiet", "--short", "HEAD"], MAX_PATH, [1]);
		const branch = ref.exitCode === 1 ? null : text(ref.bytes).trim();
		if (branch !== null && (!branch || control.test(branch))) throw failure("GIT_RESULT_INVALID");
		return { head: oid, branch: branch };
	}
	async function rawStatus(ctx) {
		const result = await execute(ctx, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."], MAX_STATUS);
		return { bytes: result.bytes, resources: resources(result.bytes) };
	}
	/*
	 * git check-ignore --no-index -- <paths>: ask Git, never reimplement its matching.
	 *
	 * Three deliberate choices:
	 * - --no-index: a path already in the index is still judged against the patterns, so "ignored by rule"
	 *   stays a fact even when git status reports the file as tracked;
	 * - argv instead of stdin: the frame protocol owns one direction (stdout) and gains no new stream;
	 * - exit 1 is a NORMAL answer (nothing matched), so only other exit codes are failures.
	 * Output is one ignored path per line. -z is unusable here: git 2.34 refuses it without --stdin, and this
	 * worker deliberately keeps a single direction (a path carrying a newline is already refused by the path
	 * rule, so line separation is unambiguous).
	 */
	async function checkIgnore(ctx, params) {
		const result = await execute(ctx, ["check-ignore", "--no-index", "--"].concat(params.paths), MAX_CHECK_IGNORE, [1], true);
		const ignored = new Set(text(result.bytes).split("\n").filter(function (line) { return line !== ""; }));
		return { ignored: params.paths.map(function (path) { return ignored.has(path); }) };
	}
	async function validateConfiguration(ctx) {
		const version = text((await execute(ctx, ["--version"], 1024)).bytes);
		const parsed = /\bgit version (\d+)\.(\d+)\./.exec(version);
		if (!parsed || Number(parsed[1]) < 2 || (Number(parsed[1]) === 2 && Number(parsed[2]) < 16)) throw failure("GIT_VERSION_UNSUPPORTED");
		/* --local: only repository config can make a repository unsupported; host-wide config (system-level git-lfs writes filter.lfs.*) is host tooling and read-only commands never smudge/clean. Local filters stay refused. */
		const config = await execute(ctx, ["config", "--local", "--null", "--get-regexp", "^(filter\\.|core\\.(worktree|bare|splitindex|sparsecheckout)|index\\.sparse|extensions\\.(worktreeconfig|partialclone)|remote\\..*\\.(promisor|partialclonefilter))"], MAX_STDERR, [1]);
		if (config.exitCode === 0) {
			let fields;
			try { fields = new TextDecoder("utf-8", { fatal: true }).decode(config.bytes).split("\0"); } catch { throw failure("GIT_RESULT_INVALID"); }
			for (const field of fields) if (/^filter\.|^core\.(worktree|splitindex|sparsecheckout)\n|^index\.sparse\n|^extensions\.|^remote\./i.test(field)) throw failure("GIT_CONFIG_UNSUPPORTED");
			if (/core\.bare\ntrue(?:\0|$)/i.test(config.bytes.toString("utf8"))) throw failure("GIT_UNSUPPORTED_REPOSITORY");
		}
		const staged = await execute(ctx, ["ls-files", "--stage", "-z"], MAX_INDEX);
		if (/(?:^|\0)160000 /.test(staged.bytes.toString("utf8"))) throw failure("GIT_UNSUPPORTED_REPOSITORY");
	}
	function belongs(resource, group) {
		const conflict = ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(resource.xy);
		if (group === "merge") return conflict;
		if (conflict) return false;
		if (group === "untracked") return resource.xy === "??";
		if (group === "index") return ![" ", "?", "!"].includes(resource.xy[0]);
		return resource.xy === "??" || ![" ", "?", "!"].includes(resource.xy[1]);
	}
	async function blob(ctx, ref) { return text((await execute(ctx, ["show", "--no-ext-diff", "--no-textconv", ref], MAX_TEXT)).bytes); }
	async function readDiff(ctx, params, status, initialHead) {
		const resource = status.resources.find(function (entry) { return entry.path === params.path && belongs(entry, params.group); });
		if (!resource) throw failure("GIT_RESOURCE_CHANGED");
		const xy = resource.xy, current = resource.path, old = resource.oldPath || current;
		let originalContent, modifiedContent;
		if (xy === "??") { originalContent = ""; modifiedContent = text(readFile(ctx.cwd, current, MAX_TEXT)); }
		else if (params.group === "index") {
			originalContent = xy[0] === "A" ? "" : await blob(ctx, initialHead.head + ":" + old);
			modifiedContent = xy[0] === "D" ? "" : await blob(ctx, ":" + current);
		} else if (params.group === "workingTree") {
			originalContent = xy === " A" ? "" : await blob(ctx, ":" + (xy[1] === "R" || xy[1] === "C" ? old : current));
			modifiedContent = xy[1] === "D" ? "" : text(readFile(ctx.cwd, current, MAX_TEXT));
		} else {
			originalContent = ["UA", "DU", "DD"].includes(xy) || initialHead.head === null ? "" : await blob(ctx, initialHead.head + ":" + current);
			modifiedContent = xy === "DD" ? "" : text(readFile(ctx.cwd, current, MAX_TEXT));
		}
		const finalStatus = await rawStatus(ctx);
		if (!finalStatus.bytes.equals(status.bytes)) throw failure("GIT_RESOURCE_CHANGED");
		/* Worktree can change without a different XY flag: compare bytes, not only status. */
		const readsWorktree = xy === "??" || (params.group === "workingTree" && xy[1] !== "D") || (params.group === "merge" && xy !== "DD");
		if (readsWorktree && text(readFile(ctx.cwd, current, MAX_TEXT)) !== modifiedContent) throw failure("GIT_RESOURCE_CHANGED");
		return { originalContent: originalContent, modifiedContent: modifiedContent };
	}
	const writer = createGitWriteProgram(fs, { crypto: crypto, failure: failure, relative: relative, metadata: metadata, readFile: readFile, text: text, execute: execute, rawStatus: rawStatus, snapshot: snapshot, head: head, belongs: belongs, validateConfiguration: validateConfiguration });
` + REMOTE_GIT_READ_HISTORY_SOURCE
).replace(/\r?\n[\t ]*/g, "");
