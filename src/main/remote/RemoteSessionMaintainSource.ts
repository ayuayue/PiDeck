/**
 * Frozen remote session-maintain scope, deployed as session-maintain.mjs and imported by helper.mjs.
 *
 * Edit / delete / resend-truncate must rewrite one pi session JSONL **in place on the host**, so main never
 * has to download and re-upload the whole file through the 256 KiB-chunk round trip. This artifact is the
 * only code in the bundle that renames a file the user owns, so the containment rules are explicit: Linux
 * procfs anchors the already-open parent directory, O_NOFOLLOW keeps a link out of every component, the
 * caller's revision is a compare-and-swap (identity plus sha256) that is re-verified immediately before the
 * rename, and every failure after the rename is reported as unconfirmed instead of "untouched".
 *
 * The mutation semantics deliberately mirror the local editor (SessionFileEditor's streaming path plus
 * sessionFile/sessionFileEntryTargets): edit and delete append pi-native `context_edit` records chained from
 * the current leaf, resend rewrites the target subtree as `deleted` tombstones with the same key order and
 * reason, and every untouched line is copied byte for byte with its own `\n` / `\r\n` / missing final EOL.
 *
 * Two streaming passes keep memory bounded by the index, never by the file size: pass 1 parses lines and
 * keeps only ids, parents, roles, thinking/visible-text flags, tombstones, the leaf pair and the header
 * count; pass 2 copies the file into a 0600 sibling temp, substituting only the tombstoned lines, and then
 * appends the new records. No per-line byte offset is retained: the target line is recognised by number.
 *
 * The target is resolved from the caller's ordered id hints, so the `context_edit` text map the local editor
 * needs for its "find by displayed text" fallback is not kept here — that resolution belongs to main, which
 * already knows which message the user pointed at.
 */

export const REMOTE_SESSION_MAINTAIN_FILE_NAME = "session-maintain.mjs";

