/**
 * Frozen remote upload-commit scope, deployed as upload-commit.mjs and imported by helper.mjs.
 *
 * The SFTP executor may write only to `<deployRoot>/upload-spool/<32hex>.part`. This artifact owns the
 * one-use prepare/commit token and publishes that spool file either create-only or as a compare-and-swap
 * replacement of the revision the caller read: Linux procfs anchors the already-open target directory,
 * O_NOFOLLOW prevents link traversal, a 0600 sibling receives an exact size/hash copy, a hard link is the
 * create-only publish and a rename is the replacement, and every failure after publish is reported as
 * unconfirmed. Same-user staging names are reserved, not treated as user files.
 */

export const REMOTE_UPLOAD_COMMIT_FILE_NAME = "upload-commit.mjs";

export const REMOTE_UPLOAD_COMMIT_SOURCE = String.raw`"use strict";
export function createUploadCommitScope(root, deployRoot, fs, path, crypto) {
	const TTL_MS = 120000, MAX_PENDING = 64, MAX_BYTES = 8589934592, COPY_CHUNK = 1048576;
	const HASH = /^[0-9a-f]{64}$/, REF = /^[0-9a-f]{32}$/, CONTROL = /[\u0000-\u001f\u007f]/;
	const DIGITS = /^[0-9]{1,40}$/, EXPECTED_KEYS = ["mode", "size", "dev", "ino", "uid", "gid", "mtimeNs", "ctimeNs", "digest"];
	const CREATE_KEYS = ["uploadId", "path", "policy", "size", "sha256"], REPLACE_KEYS = ["uploadId", "path", "policy", "size", "sha256", "expected"];
	const WINDOWS_DRIVE = /^[A-Za-z]:/, ENCODED_SEPARATOR = /%2e|%2f|%5c/i;
	const RESERVED = /^\.[0-9a-f]{32}\.pideck-put$/;
	const pending = new Map();
	const C = fs.constants;
	const O_READ = C.O_RDONLY;
	const O_WRITE = C.O_WRONLY;
	const O_CREATE = C.O_CREAT;
	const O_EXCL = C.O_EXCL;
	const O_NOFOLLOW = C.O_NOFOLLOW;
	const O_DIRECTORY = C.O_DIRECTORY;
	const READ_DIR = O_READ | O_DIRECTORY | O_NOFOLLOW;
	const CREATE_FILE = O_WRITE | O_CREATE | O_EXCL | O_NOFOLLOW;
	function failure(code) { const error = new Error(code); error.uploadCode = code; return error; }
	function isRecord(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
	function hasExactKeys(value, keys) {
		if (isRecord(value) === false || Object.keys(value).length !== keys.length) return false;
		for (const key of keys) if (Object.prototype.hasOwnProperty.call(value, key) === false) return false;
		return true;
	}
	function unsupported() {
		if (typeof deployRoot !== "string" || deployRoot.length === 0 || deployRoot.charAt(0) !== "/" || CONTROL.test(deployRoot)) return true;
		if (process.platform !== "linux" || crypto === null || typeof process.getuid !== "function" || typeof process.getgid !== "function") return true;
		if (typeof O_NOFOLLOW !== "number" || typeof O_DIRECTORY !== "number") return true;
		try { return fs.statSync("/proc/self/fd").isDirectory() !== true; } catch { return true; }
	}
	function rootStamp() {
		if (unsupported()) throw failure("FILE_UPLOAD_UNSUPPORTED");
		if (typeof root !== "string" || root.length === 0 || root.charAt(0) !== "/" || CONTROL.test(root)) throw failure("FILE_UPLOAD_ROOT_CHANGED");
		try {
			if (fs.realpathSync(root) !== root) throw failure("FILE_UPLOAD_ROOT_CHANGED");
			const stats = fs.statSync(root, { bigint: true });
			if (stats.isDirectory() !== true) throw failure("FILE_UPLOAD_ROOT_CHANGED");
			return { dev: String(stats.dev), ino: String(stats.ino) };
		} catch (error) {
			if (error !== null && error.uploadCode !== undefined) throw error;
			throw failure("FILE_UPLOAD_ROOT_CHANGED");
		}
	}
	function readRelative(value) {
		if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 4096 || CONTROL.test(value)) throw failure("FILE_UPLOAD_INPUT_INVALID");
		if (value.charAt(0) === "/" || value.indexOf("\\") >= 0 || WINDOWS_DRIVE.test(value) || ENCODED_SEPARATOR.test(value)) throw failure("FILE_UPLOAD_INPUT_INVALID");
		const segments = value.split("/");
		for (const segment of segments) {
			if (segment === "" || segment === "." || segment === "..") throw failure("FILE_UPLOAD_INPUT_INVALID");
		}
		if (segments[0] === ".pideck-trash" || RESERVED.test(segments[segments.length - 1])) throw failure("FILE_UPLOAD_INPUT_INVALID");
		const absolute = path.resolve(root, value);
		if (absolute !== root && absolute.startsWith(root + path.sep) === false) throw failure("FILE_UPLOAD_PATH_INVALID");
		return { relative: value, segments: segments };
	}
	function readExpected(value) {
		if (hasExactKeys(value, EXPECTED_KEYS) === false) throw failure("FILE_UPLOAD_INPUT_INVALID");
		if (Number.isInteger(value.mode) === false || value.mode < 0 || value.mode > 4095 || Number.isSafeInteger(value.size) === false || value.size < 0 || value.size > MAX_BYTES || typeof value.digest !== "string" || HASH.test(value.digest) === false) throw failure("FILE_UPLOAD_INPUT_INVALID");
		for (const key of ["dev", "ino", "uid", "gid", "mtimeNs", "ctimeNs"]) {
			if (typeof value[key] !== "string" || DIGITS.test(value[key]) === false) throw failure("FILE_UPLOAD_INPUT_INVALID");
		}
		return { mode: value.mode, size: value.size, dev: value.dev, ino: value.ino, uid: value.uid, gid: value.gid, mtimeNs: value.mtimeNs, ctimeNs: value.ctimeNs, digest: value.digest };
	}
	function readUploadBody(params) {
		if (typeof params.uploadId !== "string" || REF.test(params.uploadId) === false || Number.isSafeInteger(params.size) === false || params.size < 0 || params.size > MAX_BYTES || typeof params.sha256 !== "string" || HASH.test(params.sha256) === false) throw failure("FILE_UPLOAD_INPUT_INVALID");
		return { uploadId: params.uploadId, size: params.size, sha256: params.sha256 };
	}
	function readPrepare(params) {
		const replace = isRecord(params) === true && params.policy === "replace";
		if (hasExactKeys(params, replace ? REPLACE_KEYS : CREATE_KEYS) === false) throw failure("FILE_UPLOAD_INPUT_INVALID");
		const common = readUploadBody(params);
		if (replace === false && params.policy !== "create") throw failure("FILE_UPLOAD_INPUT_INVALID");
		return { uploadId: common.uploadId, target: readRelative(params.path), size: common.size, sha256: common.sha256, policy: replace ? "replace" : "create", expected: replace ? requireOwnRevision(readExpected(params.expected)) : null };
	}
	/* The caller must be the owner the replacement will keep: a rename would otherwise hand a foreign file to this account. */
	function requireOwnRevision(expected) {
		if (typeof process.getuid !== "function" || typeof process.getgid !== "function" || expected.uid !== String(process.getuid()) || expected.gid !== String(process.getgid())) throw failure("PERMISSION_DENIED");
		return expected;
	}
	function readCommit(params) {
		if (hasExactKeys(params, ["uploadId", "token"]) === false || typeof params.uploadId !== "string" || REF.test(params.uploadId) === false || typeof params.token !== "string" || REF.test(params.token) === false) throw failure("FILE_UPLOAD_INPUT_INVALID");
		return { uploadId: params.uploadId, token: params.token };
	}
	function procPath(directoryFd, name) { return "/proc/self/fd/" + String(directoryFd) + "/" + name; }
	function close(descriptor) { if (descriptor === null) return; try { fs.closeSync(descriptor); } catch {} }
	function openRootDirectory() {
		let descriptor = null;
		try { descriptor = fs.openSync(root, READ_DIR); } catch { throw failure("FILE_UPLOAD_ROOT_CHANGED"); }
		try {
			const opened = fs.fstatSync(descriptor, { bigint: true });
			if (opened.isDirectory() !== true) throw failure("FILE_UPLOAD_ROOT_CHANGED");
			return descriptor;
		} catch (error) {
			close(descriptor);
			if (error !== null && error.uploadCode !== undefined) throw error;
			throw failure("FILE_UPLOAD_ROOT_CHANGED");
		}
	}
	function openParent(target) {
		let current = openRootDirectory();
		try {
			for (let index = 0; index < target.segments.length - 1; index += 1) {
				let next = null;
				try { next = fs.openSync(procPath(current, target.segments[index]), READ_DIR); }
				catch { throw failure("FILE_UPLOAD_PATH_INVALID"); }
				close(current);
				current = next;
			}
			return current;
		} catch (error) {
			close(current);
			if (error !== null && error.uploadCode !== undefined) throw error;
			throw failure("FILE_UPLOAD_PATH_INVALID");
		}
	}
	function targetName(target) { return target.segments[target.segments.length - 1]; }
	function targetPath(parentFd, target) { return procPath(parentFd, targetName(target)); }
	function requireAbsent(parentFd, target) {
		try {
			fs.lstatSync(targetPath(parentFd, target));
			throw failure("FILE_UPLOAD_TARGET_EXISTS");
		} catch (error) {
			if (error !== null && error.uploadCode !== undefined) throw error;
			const code = error !== null && typeof error === "object" ? error.code : "";
			if (code === "ENOENT") return;
			if (code === "ELOOP" || code === "ENOTDIR") throw failure("FILE_UPLOAD_PATH_INVALID");
			if (code === "EACCES" || code === "EPERM" || code === "EROFS") throw failure("PERMISSION_DENIED");
			throw failure("IO_ERROR");
		}
	}
	function spoolDirectory() { return deployRoot + "/upload-spool"; }
	function verifySpoolDirectory(directory) {
		let stats = null;
		try { stats = fs.lstatSync(directory); } catch (error) {
			const code = error !== null && typeof error === "object" ? error.code : "";
			if (code !== "ENOENT") throw failure("FILE_UPLOAD_STAGE_INVALID");
			try { fs.mkdirSync(directory, { mode: 448 }); fs.chmodSync(directory, 448); stats = fs.lstatSync(directory); }
			catch { throw failure("FILE_UPLOAD_STAGE_INVALID"); }
		}
		if (stats.isDirectory() !== true || stats.isSymbolicLink() === true || stats.uid !== process.getuid()) throw failure("FILE_UPLOAD_STAGE_INVALID");
		if ((stats.mode & 448) !== 448 || (stats.mode & 63) !== 0) {
			try { fs.chmodSync(directory, 448); stats = fs.lstatSync(directory); } catch { throw failure("FILE_UPLOAD_STAGE_INVALID"); }
		}
		if (stats.isDirectory() !== true || stats.isSymbolicLink() === true || stats.uid !== process.getuid() || (stats.mode & 448) !== 448 || (stats.mode & 63) !== 0) throw failure("FILE_UPLOAD_STAGE_INVALID");
	}
	function openSpoolDirectory() {
		const directory = spoolDirectory();
		verifySpoolDirectory(directory);
		try {
			const descriptor = fs.openSync(directory, READ_DIR);
			const stats = fs.fstatSync(descriptor);
			if (stats.isDirectory() !== true || stats.uid !== process.getuid()) {
				close(descriptor);
				throw failure("FILE_UPLOAD_STAGE_INVALID");
			}
			return descriptor;
		} catch (error) {
			if (error !== null && error.uploadCode !== undefined) throw error;
			throw failure("FILE_UPLOAD_STAGE_INVALID");
		}
	}
	function stageName(uploadId) { return uploadId + ".part"; }
	function verifyNoStage(spoolFd, uploadId) {
		try { fs.lstatSync(procPath(spoolFd, stageName(uploadId))); throw failure("FILE_UPLOAD_STAGE_INVALID"); }
		catch (error) {
			if (error !== null && error.uploadCode !== undefined) throw error;
			const code = error !== null && typeof error === "object" ? error.code : "";
			if (code !== "ENOENT") throw failure("FILE_UPLOAD_STAGE_INVALID");
		}
	}
	function unlinkAnchored(directoryFd, name) {
		try { fs.unlinkSync(procPath(directoryFd, name)); return true; }
		catch (error) {
			const code = error !== null && typeof error === "object" ? error.code : "";
			return code === "ENOENT";
		}
	}
	function cleanupStage(uploadId) {
		let spoolFd = null;
		try { spoolFd = openSpoolDirectory(); return unlinkAnchored(spoolFd, stageName(uploadId)); }
		catch { return false; }
		finally { close(spoolFd); }
	}
	function sweep(now) {
		for (const [uploadId, record] of pending) {
			if (record.expiresAt > now) continue;
			pending.delete(uploadId);
			cleanupStage(record.uploadId);
		}
	}
	function prepare(params, identity) {
		const input = readPrepare(params);
		if (unsupported()) throw failure("FILE_UPLOAD_UNSUPPORTED");
		const now = Date.now(), stamp = rootStamp();
		sweep(now);
		if (pending.size >= MAX_PENDING) throw failure("TOO_MANY_REQUESTS");
		if (pending.has(input.uploadId)) throw failure("FILE_UPLOAD_TOKEN_INVALID");
		let parentFd = null, spoolFd = null;
		try {
			parentFd = openParent(input.target);
			if (input.expected === null) requireAbsent(parentFd, input.target);
			else requireRevision(parentFd, input.target, input.expected);
			spoolFd = openSpoolDirectory();
			verifyNoStage(spoolFd, input.uploadId);
		} finally {
			close(parentFd);
			close(spoolFd);
		}
		const token = crypto.randomBytes(16).toString("hex");
		pending.set(input.uploadId, {
			token: token,
			uploadId: input.uploadId,
			path: input.target.relative,
			policy: input.policy,
			expected: input.expected,
			size: input.size,
			sha256: input.sha256,
			stageRef: input.uploadId,
			hostId: identity.hostId,
			generation: identity.generation,
			rootDev: stamp.dev,
			rootIno: stamp.ino,
			expiresAt: now + TTL_MS
		});
		return { token: token, stageRef: input.uploadId, expiresAt: now + TTL_MS };
	}
	function sameRoot(record) {
		const stamp = rootStamp();
		if (stamp.dev !== record.rootDev || stamp.ino !== record.rootIno) throw failure("FILE_UPLOAD_ROOT_CHANGED");
	}
	function sourceSnapshot(stats) {
		return { dev: String(stats.dev), ino: String(stats.ino), size: String(stats.size), mtimeNs: String(stats.mtimeNs), ctimeNs: String(stats.ctimeNs), uid: Number(stats.uid), gid: Number(stats.gid) };
	}
	function sameSource(left, right) { return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs && left.uid === right.uid && left.gid === right.gid; }
	/* Compare-and-swap identity: every field the caller read is compared numerically, so a leading zero is the same number. */
	function sameRevision(stats, expected) {
		return Number(stats.mode & 4095n) === expected.mode && stats.size === BigInt(expected.size) && stats.dev === BigInt(expected.dev) && stats.ino === BigInt(expected.ino) && stats.uid === BigInt(expected.uid) && stats.gid === BigInt(expected.gid) && stats.mtimeNs === BigInt(expected.mtimeNs) && stats.ctimeNs === BigInt(expected.ctimeNs);
	}
	function hashDescriptor(descriptor, size) {
		const hash = crypto.createHash("sha256");
		const chunk = Buffer.allocUnsafe(Math.min(COPY_CHUNK, Math.max(1, size)));
		let offset = 0;
		while (offset < size) {
			const count = fs.readSync(descriptor, chunk, 0, Math.min(chunk.length, size - offset), offset);
			if (count <= 0) throw failure("FILE_UPLOAD_SOURCE_CHANGED");
			hash.update(chunk.subarray(0, count));
			offset += count;
		}
		return hash.digest("hex");
	}
	/* The revision the caller read, re-derived from the anchored parent: a missing, linked or different file is SOURCE_CHANGED. */
	function requireRevision(parentFd, target, expected) {
		let descriptor = null;
		try { descriptor = fs.openSync(targetPath(parentFd, target), O_READ | O_NOFOLLOW); }
		catch (error) {
			const code = error !== null && typeof error === "object" ? error.code : "";
			if (code === "EACCES" || code === "EPERM") throw failure("PERMISSION_DENIED");
			throw failure("FILE_UPLOAD_SOURCE_CHANGED");
		}
		try {
			const before = fs.fstatSync(descriptor, { bigint: true });
			if (before.isFile() !== true || sameRevision(before, expected) === false) throw failure("FILE_UPLOAD_SOURCE_CHANGED");
			if (hashDescriptor(descriptor, Number(before.size)) !== expected.digest) throw failure("FILE_UPLOAD_SOURCE_CHANGED");
			if (sameRevision(fs.fstatSync(descriptor, { bigint: true }), expected) === false) throw failure("FILE_UPLOAD_SOURCE_CHANGED");
		} finally { close(descriptor); }
	}
	function openStage(spoolFd, uploadId) {
		let descriptor = null;
		try { descriptor = fs.openSync(procPath(spoolFd, stageName(uploadId)), O_READ | O_NOFOLLOW); }
		catch { throw failure("FILE_UPLOAD_STAGE_INVALID"); }
		try {
			const stats = fs.fstatSync(descriptor, { bigint: true });
			if (stats.isFile() !== true) throw failure("FILE_UPLOAD_STAGE_INVALID");
			return { descriptor: descriptor, stats: sourceSnapshot(stats) };
		} catch (error) {
			close(descriptor);
			if (error !== null && error.uploadCode !== undefined) throw error;
			throw failure("FILE_UPLOAD_STAGE_INVALID");
		}
	}
	function copyAndHash(sourceFd, destinationFd, size, expected, deadlineAt) {
		const hash = crypto.createHash("sha256");
		const chunk = Buffer.allocUnsafe(Math.min(COPY_CHUNK, Math.max(1, size)));
		let offset = 0;
		while (offset < size) {
			if (deadlineAt > 0 && Date.now() > deadlineAt) throw failure("REQUEST_TIMEOUT");
			const count = fs.readSync(sourceFd, chunk, 0, Math.min(chunk.length, size - offset), offset);
			if (count <= 0) throw failure("FILE_UPLOAD_STAGE_INVALID");
			hash.update(chunk.subarray(0, count));
			let written = 0;
			while (written < count) {
				const amount = fs.writeSync(destinationFd, chunk, written, count - written, offset + written);
				if (amount <= 0) throw failure("IO_ERROR");
				written += amount;
			}
			offset += count;
		}
		const digest = hash.digest("hex");
		if (digest !== expected) throw failure("FILE_UPLOAD_STAGE_INVALID");
	}
	function revisionOf(stats) {
		return {
			mode: Number(stats.mode & 4095n),
			size: Number(stats.size),
			dev: String(stats.dev),
			ino: String(stats.ino),
			uid: String(stats.uid),
			gid: String(stats.gid),
			mtimeNs: String(stats.mtimeNs),
			ctimeNs: String(stats.ctimeNs)
		};
	}
	/* Create-only publishes with a hard link; a replacement renames over the target, after the CAS re-check upstream. */
	function publish(parentFd, tempName, target, replace) {
		try {
			if (replace) fs.renameSync(procPath(parentFd, tempName), targetPath(parentFd, target));
			else fs.linkSync(procPath(parentFd, tempName), targetPath(parentFd, target));
		} catch (error) {
			const code = error !== null && typeof error === "object" ? error.code : "";
			if (code === "EEXIST") throw failure("FILE_UPLOAD_TARGET_EXISTS");
			if (code === "EACCES" || code === "EPERM" || code === "EROFS") throw failure("PERMISSION_DENIED");
			throw failure("IO_ERROR");
		}
	}
	function commit(params, identity, deadlineAt) {
		const input = readCommit(params);
		const record = pending.get(input.uploadId);
		if (record === undefined || record.token !== input.token || record.hostId !== identity.hostId || record.generation !== identity.generation) throw failure("FILE_UPLOAD_TOKEN_INVALID");
		pending.delete(input.uploadId);
		if (record.expiresAt <= Date.now()) throw failure("FILE_UPLOAD_TOKEN_INVALID");
		let spoolFd = null, parentFd = null, sourceFd = null, tempFd = null, tempName = null, published = false;
		try {
			if (unsupported()) throw failure("FILE_UPLOAD_UNSUPPORTED");
			sameRoot(record);
			const target = readRelative(record.path);
			spoolFd = openSpoolDirectory();
			const stage = openStage(spoolFd, record.uploadId);
			sourceFd = stage.descriptor;
			if (stage.stats.size !== String(record.size) || stage.stats.uid !== process.getuid() || stage.stats.gid !== process.getgid()) throw failure("FILE_UPLOAD_STAGE_INVALID");
			parentFd = openParent(target);
			const replace = record.expected !== null;
			if (replace) requireRevision(parentFd, target, record.expected);
			else requireAbsent(parentFd, target);
			tempName = "." + record.uploadId + ".pideck-put";
			try { tempFd = fs.openSync(procPath(parentFd, tempName), CREATE_FILE, 384); }
			catch (error) {
				const code = error !== null && typeof error === "object" ? error.code : "";
				if (code === "EEXIST") throw failure("FILE_UPLOAD_STAGE_INVALID");
				if (code === "EACCES" || code === "EPERM" || code === "EROFS") throw failure("PERMISSION_DENIED");
				throw failure("IO_ERROR");
			}
			const temporary = fs.fstatSync(tempFd, { bigint: true });
			if (temporary.isFile() !== true || Number(temporary.uid) !== process.getuid() || Number(temporary.gid) !== process.getgid()) throw failure("IO_ERROR");
			copyAndHash(sourceFd, tempFd, record.size, record.sha256, deadlineAt);
			const after = sourceSnapshot(fs.fstatSync(sourceFd, { bigint: true }));
			if (sameSource(stage.stats, after) === false) throw failure("FILE_UPLOAD_STAGE_INVALID");
			const mode = replace ? record.expected.mode : 384;
			fs.fchmodSync(tempFd, mode);
			fs.fsyncSync(tempFd);
			const ready = fs.fstatSync(tempFd, { bigint: true });
			if (ready.isFile() !== true || Number(ready.mode & 4095n) !== mode || ready.size !== BigInt(record.size) || Number(ready.uid) !== process.getuid() || Number(ready.gid) !== process.getgid()) throw failure("IO_ERROR");
			if (replace) requireRevision(parentFd, target, record.expected);
			publish(parentFd, tempName, target, replace);
			published = true;
			const linked = fs.lstatSync(targetPath(parentFd, target), { bigint: true });
			if (linked.isFile() !== true || linked.dev !== ready.dev || linked.ino !== ready.ino || linked.size !== ready.size || linked.uid !== ready.uid || linked.gid !== ready.gid) throw failure("FILE_UPLOAD_COMMIT_UNCONFIRMED");
			if (replace && Number(linked.mode & 4095n) !== record.expected.mode) throw failure("FILE_UPLOAD_COMMIT_UNCONFIRMED");
			fs.fsyncSync(parentFd);
			const tempCleaned = unlinkAnchored(parentFd, tempName);
			const stageCleaned = unlinkAnchored(spoolFd, stageName(record.uploadId));
			try { fs.fsyncSync(spoolFd); } catch {}
			return { committed: true, path: record.path, size: record.size, sha256: record.sha256, revision: revisionOf(linked), fsync: true, stageCleaned: stageCleaned && tempCleaned };
		} catch (error) {
			close(tempFd);
			tempFd = null;
			if (parentFd !== null && tempName !== null) unlinkAnchored(parentFd, tempName);
			cleanupStage(record.uploadId);
			if (published === true) throw failure("FILE_UPLOAD_COMMIT_UNCONFIRMED");
			if (error !== null && error.uploadCode !== undefined) throw error;
			const code = error !== null && typeof error === "object" ? error.code : "";
			if (code === "EACCES" || code === "EPERM" || code === "EROFS") throw failure("PERMISSION_DENIED");
			throw failure("IO_ERROR");
		} finally {
			close(sourceFd);
			close(tempFd);
			close(parentFd);
			close(spoolFd);
		}
	}
	function abort(params, identity) {
		const input = readCommit(params);
		const record = pending.get(input.uploadId);
		if (record === undefined || record.token !== input.token || record.hostId !== identity.hostId || record.generation !== identity.generation) throw failure("FILE_UPLOAD_TOKEN_INVALID");
		pending.delete(input.uploadId);
		if (record.expiresAt <= Date.now()) {
			cleanupStage(record.uploadId);
			throw failure("FILE_UPLOAD_TOKEN_INVALID");
		}
		if (cleanupStage(record.uploadId) !== true) throw failure("FILE_UPLOAD_STAGE_INVALID");
		return { cleaned: true };
	}
	/* The scope's own shutdown, named apart from close(descriptor): a shared name would shadow it for the whole factory. */
	function closeScope() {
		for (const [uploadId] of pending) cleanupStage(uploadId);
		pending.clear();
	}
	return { prepare: prepare, commit: commit, abort: abort, close: closeScope, supported: function () { return unsupported() === false; } };
}
`.replace(/\r?\n[\t ]*/g, "");

/** sha256 of REMOTE_UPLOAD_COMMIT_SOURCE; a bundle whose helper differs from the reviewed bytes never activates. */
export const REMOTE_HELPER_UPLOAD_COMMIT_SHA256 = "e96853ced06131679c91d2691ed513df4f3c88d41a63d5275c986600ab563bf4";
