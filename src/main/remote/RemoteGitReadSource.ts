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
 * - the refs compare is the direct tree diff of the two commits the refs resolved to (two-dot), never a
 *   merge-base/three-dot view: the per-file read names the same two OIDs, so the list and the content cannot
 *   disagree even if a ref moves after the compare. Both inputs are full local ref names (`refs/heads/*`,
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
 * - nested write scope (G5e): every existing write program accepts the same optional `repo`, because each one already roots
 *   every check (repository metadata, official index lock, scratch context, restore, ref CAS, witness) at `ctx.cwd` and
 *   `run()` keeps the root canonical/identity checks in front of all of them. The anchor is therefore reused verbatim: a link
 *   segment or a missing directory is still GIT_NOT_REPOSITORY before a Git child, and the only repository a write can reach
 *   is the one the frame named. `git.init` and `git.repos` stay root-only. Nothing about hooks/filter/signing/in-progress
 *   gates, budgets, cancellation, cleanup or unconfirmed-result semantics changes for a nested write.
 */
export const REMOTE_GIT_READ_SOURCE = String.raw`import{createGitWriteProgram,createGitCommitProgram,createGitBranchProgram,createGitDiscardProgram,createGitRecoveryProgram,createGitInitProgram}from"./git-write.mjs";import{createGitSyncProgram}from"./git-sync.mjs";export function createGitReadProgram(root, fs, path) {
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
	function failure(code) { return new Error(code); }
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
	const READ_REPO = new Set(["git.status", "git.workspaceDiff", "git.log", "git.commitDetail", "git.refs", "git.refFileDiff", "git.compare", "git.recoveryList", "git.syncFacts", "git.checkIgnore"]);
	/* Every write program already runs entirely from ctx.cwd, so the same anchored scope can carry a write to a nested repository. */
	const WRITE_REPO = new Set(["git.stage", "git.unstage", "git.commit", "git.createBranch", "git.switchBranch", "git.discard", "git.recoveryRestore", "git.recoveryDrop", "git.fetch", "git.push", "git.pull"]);
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
	function execute(ctx, args, limit, allowed, keepPathspecMagic) {
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
			child.stdout.on("data", function (chunk) { bytes += chunk.length; if (bytes > limit) abort("RESULT_TOO_LARGE"); else if (!settled) chunks.push(chunk); });
			child.stderr.on("data", function (chunk) { errors += chunk.length; if (errors > MAX_STDERR) abort("RESULT_TOO_LARGE"); });
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
	/* G3a read-only history: log, commit detail, local refs, one file between two revisions. */
	const MAX_LOG = 100, LOG_DEFAULT = 50, MAX_SKIP = 100000, MAX_PARENTS = 8, MAX_REFS = 512, MAX_REF_NAME = 1024, MAX_SUBJECT = 1024, MAX_DETAIL_FILES = 512, MAX_MESSAGE = 65536, MAX_IDENTITY = 320;
	const NAME_CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f]/, BODY_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/, HASH_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
	/* NUL-separated listings are still text, so they need a decoder that does not refuse the separators. */
	function nulText(buffer) { try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer); } catch { throw failure("GIT_NOT_TEXT"); } }
	function readHash(value) { if (typeof value !== "string" || !HASH_PATTERN.test(value)) throw failure("GIT_RESULT_INVALID"); return value; }
	function readName(value, limit) { if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > limit || NAME_CONTROL.test(value)) throw failure("GIT_RESULT_INVALID"); return value; }
	/* Full local refs only; the rules mirror check-ref-format and add the shapes Git accepts but this protocol rejects. */
	function readRef(value) {
		if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_REF_NAME || /[\u0000-\u0020\u007f~^:?*[\\{}]/.test(value) || value.includes("..") || value.includes("@{") || value.includes("//")) throw failure("GIT_RESULT_INVALID");
		const prefix = value.startsWith("refs/heads/") ? "refs/heads/" : value.startsWith("refs/tags/") ? "refs/tags/" : null;
		if (prefix === null) throw failure("GIT_RESULT_INVALID");
		const name = value.slice(prefix.length);
		if (!name || name.split("/").some(function (part) { return !part || part === "." || part === ".." || part === "@" || part.startsWith(".") || part.startsWith("-") || part.endsWith(".") || part.endsWith(".lock"); })) throw failure("GIT_RESULT_INVALID");
		return value;
	}
	/* Each record starts with its separator, so the newline git appends per record is unambiguous. */
	function splitRecords(raw, limit) {
		const parts = raw.length === 0 ? [] : raw.split("\u001e");
		if (parts.length > 0 && parts[0] === "") parts.shift();
		if (parts.length > limit) throw failure("RESULT_TOO_LARGE");
		return parts.map(function (part) { return part.endsWith("\n") ? part.slice(0, -1) : part; });
	}
	function splitLines(raw, limit) {
		const parts = raw.length === 0 ? [] : raw.split("\n");
		if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
		if (parts.length > limit) throw failure("RESULT_TOO_LARGE");
		return parts;
	}
	function fieldList(text, expect) { const parts = text.split("\u001f"); if (parts.length !== expect) throw failure("GIT_RESULT_INVALID"); return parts; }
	async function objectType(ctx, oid) {
		const probe = await execute(ctx, ["cat-file", "-t", oid], 256, [1, 128]);
		if (probe.exitCode !== 0) throw failure("GIT_OBJECT_NOT_FOUND");
		return text(probe.bytes).trim();
	}
	/* hasMore comes from fetching exactly one record more than the caller asked for. */
	async function log(ctx, params) {
		const argv = ["log", "--format=\u001e%H\u001f%P\u001f%an\u001f%ae\u001f%at\u001f%s", "--max-count=" + String(params.maxCount + 1), "--skip=" + String(params.skip)];
		const list = splitRecords(text((await execute(ctx, argv, (params.maxCount + 1) * 2048)).bytes), params.maxCount + 1);
		const commits = [];
		for (const record of list.slice(0, params.maxCount)) {
			const fields = fieldList(record, 6), parents = fields[1] === "" ? [] : fields[1].split(" "), seconds = Number(fields[4]);
			if (parents.length > MAX_PARENTS || parents.some(function (parent) { return !HASH_PATTERN.test(parent); }) || !Number.isSafeInteger(seconds) || seconds < 0 || Buffer.byteLength(fields[5], "utf8") > MAX_SUBJECT || NAME_CONTROL.test(fields[5])) throw failure("GIT_RESULT_INVALID");
			commits.push({ oid: readHash(fields[0]), parents: parents, authorName: readName(fields[2], MAX_IDENTITY), authorEmail: readName(fields[3], MAX_IDENTITY), authorTimeSec: seconds, subject: fields[5] });
		}
		return { commits: commits, hasMore: list.length > params.maxCount };
	}
	/* One commit's changed files against its first parent, from diff-tree --name-status -z. */
	async function commitFiles(ctx, oid) {
		const raw = nulText((await execute(ctx, ["diff-tree", "--no-commit-id", "-r", "-z", "--name-status", "--find-renames", "--root", oid], MAX_DETAIL_FILES * 4096)).bytes);
		const tokens = raw.length === 0 ? [] : raw.split("\u0000");
		if (tokens.length > 0 && tokens[tokens.length - 1] === "") tokens.pop();
		const files = [];
		for (let index = 0; index < tokens.length; ) {
			const status = tokens[index++], renamed = status.charAt(0) === "R" || status.charAt(0) === "C";
			if (!/^(?:[AMDTUXB]|[RC]\d{1,3})$/.test(status) || index >= tokens.length) throw failure("GIT_RESULT_INVALID");
			const first = relative(tokens[index++]), second = renamed ? (index < tokens.length ? relative(tokens[index++]) : null) : null;
			if (renamed && second === null) throw failure("GIT_RESULT_INVALID");
			files.push(renamed ? { status: status, path: second, oldPath: first } : { status: status, path: first });
			if (files.length > MAX_DETAIL_FILES) throw failure("RESULT_TOO_LARGE");
		}
		return files;
	}
	/* Parsed from cat-file commit: the message is byte-exact, with no format terminator. */
	async function commitDetail(ctx, params) {
		const type = await objectType(ctx, params.oid);
		if (type !== "commit") throw failure("GIT_RESULT_INVALID");
		const raw = text((await execute(ctx, ["cat-file", "commit", params.oid], MAX_MESSAGE + 16384)).bytes), separator = raw.indexOf("\n\n");
		if (separator < 0) throw failure("GIT_RESULT_INVALID");
		const message = raw.slice(separator + 2);
		if (message.length > MAX_MESSAGE || BODY_CONTROL.test(message)) throw failure(BODY_CONTROL.test(message) ? "GIT_RESULT_INVALID" : "RESULT_TOO_LARGE");
		const subject = message.split("\n")[0];
		if (Buffer.byteLength(subject, "utf8") > MAX_SUBJECT || NAME_CONTROL.test(subject)) throw failure("GIT_RESULT_INVALID");
		const parents = [], people = {};
		let tree = null;
		for (const line of raw.slice(0, separator).split("\n")) {
			if (line.startsWith("parent ")) parents.push(readHash(line.slice(7)));
			else if (line.startsWith("tree ")) tree = readHash(line.slice(5));
			else if (line.startsWith("author ") || line.startsWith("committer ")) {
				const kind = line.startsWith("author ") ? "author" : "committer", parsed = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line.slice(kind.length + 1));
				if (!parsed) throw failure("GIT_RESULT_INVALID");
				people[kind] = { name: readName(parsed[1], MAX_IDENTITY), email: readName(parsed[2], MAX_IDENTITY), seconds: Number(parsed[3]) };
			}
		}
		if (tree === null || parents.length > MAX_PARENTS || !people.author || !people.committer) throw failure("GIT_RESULT_INVALID");
		for (const person of [people.author, people.committer]) if (!Number.isSafeInteger(person.seconds) || person.seconds < 0) throw failure("GIT_RESULT_INVALID");
		return { oid: params.oid, parents: parents, authorName: people.author.name, authorEmail: people.author.email, authorTimeSec: people.author.seconds, committerName: people.committer.name, committerEmail: people.committer.email, committerTimeSec: people.committer.seconds, subject: subject, message: message, files: await commitFiles(ctx, params.oid) };
	}
	/* Local branches and tags only: remote-tracking refs would imply a sync state this batch does not deliver. */
	async function refs(ctx) {
		const list = splitLines(text((await execute(ctx, ["for-each-ref", "--format=%(refname)\u001f%(objectname)\u001f%(*objectname)", "refs/heads", "refs/tags"], MAX_REFS * 2048)).bytes), MAX_REFS);
		const entries = [];
		for (const line of list) {
			const fields = fieldList(line, 3), fullName = fields[0], kind = fullName.startsWith("refs/heads/") ? "branch" : fullName.startsWith("refs/tags/") ? "tag" : null, name = kind === null ? "" : fullName.slice(kind === "branch" ? 11 : 10);
			if (kind === null || Buffer.byteLength(name, "utf8") > MAX_REF_NAME || NAME_CONTROL.test(name)) throw failure("GIT_RESULT_INVALID");
			/* An annotated tag points at a tag object; prefer the peeled commit a caller can use. */
			entries.push({ fullName: fullName, name: name, oid: fields[2] === "" ? readHash(fields[1]) : readHash(fields[2]), kind: kind });
		}
		const current = await head(ctx);
		return { head: current.head, branch: current.branch, refs: entries };
	}
	/* One file between two revisions: a missing side is empty, both missing is a refusal. */
	async function refFileDiff(ctx, params) {
		/* revision:path cannot address a colon-containing path; refused, not guessed. */
		if (params.path.includes(":")) throw failure("GIT_RESULT_INVALID");
		const side = async function (oid) {
			if (oid === null) return { present: false, content: "" };
			if ((await objectType(ctx, oid)) !== "commit") throw failure("GIT_RESULT_INVALID");
			const at = oid + ":" + params.path;
			/* Inside a commit, a path that is not in its tree answers 128, the same way -e answers 1 for a missing object. */
			return (await execute(ctx, ["cat-file", "-e", at], 256, [1, 128])).exitCode === 0 ? { present: true, content: await blob(ctx, at) } : { present: false, content: "" };
		};
		const original = await side(params.base), modified = await side(params.head);
		if (params.base !== null && !original.present && !modified.present) throw failure("GIT_RESOURCE_CHANGED");
		return { originalContent: original.content, modifiedContent: modified.content };
	}
	/* One full local ref to the commit it names: a missing ref is its own code, a non-commit target is not a ref this batch can compare. */
	async function resolveRef(ctx, value) {
		const probe = await execute(ctx, ["check-ref-format", value], 256, [1, 128]);
		if (probe.exitCode !== 0) throw failure("GIT_RESULT_INVALID");
		const resolved = await execute(ctx, ["rev-parse", "--verify", "--quiet", value + "^{commit}"], 256, [1, 128]);
		if (resolved.exitCode === 0) return readHash(text(resolved.bytes).trim());
		try { await objectType(ctx, value); } catch (error) { if (error && error.message === "GIT_OBJECT_NOT_FOUND") throw failure("GIT_REF_NOT_FOUND"); throw error; }
		throw failure("GIT_RESULT_INVALID");
	}
	/* Two refs, their trees, native diff; the OIDs travel with the answer so a later ref move cannot rewrite it. */
	async function compare(ctx, params) {
		const base = await resolveRef(ctx, params.base), head = await resolveRef(ctx, params.head);
		if (base === head) return { base: { ref: params.base, oid: base }, head: { ref: params.head, oid: head }, files: [] };
		const raw = nulText((await execute(ctx, ["diff", "--name-status", "-z", "--find-renames", "--no-ext-diff", "--no-textconv", base, head], MAX_STATUS)).bytes);
		const tokens = raw.length === 0 ? [] : raw.split("\u0000");
		if (tokens.length > 0 && tokens[tokens.length - 1] === "") tokens.pop();
		const files = [];
		for (let index = 0; index < tokens.length; ) {
			const status = tokens[index++], renamed = status.charAt(0) === "R" || status.charAt(0) === "C";
			if (!/^(?:[AMDTUXB]|[RC]\d{1,3})$/.test(status) || index >= tokens.length) throw failure("GIT_RESULT_INVALID");
			const first = relative(tokens[index++]);
			if (renamed) { if (index >= tokens.length) throw failure("GIT_RESULT_INVALID"); files.push({ status: status, path: relative(tokens[index++]), oldPath: first }); }
			else files.push({ status: status, path: first });
			if (files.length > MAX_RESOURCES) throw failure("RESULT_TOO_LARGE");
		}
		return { base: { ref: params.base, oid: base }, head: { ref: params.head, oid: head }, files: files };
	}

	/* Commit identity is read from the repository's own config chain (local wins over global) and never written. */
	async function configValue(ctx, key) {
		const result = await execute(ctx, ["config", "--get", key], 1024, [1]);
		if (result.exitCode !== 0) return null;
		const raw = text(result.bytes);
		return raw.endsWith("\n") ? raw.slice(0, -1) : raw;
	}
	async function commitIdentity(ctx) {
		const name = await configValue(ctx, "user.name"), email = await configValue(ctx, "user.email");
		for (const value of [name, email]) if (value === null || value.length === 0 || value.length > 320 || control.test(value) || value.indexOf("<") >= 0 || value.indexOf(">") >= 0) throw failure("GIT_COMMIT_IDENTITY_REQUIRED");
		return { name: name, email: email };
	}
	const committer = createGitCommitProgram(fs, { crypto: crypto, failure: failure, text: text, readFile: readFile, execute: execute, rawStatus: rawStatus, snapshot: snapshot, head: head }, { gates: writer.gates, entries: writer.entries, reaped: writer.reaped, fingerprint: writer.fingerprint }, commitIdentity);
	const branches = createGitBranchProgram(fs, { failure: failure, execute: execute, rawStatus: rawStatus, snapshot: snapshot, head: head, text: text }, writer.gates);
	/* Fixed journal identity for recovery commits: must stay equal to REMOTE_GIT_RECOVERY_IDENTITY in RemoteHelperContract.ts. */
	const discarder = createGitDiscardProgram(fs, { failure: failure, crypto: crypto, execute: execute, rawStatus: rawStatus, snapshot: snapshot, head: head, entries: writer.entries, readFile: readFile, belongs: belongs, fingerprint: writer.fingerprint, reaped: writer.reaped }, writer.gates, { name: "PiDeck recovery", email: "pideck-recovery@localhost" });
	const recovery = createGitRecoveryProgram(fs, { failure: failure, crypto: crypto, execute: execute, rawStatus: rawStatus, head: head, readFile: readFile, relative: relative, fingerprint: writer.fingerprint, reaped: writer.reaped }, writer.gates);
	const sync = createGitSyncProgram(fs, { failure: failure, execute: execute, rawStatus: rawStatus, head: head, snapshot: snapshot, fingerprint: writer.fingerprint, reaped: writer.reaped }, writer.gates);
	const inits = createGitInitProgram(fs, root, { failure: failure, execute: execute, head: head });
	async function run(ctx, params, repo) {
		ctx.check();
		if (process.platform !== "linux") throw failure("GIT_PLATFORM_UNSUPPORTED");
		if (root === null) throw failure("PATH_OUTSIDE_ROOT");
		const rootStats = fs.lstatSync(root, { bigint: true });
		if (!rootStats.isDirectory() || rootStats.isSymbolicLink() || fs.realpathSync(root) !== root) throw failure("GIT_RESOURCE_CHANGED");
		ctx.fd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
		ctx.cwd = "/proc/" + process.pid + "/fd/" + ctx.fd;
		ctx.rootIdentity = [rootStats.dev, rootStats.ino].map(String).join(":");
		const openedRoot = fs.fstatSync(ctx.fd, { bigint: true });
		if ([openedRoot.dev, openedRoot.ino].map(String).join(":") !== ctx.rootIdentity) throw failure("GIT_RESOURCE_CHANGED");
		/* Discovery runs before any repository exists: it only walks bounded directories and never executes Git. */
		if (params.method === "git.repos") return repositories(ctx);
		/* The one write that runs before a repository exists: it verifies its own preconditions instead of the .git checks below. */
		if (params.method === "git.init") { ctx.executable = executable(); ctx.env = environment(); return inits.run(ctx); }
		/* A non-empty scope is anchored from the root fd before the .git checks, so the whole request (read or write) targets that repository. */
		anchorRepository(ctx, repo);
		let gitStats;
		try { gitStats = fs.lstatSync(ctx.cwd + "/.git", { bigint: true }); } catch (error) { if (error.code === "ENOENT") throw failure("GIT_NOT_REPOSITORY"); throw error; }
		if (!gitStats.isDirectory() || gitStats.isSymbolicLink()) throw failure("GIT_UNSUPPORTED_REPOSITORY");
		ctx.gitIdentity = [gitStats.dev, gitStats.ino].map(String).join(":");
		await inspectMetadata(ctx);
		ctx.executable = executable(); ctx.env = environment();
		await validateConfiguration(ctx);
		const first = snapshot(ctx), firstHead = await head(ctx);
		if (params.method === "git.commit") return committer.run(ctx, params, first, firstHead);
		if (params.method === "git.createBranch" || params.method === "git.switchBranch") return branches.run(ctx, params, first, firstHead);
		if (params.method === "git.discard") return discarder.run(ctx, params, first, firstHead);
		if (params.method === "git.fetch") return sync.fetch(ctx, params, first, firstHead);
		if (params.method === "git.push") return sync.push(ctx, params, first, firstHead);
		if (params.method === "git.pull") return sync.pull(ctx, params, first, firstHead);
		if (params.method === "git.syncFacts") return unchangedRead(ctx, first, firstHead, sync.facts(ctx));
		if (params.method === "git.recoveryRestore" || params.method === "git.recoveryDrop") { params.expectedRevision = params.expectedRevision; return params.method === "git.recoveryRestore" ? recovery.restore(ctx, params, first, firstHead) : recovery.drop(ctx, params, first, firstHead); }
		if (params.method === "git.recoveryList") return unchangedRead(ctx, first, firstHead, recovery.list(ctx));
		if (params.method === "git.stage" || params.method === "git.unstage") return writer.run(ctx, params, first, firstHead);
		if (params.method === "git.log") return unchangedRead(ctx, first, firstHead, log(ctx, params));
		if (params.method === "git.commitDetail") return unchangedRead(ctx, first, firstHead, commitDetail(ctx, params));
		if (params.method === "git.refs") return unchangedRead(ctx, first, firstHead, refs(ctx));
		if (params.method === "git.refFileDiff") return unchangedRead(ctx, first, firstHead, refFileDiff(ctx, params));
		if (params.method === "git.compare") return unchangedRead(ctx, first, firstHead, compare(ctx, params));
		if (params.method === "git.checkIgnore") return unchangedRead(ctx, first, firstHead, checkIgnore(ctx, params));
		const status = await rawStatus(ctx);
		return unchangedRead(ctx, first, firstHead, params.method === "git.status" ? { status: status.bytes.toString("base64"), head: firstHead.head, branch: firstHead.branch, revision: writer.fingerprint(ctx, first, firstHead, status) } : readDiff(ctx, params, status, firstHead));
	}
	/* A read is published only while the identity it was answered from is still on disk. */
	async function unchangedRead(ctx, first, firstHead, work) {
		const result = await work, finalHead = await head(ctx);
		if (snapshot(ctx) !== first || finalHead.head !== firstHead.head || finalHead.branch !== firstHead.branch) throw failure("GIT_RESOURCE_CHANGED");
		ctx.check();
		return result;
	}
	function prepare(method, params, repo) {
		if (root === null) throw failure("PATH_OUTSIDE_ROOT");
		const repoPath = readRepo(repo);
		/* The read and write batches accept a repository scope; git.init and git.repos are root-only and refuse one before any Git child. */
		if (repoPath !== "" && !READ_REPO.has(method) && !WRITE_REPO.has(method)) throw failure("GIT_RESULT_INVALID");
		if (params === undefined) params = {};
		if (params === null || typeof params !== "object" || Array.isArray(params)) throw failure("GIT_RESULT_INVALID");
		const keys = Object.keys(params);
		if (method === "git.init" || method === "git.status" || method === "git.repos") { if (keys.length) throw failure("GIT_RESULT_INVALID"); return { method: method }; }
		if (method === "git.log") {
			if (keys.some(function (key) { return key !== "maxCount" && key !== "skip"; })) throw failure("GIT_RESULT_INVALID");
			const maxCount = params.maxCount === undefined ? LOG_DEFAULT : params.maxCount, skip = params.skip === undefined ? 0 : params.skip;
			if (!Number.isSafeInteger(maxCount) || maxCount < 1 || maxCount > MAX_LOG || !Number.isSafeInteger(skip) || skip < 0 || skip > MAX_SKIP) throw failure("GIT_RESULT_INVALID");
			return { method: method, maxCount: maxCount, skip: skip };
		}
		if (method === "git.commitDetail") { if (keys.length !== 1 || !keys.includes("oid")) throw failure("GIT_RESULT_INVALID"); return { method: method, oid: readHash(params.oid) }; }
		if (method === "git.refs") { if (keys.length) throw failure("GIT_RESULT_INVALID"); return { method: method }; }
		if (method === "git.checkIgnore") {
			/* Position-for-position: the answer is the same length and order as the request, so exactly one
			   field is allowed here and every entry is cleaned by the same relative-path rule as any other path. */
			if (keys.length !== 1 || !keys.includes("paths")) throw failure("GIT_RESULT_INVALID");
			const paths = params.paths;
			if (!Array.isArray(paths) || paths.length === 0 || paths.length > 64) throw failure("GIT_RESULT_INVALID");
			const read = [];
			for (let index = 0; index < paths.length; index += 1) {
				const cleaned = relative(paths[index]);
				/* A leading colon is a pathspec magic/revision expression; only check-ignore keeps magic on, so it is
				   refused here rather than trusted to stay literal. */
				if (cleaned.charAt(0) === ":") throw failure("PATH_OUTSIDE_ROOT");
				read.push(cleaned);
			}
			return { method: method, paths: read };
		}
		if (method === "git.refFileDiff") {
			if (keys.length !== 3 || !keys.includes("base") || !keys.includes("head") || !keys.includes("path")) throw failure("GIT_RESULT_INVALID");
			return { method: method, base: params.base === null ? null : readHash(params.base), head: readHash(params.head), path: relative(params.path) };
		}
		if (method === "git.compare") {
			if (keys.length !== 2 || !keys.includes("base") || !keys.includes("head")) throw failure("GIT_RESULT_INVALID");
			return { method: method, base: readRef(params.base), head: readRef(params.head) };
		}
		if (method === "git.recoveryList") { if (keys.length) throw failure("GIT_RESULT_INVALID"); return { method: method }; }
		if (method === "git.recoveryRestore") {
			if (keys.length !== 4 || !keys.includes("ref") || !keys.includes("oid") || !keys.includes("path") || !keys.includes("expectedRevision") || typeof params.ref !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(params.oid) || typeof params.expectedRevision !== "string" || !/^[0-9a-f]{64}$/.test(params.expectedRevision)) throw failure("GIT_RESULT_INVALID");
			return { method: method, ref: params.ref, oid: params.oid, path: relative(params.path), expectedRevision: params.expectedRevision };
		}
		if (method === "git.recoveryDrop") {
			if (keys.length !== 3 || !keys.includes("ref") || !keys.includes("oid") || !keys.includes("expectedRevision") || typeof params.ref !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(params.oid) || typeof params.expectedRevision !== "string" || !/^[0-9a-f]{64}$/.test(params.expectedRevision)) throw failure("GIT_RESULT_INVALID");
			return { method: method, ref: params.ref, oid: params.oid, expectedRevision: params.expectedRevision };
		}
		if (method === "git.syncFacts") { if (keys.length) throw failure("GIT_RESULT_INVALID"); return { method: method }; }
		if (method === "git.fetch") {
			if (keys.length !== 2 || !keys.includes("remote") || !keys.includes("expectedRevision") || typeof params.remote !== "string" || typeof params.expectedRevision !== "string" || !/^[0-9a-f]{64}$/.test(params.expectedRevision)) throw failure("GIT_RESULT_INVALID");
			return { method: method, remote: params.remote, expectedRevision: params.expectedRevision };
		}
		if (method === "git.push" || method === "git.pull") {
			if (keys.length !== 3 || !keys.includes("remote") || !keys.includes("branch") || !keys.includes("expectedRevision") || typeof params.remote !== "string" || typeof params.branch !== "string" || typeof params.expectedRevision !== "string" || !/^[0-9a-f]{64}$/.test(params.expectedRevision)) throw failure("GIT_RESULT_INVALID");
			return { method: method, remote: params.remote, branch: params.branch, expectedRevision: params.expectedRevision };
		}
		if (method === "git.discard") {
			if (keys.length !== 3 || !keys.includes("path") || !keys.includes("group") || !keys.includes("expectedRevision") || !["workingTree", "untracked"].includes(params.group) || typeof params.expectedRevision !== "string" || !/^[0-9a-f]{64}$/.test(params.expectedRevision)) throw failure("GIT_RESULT_INVALID");
			return { method: method, path: relative(params.path), group: params.group, expectedRevision: params.expectedRevision };
		}
		if (method === "git.createBranch" || method === "git.switchBranch") {
			if (keys.length !== 2 || !keys.includes("name") || !keys.includes("expectedHead") || (params.expectedHead !== null && (typeof params.expectedHead !== "string" || !HASH_PATTERN.test(params.expectedHead)))) throw failure("GIT_RESULT_INVALID");
			return { method: method, name: params.name, expectedHead: params.expectedHead };
		}
		if (method === "git.commit") {
			if (keys.length !== 2 || !keys.includes("message") || !keys.includes("expectedRevision") || typeof params.message !== "string" || params.message.indexOf("\u0000") >= 0 || Buffer.byteLength(params.message, "utf8") > 4096 || typeof params.expectedRevision !== "string" || !/^[0-9a-f]{64}$/.test(params.expectedRevision)) throw failure("GIT_RESULT_INVALID");
			return { method: method, message: params.message, expectedRevision: params.expectedRevision };
		}
		if (method === "git.stage" || method === "git.unstage") {
			if (keys.length !== 3 || !keys.includes("path") || !keys.includes("group") || !keys.includes("expectedRevision") || typeof params.expectedRevision !== "string" || !/^[0-9a-f]{64}$/.test(params.expectedRevision) || !(method === "git.unstage" ? params.group === "index" : ["workingTree", "untracked"].includes(params.group))) throw failure("GIT_RESULT_INVALID");
			return { method: method, path: relative(params.path), group: params.group, expectedRevision: params.expectedRevision };
		}
		if (keys.length !== 2 || !keys.includes("path") || !keys.includes("group") || !["merge", "index", "workingTree", "untracked"].includes(params.group)) throw failure("GIT_RESULT_INVALID");
		return { method: method, path: relative(params.path), group: params.group };
	}
	function start(params, deadline, done, repo) {
		const ctx = { children: new Set(), rejectors: new Set(), fd: null, repoFd: null, stopped: null };
		ctx.check = function () { if (ctx.stopped !== null) throw failure(ctx.stopped); if (Date.now() >= deadline) throw failure("REQUEST_TIMEOUT"); };
		ctx.abort = function (reason) { if (ctx.stopped !== null) return; ctx.stopped = reason; for (const reject of Array.from(ctx.rejectors)) reject(reason); for (const child of ctx.children) kill(child); };
		scopes.add(ctx);
		const timer = setTimeout(function () { ctx.abort("REQUEST_TIMEOUT"); }, Math.max(1, deadline - Date.now()));
		Promise.resolve().then(function () { return run(ctx, params, repo); }).then(function (result) { done(null, result); }, function (error) { done(code(error)); }).finally(function () {
			clearTimeout(timer); for (const child of ctx.children) kill(child); if (ctx.repoFd !== null) { try { fs.closeSync(ctx.repoFd); } catch {} } if (ctx.fd !== null) { try { fs.closeSync(ctx.fd); } catch {} } scopes.delete(ctx);
		}).catch(function () { /* A transport shutdown cannot receive another terminal outcome. */ });
		return function () { ctx.abort("REQUEST_CANCELLED"); };
	}
	return { prepare: prepare, start: start, close: function () { for (const ctx of scopes) ctx.abort("REMOTE_CONNECTION_LOST"); } };
}`.replace(/\r?\n[\t ]*/g, "");
