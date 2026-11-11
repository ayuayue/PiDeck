/**
 * Frozen remote configuration scope, deployed as its own bundle file (config.mjs) and imported by helper.mjs.
 *
 * Why a separate artifact instead of growing the protocol entry: the remote half of PiDeck needs one reviewed,
 * content-addressed file for the config allowlist, exactly like the Git worker. Adding it as a sibling keeps each
 * change reviewable on its own file and keeps the entry's command-line/artifact audit surface stable.
 *
 * Security model (each item is a one-line invariant in the frozen body):
 * - only four files exist for this scope: $HOME/.pi/agent/models.json, settings.json, trust.json and mcp.json. No
 *   path parameter exists at all, so auth.json (or any other file under the agent dir) is structurally unreachable;
 *   trust/mcp carry no extra privilege: they go through the same sanitize/patch rules as models/settings;
 * - HOME comes from the handshake (absolute POSIX, bounded, no control byte). .pi and .pi/agent may be created
 *   with mode 0700 when missing; an existing symlink or non-directory there is refused before any read/write;
 * - the target file is opened with O_NOFOLLOW and must be a regular file; bytes are bounded at 1 MiB; malformed
 *   JSON is a refusal that never overwrites the file and never returns the raw text;
 * - read responses are sanitized recursively: any object key matching SECRET_KEY has its value replaced by
 *   `configured`/`missing` and the path/status is returned separately. A patch may replace a secret only with a
 *   new explicit string; the placeholder strings (and null/absent) mean keep the existing value;
 * - patch is RFC 7396 merge-patch (objects merge, arrays replace, null deletes non-secret keys), re-reads and
 *   checks expectedVersion, is bounded by depth/node/byte caps, then writes with a 0600 sibling temp file +
 *   fsync + rename + directory fsync. Unknown fields survive because the merge starts from the parsed file.
 * - after rename the file is read back and re-hashed; a readback failure is CONFIG_RESULT_UNCONFIRMED, never a
 *   claimed success and never an automatic retry.
 */

