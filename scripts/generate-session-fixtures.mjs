#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { access, mkdir, readFile, readdir, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, posix as posixPath } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const FIXTURE_VERSION = 2;
const FIXED_SEED = "pideck-session-first-v1";
const FIXED_TIME = "2026-01-15T08:00:00.000Z";
const FIXED_MTIME = Date.parse(FIXED_TIME) + 123_456;
const DEFAULT_LARGE_BYTES = 50 * 1024 * 1024;
const MARKER = ".pideck-session-fixtures.json";
const MANAGED_ENTRIES = ["sessions", "user-data", "project", "fixture-manifest.json", MARKER];
const SCRIPT_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function normalizeSlashes(value) {
	return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

function pathIsWithin(candidate, root) {
	const rel = relative(resolve(root), resolve(candidate));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function deterministicId(label) {
	return createHash("sha256").update(`${FIXED_SEED}:${label}`).digest("hex").slice(0, 24);
}

function stableTimestamp(index) {
	return new Date(Date.parse(FIXED_TIME) + index * 1_000).toISOString();
}

function sessionHeader(label, cwd) {
	return {
		type: "session",
		version: 3,
		id: deterministicId(`${label}:session`),
		timestamp: FIXED_TIME,
		cwd,
	};
}

function messageEntry(label, index, parentId, text) {
	const id = deterministicId(`${label}:message:${index}`);
	return {
		type: "message",
		id,
		parentId,
		timestamp: stableTimestamp(index + 1),
		message: {
			role: index % 2 === 0 ? "user" : "assistant",
			content: [{ type: "text", text }],
		},
	};
}

export function createSessionJsonl({ label, messageCount, cwd, textSize = 96 }) {
	const header = sessionHeader(label, cwd);
	const lines = [JSON.stringify(header)];
	let parentId = header.id;
	for (let index = 0; index < messageCount; index += 1) {
		const prefix = `${label} deterministic message ${String(index + 1).padStart(5, "0")} `;
		const text = (prefix + "0123456789abcdef".repeat(Math.ceil(textSize / 16))).slice(0, textSize);
		const entry = messageEntry(label, index, parentId, text);
		lines.push(JSON.stringify(entry));
		parentId = entry.id;
	}
	return `${lines.join("\n")}\n`;
}

export function createSizedSessionJsonl({ label, targetBytes = DEFAULT_LARGE_BYTES, cwd }) {
	if (!Number.isSafeInteger(targetBytes) || targetBytes < 4_096) {
		throw new Error("targetBytes must be an integer of at least 4096 bytes");
	}
	const header = sessionHeader(label, cwd);
	const lines = [JSON.stringify(header)];
	let bytes = Buffer.byteLength(`${lines[0]}\n`);
	let parentId = header.id;
	let index = 0;
	const chunkText = "0123456789abcdef".repeat(4_096);
	while (true) {
		const entry = messageEntry(label, index, parentId, chunkText);
		const line = JSON.stringify(entry);
		const lineBytes = Buffer.byteLength(`${line}\n`);
		if (bytes + lineBytes + 512 > targetBytes) break;
		lines.push(line);
		bytes += lineBytes;
		parentId = entry.id;
		index += 1;
	}
	const emptyEntry = messageEntry(label, index, parentId, "");
	const emptyLineBytes = Buffer.byteLength(`${JSON.stringify(emptyEntry)}\n`);
	const remainingTextBytes = targetBytes - bytes - emptyLineBytes;
	if (remainingTextBytes < 0) throw new Error(`Unable to fit final entry into ${targetBytes} bytes`);
	lines.push(JSON.stringify(messageEntry(label, index, parentId, "x".repeat(remainingTextBytes))));
	const content = `${lines.join("\n")}\n`;
	if (Buffer.byteLength(content) !== targetBytes) throw new Error("Sized JSONL byte count mismatch");
	return content;
}

function canonicalPosixPath(value, label = "POSIX path") {
	if (typeof value !== "string" || !value.startsWith("/") || value === "/mnt" || value.startsWith("/mnt/")) {
		throw new Error(`${label} must be an absolute ext4 POSIX path, not /mnt/*`);
	}
	if (value === "/" || value.includes("\\") || value.split("/").some((part) => part === "." || part === "..")) {
		throw new Error(`${label} contains traversal or invalid separators: ${value}`);
	}
	if (posixPath.normalize(value) !== value || value.includes("//")) {
		throw new Error(`${label} is not canonical POSIX: ${value}`);
	}
	return value;
}

export function shellQuote(value) {
	return "'" + String(value).split("'").join("'\"'\"'") + "'";
}

export function buildWslArgs({ distro, user }) {
	if (!distro || !user) throw new Error("distro and user are required");
	return ["-d", distro, "-u", user, "--", "sh", "-s"];
}

export function buildWslInvocation({ distro, user, script }) {
	if (!script) throw new Error("script is required");
	return {
		command: "wsl.exe",
		args: buildWslArgs({ distro, user }),
		options: { input: String(script) },
	};
}

export function isAllowedWslFixtureDir(directory, home) {
	try {
		const canonicalHome = canonicalPosixPath(home, "WSL HOME");
		const canonicalDir = canonicalPosixPath(directory, "WSL fixture directory");
		const sessionsRoot = `${canonicalHome}/.pi/agent/sessions`;
		const prefix = `${sessionsRoot}/`;
		if (!canonicalDir.startsWith(prefix)) return false;
		const leaf = canonicalDir.slice(prefix.length);
		return /^pideck-validation-[a-f0-9]{7,64}$/.test(leaf);
	} catch {
		return false;
	}
}

export function parseWslProbe(stdout) {
	const fields = {};
	for (const line of String(stdout ?? "")
		.trim()
		.split(/\r?\n/)) {
		const separator = line.indexOf("=");
		if (separator > 0) fields[line.slice(0, separator)] = line.slice(separator + 1);
	}
	return fields;
}

export function buildWslProbeScript(user) {
	return [
		"set -eu",
		"raw_home=$HOME",
		'home=$(realpath -- "$raw_home")',
		'test "$raw_home" = "$home"',
		"actual_user=$(whoami)",
		'fstype=$(findmnt -T "$home" -n -o FSTYPE)',
		"command -v pi >/dev/null",
		`test \"$actual_user\" = ${shellQuote(user)}`,
		'test "$fstype" = ext4',
		'case "$home" in /|/mnt|/mnt/*|*/*/../*|*/./*) exit 1 ;; esac',
		'printf \'RAW_HOME=%s\\nHOME=%s\\nUSER=%s\\nFSTYPE=%s\\n\' "$raw_home" "$home" "$actual_user" "$fstype"',
	].join("; ");
}

export function buildWslResetScript({ home, sha }) {
	const canonicalHome = canonicalPosixPath(home, "WSL HOME");
	if (!/^[a-f0-9]{7,64}$/.test(sha)) throw new Error("Invalid fixture SHA for WSL reset");
	const expectedTarget = `${canonicalHome}/.pi/agent/sessions/pideck-validation-${sha}`;
	const expectedProject = `${expectedTarget}/project`;
	return [
		"set -eu",
		"raw_home=$HOME",
		'home=$(realpath -- "$raw_home")',
		'test "$raw_home" = "$home"',
		`test \"$home\" = ${shellQuote(canonicalHome)}`,
		'case "$home" in /|/mnt|/mnt/*) exit 1 ;; esac',
		'test "$(findmnt -T "$home" -n -o FSTYPE)" = ext4',
		`parent=\"$home/.pi/agent/sessions\"; test \"$(realpath -m -- \"$parent\")\" = ${shellQuote(`${canonicalHome}/.pi/agent/sessions`)}`,
		`target=\"$parent/pideck-validation-${sha}\"; test \"$(realpath -m -- \"$target\")\" = ${shellQuote(expectedTarget)}`,
		`if test -e \"$target\" || test -L \"$target\"; then test \"$(realpath -- \"$target\")\" = ${shellQuote(expectedTarget)}; fi`,
		`project=\"$target/project\"; test \"$(realpath -m -- \"$project\")\" = ${shellQuote(expectedProject)}`,
		`if test -e \"$project\" || test -L \"$project\"; then test \"$(realpath -- \"$project\")\" = ${shellQuote(expectedProject)}; fi`,
		`rm -rf -- \"$target\"; mkdir -p -- \"$project\"; test \"$(realpath -- \"$project\")\" = ${shellQuote(expectedProject)}; printf 'PROJECT=%s\\n' \"$project\"`,
	].join("; ");
}

async function defaultWslRunner(command, args, options = {}) {
	const { input, ...execOptions } = options;
	const execution = execFile(command, args, {
		encoding: "utf8",
		maxBuffer: 4 * 1024 * 1024,
		...execOptions,
	});
	if (input !== undefined) {
		if (!execution.child?.stdin) throw new Error("WSL runner stdin is unavailable");
		execution.child.stdin.end(String(input));
	}
	return execution;
}

async function existingPath(path, accessFn = access) {
	try {
		await accessFn(path);
		return true;
	} catch {
		return false;
	}
}

export async function resolvePathBoundary(path, options = {}) {
	const accessFn = options.accessFn ?? access;
	const realpathFn = options.realpathFn ?? realpath;
	let current = resolve(path);
	const suffix = [];
	while (!(await existingPath(current, accessFn))) {
		const parent = dirname(current);
		if (parent === current) break;
		suffix.unshift(basename(current));
		current = parent;
	}
	const realExisting = await realpathFn(current);
	return resolve(realExisting, ...suffix);
}

export async function assertSafeOutputDir(outputDir, options = {}) {
	if (!outputDir || !isAbsolute(outputDir)) throw new Error("--output must be an explicit absolute path");
	const output = resolve(outputDir);
	const home = resolve(options.homeDir ?? homedir());
	const repoRoot = resolve(options.repoRoot ?? SCRIPT_REPO_ROOT);
	const userProfile = options.userProfile ?? process.env.USERPROFILE;
	const forbiddenRoots = [repoRoot, home, userProfile, options.appDataDir ?? process.env.APPDATA, options.localAppDataDir ?? process.env.LOCALAPPDATA, options.userDataDir, ...(options.forbiddenRoots ?? [])].filter(Boolean).map((root) => resolve(root));
	if (resolve(output, "..") === output) throw new Error(`Refusing to use filesystem root: ${output}`);
	const outputReal = await resolvePathBoundary(output, options);
	const homeReal = await resolvePathBoundary(home, options).catch(() => home);
	if (output === home || outputReal === homeReal) {
		throw new Error(`Refusing to use the real home directory: ${output}`);
	}
	for (const root of forbiddenRoots) {
		const rootReal = await resolvePathBoundary(root, options).catch(() => root);
		if (pathIsWithin(output, root) || pathIsWithin(outputReal, rootReal)) {
			throw new Error(`Refusing output inside protected path: ${output}`);
		}
	}
	return output;
}

export async function prepareOutputDirectory(outputDir) {
	await mkdir(outputDir, { recursive: true });
	const entries = await readdir(outputDir);
	if (entries.length > 0 && !entries.includes(MARKER)) throw new Error(`Refusing to clean unmarked output directory: ${outputDir}`);
	if (entries.includes(MARKER)) {
		const marker = JSON.parse(await readFile(join(outputDir, MARKER), "utf8"));
		if (marker.version !== FIXTURE_VERSION || resolve(marker.outputDir) !== resolve(outputDir)) throw new Error(`Fixture marker does not own output directory: ${outputDir}`);
		for (const entry of MANAGED_ENTRIES) await rm(join(outputDir, entry), { recursive: true, force: true });
	}
	await mkdir(outputDir, { recursive: true });
}

function originKey({ source, environment, filePath, distro, user, importedSourceId }) {
	const environmentKey = environment === "wsl" ? `wsl:${distro}:${user}` : "native";
	const canonicalPath = environment === "native" ? normalizeSlashes(filePath).toLowerCase() : normalizeSlashes(filePath);
	return `${source}:${environmentKey}:${canonicalPath}${importedSourceId ? `:${encodeURIComponent(importedSourceId)}` : ""}`;
}

async function probeWsl({ distro, user, expectedHome, runner }) {
	const invocation = buildWslInvocation({ distro, user, script: buildWslProbeScript(user) });
	const result = await runner(invocation.command, invocation.args, invocation.options);
	const fields = parseWslProbe(result.stdout);
	const home = canonicalPosixPath(fields.HOME, "WSL HOME");
	if (fields.RAW_HOME !== home) throw new Error(`WSL HOME realpath mismatch: ${fields.RAW_HOME ?? "<empty>"} -> ${home}`);
	if (fields.USER !== user) throw new Error(`WSL user mismatch: expected ${user}, got ${fields.USER ?? "<empty>"}`);
	if (fields.FSTYPE !== "ext4") throw new Error(`WSL filesystem is not ext4: ${fields.FSTYPE ?? "<empty>"}`);
	if (expectedHome && canonicalPosixPath(expectedHome, "--wsl-root") !== home) throw new Error(`WSL root mismatch: expected ${expectedHome}, got ${home}`);
	return home;
}

async function writeWslIdentityFixtures({ distro, user, home, sha, runner }) {
	const directory = `${home}/.pi/agent/sessions/pideck-validation-${sha}`;
	const projectCwd = `${directory}/project`;
	if (!isAllowedWslFixtureDir(directory, home)) throw new Error(`Refusing unsafe WSL fixture directory: ${directory}`);
	const reset = buildWslInvocation({ distro, user, script: buildWslResetScript({ home, sha }) });
	await runner(reset.command, reset.args, reset.options);
	const upper = createSessionJsonl({ label: "wsl-identity-upper", messageCount: 2, cwd: projectCwd });
	const lower = createSessionJsonl({ label: "wsl-identity-lower", messageCount: 2, cwd: projectCwd });
	for (const [name, content] of [
		["Case.jsonl", upper],
		["case.jsonl", lower],
	]) {
		const filePath = `${directory}/${name}`;
		const write = buildWslInvocation({
			distro,
			user,
			script: `set -eu; printf %s ${shellQuote(content)} > ${shellQuote(filePath)}`,
		});
		await runner(write.command, write.args, write.options);
	}
	return { directory, projectCwd, paths: [`${directory}/Case.jsonl`, `${directory}/case.jsonl`] };
}

function buildCodexSource({ projectCwd, importedSourceId }) {
	return (
		[
			{ type: "session_meta", payload: { id: importedSourceId, cwd: projectCwd, timestamp: FIXED_TIME, model_provider: "openai", model: "codex-validation", thread_source: "user" } },
			{ type: "event_msg", timestamp: FIXED_TIME, payload: { type: "user_message", message: "Validate imported session identity" } },
			{ type: "response_item", timestamp: stableTimestamp(1), payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Imported fixture response" }] } },
		]
			.map((entry) => JSON.stringify(entry))
			.join("\n") + "\n"
	);
}

function buildCodexTarget({ sourcePath, sourceMtime, sourceSize, projectCwd, importedSourceId }) {
	const id = (sequence) => createHash("sha1").update(`${importedSourceId}:${sequence}`).digest("hex").slice(0, 8);
	return (
		[
			{ type: "session", version: 3, id: importedSourceId, timestamp: FIXED_TIME, cwd: projectCwd },
			{ sessionName: "Validate imported session identity", cwd: projectCwd },
			{ type: "codex_import", version: 1, codexSessionId: importedSourceId, sourcePath, sourceMtime, sourceSize, importedAt: FIXED_TIME, threadSource: "user", parentThreadId: null, agentRole: null, agentNickname: null },
			{ type: "model_change", id: id(1), parentId: null, timestamp: FIXED_TIME, provider: "openai", modelId: "codex-validation" },
			{ type: "message", id: id(2), parentId: id(1), timestamp: stableTimestamp(1), message: { role: "user", content: [{ type: "text", text: "Validate imported session identity" }] } },
			{
				type: "message",
				id: id(3),
				parentId: id(2),
				timestamp: stableTimestamp(2),
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Imported fixture response" }],
					api: "codex-import",
					provider: "openai",
					model: "codex-validation",
					stopReason: "stop",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				},
			},
		]
			.map((entry) => JSON.stringify(entry))
			.join("\n") + "\n"
	);
}

function catalogEntry({ id, projectId, title, source, environment, filePath, messageCount, originKey: key, importedSourceId, wslDistro, wslUser }) {
	return { id, projectId, originKey: key, title, source, environment, filePath, importedSourceId, wslDistro, wslUser, status: "active", createdAt: Date.parse(FIXED_TIME), updatedAt: Date.parse(FIXED_TIME), preview: title, messageCount };
}

async function writeUserDataTemplate(directory, { settings, projects, sessions }) {
	await mkdir(directory, { recursive: true });
	const primary = join(directory, "session-catalog.json");
	const backup = `${primary}.bak`;
	const corrupt = join(directory, "session-catalog.corrupt.json");
	await Promise.all([
		writeFile(primary, JSON.stringify({ version: 1, sessions }, null, 2), "utf8"),
		writeFile(backup, JSON.stringify({ version: 1, sessions }, null, 2), "utf8"),
		writeFile(corrupt, '{"version":1,"sessions":[', "utf8"),
		writeFile(join(directory, "settings.json"), JSON.stringify(settings, null, 2), "utf8"),
		writeFile(join(directory, "projects.json"), JSON.stringify(projects, null, 2), "utf8"),
	]);
	return { directory, settings: join(directory, "settings.json"), projects: join(directory, "projects.json"), catalog: { primary, backup, corrupt } };
}

function parseArgs(argv) {
	const options = {};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--dry-run") options.dryRun = true;
		else if (["--output", "--sha", "--wsl-distro", "--wsl-user", "--wsl-root"].includes(arg)) {
			const value = argv[index + 1];
			if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
			options[arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
			index += 1;
		} else if (arg === "--help") options.help = true;
		else throw new Error(`Unknown argument: ${arg}`);
	}
	return options;
}

export async function generateSessionFixtures({ outputDir, sha, wslDistro, wslUser, wslRoot, dryRun = false, largeTargetBytes = DEFAULT_LARGE_BYTES, runner = defaultWslRunner, safety = {} }) {
	const output = await assertSafeOutputDir(outputDir, safety);
	if (!/^[a-f0-9]{7,64}$/i.test(sha ?? "")) throw new Error("--sha must be a 7-64 character hex commit SHA");
	const normalizedSha = sha.toLowerCase();
	const wslRequested = Boolean(wslDistro || wslUser || wslRoot);
	if (wslRequested && (!wslDistro || !wslUser)) throw new Error("--wsl-distro and --wsl-user must be provided together");
	if (wslRoot) canonicalPosixPath(wslRoot, "--wsl-root");
	const projectCwd = join(output, "project");
	const plannedWslDir = wslRoot ? `${wslRoot}/.pi/agent/sessions/pideck-validation-${normalizedSha}` : undefined;
	if (dryRun) return { dryRun: true, outputDir: output, managedEntries: [...MANAGED_ENTRIES], wsl: wslRequested ? { distro: wslDistro, user: wslUser, home: wslRoot ?? "<detected-$HOME>", directory: plannedWslDir ?? "<detected-$HOME>/.pi/agent/sessions/pideck-validation-<sha>" } : null };

	// Probe before touching native output, so a rejected WSL target cannot strand an unmarked fixture tree.
	let wslHome;
	if (wslRequested) wslHome = await probeWsl({ distro: wslDistro, user: wslUser, expectedHome: wslRoot, runner });

	await prepareOutputDirectory(output);
	// From here a failed write remains explicitly owned and can be safely regenerated.
	await writeFile(join(output, MARKER), JSON.stringify({ version: FIXTURE_VERSION, outputDir: output, sha: normalizedSha }, null, 2), "utf8");
	const nativeProject = projectCwd;
	const nativeScaleDir = join(output, "sessions", "scale");
	const nativeIdentityDir = join(output, "sessions", "identity", "native");
	const importsDir = join(output, "sessions", "imports");
	await Promise.all([mkdir(nativeScaleDir, { recursive: true }), mkdir(nativeIdentityDir, { recursive: true }), mkdir(importsDir, { recursive: true }), mkdir(nativeProject, { recursive: true })]);
	const scaleFiles = {};
	for (const count of [100, 1_000, 10_000]) {
		const key = String(count);
		const filePath = join(nativeScaleDir, `messages-${key}.jsonl`);
		await writeFile(filePath, createSessionJsonl({ label: `messages-${key}`, messageCount: count, cwd: nativeProject }), "utf8");
		scaleFiles[key] = filePath;
	}
	const largeFile = join(nativeScaleDir, "messages-50mb.jsonl");
	await writeFile(largeFile, createSizedSessionJsonl({ label: "messages-50mb", targetBytes: largeTargetBytes, cwd: nativeProject }), "utf8");
	const nativeUpperPath = join(nativeIdentityDir, "Case.jsonl");
	const nativeLowerPath = join(nativeIdentityDir, "case.jsonl");
	await writeFile(nativeUpperPath, createSessionJsonl({ label: "identity-upper", messageCount: 2, cwd: nativeProject }), "utf8");
	await writeFile(nativeLowerPath, createSessionJsonl({ label: "identity-lower", messageCount: 2, cwd: nativeProject }), "utf8");
	const importedSourceId = "codex-thread-validation-001";
	const importedSourcePath = join(importsDir, "codex-source.jsonl");
	const importedTargetPath = join(importsDir, "codex-native.jsonl");
	await writeFile(importedSourcePath, buildCodexSource({ projectCwd: nativeProject, importedSourceId }), "utf8");
	await utimes(importedSourcePath, FIXED_MTIME / 1000, FIXED_MTIME / 1000);
	const sourceStats = await stat(importedSourcePath);
	await writeFile(importedTargetPath, buildCodexTarget({ sourcePath: importedSourcePath, sourceMtime: sourceStats.mtimeMs, sourceSize: sourceStats.size, projectCwd: nativeProject, importedSourceId }), "utf8");
	let wslIdentity;
	if (wslRequested) {
		wslIdentity = await writeWslIdentityFixtures({ distro: wslDistro, user: wslUser, home: wslHome, sha: normalizedSha, runner });
	}
	const nativeCaseOrigin = originKey({ source: "pi", environment: "native", filePath: nativeUpperPath });
	const importedOrigin = originKey({ source: "codex", environment: "native", filePath: importedTargetPath, importedSourceId });
	const nativeSessions = [
		...Object.entries(scaleFiles).map(([count, filePath]) =>
			catalogEntry({ id: `fixture-native-${count}`, projectId: "fixture-project-native", title: `Native ${count} messages`, source: "pi", environment: "native", filePath, messageCount: Number(count), originKey: originKey({ source: "pi", environment: "native", filePath }) }),
		),
		catalogEntry({ id: "fixture-native-50mb", projectId: "fixture-project-native", title: "Native 50 MiB session", source: "pi", environment: "native", filePath: largeFile, messageCount: 1, originKey: originKey({ source: "pi", environment: "native", filePath: largeFile }) }),
		catalogEntry({ id: "fixture-native-case-folded", projectId: "fixture-project-native", title: "Native case identity", source: "pi", environment: "native", filePath: nativeUpperPath, messageCount: 2, originKey: nativeCaseOrigin }),
		catalogEntry({ id: "fixture-codex-import", projectId: "fixture-project-native", title: "Imported source identity", source: "codex", environment: "native", filePath: importedTargetPath, messageCount: 2, originKey: importedOrigin, importedSourceId }),
	];
	const nativeUserData = await writeUserDataTemplate(join(output, "user-data", "native"), {
		settings: { language: "en", wslEnabled: false, wslDistro: "Ubuntu", wslUser: "root", telemetryEnabled: false, showDevTools: false },
		projects: [{ id: "fixture-project-native", name: "PiDeck validation native", path: nativeProject, lastOpenedAt: Date.parse(FIXED_TIME), sortOrder: 0, environment: "windows" }],
		sessions: nativeSessions,
	});
	let wslUserData = null;
	if (wslIdentity) {
		const wslSessions = wslIdentity.paths.map((filePath, index) =>
			catalogEntry({
				id: `fixture-wsl-${index ? "lower" : "upper"}`,
				projectId: "fixture-project-wsl",
				title: `WSL ${index ? "case" : "Case"}.jsonl`,
				source: "pi",
				environment: "wsl",
				filePath,
				messageCount: 2,
				originKey: originKey({ source: "pi", environment: "wsl", filePath, distro: wslDistro, user: wslUser }),
				wslDistro,
				wslUser,
			}),
		);
		wslUserData = await writeUserDataTemplate(join(output, "user-data", "wsl"), {
			settings: { language: "en", wslEnabled: true, wslDistro, wslUser, telemetryEnabled: false, showDevTools: false },
			projects: [{ id: "fixture-project-wsl", name: "PiDeck validation WSL", path: wslIdentity.projectCwd, lastOpenedAt: Date.parse(FIXED_TIME), sortOrder: 0, environment: "wsl" }],
			sessions: wslSessions,
		});
	}
	const largeStats = await stat(largeFile);
	const manifest = {
		version: FIXTURE_VERSION,
		seed: FIXED_SEED,
		sha: normalizedSha,
		generatedAt: FIXED_TIME,
		outputDir: output,
		projectCwd: nativeProject,
		scale: {
			messages: Object.fromEntries(Object.entries(scaleFiles).map(([count, filePath]) => [count, { path: filePath, messageCount: Number(count) }])),
			large: { path: largeFile, bytes: largeStats.size, targetBytes: largeTargetBytes },
		},
		userData: { native: nativeUserData, wsl: wslUserData },
		nativeIdentity: {
			paths: [nativeUpperPath, nativeLowerPath],
			source: "pi",
			importedSourceId: null,
			expectedOriginKeys: [nativeCaseOrigin, nativeCaseOrigin],
			expectedIndependentSessionCount: 1,
		},
		importIdentity: {
			sourcePath: importedSourcePath,
			targetPath: importedTargetPath,
			path: importedTargetPath,
			source: "codex",
			importedSourceId,
			expectedOriginKey: importedOrigin,
			sourceMtime: sourceStats.mtimeMs,
			sourceSize: sourceStats.size,
			expectedIndependentSessionCount: 1,
		},
		wslIdentity: wslIdentity
			? {
					distro: wslDistro,
					user: wslUser,
					home: wslHome,
					directory: wslIdentity.directory,
					projectCwd: wslIdentity.projectCwd,
					paths: wslIdentity.paths,
					source: "pi",
					importedSourceId: null,
					expectedOriginKeys: wslIdentity.paths.map((filePath) => originKey({ source: "pi", environment: "wsl", filePath, distro: wslDistro, user: wslUser })),
					expectedIndependentSessionCount: 2,
				}
			: null,
		scenarios: {
			A3: { userDataTemplate: "native", sessionPath: scaleFiles["100"] },
			A4: { userDataTemplate: "native", sessionPath: scaleFiles["1000"] },
			A5: { userDataTemplate: "native", sessionPath: scaleFiles["10000"] },
			A6: { userDataTemplate: "native", sessionPath: largeFile },
			A7: { userDataTemplate: "native", catalog: "corrupt" },
			A8: { userDataTemplate: "native", sessionPaths: [nativeUpperPath, nativeLowerPath, importedTargetPath] },
			A9: wslIdentity ? { userDataTemplate: "wsl", sessionPaths: wslIdentity.paths } : null,
			A10: { userDataTemplate: "native", dryRun: true },
		},
	};
	const fixtureManifestPath = join(output, "fixture-manifest.json");
	await writeFile(fixtureManifestPath, JSON.stringify(manifest, null, 2), "utf8");
	return { ...manifest, fixtureManifestPath };
}

function helpText() {
	return [
		"Usage: node scripts/generate-session-fixtures.mjs --output <absolute-dir> --sha <commit> [options]",
		"",
		"Options:",
		"  --wsl-distro <name>  Target distro (requires --wsl-user)",
		"  --wsl-user <name>    Target WSL user (requires --wsl-distro)",
		"  --wsl-root <path>    Expected canonical ext4 $HOME; rejects traversal and /mnt/*",
		"  --dry-run            Print the bounded write plan without changing files",
	].join("\n");
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
	try {
		const options = parseArgs(process.argv.slice(2));
		if (options.help) console.log(helpText());
		else {
			if (!options.output || !options.sha) throw new Error("--output and --sha are required");
			console.log(JSON.stringify(await generateSessionFixtures({ outputDir: options.output, sha: options.sha, wslDistro: options.wslDistro, wslUser: options.wslUser, wslRoot: options.wslRoot, dryRun: options.dryRun }), null, 2));
		}
	} catch (error) {
		console.error(`Fixture generation failed: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
