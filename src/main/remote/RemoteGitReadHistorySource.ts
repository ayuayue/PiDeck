/**
 * 冻结 Git worker 的「历史 / 比较 / 暂存 diff」半段，与 `RemoteGitReadSource.ts` 拼成同一份 git-read.mjs。
 *
 * 拆开的只是 **TypeScript 的持有方式**（文件体量门禁）：两段拼接后再做同一份换行归一，产物字节不变，
 * `REMOTE_HELPER_GIT_READ_SHA256` 仍指同一串内容。改这里的任何字符都会让摘要对不上。
 */
export const REMOTE_GIT_READ_HISTORY_SOURCE = String.raw`	/* G3a read-only history: log, commit detail, local refs, one file between two revisions. */
	const MAX_LOG = 100, LOG_DEFAULT = 50, MAX_SKIP = 100000, MAX_PARENTS = 8, MAX_REFS = 512, MAX_REF_NAME = 1024, MAX_SUBJECT = 1024, MAX_DETAIL_FILES = 512, MAX_MESSAGE = 65536, MAX_IDENTITY = 320;
	/* Text bound of the staged diff the AI summary reads; the child is stopped once the answer is provably past it. */
	const MAX_STAGED_DIFF = 102400;
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
	/* The filter (one full ref, --all, or HEAD) is spelled once, so the page and its count cannot disagree. */
	function logFilter(params) { return params.ref !== null ? [params.ref] : params.all ? ["--all"] : ["HEAD"]; }
	/* hasMore comes from fetching exactly one record more than the caller asked for; total only when it was asked for. */
	async function log(ctx, params) {
		const argv = ["log", "--format=\u001e%H\u001f%P\u001f%an\u001f%ae\u001f%at\u001f%s", "--max-count=" + String(params.maxCount + 1), "--skip=" + String(params.skip)].concat(logFilter(params));
		const list = splitRecords(text((await execute(ctx, argv, (params.maxCount + 1) * 2048)).bytes), params.maxCount + 1);
		const commits = [];
		for (const record of list.slice(0, params.maxCount)) {
			const fields = fieldList(record, 6), parents = fields[1] === "" ? [] : fields[1].split(" "), seconds = Number(fields[4]);
			if (parents.length > MAX_PARENTS || parents.some(function (parent) { return !HASH_PATTERN.test(parent); }) || !Number.isSafeInteger(seconds) || seconds < 0 || Buffer.byteLength(fields[5], "utf8") > MAX_SUBJECT || NAME_CONTROL.test(fields[5])) throw failure("GIT_RESULT_INVALID");
			commits.push({ oid: readHash(fields[0]), parents: parents, authorName: readName(fields[2], MAX_IDENTITY), authorEmail: readName(fields[3], MAX_IDENTITY), authorTimeSec: seconds, subject: fields[5] });
		}
		if (!params.withCount) return { commits: commits, hasMore: list.length > params.maxCount };
		const total = Number(text((await execute(ctx, ["rev-list", "--count"].concat(logFilter(params)), 64)).bytes).trim());
		if (!Number.isSafeInteger(total) || total < 0) throw failure("GIT_RESULT_INVALID");
		return { commits: commits, hasMore: list.length > params.maxCount, total: total };
	}
	/* --name-status -z records: a status, then one path, or the old and the new path for a rename/copy. */
	function nameStatusFiles(raw, limit) {
		const tokens = raw.length === 0 ? [] : raw.split("\u0000");
		if (tokens.length > 0 && tokens[tokens.length - 1] === "") tokens.pop();
		const files = [];
		for (let index = 0; index < tokens.length; ) {
			const status = tokens[index++], renamed = status.charAt(0) === "R" || status.charAt(0) === "C";
			if (!/^(?:[AMDTUXB]|[RC]\d{1,3})$/.test(status) || index >= tokens.length) throw failure("GIT_RESULT_INVALID");
			const first = relative(tokens[index++]), second = renamed ? (index < tokens.length ? relative(tokens[index++]) : null) : null;
			if (renamed && second === null) throw failure("GIT_RESULT_INVALID");
			files.push(renamed ? { status: status, path: second, oldPath: first } : { status: status, path: first });
			if (files.length > limit) throw failure("RESULT_TOO_LARGE");
		}
		return files;
	}
	/* diff-tree prints one output format per run (the last flag wins), so the numbers are a second pass over the same commit. */
	async function commitNumbers(ctx, oid) {
		const raw = nulText((await execute(ctx, ["diff-tree", "--no-commit-id", "-r", "-z", "--numstat", "--find-renames", "--root", oid], MAX_DETAIL_FILES * 4096)).bytes);
		const tokens = raw.length === 0 ? [] : raw.split("\u0000");
		if (tokens.length > 0 && tokens[tokens.length - 1] === "") tokens.pop();
		const numbers = [];
		for (let index = 0; index < tokens.length; index += 1) {
			const record = tokens[index], first = record.indexOf("\t"), second = record.indexOf("\t", first + 1);
			if (first < 0 || second < 0) throw failure("GIT_RESULT_INVALID");
			const added = record.slice(0, first), deleted = record.slice(first + 1, second), tail = record.slice(second + 1);
			/* '-' is numstat's own answer for a binary record: the count is absent, never a made-up zero. */
			if (!/^(?:\d+|-)$/.test(added) || !/^(?:\d+|-)$/.test(deleted) || (added === "-") !== (deleted === "-")) throw failure("GIT_RESULT_INVALID");
			/* A -z rename record carries no path of its own; the old and the new path are the following fields. */
			let path = tail, oldPath = null;
			if (tail === "") { if (index + 2 >= tokens.length) throw failure("GIT_RESULT_INVALID"); oldPath = relative(tokens[++index]); path = tokens[++index]; }
			numbers.push({ path: relative(path), oldPath: oldPath, additions: added === "-" ? null : Number(added), deletions: deleted === "-" ? null : Number(deleted) });
			if (numbers.length > MAX_DETAIL_FILES) throw failure("RESULT_TOO_LARGE");
		}
		return numbers;
	}
	/* One commit's changed files against its first parent: names from one pass, line counts from the other, joined in order. */
	async function commitFiles(ctx, oid) {
		const files = nameStatusFiles(nulText((await execute(ctx, ["diff-tree", "--no-commit-id", "-r", "-z", "--name-status", "--find-renames", "--root", oid], MAX_DETAIL_FILES * 4096)).bytes), MAX_DETAIL_FILES);
		const numbers = await commitNumbers(ctx, oid);
		if (numbers.length !== files.length) throw failure("GIT_RESULT_INVALID");
		for (let index = 0; index < files.length; index += 1) {
			const file = files[index], number = numbers[index];
			if (file.path !== number.path || (file.oldPath || null) !== number.oldPath) throw failure("GIT_RESULT_INVALID");
			if (number.additions !== null && (!Number.isSafeInteger(number.additions) || !Number.isSafeInteger(number.deletions))) throw failure("GIT_RESULT_INVALID");
			if (number.additions !== null) { file.additions = number.additions; file.deletions = number.deletions; }
		}
		return files;
	}
	/* shortStat sums only the counts that were read, so a binary-only commit reports 0/0 instead of pretending. */
	function shortStatOf(files) {
		const stat = { files: files.length, insertions: 0, deletions: 0 };
		for (const file of files) if (file.additions !== undefined) { stat.insertions += file.additions; stat.deletions += file.deletions; }
		return stat;
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
		const files = await commitFiles(ctx, params.oid);
		return { oid: params.oid, parents: parents, authorName: people.author.name, authorEmail: people.author.email, authorTimeSec: people.author.seconds, committerName: people.committer.name, committerEmail: people.committer.email, committerTimeSec: people.committer.seconds, subject: subject, message: message, files: files, shortStat: shortStatOf(files) };
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
		if (params.mode === "threeDot") return compareThreeDot(ctx, params, base, head);
		if (base === head) return { base: { ref: params.base, oid: base }, head: { ref: params.head, oid: head }, files: [] };
		const raw = nulText((await execute(ctx, ["diff", "--name-status", "-z", "--find-renames", "--no-ext-diff", "--no-textconv", base, head], MAX_STATUS)).bytes);
		return { base: { ref: params.base, oid: base }, head: { ref: params.head, oid: head }, files: nameStatusFiles(raw, MAX_RESOURCES) };
	}
	/* Three-dot: the merge base is resolved once, the counts are Git's left/right answer and the files are the ADMR set local compare uses. */
	async function compareThreeDot(ctx, params, base, head) {
		const shared = await execute(ctx, ["merge-base", base, head], 256, [1]);
		/* Unrelated histories have no common ancestor: there is no three-dot answer, and an empty list would fake one. */
		if (shared.exitCode !== 0) throw failure("GIT_RESULT_INVALID");
		const mergeBase = readHash(text(shared.bytes).trim());
		const parts = text((await execute(ctx, ["rev-list", "--left-right", "--count", base + "..." + head], 256)).bytes).trim().split(/\s+/);
		if (parts.length !== 2) throw failure("GIT_RESULT_INVALID");
		const behind = Number(parts[0]), ahead = Number(parts[1]);
		if (!Number.isSafeInteger(behind) || behind < 0 || !Number.isSafeInteger(ahead) || ahead < 0) throw failure("GIT_RESULT_INVALID");
		const raw = nulText((await execute(ctx, ["diff", "--name-status", "-z", "--diff-filter=ADMR", "--find-renames", "--no-ext-diff", "--no-textconv", base + "..." + head], MAX_STATUS)).bytes);
		return { mode: "merge-base", mergeBase: mergeBase, base: { ref: params.base, oid: base }, head: { ref: params.head, oid: head }, ahead: ahead, behind: behind, files: nameStatusFiles(raw, MAX_RESOURCES) };
	}
	/* Staged text for the AI summary: the same argv as the local read, stopped once the answer is provably past the bound. */
	async function stagedDiff(ctx) {
		const result = await execute(ctx, ["diff", "--staged", "--unified=3", "--no-color", "--no-ext-diff"], MAX_STAGED_DIFF * 8, undefined, undefined, MAX_STAGED_DIFF * 4);
		const value = new TextDecoder("utf-8", { ignoreBOM: true }).decode(result.bytes);
		if (value.includes("\u0000")) throw failure("GIT_NOT_TEXT");
		return { diff: result.cut || value.length > MAX_STAGED_DIFF ? value.slice(0, MAX_STAGED_DIFF) + "\n\n... (diff truncated)" : value };
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
	const history = createGitHistoryProgram(fs, { failure: failure, execute: execute, rawStatus: rawStatus, snapshot: snapshot, head: head }, writer.gates, commitIdentity);
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
		if (params.method === "git.cherryPick" || params.method === "git.revert" || params.method === "git.reset" || params.method === "git.drop") return history.run(ctx, params, first, firstHead);
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
		if (params.method === "git.stagedDiff") return unchangedRead(ctx, first, firstHead, stagedDiff(ctx));
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
			if (keys.some(function (key) { return key !== "maxCount" && key !== "skip" && key !== "ref" && key !== "all" && key !== "withCount"; })) throw failure("GIT_RESULT_INVALID");
			const maxCount = params.maxCount === undefined ? LOG_DEFAULT : params.maxCount, skip = params.skip === undefined ? 0 : params.skip;
			if (!Number.isSafeInteger(maxCount) || maxCount < 1 || maxCount > MAX_LOG || !Number.isSafeInteger(skip) || skip < 0 || skip > MAX_SKIP) throw failure("GIT_RESULT_INVALID");
			/* One full ref or the whole local history, never both; either switch is optional and a non-boolean is refused. */
			const ref = params.ref === undefined ? null : readRef(params.ref), all = params.all === undefined ? false : params.all, withCount = params.withCount === undefined ? false : params.withCount;
			if (typeof all !== "boolean" || typeof withCount !== "boolean" || (ref !== null && all)) throw failure("GIT_RESULT_INVALID");
			return { method: method, maxCount: maxCount, skip: skip, ref: ref, all: all, withCount: withCount };
		}
		if (method === "git.commitDetail") { if (keys.length !== 1 || !keys.includes("oid")) throw failure("GIT_RESULT_INVALID"); return { method: method, oid: readHash(params.oid) }; }
		if (method === "git.refs") { if (keys.length) throw failure("GIT_RESULT_INVALID"); return { method: method }; }
		if (method === "git.stagedDiff") { if (keys.length) throw failure("GIT_RESULT_INVALID"); return { method: method }; }
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
			if (!keys.includes("base") || !keys.includes("head") || keys.some(function (key) { return key !== "base" && key !== "head" && key !== "mode"; })) throw failure("GIT_RESULT_INVALID");
			const mode = params.mode === undefined ? "trees" : params.mode;
			if (mode !== "trees" && mode !== "threeDot") throw failure("GIT_RESULT_INVALID");
			return { method: method, base: readRef(params.base), head: readRef(params.head), mode: mode };
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
			/* Upstream mode: remote and branch are both null (follow the configured upstream / push.default), or both named. */
			if (keys.length !== 3 || !keys.includes("remote") || !keys.includes("branch") || !keys.includes("expectedRevision") || (params.remote === null) !== (params.branch === null)) throw failure("GIT_RESULT_INVALID");
			if (params.remote !== null && (typeof params.remote !== "string" || params.remote.length === 0 || params.remote.length > 128)) throw failure("GIT_RESULT_INVALID");
			if (params.branch !== null && (typeof params.branch !== "string" || params.branch.length === 0 || params.branch.length > 1024)) throw failure("GIT_RESULT_INVALID");
			if (typeof params.expectedRevision !== "string" || !/^[0-9a-f]{64}$/.test(params.expectedRevision)) throw failure("GIT_RESULT_INVALID");
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
		Promise.resolve().then(function () { return run(ctx, params, repo); }).then(function (result) { done(null, result); }, function (error) { done(code(error), null, error && typeof error.detail === "string" ? error.detail : undefined); }).finally(function () {
			clearTimeout(timer); for (const child of ctx.children) kill(child); if (ctx.repoFd !== null) { try { fs.closeSync(ctx.repoFd); } catch {} } if (ctx.fd !== null) { try { fs.closeSync(ctx.fd); } catch {} } scopes.delete(ctx);
		}).catch(function () { /* A transport shutdown cannot receive another terminal outcome. */ });
		return function () { ctx.abort("REQUEST_CANCELLED"); };
	}
	return { prepare: prepare, start: start, close: function () { for (const ctx of scopes) ctx.abort("REMOTE_CONNECTION_LOST"); } };
}`;