export const REMOTE_CONFIG_SOURCE = String.raw`"use strict";
export function createConfigScope(home, fs, path, crypto) {
	const FILES = { models: "models.json", settings: "settings.json", trust: "trust.json", mcp: "mcp.json" };
	const DEFAULTS = { models: "{\"providers\":{}}", settings: "{}", trust: "{}", mcp: "{}" };
	const MAX_BYTES = 1048576, MAX_NODES = 20000, MAX_DEPTH = 32;
	/* Whole-name matching: maxTokens/tokenizer must NOT be treated as secrets (they are real, patchable model fields), while camelCase compound names (clientSecret/openaiApiKey) still match. */
	const SECRET_KEY = /^(?:[a-z0-9]+[-_])*(?:[a-z0-9]+)?(?:api[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token|token|secret|password|passwd|authorization|cookie|credential|private[-_]?key)$/i;
	const RESERVED = /^(?:__proto__|constructor|prototype)$/;
	const CONTROL = /[\u0000-\u001f\u007f]/;
	function failure(code) { return new Error(code); }
	function isRecord(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
	function homeRoot() {
		if (typeof home !== "string" || home.length === 0 || home.length > 4096 || home.charAt(0) !== "/" || CONTROL.test(home)) throw failure("CONFIG_UNAVAILABLE");
		return home;
	}
	function fileKey(value, keys) {
		if (!isRecord(value) || Object.keys(value).length !== keys.length) throw failure("CONFIG_PATH_UNSUPPORTED");
		for (const key of keys) if (Object.prototype.hasOwnProperty.call(value, key) === false) throw failure("CONFIG_PATH_UNSUPPORTED");
		if (typeof value.file !== "string" || Object.prototype.hasOwnProperty.call(FILES, value.file) === false) throw failure("CONFIG_PATH_UNSUPPORTED");
		return value.file;
	}
	function readParams(value) { return fileKey(value, ["file"]); }
	function patchParams(value) {
		const file = fileKey(value, ["file", "expectedVersion", "patch"]);
		if (typeof value.expectedVersion !== "string" || /^[0-9a-f]{64}$/.test(value.expectedVersion) === false) throw failure("CONFIG_VERSION_CONFLICT");
		if (isRecord(value.patch) === false) throw failure("CONFIG_FILE_INVALID");
		return { file: file, expectedVersion: value.expectedVersion, patch: value.patch };
	}
	function ensureDirectory(target) {
		let stats = null;
		try { stats = fs.lstatSync(target); } catch (error) {
			if (error === null || error.code !== "ENOENT") throw failure("CONFIG_UNAVAILABLE");
			try { fs.mkdirSync(target, { mode: 448 }); fs.chmodSync(target, 448); } catch { throw failure("CONFIG_UNAVAILABLE"); }
			return;
		}
		if (stats.isDirectory() !== true || stats.isSymbolicLink() === true) throw failure("CONFIG_PATH_UNSUPPORTED");
	}
	function agentDirectory() {
		const root = homeRoot();
		ensureDirectory(root + "/.pi");
		const agent = root + "/.pi/agent";
		ensureDirectory(agent);
		return agent;
	}
	function readBytes(target) {
		let named = null;
		try { named = fs.lstatSync(target); } catch (error) {
			if (error !== null && error.code === "ENOENT") return null;
			throw failure("CONFIG_UNAVAILABLE");
		}
		if (named.isFile() !== true || named.isSymbolicLink() === true) throw failure("CONFIG_PATH_UNSUPPORTED");
		if (Number(named.size) > MAX_BYTES) throw failure("CONFIG_FILE_TOO_LARGE");
		const noFollow = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW === undefined ? 0 : fs.constants.O_NOFOLLOW);
		let descriptor = null;
		try {
			descriptor = fs.openSync(target, noFollow);
			const opened = fs.fstatSync(descriptor, { bigint: true });
			if (opened.isFile() !== true || String(opened.dev) !== String(named.dev) || String(opened.ino) !== String(named.ino)) throw failure("CONFIG_PATH_UNSUPPORTED");
			const size = Number(opened.size);
			if (size > MAX_BYTES) throw failure("CONFIG_FILE_TOO_LARGE");
			const buffer = Buffer.alloc(size);
			let offset = 0;
			while (offset < size) {
				const count = fs.readSync(descriptor, buffer, offset, size - offset, offset);
				if (count < 1) throw failure("CONFIG_UNAVAILABLE");
				offset += count;
			}
			return buffer;
		} finally {
			if (descriptor !== null) fs.closeSync(descriptor);
		}
	}
	function sha256(buffer) { return crypto.createHash("sha256").update(buffer).digest("hex"); }
	function defaultBytes(file) { return Buffer.from(DEFAULTS[file], "utf8"); }
	function parseData(buffer) {
		let text = null;
		try { text = new TextDecoder("utf-8", { fatal: true }).decode(buffer); } catch { throw failure("CONFIG_FILE_INVALID"); }
		let parsed = null;
		try { parsed = JSON.parse(text); } catch { throw failure("CONFIG_FILE_INVALID"); }
		if (isRecord(parsed) === false) throw failure("CONFIG_FILE_INVALID");
		return parsed;
	}
	function modelsFile(data) {
		if (isRecord(data.providers) === false) throw failure("CONFIG_FILE_INVALID");
	}
	/* mcpServers must stay an object when present: an array/string here makes pi reject the whole file. */
	function mcpFile(data) {
		if (data.mcpServers !== undefined && isRecord(data.mcpServers) === false) throw failure("CONFIG_FILE_INVALID");
	}
	/* One per-file shape rule; a file without one only has to be a JSON object. */
	function validateFile(file, data) {
		if (file === "models") modelsFile(data);
		if (file === "mcp") mcpFile(data);
	}
	function collectSecrets(data) {
		const secrets = [];
		const budget = { nodes: 0 };
		function walk(value, prefix, depth) {
			if (depth > MAX_DEPTH) throw failure("CONFIG_FILE_INVALID");
			if (Array.isArray(value)) {
				for (let index = 0; index < value.length; index += 1) {
					budget.nodes += 1;
					if (budget.nodes > MAX_NODES) throw failure("CONFIG_FILE_INVALID");
					walk(value[index], prefix === "" ? String(index) : prefix + "." + index, depth + 1);
				}
				return;
			}
			if (isRecord(value) === false) return;
			for (const key of Object.keys(value)) {
				budget.nodes += 1;
				if (budget.nodes > MAX_NODES) throw failure("CONFIG_FILE_INVALID");
				const child = prefix === "" ? key : prefix + "." + key;
				if (RESERVED.test(key)) throw failure("CONFIG_FILE_INVALID");
				if (SECRET_KEY.test(key)) {
					const status = value[key] === "missing" || value[key] === null || value[key] === undefined || value[key] === "" ? "missing" : "configured";
					value[key] = status;
					secrets.push({ path: child, status: status });
					continue;
				}
				walk(value[key], child, depth + 1);
			}
		}
		walk(data, "", 0);
		secrets.sort(function (left, right) { return left.path < right.path ? -1 : left.path > right.path ? 1 : 0; });
		return secrets;
	}
	function snapshot(file, buffer) {
		const data = parseData(buffer);
		validateFile(file, data);
		const secrets = collectSecrets(data);
		const digest = sha256(buffer);
		return { version: digest, sha256: digest, data: data, secrets: secrets };
	}
	function mergeInto(base, patch, depth, budget) {
		if (depth > MAX_DEPTH) throw failure("CONFIG_FILE_INVALID");
		if (patch === null) return { deleted: true };
		budget.nodes += 1;
		if (budget.nodes > MAX_NODES) throw failure("CONFIG_FILE_INVALID");
		if (Array.isArray(patch)) return { value: JSON.parse(JSON.stringify(patch)) };
		if (isRecord(patch) === false) return { value: patch };
		const target = isRecord(base) ? base : {};
		for (const key of Object.keys(patch)) {
			const next = patch[key];
			if (RESERVED.test(key)) throw failure("CONFIG_FILE_INVALID");
			if (SECRET_KEY.test(key)) {
				/* A secret is only ever replaced by a value; a non-string is a caller shape error, not a silent no-op. */
				if (typeof next !== "string") throw failure("CONFIG_FILE_INVALID");
				if (next !== "configured" && next !== "missing") Object.defineProperty(target, key, { value: next, enumerable: true, configurable: true, writable: true });
				continue;
			}
			const merged = mergeInto(target[key], next, depth + 1, budget);
			if (merged.deleted === true) delete target[key];
			else Object.defineProperty(target, key, { value: merged.value, enumerable: true, configurable: true, writable: true });
		}
		return { value: target };
	}
	function encode(data) {
		const json = JSON.stringify(data);
		if (typeof json !== "string" || Buffer.byteLength(json, "utf8") > MAX_BYTES) throw failure("CONFIG_FILE_TOO_LARGE");
		return json;
	}
	function writeAtomic(target, bytes) {
		const temporary = target + ".tmp-" + crypto.randomBytes(8).toString("hex");
		let descriptor = null;
		try {
			descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 384);
			fs.writeFileSync(descriptor, bytes);
			fs.fsyncSync(descriptor);
			fs.closeSync(descriptor);
			descriptor = null;
			fs.renameSync(temporary, target);
		} catch (error) {
			if (descriptor !== null) { try { fs.closeSync(descriptor); } catch {} }
			try { fs.unlinkSync(temporary); } catch {}
			throw failure("CONFIG_UNAVAILABLE");
		}
		try {
			const dirFd = fs.openSync(path.dirname(target), "r");
			try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
		} catch { /* directory fsync is best-effort on platforms that refuse it */ }
	}
	function read(value) {
		const file = readParams(value);
		const target = agentDirectory() + "/" + FILES[file];
		const current = readBytes(target);
		return snapshot(file, current === null ? defaultBytes(file) : current);
	}
	/** Reject reserved keys anywhere in the patch (including array elements) before any merge walk. */
	function validatePatch(value, depth, budget) {
		if (depth > MAX_DEPTH) throw failure("CONFIG_FILE_INVALID");
		budget.nodes += 1;
		if (budget.nodes > MAX_NODES) throw failure("CONFIG_FILE_INVALID");
		if (Array.isArray(value)) {
			for (const entry of value) validatePatch(entry, depth + 1, budget);
			return;
		}
		if (isRecord(value) === false) return;
		for (const key of Object.keys(value)) {
			if (RESERVED.test(key)) throw failure("CONFIG_FILE_INVALID");
			validatePatch(value[key], depth + 1, budget);
		}
	}
	function patch(value) {
		const params = patchParams(value);
		validatePatch(params.patch, 0, { nodes: 0 });
		const target = agentDirectory() + "/" + FILES[params.file];
		const current = readBytes(target);
		const before = current === null ? defaultBytes(params.file) : current;
		if (sha256(before) !== params.expectedVersion) throw failure("CONFIG_VERSION_CONFLICT");
		const data = parseData(before);
		validateFile(params.file, data);
		const merged = mergeInto(data, params.patch, 0, { nodes: 0 });
		const next = merged.deleted === true ? null : merged.value;
		if (isRecord(next) === false) throw failure("CONFIG_FILE_INVALID");
		validateFile(params.file, next);
		const bytes = Buffer.from(encode(next), "utf8");
		writeAtomic(target, bytes);
		let written = null;
		try { written = readBytes(target); } catch { throw failure("CONFIG_RESULT_UNCONFIRMED"); }
		if (written === null || sha256(written) !== sha256(bytes)) throw failure("CONFIG_RESULT_UNCONFIRMED");
		return snapshot(params.file, written);
	}
	return { read: read, patch: patch };
}
`.replace(/\r?\n[\t ]*/g, "");

/** sha256 of REMOTE_CONFIG_SOURCE as UTF-8 bytes; pinned here and re-checked by the helper contract tests. */
export const REMOTE_HELPER_CONFIG_SHA256 = "830b83c490bce88a4e792d66458c281c6c857761e4b387dae2a76ba7507c2c35";
