/**
 * Fixed resource domain, shipped and hashed with the existing SSH helper.
 *
 * Two closed layers share one relative reference language: the host's global user resources
 * ('~/.pi/agent/skills', '~/.agents/skills', '~/.pi/agent/prompts', '~/.pi/agent/extensions') and one
 * project's own resources ('<root>/.pi/skills', '<root>/.agents/skills', '<root>/.pi/prompts',
 * '<root>/.pi/extensions'). The scope is an explicit request field, never inferred from the path: the same
 * '{ root, path }' reference names a different absolute file in each layer, and a caller that forgot the
 * scope must be refused instead of silently writing the global layer (2026-11 project management defect).
 *
 * The project root is the one the helper process was started with, so a project layer can never address a
 * sibling project: there is no path field to escape it.
 */
export const REMOTE_RESOURCE_SOURCE = String.raw`"use strict";
export function createResourceScope(home, root, fs, path, crypto, createConfig, config) {
	const ROOTS = { skills: ".pi/agent/skills", "agents-skills": ".agents/skills", prompts: ".pi/agent/prompts", extensions: ".pi/agent/extensions" };
	const PROJECT_ROOTS = { skills: ".pi/skills", "agents-skills": ".agents/skills", prompts: ".pi/prompts", extensions: ".pi/extensions" };
	const MAX_BYTES = 1048576, MAX_TOTAL = 4194304, MAX_ENTRIES = 2000, MAX_DEPTH = 12;
	const CONTROL = /[\u0000-\u001f\u007f]/, HEX = /^[0-9a-f]{64}$/;
	let projectConfig = null;
	function fail(code) { throw new Error(code); }
	function record(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
	function keys(value, expected) { if (!record(value) || Object.keys(value).sort().join(",") !== expected.slice().sort().join(",")) fail("RESOURCE_INPUT_INVALID"); }
	/* Every mutation may name the layer; 'list' is the only read that must.
	   A request without 'scope' keeps the historical global meaning, so an older caller cannot start writing
	   project files by accident either. */
	function keysScoped(value, expected) {
		if (!record(value)) fail("RESOURCE_INPUT_INVALID");
		const actual = Object.keys(value).sort().join(","), bare = expected.slice().sort().join(","), scoped = expected.concat(["scope"]).sort().join(",");
		if (actual !== bare && actual !== scoped) fail("RESOURCE_INPUT_INVALID");
	}
	function scopeOf(value) {
		if (!record(value) || value.scope === undefined) return "global";
		if (value.scope !== "global" && value.scope !== "project") fail("RESOURCE_INPUT_INVALID");
		return value.scope;
	}
	function baseFor(scope) {
		if (scope !== "project") return home;
		if (typeof root !== "string" || root.length === 0 || root.length > 4096 || root[0] !== "/" || CONTROL.test(root)) fail("RESOURCE_UNAVAILABLE");
		return root;
	}
	/* pi reads a project's own '.pi/settings.json'; the project layer therefore reuses the config scope with a
	   different agent directory instead of growing a second settings implementation. */
	function settingsFor(scope) {
		if (scope !== "project") return config;
		if (projectConfig === null) projectConfig = createConfig(baseFor(scope), fs, path, crypto, ".pi");
		return projectConfig;
	}
	function digest(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
	function named(target) { try { return fs.lstatSync(target, { bigint: true }); } catch (error) { if (error && error.code === "ENOENT") return null; fail("RESOURCE_UNAVAILABLE"); } }
	function directory(target, create) {
		let stats = named(target);
		if (stats === null && create) { try { fs.mkdirSync(target, { mode: 448 }); } catch { fail("RESOURCE_UNAVAILABLE"); } stats = named(target); }
		if (stats === null) return false;
		if (!stats.isDirectory() || stats.isSymbolicLink()) fail("RESOURCE_PATH_INVALID");
		return true;
	}
	function rootFor(scope, kind, create) {
		const base = baseFor(scope), roots = scope === "project" ? PROJECT_ROOTS : ROOTS;
		if (typeof base !== "string" || base[0] !== "/" || base.length > 4096 || CONTROL.test(base) || !Object.hasOwn(roots, kind)) fail("RESOURCE_PATH_INVALID");
		let current = base;
		for (const part of roots[kind].split("/")) { current += "/" + part; if (!directory(current, create)) return null; }
		return current;
	}
	function relative(value) {
		if (typeof value !== "string" || value.length === 0 || value.length > 1024 || CONTROL.test(value) || /[\\%]/.test(value)) fail("RESOURCE_PATH_INVALID");
		const parts = value.split("/");
		if (parts.length > MAX_DEPTH || parts.some(function (part) { return !part || part === "." || part === ".." || part.startsWith(".") || part === "node_modules"; })) fail("RESOURCE_PATH_INVALID");
		return parts;
	}
	function locate(ref, create, scope) {
		keys(ref, ["root", "path"]);
		const parts = relative(ref.path), directoryRoot = rootFor(scope, ref.root, create);
		const leaf = parts[parts.length - 1];
		if (ref.root === "extensions" ? !/\.(?:[cm]?js|ts|json)$/i.test(leaf) : ref.root === "prompts" ? !/\.md$/i.test(leaf) : leaf !== "SKILL.md" && !(ref.root === "skills" && parts.length === 1 && /\.md$/i.test(leaf))) fail("RESOURCE_PATH_INVALID");
		if (directoryRoot === null) fail("RESOURCE_NOT_FOUND");
		let parent = directoryRoot;
		for (const part of parts.slice(0, -1)) { parent += "/" + part; if (!directory(parent, create)) fail("RESOURCE_NOT_FOUND"); }
		const absolute = parent + "/" + parts[parts.length - 1];
		return { absolute: absolute, root: directoryRoot, parts: parts };
	}
	function bytes(target) {
		const stats = named(target);
		if (stats === null) fail("RESOURCE_NOT_FOUND");
		if (!stats.isFile() || stats.isSymbolicLink()) fail("RESOURCE_PATH_INVALID");
		if (Number(stats.size) > MAX_BYTES) fail("RESOURCE_TOO_LARGE");
		let fd;
		try {
			fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
			const opened = fs.fstatSync(fd, { bigint: true });
			if (!opened.isFile() || opened.dev !== stats.dev || opened.ino !== stats.ino || Number(opened.size) > MAX_BYTES) fail("RESOURCE_PATH_INVALID");
			const data = Buffer.alloc(Number(opened.size));
			let offset = 0;
			while (offset < data.length) { const count = fs.readSync(fd, data, offset, data.length - offset, offset); if (count < 1) fail("RESOURCE_UNAVAILABLE"); offset += count; }
			if (data.length > MAX_BYTES || data.includes(0)) fail("RESOURCE_TOO_LARGE");
			return data;
		} finally { if (fd !== undefined) fs.closeSync(fd); }
	}
	/* ignoreBOM: the version is the sha256 of the raw bytes, so the decoded string must re-encode to those same bytes.
	   Default TextDecoder drops a leading BOM, which made every BOM-prefixed SKILL.md / prompt fail the main-side
	   version check and took the whole resources.list down with PI_RESOURCE_FILE_INVALID (2026-11-19). */
	function text(data) { try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data); } catch { fail("RESOURCE_INPUT_INVALID"); } }
	/* One stray file must not take the whole domain down: an entry pi cannot read as text (invalid UTF-8, byte NUL,
	   over the per-file cap, or gone between readdir and read) is skipped exactly like a link, and the caller still
	   gets every other skill/prompt/extension. 2026-11-19: a single such file answered PI_RESOURCE_FILE_INVALID for
	   resources.list, so the entire remote Agent-capability page was dead. */
	function tolerable(run) { try { return run(); } catch (error) { const code = error !== null && typeof error === "object" ? error.message : ""; if (code === "RESOURCE_INPUT_INVALID" || code === "RESOURCE_TOO_LARGE" || code === "RESOURCE_NOT_FOUND" || code === "RESOURCE_PATH_INVALID") return null; throw error; } }
	function read(ref, scope) {
		const target = locate(ref, false, scope), data = bytes(target.absolute);
		return { root: ref.root, path: ref.path, content: text(data), version: digest(data) };
	}
	function list(value) {
		const scope = scopeOf(value);
		const files = [], budget = { entries: 0, total: 0 };
		function walk(root, base, prefix, depth) {
			if (depth > MAX_DEPTH) fail("RESOURCE_TOO_LARGE");
			const dir = fs.opendirSync(base);
			try {
				for (;;) {
					const entry = dir.readSync(); if (entry === null) break;
					if (++budget.entries > MAX_ENTRIES) fail("RESOURCE_TOO_LARGE");
					if (entry.name.startsWith(".") || ["node_modules", "dist", "build", "vendor"].includes(entry.name)) continue;
					const absolute = base + "/" + entry.name, rel = prefix + entry.name, stats = named(absolute);
					if (stats === null || stats.isSymbolicLink()) continue;
					if (stats.isDirectory()) { walk(root, absolute, rel + "/", depth + 1); continue; }
					if (!stats.isFile()) continue;
					const allowed = root === "prompts" ? /\.md$/i.test(entry.name) : root === "extensions" ? /\.(?:[cm]?js|ts|json)$/i.test(entry.name) : entry.name === "SKILL.md" || depth === 0 && root === "skills" && /\.md$/i.test(entry.name);
					if (!allowed) continue;
					const file = tolerable(function () { return read({ root: root, path: rel }, scope); });
					if (file === null) continue;
					budget.total += Buffer.byteLength(file.content, "utf8"); if (budget.total > MAX_TOTAL) fail("RESOURCE_TOO_LARGE");
					files.push(file);
				}
			} finally { dir.closeSync(); }
		}
		for (const root of Object.keys(scope === "project" ? PROJECT_ROOTS : ROOTS)) { const absolute = rootFor(scope, root, false); if (absolute !== null) walk(root, absolute, "", 0); }
		files.sort(function (a, b) { return (a.root + "/" + a.path).localeCompare(b.root + "/" + b.path); });
		const settings = settingsFor(scope).read({ file: "settings" });
		return { home: home, scope: scope, projectRoot: scope === "project" ? baseFor(scope) : null, files: files, settings: settings.data, settingsVersion: settings.version, discovery: discover(settings.data, budget, scope) };
	}
	/* Discovery follows only paths declared by the host's settings, and never grants them file-write access. */
	/* Project-level "disabled inherited resources" are the same native '-<path>' rules pi reads; the page shows
	   them as overrides so a project can switch a global skill off without touching the host's files. */
	function overrides(settings) {
		const result = { disabledGlobalSkills: [], disabledGlobalPrompts: [], disabledGlobalExtensions: [] };
		const fields = { skills: "disabledGlobalSkills", prompts: "disabledGlobalPrompts", extensions: "disabledGlobalExtensions" };
		for (const kind of Object.keys(fields)) {
			const seen = new Set();
			for (const entry of Array.isArray(settings[kind]) ? settings[kind] : []) {
				if (typeof entry !== "string" || !entry.startsWith("-")) continue;
				const value = entry.slice(1).trim();
				/* Legacy identity keys ('pi-global:<name>') are not paths pi can match, so they never disabled anything. */
				if (!value || /^(?:pi-global|agents-global):/.test(value) || seen.has(value)) continue;
				seen.add(value);
				result[fields[kind]].push(kind === "extensions" ? value : value.toLowerCase());
			}
		}
		return result;
	}
	function discover(settings, budget, scope) {
		const result = { projectResourcesAllowed: false, overrides: overrides(settings), skills: [], prompts: [], extensions: [] }, seen = new Set();
		/* A project layer discovers the paths its own settings declare, so the page can show them read-only next
		   to the project's managed directories. '~' still means the host HOME in both layers. */
		const base = scope === "project" ? baseFor(scope) + "/.pi" : home + "/.pi/agent";
		const managed = Object.values(scope === "project" ? PROJECT_ROOTS : ROOTS).map(function (entry) { return baseFor(scope) + "/" + entry; });
		if (scope === "project") result.projectResourcesAllowed = true;
		function resolve(value, from) {
			if (typeof value !== "string" || !value || value.length > 4096 || CONTROL.test(value) || value.includes("\\")) return null;
			if (value.startsWith("file://")) { try { const url = new URL(value); if (url.hostname) return null; value = decodeURIComponent(url.pathname); } catch { return null; } }
			else if (value.startsWith("file:")) value = value.slice(5);
			if (value === "~") value = home;
			else if (value.startsWith("~/")) value = home + value.slice(1);
			return path.resolve(from, value);
		}
		function safe(target) {
			let current = "";
			for (const part of target.split("/").filter(Boolean)) { current += "/" + part; const stats = named(current); if (stats === null || stats.isSymbolicLink()) return null; }
			return named(target);
		}
		function match(file, pattern, from, exact) {
			const normalized = resolve(pattern.replace(/^\.\//, ""), from);
			if (normalized === null) return false;
			const parent = file.endsWith("/SKILL.md") ? path.dirname(file) : "";
			if (exact) return normalized === file || normalized === parent;
			const regex = new RegExp("^" + pattern.replace(/[$.+^{}()|[\]\\]/g, "\\$&").replace(/\*\*\//g, "\u0002").replace(/\*\*/g, "\u0001").replace(/\*/g, "[^/]*").replace(/\u0001/g, ".*").replace(/\u0002/g, "(?:.*/)?").replace(/\?/g, "[^/]") + "$");
			return [file, path.relative(from, file), path.basename(file), parent, parent && path.relative(from, parent), parent && path.basename(parent)].some(function (value) { return value && regex.test(value); }) || normalized === file || normalized === parent || !/[*?]/.test(pattern) && file.startsWith(normalized + "/");
		}
		function filtered(file, rules, from, includes) {
			if (!Array.isArray(rules)) return true;
			const plain = rules.filter(function (entry) { return typeof entry === "string" && !/^[!+-]/.test(entry); });
			let enabled = !includes || plain.length === 0 || plain.some(function (rule) { return match(file, rule, from, false); });
			for (const prefix of ["!", "+", "-"]) if (rules.some(function (rule) { return typeof rule === "string" && rule[0] === prefix && match(file, rule.slice(1), from, prefix !== "!"); })) enabled = prefix === "+";
			return enabled;
		}
		function header(content, key) {
			const body = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(content), value = body && new RegExp("^" + key + ":\\s*(.*)$", "m").exec(body[1]);
			if (!value) return "";
			try { const parsed = JSON.parse(value[1]); return typeof parsed === "string" ? parsed : String(parsed); } catch { return value[1].trim().replace(/^['"]|['"]$/g, ""); }
		}
		function add(kind, target, sourceId, label, packageRoot, filters, manifestRules) {
			const identity = kind + ":" + target; if (seen.has(identity)) return;
			if (!(kind === "skills" ? target.endsWith("/SKILL.md") || /\.md$/i.test(target) : kind === "prompts" ? /\.md$/i.test(target) : /\.(?:[cm]?js|ts)$/i.test(target))) return;
			seen.add(identity);
			const content = tolerable(function () { return text(bytes(target)); }); if (content === null) return;
			budget.total += Buffer.byteLength(content, "utf8"); if (budget.total > MAX_TOTAL) fail("RESOURCE_TOO_LARGE");
			const enabled = filtered(target, settings[kind], base, false) && (filters === undefined || Array.isArray(filters) && filters.length > 0 && filtered(target, filters, packageRoot, true)) && filtered(target, manifestRules, packageRoot, true);
			const description = kind === "extensions" ? "" : header(content, "description");
			if (kind === "skills") { const name = header(content, "name") || path.basename(path.dirname(target)); result.skills.push({ id: sourceId + ":" + target, name: name, path: target, dir: path.dirname(target), sourceId: sourceId, sourceLabel: label, description: description, userOnly: header(content, "disable-model-invocation") === "true", enabled: enabled, managed: true }); }
			if (kind === "prompts") result.prompts.push({ name: path.basename(target, ".md"), path: target, sourceId: sourceId, sourceLabel: label, description: description, enabled: enabled, managed: true });
			if (kind === "extensions") result.extensions.push({ source: label, path: target, sourceId: sourceId, sourceLabel: label, physicalScope: scope === "project" ? "project" : "user", enabled: enabled, managed: true });
		}
		function collect(kind, target, sourceId, label, packageRoot, filters, manifestRules, depth) {
			if (depth > MAX_DEPTH || ++budget.entries > MAX_ENTRIES) fail("RESOURCE_TOO_LARGE");
			const stats = safe(target); if (stats === null) return;
			if (stats.isFile()) { add(kind, target, sourceId, label, packageRoot, filters, manifestRules); return; }
			if (!stats.isDirectory()) return;
			const dir = fs.opendirSync(target);
			try { for (;;) { const entry = dir.readSync(); if (entry === null) break; if (entry.name.startsWith(".") || ["node_modules", "dist", "build", "vendor"].includes(entry.name)) continue; collect(kind, target + "/" + entry.name, sourceId, label, packageRoot, filters, manifestRules, depth + 1); } } finally { dir.closeSync(); }
		}
		function declaredPath(value, from) {
			if (!/[*?]/.test(value)) return resolve(value, from);
			const before = value.slice(0, value.search(/[*?]/)), slash = before.lastIndexOf("/");
			return resolve(slash < 0 ? "." : before.slice(0, slash) || "/", from);
		}
		for (const kind of ["skills", "prompts", "extensions"]) {
			for (const entry of Array.isArray(settings[kind]) ? settings[kind] : []) {
				if (typeof entry !== "string" || /^[!+-]/.test(entry) || entry.startsWith("builtin:")) continue;
				const target = declaredPath(entry, base); if (target !== null && !managed.some(function (root) { return target === root || target.startsWith(root + "/"); })) collect(kind, target, "settings-user", "settings." + kind, base, [entry], undefined, 0);
			}
		}
		for (const entry of Array.isArray(settings.packages) ? settings.packages : []) {
			const source = typeof entry === "string" ? entry : record(entry) && entry.source;
			if (typeof source !== "string") continue;
			let root = null;
			if (source.startsWith("npm:")) { const name = /^(@[^/@]+\/[^/@]+|[^/@]+)(?:@[^/]+)?$/.exec(source.slice(4)); if (name && !name[1].split("/").some(function (part) { return part === "." || part === ".."; })) root = base + "/npm/node_modules/" + name[1]; }
			else if (/^(?:github:|git:|https?:\/\/)/.test(source)) {
				try { const value = source.startsWith("github:") ? "https://github.com/" + source.slice(7) : source.replace(/^git:/, ""); const url = new URL(value), rel = url.pathname.replace(/^\//, "").replace(/(?:\.git)?(?:[@#].*)?$/, ""); if (rel.split("/").length >= 2 && !rel.split("/").some(function (part) { return !part || part === ".."; })) root = base + "/git/" + url.hostname + "/" + rel; } catch {} }
			else root = resolve(source, base);
			if (root === null || safe(root) === null) continue;
			let manifest = null;
			if (safe(root + "/package.json")) { try { const parsed = JSON.parse(text(bytes(root + "/package.json"))); if (record(parsed.pi)) manifest = parsed.pi; } catch {} }
			for (const kind of ["skills", "prompts", "extensions"]) {
				const declared = manifest && manifest[kind], entries = Array.isArray(declared) ? declared.filter(function (item) { return typeof item === "string" && !/^[!+-]/.test(item); }) : manifest ? [] : [kind];
				for (const item of entries) { const target = declaredPath(item, root); if (target !== null && (target === root || target.startsWith(root + "/"))) collect(kind, target, "package-user", source, root, record(entry) ? entry[kind] : undefined, declared, 0); }
			}
		}
		return result;
	}
	function contentBytes(value) {
		if (typeof value !== "string" || value.includes("\u0000")) fail("RESOURCE_INPUT_INVALID");
		const data = Buffer.from(value, "utf8"); if (data.length > MAX_BYTES) fail("RESOURCE_TOO_LARGE"); return data;
	}
	function version(value, current) { if (typeof value !== "string" || !HEX.test(value) || value !== current) fail("RESOURCE_VERSION_CONFLICT"); }
	function syncDirectory(target) { let fd; try { fd = fs.openSync(path.dirname(target), "r"); fs.fsyncSync(fd); } catch {} finally { if (fd !== undefined) fs.closeSync(fd); } }
	function write(value, create) {
		keysScoped(value, create ? ["ref", "content"] : ["ref", "content", "expectedVersion"]);
		const scope = scopeOf(value), data = contentBytes(value.content), target = locate(value.ref, true, scope);
		if (create && named(target.absolute) !== null) fail("RESOURCE_VERSION_CONFLICT");
		if (!create) version(value.expectedVersion, read(value.ref, scope).version);
		const temp = target.absolute + ".tmp-" + crypto.randomBytes(8).toString("hex");
		let fd, published = false;
		try {
			fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 384);
			fs.writeFileSync(fd, data); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
			if (create) { fs.linkSync(temp, target.absolute); published = true; fs.unlinkSync(temp); }
			else { fs.renameSync(temp, target.absolute); published = true; }
			syncDirectory(target.absolute);
			const result = read(value.ref, scope); if (result.version !== digest(data)) fail("RESOURCE_RESULT_UNCONFIRMED"); return result;
		} catch (error) { if (published) fail("RESOURCE_RESULT_UNCONFIRMED"); if (error && error.code === "EEXIST") fail("RESOURCE_VERSION_CONFLICT"); throw error; }
		finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch {} } try { fs.unlinkSync(temp); } catch {} }
	}
	function rename(value) {
		keysScoped(value, ["ref", "expectedVersion", "name"]);
		const scope = scopeOf(value), settings = settingsFor(scope);
		const current = read(value.ref, scope); version(value.expectedVersion, current.version);
		const name = relative(value.name); if (name.length !== 1) fail("RESOURCE_PATH_INVALID");
		const target = locate(value.ref, false, scope), isSkill = value.ref.root === "skills" || value.ref.root === "agents-skills";
		const moveDirectory = isSkill && target.parts.length > 1 && target.parts[target.parts.length - 1] === "SKILL.md";
		const source = moveDirectory ? path.dirname(target.absolute) : target.absolute;
		const destination = path.dirname(source) + "/" + value.name;
		if (named(destination) !== null) fail("RESOURCE_VERSION_CONFLICT");
		if (moveDirectory) checkTree(source, 0, { count: 0 });
		const settingsFile = settings.read({ file: "settings" });
		fs.renameSync(source, destination);
		const newPath = moveDirectory ? target.parts.slice(0, -2).concat(value.name, "SKILL.md").join("/") : target.parts.slice(0, -1).concat(value.name).join("/");
		try {
			const ref = { root: value.ref.root, path: newPath };
			let result = read(ref, scope);
			if (isSkill) {
				const skillName = value.name.replace(/\.md$/i, "");
				const content = result.content.replace(/^(---\r?\n)([\s\S]*?)(\r?\n---)/, function (_, start, body, end) { return start + (/^name\s*:/m.test(body) ? body.replace(/^name\s*:.*$/m, "name: " + JSON.stringify(skillName)) : "name: " + JSON.stringify(skillName) + "\n" + body) + end; });
				result = write({ ref: ref, expectedVersion: result.version, content: content, scope: scope }, false);
			}
			const kind = isSkill ? "skills" : value.ref.root;
			if (Array.isArray(settingsFile.data[kind])) {
				const oldFile = target.absolute, newFile = locate(ref, false, scope).absolute;
				const entries = settingsFile.data[kind].map(function (entry) {
					if (typeof entry !== "string") fail("RESOURCE_INPUT_INVALID");
					const prefix = /^[+!-]/.test(entry) ? entry[0] : "", item = prefix ? entry.slice(1) : entry;
					return item === oldFile ? prefix + newFile : item === source ? prefix + destination : entry;
				});
				settings.patch({ file: "settings", expectedVersion: settingsFile.version, patch: { [kind]: entries } });
			}
			return result;
		} catch { fail("RESOURCE_RESULT_UNCONFIRMED"); }
	}
	function checkTree(target, depth, budget) {
		if (depth > MAX_DEPTH || ++budget.count > MAX_ENTRIES) fail("RESOURCE_TOO_LARGE");
		const stats = named(target); if (stats === null || stats.isSymbolicLink()) fail("RESOURCE_PATH_INVALID");
		if (stats.isFile()) return;
		if (!stats.isDirectory()) fail("RESOURCE_PATH_INVALID");
		const dir = fs.opendirSync(target);
		try { for (;;) { const entry = dir.readSync(); if (entry === null) break; checkTree(target + "/" + entry.name, depth + 1, budget); } } finally { dir.closeSync(); }
	}
	function remove(value) {
		keysScoped(value, ["ref", "expectedVersion"]);
		const scope = scopeOf(value);
		version(value.expectedVersion, read(value.ref, scope).version);
		const target = locate(value.ref, false, scope), isSkill = value.ref.root === "skills" || value.ref.root === "agents-skills";
		const source = isSkill && target.parts.length > 1 && target.parts[target.parts.length - 1] === "SKILL.md" ? path.dirname(target.absolute) : target.absolute;
		checkTree(source, 0, { count: 0 });
		const trash = target.root + "/.pideck-trash"; directory(trash, true);
		const destination = trash + "/" + Date.now() + "-" + crypto.randomBytes(8).toString("hex") + "-" + path.basename(source);
		fs.renameSync(source, destination);
		if (named(source) !== null || named(destination) === null) fail("RESOURCE_RESULT_UNCONFIRMED");
		return { applied: true };
	}
	/* File toggles only address a verified resource; native settings rules determine what Pi loads. */
	function toggle(value) {
		keysScoped(value, ["ref", "expectedVersion", "enabled"]);
		if (typeof value.enabled !== "boolean") fail("RESOURCE_INPUT_INVALID");
		const scope = scopeOf(value), settings = settingsFor(scope);
		const target = locate(value.ref, false, scope); read(value.ref, scope);
		const kind = value.ref.root === "agents-skills" ? "skills" : value.ref.root;
		const file = settings.read({ file: "settings" }); version(value.expectedVersion, file.version);
		const entries = file.data[kind] === undefined ? [] : file.data[kind];
		if (!Array.isArray(entries) || entries.some(function (entry) { return typeof entry !== "string"; })) fail("RESOURCE_INPUT_INVALID");
		const cleaned = entries.filter(function (entry) { return entry !== "+" + target.absolute && entry !== "-" + target.absolute; });
		settings.patch({ file: "settings", expectedVersion: file.version, patch: { [kind]: cleaned.concat((value.enabled ? "+" : "-") + target.absolute) } });
		return { applied: true };
	}
	function builtin(value) {
		keysScoped(value, ["name", "expectedVersion", "enabled"]);
		/* Builtin extensions are a host-level concern: a project layer has no builtin of its own. */
		if (scopeOf(value) === "project") fail("RESOURCE_INPUT_INVALID");
		if (!["mcp", "llama.cpp", "codemode", "tool-search"].includes(value.name) || typeof value.enabled !== "boolean") fail("RESOURCE_INPUT_INVALID");
		const settings = config.read({ file: "settings" }); version(value.expectedVersion, settings.version);
		const entries = settings.data.extensions === undefined ? [] : settings.data.extensions;
		if (!Array.isArray(entries) || entries.some(function (entry) { return typeof entry !== "string"; })) fail("RESOURCE_INPUT_INVALID");
		const name = "builtin:" + value.name;
		config.patch({ file: "settings", expectedVersion: settings.version, patch: { extensions: entries.filter(function (entry) { return entry !== "+" + name && entry !== "-" + name; }).concat((value.enabled ? "+" : "-") + name) } });
		return { applied: true };
	}
	/* A project can switch an *inherited* global resource off without touching the host's files: the rule is
	   written into the project's own .pi/settings.json, which is exactly what pi reads for that project. */
	function toggleInherited(value) {
		keysScoped(value, ["kind", "key", "enabled"]);
		if (scopeOf(value) !== "project") fail("RESOURCE_INPUT_INVALID");
		const FIELDS = { skill: "skills", prompt: "prompts", extension: "extensions" };
		if (!Object.hasOwn(FIELDS, String(value.kind)) || typeof value.enabled !== "boolean") fail("RESOURCE_INPUT_INVALID");
		const key = value.key;
		/* The key is a verified absolute path from an earlier list; anything else (identity keys, globs) is refused
		   rather than written as a rule pi would silently ignore. */
		if (typeof key !== "string" || key.length === 0 || key.length > 4096 || key[0] !== "/" || CONTROL.test(key)) fail("RESOURCE_INPUT_INVALID");
		const field = FIELDS[value.kind], settings = settingsFor("project");
		const file = settings.read({ file: "settings" });
		const entries = file.data[field] === undefined ? [] : file.data[field];
		if (!Array.isArray(entries) || entries.some(function (entry) { return typeof entry !== "string"; })) fail("RESOURCE_INPUT_INVALID");
		const cleaned = entries.filter(function (entry) { return entry !== "+" + key && entry !== "-" + key; });
		settings.patch({ file: "settings", expectedVersion: file.version, patch: { [field]: cleaned.concat((value.enabled ? "+" : "-") + key) } });
		return { applied: true };
	}
	/* Keep selective package filters in a fixed host-only state file, so disable/enable restores them. */
	function togglePackage(value) {
		keysScoped(value, ["source", "expectedVersion", "enabled"]);
		if (typeof value.source !== "string" || value.source.length > 2048 || CONTROL.test(value.source) || typeof value.enabled !== "boolean") fail("RESOURCE_INPUT_INVALID");
		const scope = scopeOf(value), settings = settingsFor(scope);
		const settingsFile = settings.read({ file: "settings" }); version(value.expectedVersion, settingsFile.version);
		if (!Array.isArray(settingsFile.data.packages)) fail("RESOURCE_NOT_FOUND");
		const matches = settingsFile.data.packages.filter(function (entry) { return entry === value.source || record(entry) && entry.source === value.source; });
		if (matches.length !== 1) fail("RESOURCE_NOT_FOUND");
		const extensionsRoot = rootFor(scope, "extensions", true), stateDir = extensionsRoot + "/.pideck-state"; directory(stateDir, true);
		const statePath = stateDir + "/package-filters.json";
		let state = {};
		if (named(statePath) !== null) { try { state = JSON.parse(text(bytes(statePath))); } catch { fail("RESOURCE_INPUT_INVALID"); } }
		if (!record(state)) fail("RESOURCE_INPUT_INVALID");
		const key = digest(Buffer.from(value.source, "utf8")), current = matches[0], kinds = ["extensions", "skills", "prompts", "themes"];
		const disabled = record(current) && kinds.every(function (kind) { return Array.isArray(current[kind]) && current[kind].length === 0; });
		let next = current;
		if (value.enabled && disabled) next = Object.hasOwn(state, key) ? state[key] : value.source;
		if (!value.enabled && !disabled) {
			state[key] = current;
			const temp = statePath + ".tmp-" + crypto.randomBytes(8).toString("hex");
			let fd;
			try { fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 384); fs.writeFileSync(fd, contentBytes(JSON.stringify(state))); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined; fs.renameSync(temp, statePath); }
			finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temp); } catch {} }
			next = Object.assign({}, typeof current === "string" ? { source: current } : current, { extensions: [], skills: [], prompts: [], themes: [] });
		}
		settings.patch({ file: "settings", expectedVersion: settingsFile.version, patch: { packages: settingsFile.data.packages.map(function (entry) { return entry === current ? next : entry; }) } });
		return { applied: true };
	}
	return { list: list, read: function (value) { return read(value.ref, scopeOf(value)); }, create: function (value) { return write(value, true); }, write: function (value) { return write(value, false); }, rename: rename, remove: remove, toggle: toggle, toggleInherited: toggleInherited, togglePackage: togglePackage, builtin: builtin };
}
`.replace(/\r?\n[\t ]*/g, "");

/** Recomputed together with the helper bundle pin whenever the frozen artifact changes. */
export const REMOTE_HELPER_RESOURCE_SHA256 = "ecdcffda8732cd51fd55a57d7ff97344e47ff017cdca3d6cf929f5c44b3d118f";