export const REMOTE_SESSION_MAINTAIN_SOURCE = String.raw`"use strict";
/* Session-maintain scope: edit / delete / resend-truncate one pi session JSONL in place, behind a compare-and-swap revision. */
export function createSessionMaintainScope(fs, path, crypto) {
	const READ_CHUNK = 262144, MAX_BYTES = 8589934592, MAX_PATH = 4096, MAX_CANDIDATES = 3, MAX_ROOTS = 4, MAX_ID = 256;
	const HASH = /^[0-9a-f]{64}$/, DIGITS = /^[0-9]{1,40}$/, CONTROL = /[\u0000-\u001f\u007f]/;
	const WINDOWS_DRIVE = /^[A-Za-z]:/, ENCODED_SEPARATOR = /%2e|%2f|%5c/i;
	const REVISION_KEYS = ["mode", "size", "dev", "ino", "uid", "gid", "mtimeNs", "ctimeNs", "digest"];
	const LIMIT_KEYS = ["maxFileBytes", "maxLineBytes", "maxEntries", "maxDraftBytes"];
	const MAINTAIN_KEYS = ["path", "operation", "candidateIds", "newText", "allowedRoots", "expected", "limits"];
	const C = fs.constants, O_READ = C.O_RDONLY, O_WRITE = C.O_WRONLY, O_CREATE = C.O_CREAT, O_EXCL = C.O_EXCL, O_NOFOLLOW = C.O_NOFOLLOW, O_DIRECTORY = C.O_DIRECTORY;
	const READ_DIR = O_READ | O_DIRECTORY | O_NOFOLLOW, CREATE_FILE = O_WRITE | O_CREATE | O_EXCL | O_NOFOLLOW;
	function failure(code) { const error = new Error(code); error.maintainCode = code; return error; }
	function isRecord(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
	function hasExactKeys(value, keys) {
		if (isRecord(value) === false || Object.keys(value).length !== keys.length) return false;
		for (const key of keys) if (Object.prototype.hasOwnProperty.call(value, key) === false) return false;
		return true;
	}
	function errorCodeOf(error) { return error !== null && typeof error === "object" && typeof error.code === "string" ? error.code : ""; }
	function isOwnFailure(error) { return error !== null && typeof error === "object" && error.maintainCode !== undefined; }
	function close(descriptor) { if (descriptor === null) return; try { fs.closeSync(descriptor); } catch {} }
	function procPath(directoryFd, name) { return "/proc/self/fd/" + String(directoryFd) + "/" + name; }
	function absolutePath(segments) { return segments.length === 0 ? "/" : path.resolve("/", segments.join("/")); }
	/* Linux procfs is the anchor and /proc/self/fd must be a directory; a host without them (or without an
	ownership identity to check) is refused as PERMISSION_DENIED: there is no unsupported state in the code list. */
	function unsupported() {
		if (process.platform !== "linux" || crypto === null || typeof crypto !== "object") return true;
		if (typeof crypto.createHash !== "function" || typeof crypto.randomUUID !== "function") return true;
		if (typeof process.getuid !== "function" || typeof process.getgid !== "function") return true;
		if (typeof O_NOFOLLOW !== "number" || typeof O_DIRECTORY !== "number") return true;
		try { return fs.statSync("/proc/self/fd").isDirectory() !== true; } catch { return true; }
	}
	function ioFailure(error, fallback) {
		const code = errorCodeOf(error);
		if (code === "EACCES" || code === "EPERM" || code === "EROFS") return failure("PERMISSION_DENIED");
		return failure(fallback);
	}
	function readRevision(value) {
		if (hasExactKeys(value, REVISION_KEYS) === false) throw failure("SESSION_MAINTAIN_INPUT_INVALID");
		if (Number.isInteger(value.mode) === false || value.mode < 0 || value.mode > 4095) throw failure("SESSION_MAINTAIN_INPUT_INVALID");
		if (Number.isSafeInteger(value.size) === false || value.size < 0 || value.size > MAX_BYTES) throw failure("SESSION_MAINTAIN_INPUT_INVALID");
		if (typeof value.digest !== "string" || HASH.test(value.digest) === false) throw failure("SESSION_MAINTAIN_INPUT_INVALID");
		for (const key of ["dev", "ino", "uid", "gid", "mtimeNs", "ctimeNs"]) if (typeof value[key] !== "string" || DIGITS.test(value[key]) === false) throw failure("SESSION_MAINTAIN_INPUT_INVALID");
		return { mode: value.mode, size: value.size, dev: value.dev, ino: value.ino, uid: value.uid, gid: value.gid, mtimeNs: value.mtimeNs, ctimeNs: value.ctimeNs, digest: value.digest };
	}
	function readLimits(value) {
		if (hasExactKeys(value, LIMIT_KEYS) === false) throw failure("SESSION_MAINTAIN_INPUT_INVALID");
		const limits = {};
		for (const key of LIMIT_KEYS) {
			if (Number.isSafeInteger(value[key]) === false || value[key] < 1) throw failure("SESSION_MAINTAIN_INPUT_INVALID");
			limits[key] = value[key];
		}
		return limits;
	}
	/* An absolute POSIX path with canonical segments: the walk below never sees "" or "..", so no name can leave its directory. */
	function readAnchored(value, bare) {
		if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > MAX_PATH || CONTROL.test(value)) throw failure("SESSION_MAINTAIN_PATH_INVALID");
		if (value.charAt(0) !== "/" || value.indexOf("\\") >= 0 || value.indexOf("'") >= 0 || WINDOWS_DRIVE.test(value) || ENCODED_SEPARATOR.test(value)) throw failure("SESSION_MAINTAIN_PATH_INVALID");
		if (value === "/") { if (bare === true) return []; throw failure("SESSION_MAINTAIN_PATH_INVALID"); }
		const segments = value.split("/");
		segments.shift();
		for (const segment of segments) if (segment === "" || segment === "." || segment === "..") throw failure("SESSION_MAINTAIN_PATH_INVALID");
		return segments;
	}
	function readInput(params, deadlineAt) {
		if (hasExactKeys(params, MAINTAIN_KEYS) === false) throw failure("SESSION_MAINTAIN_INPUT_INVALID");
		if (params.operation !== "edit" && params.operation !== "delete" && params.operation !== "resend") throw failure("SESSION_MAINTAIN_INPUT_INVALID");
		if (typeof params.newText !== "string") throw failure("SESSION_MAINTAIN_INPUT_INVALID");
		if (Array.isArray(params.candidateIds) === false || params.candidateIds.length < 1 || params.candidateIds.length > MAX_CANDIDATES) throw failure("SESSION_MAINTAIN_INPUT_INVALID");
		const candidateIds = [];
		for (const value of params.candidateIds) {
			if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > MAX_ID || CONTROL.test(value)) throw failure("SESSION_MAINTAIN_INPUT_INVALID");
			candidateIds.push(value);
		}
		if (Array.isArray(params.allowedRoots) === false || params.allowedRoots.length > MAX_ROOTS) throw failure("SESSION_MAINTAIN_INPUT_INVALID");
		if (Number.isSafeInteger(deadlineAt) === false || deadlineAt < 0) throw failure("SESSION_MAINTAIN_INPUT_INVALID");
		const roots = [];
		for (const value of params.allowedRoots) roots.push(readAnchored(value, true));
		return { operation: params.operation, segments: readAnchored(params.path, false), candidateIds: candidateIds, newText: params.newText, roots: roots, expected: readRevision(params.expected), limits: readLimits(params.limits) };
	}
	/* The publish is a rename of our own temp over the target: a file owned by another account would be taken over. */
	function requireOwnership(expected) {
		if (typeof process.getuid !== "function" || typeof process.getgid !== "function") throw failure("PERMISSION_DENIED");
		if (expected.uid !== String(process.getuid()) || expected.gid !== String(process.getgid())) throw failure("PERMISSION_DENIED");
	}
	function openParentDirectory(segments) {
		let current = null;
		try { current = fs.openSync("/", READ_DIR); } catch { throw failure("SESSION_MAINTAIN_PATH_INVALID"); }
		try {
			for (let index = 0; index < segments.length - 1; index += 1) {
				let next = null;
				try { next = fs.openSync(procPath(current, segments[index]), READ_DIR); } catch { throw failure("SESSION_MAINTAIN_PATH_INVALID"); }
				close(current);
				current = next;
			}
			return current;
		} catch (error) {
			close(current);
			if (isOwnFailure(error)) throw error;
			throw failure("SESSION_MAINTAIN_PATH_INVALID");
		}
	}
	function requireCanonicalParent(parentPath) {
		let canonical = null;
		try { canonical = fs.realpathSync(parentPath); } catch { throw failure("SESSION_MAINTAIN_PATH_INVALID"); }
		if (canonical !== parentPath) throw failure("SESSION_MAINTAIN_PATH_INVALID");
	}
	/* Containment: the anchored file must equal or live under one realpath'd allowed root; no root at all reaches nothing. */
	function requireAllowedRoot(filePath, roots) {
		for (const root of roots) {
			let canonical = null;
			try { canonical = fs.realpathSync(absolutePath(root)); } catch { continue; }
			if (canonical === filePath || canonical === "/") return;
			if (filePath.startsWith(canonical + "/")) return;
		}
		throw failure("SESSION_MAINTAIN_PATH_INVALID");
	}
	function sameRevision(stats, expected) {
		return Number(stats.mode & 4095n) === expected.mode && stats.size === BigInt(expected.size) && stats.dev === BigInt(expected.dev) && stats.ino === BigInt(expected.ino) && stats.uid === BigInt(expected.uid) && stats.gid === BigInt(expected.gid) && stats.mtimeNs === BigInt(expected.mtimeNs) && stats.ctimeNs === BigInt(expected.ctimeNs);
	}
	function revisionOf(stats, digest) {
		return { mode: Number(stats.mode & 4095n), size: Number(stats.size), dev: String(stats.dev), ino: String(stats.ino), uid: String(stats.uid), gid: String(stats.gid), mtimeNs: String(stats.mtimeNs), ctimeNs: String(stats.ctimeNs), digest: digest };
	}
	function hashDescriptor(descriptor, size, deadlineAt) {
		const hash = crypto.createHash("sha256");
		const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK, Math.max(1, size)));
		let offset = 0;
		while (offset < size) {
			if (deadlineAt > 0 && Date.now() > deadlineAt) throw failure("REQUEST_TIMEOUT");
			const count = fs.readSync(descriptor, chunk, 0, Math.min(chunk.length, size - offset), offset);
			if (count <= 0) throw failure("SESSION_MAINTAIN_FILE_CHANGED");
			hash.update(chunk.subarray(0, count));
			offset += count;
		}
		return hash.digest("hex");
	}
	/* Open the entry through the anchored parent: O_NOFOLLOW refuses a link and the fstat refuses a non-file. */
	function openSource(parentFd, name) {
		let descriptor = null;
		try { descriptor = fs.openSync(procPath(parentFd, name), O_READ | O_NOFOLLOW); }
		catch (error) {
			const code = errorCodeOf(error);
			if (code === "EACCES" || code === "EPERM" || code === "EROFS") throw failure("PERMISSION_DENIED");
			if (code === "ELOOP" || code === "ENOTDIR" || code === "EISDIR") throw failure("SESSION_MAINTAIN_PATH_INVALID");
			if (code === "ENOENT") throw failure("SESSION_MAINTAIN_FILE_CHANGED");
			throw failure("IO_ERROR");
		}
		try {
			if (fs.fstatSync(descriptor, { bigint: true }).isFile() !== true) throw failure("SESSION_MAINTAIN_PATH_INVALID");
			return descriptor;
		} catch (error) {
			close(descriptor);
			if (isOwnFailure(error)) throw error;
			throw failure("IO_ERROR");
		}
	}
	/* The revision the caller read, re-derived from the anchored parent: a missing, linked or different file is FILE_CHANGED. */
	function requireRevision(parentFd, name, expected, deadlineAt) {
		let descriptor = null;
		try { descriptor = openSource(parentFd, name); }
		catch (error) {
			if (isOwnFailure(error) && error.maintainCode === "PERMISSION_DENIED") throw error;
			throw failure("SESSION_MAINTAIN_FILE_CHANGED");
		}
		try {
			const before = fs.fstatSync(descriptor, { bigint: true });
			if (before.isFile() !== true || sameRevision(before, expected) === false) throw failure("SESSION_MAINTAIN_FILE_CHANGED");
			if (hashDescriptor(descriptor, Number(before.size), deadlineAt) !== expected.digest) throw failure("SESSION_MAINTAIN_FILE_CHANGED");
			if (sameRevision(fs.fstatSync(descriptor, { bigint: true }), expected) === false) throw failure("SESSION_MAINTAIN_FILE_CHANGED");
		} catch (error) {
			if (isOwnFailure(error)) throw error;
			throw failure("SESSION_MAINTAIN_FILE_CHANGED");
		} finally { close(descriptor); }
	}
	function isBlankLine(content) {
		for (const byte of content) if (byte !== 32 && byte !== 9 && byte !== 13) return false;
		return true;
	}
	/* 256 KiB chunks; a line is only ever complete in the buffer, so multi-byte UTF-8 never straddles a split. */
	function* iterateLines(descriptor, size, limits, deadlineAt) {
		const chunk = Buffer.allocUnsafe(READ_CHUNK);
		let pending = Buffer.alloc(0), offset = 0;
		while (offset < size) {
			if (deadlineAt > 0 && Date.now() > deadlineAt) throw failure("REQUEST_TIMEOUT");
			const count = fs.readSync(descriptor, chunk, 0, Math.min(READ_CHUNK, size - offset), offset);
			if (count <= 0) throw failure("SESSION_MAINTAIN_FILE_CHANGED");
			offset += count;
			const view = chunk.subarray(0, count);
			const buffer = pending.length > 0 ? Buffer.concat([pending, view]) : view;
			let from = 0;
			for (;;) {
				const newline = buffer.indexOf(10, from);
				if (newline < 0) break;
				const carriage = newline > from && buffer[newline - 1] === 13;
				const content = buffer.subarray(from, carriage ? newline - 1 : newline);
				if (content.length > limits.maxLineBytes) throw failure("SESSION_MAINTAIN_FILE_TOO_LARGE");
				yield { content: content, eol: carriage ? "\r\n" : "\n" };
				from = newline + 1;
			}
			pending = Buffer.from(buffer.subarray(from));
			if (pending.length > limits.maxLineBytes) throw failure("SESSION_MAINTAIN_FILE_TOO_LARGE");
		}
		if (pending.length > 0) {
			if (pending.length > limits.maxLineBytes) throw failure("SESSION_MAINTAIN_FILE_TOO_LARGE");
			yield { content: pending, eol: "" };
		}
	}
	function readEntry(content) {
		let text = "";
		try { text = new TextDecoder("utf-8", { fatal: true }).decode(content); } catch { throw failure("SESSION_MAINTAIN_FILE_INVALID"); }
		let parsed = null;
		try { parsed = JSON.parse(text); } catch { throw failure("SESSION_MAINTAIN_FILE_INVALID"); }
		if (isRecord(parsed) === false) throw failure("SESSION_MAINTAIN_FILE_INVALID");
		return parsed;
	}
	function entryIdOf(entry) {
		if (typeof entry.id === "string" && entry.id) return entry.id;
		if (typeof entry.entryId === "string" && entry.entryId) return entry.entryId;
		return undefined;
	}
	function parentIdOf(entry) { if (entry.parentId === null) return null; return typeof entry.parentId === "string" ? entry.parentId : null; }
	function messageOf(entry) { return isRecord(entry.message) ? entry.message : undefined; }
	function textOf(content) {
		if (typeof content === "string") return content;
		if (Array.isArray(content) === false) return "";
		const parts = [];
		for (const block of content) if (isRecord(block) && block.type === "text" && typeof block.text === "string") parts.push(block.text);
		return parts.join("");
	}
	function hasThinking(content) {
		if (Array.isArray(content) === false) return false;
		for (const block of content) if (isRecord(block) && block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim() !== "") return true;
		return false;
	}
	/* Pass 1: the index, never the file. The digest of the bytes read is the compare-and-swap half of the revision. */
	function indexSource(descriptor, expected, limits, deadlineAt) {
		const hash = crypto.createHash("sha256");
		const index = { entryLineById: new Map(), parentById: new Map(), roleById: new Map(), thinkingById: new Set(), textById: new Set(), deletedIds: new Set(), leafId: undefined, branchLeafId: undefined, headerCount: 0, entries: 0, trailingEol: "", lastLineHasEol: false };
		let lineNumber = 0;
		for (const line of iterateLines(descriptor, expected.size, limits, deadlineAt)) {
			hash.update(line.content);
			hash.update(Buffer.from(line.eol, "utf8"));
			if (line.eol.length > 0) index.trailingEol = line.eol;
			index.lastLineHasEol = line.eol.length > 0;
			if (isBlankLine(line.content) === false) {
				const entry = readEntry(line.content);
				index.entries += 1;
				if (index.entries > limits.maxEntries) throw failure("SESSION_MAINTAIN_FILE_TOO_LARGE");
				if (entry._reloadMarker !== undefined) throw failure("SESSION_MAINTAIN_FILE_CHANGED");
				if (entry.type === "session") index.headerCount += 1;
				else {
					const entryId = entryIdOf(entry);
					if (entryId !== undefined) {
						if (index.entryLineById.has(entryId)) throw failure("SESSION_MAINTAIN_FILE_INVALID");
						index.entryLineById.set(entryId, lineNumber);
						index.parentById.set(entryId, parentIdOf(entry));
						index.leafId = entryId;
						if (entry.type === "deleted") index.deletedIds.add(entryId);
						else {
							index.branchLeafId = entryId;
							if (entry.type !== "context_edit") {
								const message = messageOf(entry);
								const role = message === undefined ? undefined : message.role;
								if (typeof role === "string") index.roleById.set(entryId, role);
								const content = message === undefined ? undefined : message.content;
								if (hasThinking(content)) index.thinkingById.add(entryId);
								if (textOf(content).trim() !== "") index.textById.add(entryId);
							}
						}
					}
				}
			}
			lineNumber += 1;
		}
		if (index.entries === 0 || index.headerCount !== 1) throw failure("SESSION_MAINTAIN_FILE_INVALID");
		if (hash.digest("hex") !== expected.digest) throw failure("SESSION_MAINTAIN_FILE_CHANGED");
		return index;
	}
	function branchIdsOf(index) {
		const branch = new Set();
		let current = index.branchLeafId;
		while (current !== undefined && current !== null && branch.has(current) === false) {
			branch.add(current);
			const parent = index.parentById.get(current);
			current = parent === undefined ? null : parent;
		}
		return branch;
	}
	/* The first hinted id that is on the active branch and not tombstoned; main resolves the hints, this only walks them. */
	function resolveTarget(index, candidateIds) {
		const branch = branchIdsOf(index);
		for (const candidateId of candidateIds) if (branch.has(candidateId) && index.deletedIds.has(candidateId) === false) return candidateId;
		throw failure("SESSION_MAINTAIN_MESSAGE_NOT_FOUND");
	}
	function isProcessNode(index, entryId) {
		const role = index.roleById.get(entryId);
		if (role === "toolResult") return true;
		if (role !== "assistant") return false;
		return index.thinkingById.has(entryId) && index.textById.has(entryId) === false;
	}
	/* Deleting an answer takes its whole process run (thinking-only assistant / toolResult) out of the context too.
	The walk is bounded by the entries it has already seen: a corrupt file whose parent chain loops is refused
	nowhere else, and a hang would be worse than a stale context. */
	function deleteTargets(index, targetId) {
		const targets = [targetId];
		if (index.roleById.get(targetId) === "assistant") {
			const seen = new Set([targetId]);
			let cursor = index.parentById.get(targetId);
			while (cursor !== undefined && cursor !== null && seen.has(cursor) === false) {
				if (isProcessNode(index, cursor) === false) break;
				seen.add(cursor);
				targets.push(cursor);
				const parent = index.parentById.get(cursor);
				cursor = parent === undefined ? null : parent;
			}
		}
		return targets;
	}
	function descendantsOf(index, rootId) {
		const children = new Map();
		for (const [entryId, parentId] of index.parentById) {
			if (parentId === null) continue;
			const siblings = children.get(parentId);
			if (siblings === undefined) children.set(parentId, [entryId]);
			else siblings.push(entryId);
		}
		const result = new Set([rootId]);
		const stack = [rootId];
		while (stack.length > 0) {
			const items = children.get(stack.pop());
			if (items === undefined) continue;
			for (const child of items) {
				if (result.has(child) || index.deletedIds.has(child)) continue;
				result.add(child);
				stack.push(child);
			}
		}
		return result;
	}
	/* Same shape, same key order and same reason as the local tombstone: pi rebuilds the leaf from id plus parentId. */
	function tombstone(entryId, now, parentId, reason) {
		return { type: "deleted", id: entryId, originalEntryId: entryId, parentId: parentId === undefined ? null : parentId, ts: now, reason: reason };
	}
	/* Only the first text block is rewritten (images / tool blocks survive), exactly like the local replaceTextInContent. */
	function replaceTextInContent(content, text) {
		if (typeof content === "string") return text;
		if (Array.isArray(content) === false) return [{ type: "text", text: text }];
		const next = [];
		let replaced = false;
		for (const candidate of content) {
			if (isRecord(candidate) === false || candidate.type !== "text") { next.push(candidate); continue; }
			if (replaced) continue;
			const block = { ...candidate };
			block.text = text;
			next.push(block);
			replaced = true;
		}
		if (replaced === false) next.push({ type: "text", text: text });
		return next;
	}
	/* The resend draft keeps the existing rule: every text block joined with a line feed, images as mime plus base64. */
	function draftOf(entry, limits) {
		const message = messageOf(entry);
		const content = message === undefined ? undefined : message.content;
		const images = [];
		const parts = [];
		let bytes = 0;
		if (typeof content === "string") { parts.push(content); bytes = Buffer.byteLength(content, "utf8"); }
		else if (Array.isArray(content)) {
			for (const block of content) {
				if (isRecord(block) === false) continue;
				const source = isRecord(block.source) ? block.source : undefined;
				if (block.type === "text" && typeof block.text === "string") { parts.push(block.text); bytes += Buffer.byteLength(block.text, "utf8"); continue; }
				if (block.type !== "image") continue;
				const data = typeof block.data === "string" ? block.data : source !== undefined && typeof source.data === "string" ? source.data : "";
				if (data === "") continue;
				const mime = typeof block.mimeType === "string" ? block.mimeType : typeof block.mime_type === "string" ? block.mime_type : source !== undefined && typeof source.media_type === "string" ? source.media_type : "image/png";
				images.push({ mime: mime, dataBase64: data });
				bytes += Buffer.byteLength(data, "utf8");
			}
			bytes += Math.max(0, parts.length - 1);
		}
		if (bytes > limits.maxDraftBytes) throw failure("SESSION_MAINTAIN_DRAFT_TOO_LARGE");
		return { text: parts.join("\n"), images: images };
	}
	function contextEditRecords(index, plan, now) {
		if (plan.kind === "edit" && plan.replacement === undefined) throw failure("SESSION_MAINTAIN_FILE_CHANGED");
		const targets = plan.kind === "edit" ? [{ targetId: plan.targetId, replacement: plan.replacement }] : [];
		if (plan.kind === "delete") for (const targetId of plan.targets) targets.push({ targetId: targetId, replacement: null });
		const records = [];
		let parentId = index.leafId === undefined ? null : index.leafId;
		for (const target of targets) {
			const entryId = crypto.randomUUID();
			records.push(JSON.stringify({ type: "context_edit", id: entryId, parentId: parentId, timestamp: new Date(now).toISOString(), targetId: target.targetId, replacement: target.replacement }));
			parentId = entryId;
		}
		return records;
	}
	function writeBytes(descriptor, hash, buffer) {
		if (buffer.length === 0) return 0;
		hash.update(buffer);
		let written = 0;
		while (written < buffer.length) {
			const count = fs.writeSync(descriptor, buffer, written, buffer.length - written, null);
			if (count <= 0) throw failure("IO_ERROR");
			written += count;
		}
		return buffer.length;
	}
	function createTemp(parentFd, name) {
		let descriptor = null;
		try { descriptor = fs.openSync(procPath(parentFd, name), CREATE_FILE, 384); }
		catch (error) { throw ioFailure(error, "IO_ERROR"); }
		try {
			const stats = fs.fstatSync(descriptor, { bigint: true });
			if (stats.isFile() !== true || Number(stats.uid) !== process.getuid() || Number(stats.gid) !== process.getgid()) throw failure("IO_ERROR");
			return descriptor;
		} catch (error) {
			close(descriptor);
			if (isOwnFailure(error)) throw error;
			throw failure("IO_ERROR");
		}
	}
	/* Pass 2: copy line by line, substituting only the tombstoned lines, then append the new records. */
	function writeRewritten(sourceFd, tempFd, plan, input, index, now, deadlineAt) {
		const hash = crypto.createHash("sha256");
		let lineNumber = 0, lastLineHasEol = false, trailingEol = "", size = 0;
		for (const line of iterateLines(sourceFd, input.expected.size, input.limits, deadlineAt)) {
			if (line.eol.length > 0) { trailingEol = line.eol; lastLineHasEol = true; }
			else lastLineHasEol = false;
			if (lineNumber === plan.targetLine) {
				const entry = readEntry(line.content);
				if (plan.kind === "edit") {
					const message = messageOf(entry);
					plan.replacement = { content: replaceTextInContent(message === undefined ? undefined : message.content, input.newText) };
				} else if (plan.kind === "resend") plan.draft = draftOf(entry, input.limits);
			}
			const removal = plan.removeLines === null ? undefined : plan.removeLines.get(lineNumber);
			size += writeBytes(tempFd, hash, removal === undefined ? line.content : Buffer.from(JSON.stringify(removal), "utf8"));
			size += writeBytes(tempFd, hash, Buffer.from(line.eol, "utf8"));
			lineNumber += 1;
		}
		const records = plan.kind === "resend" ? [] : contextEditRecords(index, plan, now);
		if (records.length > 0) {
			const eol = trailingEol.length > 0 ? trailingEol : "\n";
			if (lastLineHasEol === false) size += writeBytes(tempFd, hash, Buffer.from(eol, "utf8"));
			for (const record of records) size += writeBytes(tempFd, hash, Buffer.from(record + eol, "utf8"));
		}
		return { digest: hash.digest("hex"), size: size, draft: plan.draft };
	}
	function unlinkAnchored(directoryFd, name) { try { fs.unlinkSync(procPath(directoryFd, name)); return true; } catch { return false; } }
	function maintain(params, deadlineAt) {
		const input = readInput(params, deadlineAt);
		requireOwnership(input.expected);
		if (unsupported()) throw failure("PERMISSION_DENIED");
		if (deadlineAt > 0 && Date.now() > deadlineAt) throw failure("REQUEST_TIMEOUT");
		const name = input.segments[input.segments.length - 1];
		const parentSegments = input.segments.slice(0, input.segments.length - 1);
		const filePath = absolutePath(input.segments);
		let parentFd = null, sourceFd = null, tempFd = null, tempName = null, published = false;
		try {
			parentFd = openParentDirectory(input.segments);
			requireCanonicalParent(absolutePath(parentSegments));
			requireAllowedRoot(filePath, input.roots);
			sourceFd = openSource(parentFd, name);
			const opened = fs.fstatSync(sourceFd, { bigint: true });
			if (opened.isFile() !== true || sameRevision(opened, input.expected) === false) throw failure("SESSION_MAINTAIN_FILE_CHANGED");
			if (opened.size > BigInt(input.limits.maxFileBytes)) throw failure("SESSION_MAINTAIN_FILE_TOO_LARGE");
			const index = indexSource(sourceFd, input.expected, input.limits, deadlineAt);
			const targetId = resolveTarget(index, input.candidateIds);
			const now = Date.now();
			const plan = { kind: input.operation, targetId: targetId, targetLine: index.entryLineById.get(targetId), targets: null, removeLines: null, replacement: undefined, draft: null };
			if (input.operation === "edit") {
				const role = index.roleById.get(targetId);
				if (role !== "user" && role !== "assistant") throw failure("SESSION_MAINTAIN_ROLE_INVALID");
			} else if (input.operation === "delete") plan.targets = deleteTargets(index, targetId);
			else {
				if (index.roleById.get(targetId) !== "user") throw failure("SESSION_MAINTAIN_ROLE_INVALID");
				plan.removeLines = new Map();
				for (const entryId of descendantsOf(index, targetId)) {
					const lineNumber = index.entryLineById.get(entryId);
					if (lineNumber === undefined) continue;
					plan.removeLines.set(lineNumber, tombstone(entryId, now, index.parentById.get(entryId), "resend-truncate"));
				}
			}
			tempName = "." + crypto.randomBytes(16).toString("hex") + ".pideck-session";
			tempFd = createTemp(parentFd, tempName);
			const written = writeRewritten(sourceFd, tempFd, plan, input, index, now, deadlineAt);
			fs.fchmodSync(tempFd, input.expected.mode);
			fs.fsyncSync(tempFd);
			const ready = fs.fstatSync(tempFd, { bigint: true });
			if (ready.isFile() !== true || Number(ready.uid) !== process.getuid() || Number(ready.gid) !== process.getgid() || Number(ready.mode & 4095n) !== input.expected.mode || ready.size !== BigInt(written.size)) throw failure("IO_ERROR");
			requireRevision(parentFd, name, input.expected, deadlineAt);
			try { fs.renameSync(procPath(parentFd, tempName), procPath(parentFd, name)); }
			catch (error) { throw ioFailure(error, "IO_ERROR"); }
			published = true;
			tempName = null;
			fs.fsyncSync(parentFd);
			const linked = fs.lstatSync(procPath(parentFd, name), { bigint: true });
			if (linked.isFile() !== true || linked.dev !== ready.dev || linked.ino !== ready.ino || linked.size !== ready.size || linked.uid !== ready.uid || linked.gid !== ready.gid || Number(linked.mode & 4095n) !== input.expected.mode) throw failure("SESSION_MAINTAIN_COMMIT_UNCONFIRMED");
			return { revision: revisionOf(linked, written.digest), draft: written.draft };
		} catch (error) {
			close(tempFd);
			tempFd = null;
			if (published === false && parentFd !== null && tempName !== null) unlinkAnchored(parentFd, tempName);
			if (published === true) throw failure("SESSION_MAINTAIN_COMMIT_UNCONFIRMED");
			if (isOwnFailure(error)) throw error;
			throw ioFailure(error, "IO_ERROR");
		} finally {
			close(sourceFd);
			close(tempFd);
			close(parentFd);
		}
	}
	return { maintain: maintain };
}
`.replace(/\r?\n[\t ]*/g, "");

/** sha256 of REMOTE_SESSION_MAINTAIN_SOURCE; a bundle whose helper differs from the reviewed bytes never activates. */
export const REMOTE_HELPER_SESSION_MAINTAIN_SHA256 = "ad3fd2fd16b85f9dd603327836813374cb64adffb798d6986ee9425c80accc52";
