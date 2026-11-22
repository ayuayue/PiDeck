/**
 * Frozen remote configuration scope, deployed as its own bundle file (config.mjs) and imported by helper.mjs.
 *
 * Four files support sanitized, versioned document replacement/patch: models/settings/trust/mcp.
 * Auth uses dedicated readAuth/replaceAuth operations: read returns provider/type/configured only;
 * replace accepts a new API key or a host-retained source reference. No existing credential returns.
 * Other paths are structurally unreachable.
 * - HOME comes from the handshake (absolute POSIX, bounded, no control byte). .pi and .pi/agent may be created
 *   with mode 0700 when missing; an existing symlink or non-directory there is refused before any read/write;
 * - the target file is opened with O_NOFOLLOW and must be a regular file; bytes are bounded at 1 MiB; malformed
 *   JSON is a refusal that never overwrites the file and never returns the raw text;
 * - read responses are sanitized recursively: any object key matching SECRET_KEY has its value replaced by
 *   'configured'/'missing' and the path/status is returned separately. A patch may replace a secret only with a
 *   new explicit string; the placeholder strings (and null/absent) mean keep the existing value;
 * - patch is RFC 7396 merge-patch (objects merge, arrays replace, null deletes non-secret keys), re-reads and
 *   checks expectedVersion, is bounded by depth/node/byte caps, then writes with a 0600 sibling temp file +
 *   fsync + rename + directory fsync. Unknown fields survive because the merge starts from the parsed file.
 * - after rename the file is read back and re-hashed; a readback failure is CONFIG_RESULT_UNCONFIRMED, never a
 *   claimed success and never an automatic retry.
 */

