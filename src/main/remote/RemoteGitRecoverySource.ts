export const REMOTE_GIT_RECOVERY_SOURCE = String.raw`/* G4b recovery store. The snapshots G4a wrote are listed, restored and (only explicitly) dropped here. Listing is
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
`;