export const REMOTE_CONFIG_SOURCE = String.raw`"use strict";
export function createConfigScope(home, fs, path, crypto, agentSubdir) {
	const FILES = { models: "models.json", settings: "settings.json", trust: "trust.json", mcp: "mcp.json" };
	/* auth.json has dedicated value-free read and reference-based replacement operations. */
	const READ_AUTH = "auth.json";
	const DEFAULTS = { models: "{\"providers\":{}}", settings: "{}", trust: "{}", mcp: "{}", auth: "{}" };
	const MAX_BYTES = 1048576, MAX_NODES = 20000, MAX_DEPTH = 32, MAX_AUTH_PROVIDERS = 200;
	/* Provider names in auth.json are keyed by pi provider id; anything else is a file this scope will not describe. */
	const AUTH_PROVIDER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/;
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
	/* 'agentSubdir' lets the project resource layer reuse this scope for a project's own '.pi/settings.json':
	   the same versioned, atomic, secret-aware reader and writer with a different base directory. */
	function agentDirectory() {
		const root = homeRoot();
		const parts = String(agentSubdir === undefined ? ".pi/agent" : agentSubdir).split("/");
		if (parts.length === 0 || parts.some(function (part) { return /^[A-Za-z0-9._-]+$/.test(part) === false || part === "." || part === ".."; })) throw failure("CONFIG_PATH_UNSUPPORTED");
		let current = root;
		for (const part of parts) { current += "/" + part; ensureDirectory(current); }
		return current;
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
		if (Array.isArray(patch)) return { value: restoreDocument(base, patch, depth, budget, [], new Map()) };
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
	/*
	 * Read-only credential view. The answer is derived, never the document: a credential value is only compared to
	 * decide configured/missing, so no code path can put a key or an OAuth token into a frame. auth.json stays out
	 * of FILES, therefore config.patch cannot address it.
	 */
	function readAuth() {
		const target = agentDirectory() + "/" + READ_AUTH;
		const current = readBytes(target);
		const buffer = current === null ? defaultBytes("auth") : current;
		return authSnapshot(buffer);
	}
	function authSnapshot(buffer) {
		const data = parseData(buffer);
		const names = Object.keys(data);
		if (names.length > MAX_AUTH_PROVIDERS) throw failure("CONFIG_FILE_TOO_LARGE");
		const providers = [];
		for (const name of names.sort()) {
			if (RESERVED.test(name) || AUTH_PROVIDER.test(name) === false) throw failure("CONFIG_FILE_INVALID");
			const credential = data[name];
			if (isRecord(credential) === false) throw failure("CONFIG_FILE_INVALID");
			const kind = credential.type === "api_key" ? "api_key" : credential.type === "oauth" ? "oauth" : "unsupported";
			const configured = kind === "api_key" ? typeof credential.key === "string" && credential.key.length > 0 : kind === "oauth" ? typeof credential.access === "string" && credential.access.length > 0 && typeof credential.refresh === "string" && credential.refresh.length > 0 : false;
			providers.push({ provider: name, type: kind, configured: configured });
		}
		const digest = sha256(buffer);
		return { version: digest, sha256: digest, providers: providers };
	}
	/* Credentials never leave the host. The caller submits only new API keys, keep markers, or same-file copy
	 * references; omission deletes a provider. OAuth can only be kept or removed, never synthesized here. */
	function replaceAuth(value) {
		if (isRecord(value) === false || Object.keys(value).sort().join(",") !== "entries,expectedVersion" || typeof value.expectedVersion !== "string" || /^[0-9a-f]{64}$/.test(value.expectedVersion) === false || Array.isArray(value.entries) === false || value.entries.length > MAX_AUTH_PROVIDERS) throw failure("CONFIG_FILE_INVALID");
		const target = agentDirectory() + "/" + READ_AUTH;
		const current = readBytes(target);
		const beforeBytes = current === null ? defaultBytes("auth") : current;
		if (sha256(beforeBytes) !== value.expectedVersion) throw failure("CONFIG_VERSION_CONFLICT");
		const before = parseData(beforeBytes);
		const next = {};
		const seen = new Set();
		for (const entry of value.entries) {
			if (isRecord(entry) === false) throw failure("CONFIG_FILE_INVALID");
			const provider = entry.provider;
			if (typeof provider !== "string" || AUTH_PROVIDER.test(provider) === false || RESERVED.test(provider) || seen.has(provider)) throw failure("CONFIG_FILE_INVALID");
			seen.add(provider);
			const hasKey = Object.prototype.hasOwnProperty.call(entry, "apiKey");
			const hasRetain = Object.prototype.hasOwnProperty.call(entry, "retain");
			const hasSource = Object.prototype.hasOwnProperty.call(entry, "source");
			if (Object.keys(entry).some(function (key) { return key !== "provider" && key !== "apiKey" && key !== "retain" && key !== "source"; }) || hasKey && (hasSource || hasRetain)) throw failure("CONFIG_FILE_INVALID");
			let credential;
			if (hasKey) {
				if (Object.keys(entry).length !== 2 || typeof entry.apiKey !== "string" || entry.apiKey.length > 64 * 1024 || CONTROL.test(entry.apiKey)) throw failure("CONFIG_FILE_INVALID");
				credential = { type: "api_key", key: entry.apiKey };
			} else if (hasSource) {
				if (Object.keys(entry).length !== 3 || entry.retain !== true || typeof entry.source !== "string" || AUTH_PROVIDER.test(entry.source) === false || !Object.prototype.hasOwnProperty.call(before, entry.source) || isRecord(before[entry.source]) === false) throw failure("CONFIG_FILE_INVALID");
				credential = structuredClone(before[entry.source]);
			} else {
				if (Object.keys(entry).length !== 2 || entry.retain !== true || !Object.prototype.hasOwnProperty.call(before, provider) || isRecord(before[provider]) === false) throw failure("CONFIG_FILE_INVALID");
				credential = structuredClone(before[provider]);
			}
			next[provider] = credential;
		}
		const bytes = Buffer.from(encode(next), "utf8");
		authSnapshot(bytes);
		writeAtomic(target, bytes);
		let written = null;
		try { written = readBytes(target); } catch { throw failure("CONFIG_RESULT_UNCONFIRMED"); }
		if (written === null || sha256(written) !== sha256(bytes)) throw failure("CONFIG_RESULT_UNCONFIRMED");
		try { return authSnapshot(written); } catch { throw failure("CONFIG_RESULT_UNCONFIRMED"); }
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
		snapshot(params.file, bytes);
		writeAtomic(target, bytes);
		let written = null;
		try { written = readBytes(target); } catch { throw failure("CONFIG_RESULT_UNCONFIRMED"); }
		if (written === null || sha256(written) !== sha256(bytes)) throw failure("CONFIG_RESULT_UNCONFIRMED");
		try { return snapshot(params.file, written); } catch { throw failure("CONFIG_RESULT_UNCONFIRMED"); }
	}
	/* A document has replacement semantics, including explicit nulls. Redacted values are restored only here,
	 * on the host. Array model ids are identities, never their current position after a reorder. */
	function restoreDocument(before, after, depth, budget, parts, sources) {
		if (depth > MAX_DEPTH || ++budget.nodes > MAX_NODES) throw failure("CONFIG_FILE_INVALID");
		const mapped = sources.get(JSON.stringify(parts));
		if (mapped !== undefined) before = mapped;
		if (Array.isArray(after)) {
			const previous = Array.isArray(before) ? before : [];
			return after.map(function (entry, index) {
				let original = previous[index];
				if (isRecord(entry) && typeof entry.id === "string") {
					const matches = previous.filter(function (item) { return isRecord(item) && item.id === entry.id; });
					original = matches.length === 1 ? matches[0] : undefined;
				} else if (isRecord(entry) || Array.isArray(entry)) {
					/* An unkeyed item's old position cannot identify its credential after a reorder. Only an
					 * exact sanitized match proves identity; edited ambiguous items must supply fresh values. */
					const matches = previous.filter(function (item) {
						const copy = structuredClone(item);
						collectSecrets(copy);
						return JSON.stringify(copy) === JSON.stringify(entry);
					});
					original = matches.length === 1 ? matches[0] : undefined;
				}
				return restoreDocument(original, entry, depth + 1, budget, parts.concat(String(index)), sources);
			});
		}
		if (isRecord(after) === false) return after;
		const prior = isRecord(before) ? before : {};
		const result = {};
		for (const key of new Set(Object.keys(after).concat(Object.keys(prior).filter(function (key) { return SECRET_KEY.test(key); })))) {
			if (RESERVED.test(key)) throw failure("CONFIG_FILE_INVALID");
			const next = after[key];
			if (SECRET_KEY.test(key)) {
				if (next === undefined || next === null || next === "" || next === "configured" || next === "missing") {
					if (Object.prototype.hasOwnProperty.call(prior, key)) result[key] = structuredClone(prior[key]);
					else if (next === "configured") throw failure("CONFIG_FILE_INVALID");
				} else {
					if (typeof next !== "string") throw failure("CONFIG_FILE_INVALID");
					result[key] = next;
				}
			} else result[key] = restoreDocument(prior[key], next, depth + 1, budget, parts.concat(key), sources);
		}
		return result;
	}
	function atPath(data, parts) {
		if (Array.isArray(parts) === false || parts.length < 1 || parts.length > MAX_DEPTH) throw failure("CONFIG_FILE_INVALID");
		let value = data;
		for (const part of parts) {
			if (typeof part !== "string" || part.length > 512 || RESERVED.test(part) || SECRET_KEY.test(part) || (isRecord(value) === false && Array.isArray(value) === false) || Object.prototype.hasOwnProperty.call(value, part) === false) throw failure("CONFIG_FILE_INVALID");
			value = value[part];
		}
		if (isRecord(value) === false) throw failure("CONFIG_FILE_INVALID");
		return value;
	}
	function replace(value) {
		const file = fileKey(value, ["file", "expectedVersion", "data", "secretSources"]);
		if (typeof value.expectedVersion !== "string" || /^[0-9a-f]{64}$/.test(value.expectedVersion) === false) throw failure("CONFIG_VERSION_CONFLICT");
		if (isRecord(value.data) === false || Array.isArray(value.secretSources) === false || value.secretSources.length > 200) throw failure("CONFIG_FILE_INVALID");
		validatePatch(value.data, 0, { nodes: 0 });
		encode(value.data);
		const target = agentDirectory() + "/" + FILES[file];
		const current = readBytes(target);
		const bytes = current === null ? defaultBytes(file) : current;
		if (sha256(bytes) !== value.expectedVersion) throw failure("CONFIG_VERSION_CONFLICT");
		const before = parseData(bytes);
		validateFile(file, before);
		const sources = new Map();
		for (const source of value.secretSources) {
			if (isRecord(source) === false || Object.keys(source).sort().join(",") !== "from,to") throw failure("CONFIG_FILE_INVALID");
			const original = atPath(before, source.from);
			atPath(value.data, source.to);
			const key = JSON.stringify(source.to);
			if (sources.has(key)) throw failure("CONFIG_FILE_INVALID");
			sources.set(key, original);
		}
		const next = restoreDocument(before, value.data, 0, { nodes: 0 }, [], sources);
		validateFile(file, next);
		const writtenBytes = Buffer.from(encode(next), "utf8");
		snapshot(file, writtenBytes);
		writeAtomic(target, writtenBytes);
		let written = null;
		try { written = readBytes(target); } catch { throw failure("CONFIG_RESULT_UNCONFIRMED"); }
		if (written === null || sha256(written) !== sha256(writtenBytes)) throw failure("CONFIG_RESULT_UNCONFIRMED");
		try { return snapshot(file, written); } catch { throw failure("CONFIG_RESULT_UNCONFIRMED"); }
	}
	return { read: read, patch: patch, replace: replace, readAuth: readAuth, replaceAuth: replaceAuth };
}
`.replace(/\r?\n[\t ]*/g, "");

/** sha256 of REMOTE_CONFIG_SOURCE as UTF-8 bytes; pinned here and re-checked by the helper contract tests. */
export const REMOTE_HELPER_CONFIG_SHA256 = "e97358029fd537242cce7f3b5407b8b093bc965380b00011d4b3f975455e36b9";
