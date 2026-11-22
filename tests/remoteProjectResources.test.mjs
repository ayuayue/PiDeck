import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * Remote project resources (2026-11 defect).
 *
 * The project management dialog used to send every SSH project to the *local* project resource manager,
 * which answered UNSUPPORTED_PROJECT_LOCATION: skills, prompts, extensions and MCP were all unusable for a
 * remote project. The fix adds a project layer to the same SSH helper. These tests pin the three things that
 * make the layer safe:
 *
 * 1. a project scope writes inside that project's own root and never the host's global user files;
 * 2. two projects on one host cannot see or mutate each other's resources;
 * 3. an inherited global resource is switched off in the *project's* settings, which is what pi reads.
 */
const { REMOTE_CONFIG_SOURCE } = loadTsCommonJs("src/main/remote/RemoteConfigSource.ts");
const { REMOTE_RESOURCE_SOURCE } = loadTsCommonJs("src/main/remote/RemoteResourceSource.ts");
const { createRemotePiResourceBackend } = loadTsCommonJs("src/main/config/RemotePiResourceBackend.ts", { stubs: { "../extensions/piExtensionCatalog": { parsePiListOutput: () => [] }, "../pi/piSelfUpdateRunner": { supportsPiSelfUpdate: () => false } } });

const factory = (source, name) => new Function(source.replace("export function " + name, "function " + name) + "\nreturn " + name + ";")();
const createConfigScope = factory(REMOTE_CONFIG_SOURCE, "createConfigScope");
const createResourceScope = factory(REMOTE_RESOURCE_SOURCE, "createResourceScope");

const HOST = "11111111-1111-4111-8111-111111111111";
/** The helper runs in a separate VM realm: arrays/objects must be compared by value, not by prototype. */
const plain = (value) => JSON.parse(JSON.stringify(value));
const BASE = "/srv/warden";
const HOME = BASE + "/home/tester";
const PROJECT_A = BASE + "/work/app";
const PROJECT_B = BASE + "/work/other";

function fixture(t) {
	const directory = fs.mkdtempSync(path.join(tmpdir(), "pideck-remote-project-resources-"));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const resolve = (value) => (typeof value === "string" && value.startsWith(BASE) ? directory + value.slice(BASE.length) : value);
	const mappedFs = new Proxy(fs, {
		get(target, key) {
			const value = target[key];
			if (key === "lstatSync") return (p, options) => fs.lstatSync(resolve(p), options ?? { bigint: true });
			return typeof value === "function" ? (...args) => value(...args.map(resolve)) : value;
		},
	});
	fs.mkdirSync(path.join(directory, "home/tester/.pi/agent"), { recursive: true });
	fs.mkdirSync(path.join(directory, "work/app"), { recursive: true });
	fs.mkdirSync(path.join(directory, "work/other"), { recursive: true });
	const globalConfig = createConfigScope(HOME, mappedFs, path.posix, crypto);
	const scope = (root) => createResourceScope(HOME, root, mappedFs, path.posix, crypto, createConfigScope, globalConfig);
	return {
		globalConfig,
		a: scope(PROJECT_A),
		b: scope(PROJECT_B),
		global: scope(PROJECT_A),
		disk: (relative) => path.join(directory, relative),
		read: (relative) => fs.readFileSync(path.join(directory, relative), "utf8"),
		exists: (relative) => fs.existsSync(path.join(directory, relative)),
	};
}

test("a project scope writes inside its own root and never the host's global files", (t) => {
	const f = fixture(t);
	assert.deepEqual(plain(f.a.list({ scope: "project" }).files), [], "an empty project layer lists nothing");
	assert.equal(f.a.list({ scope: "project" }).projectRoot, PROJECT_A);

	const created = f.a.create({ scope: "project", ref: { root: "skills", path: "local/SKILL.md" }, content: '---\nname: local\ndescription: "project only"\n---\n' });
	assert.equal(created.path, "local/SKILL.md");
	assert.ok(f.exists("work/app/.pi/skills/local/SKILL.md"), "the project skill lands under the project root");
	assert.equal(f.exists("home/tester/.pi/agent/skills/local/SKILL.md"), false, "the host's global skills stay untouched");

	assert.deepEqual(plain(f.a.list({ scope: "global" }).files), [], "the global layer did not change");
	assert.deepEqual(plain(f.a.list({ scope: "project" }).files.map((file) => file.path)), ["local/SKILL.md"]);
	assert.deepEqual(plain(f.b.list({ scope: "project" }).files), [], "a sibling project cannot see this project's files");

	// The same relative reference names a different file per layer, so omitting the scope must not silently
	// reach the project copy.
	assert.throws(() => f.a.read({ ref: { root: "skills", path: "local/SKILL.md" } }), /RESOURCE_NOT_FOUND/);
	assert.match(f.a.read({ ref: { root: "skills", path: "local/SKILL.md" }, scope: "project" }).content, /project only/);
});

test("an inherited global resource is switched off in the project's own settings", (t) => {
	const f = fixture(t);
	fs.mkdirSync(f.disk("home/tester/.pi/agent/skills/shared"), { recursive: true });
	fs.writeFileSync(f.disk("home/tester/.pi/agent/skills/shared/SKILL.md"), '---\nname: shared\ndescription: "global"\n---\n');
	const key = HOME + "/.pi/agent/skills/shared/SKILL.md";

	f.a.toggleInherited({ scope: "project", kind: "skill", key, enabled: false });
	assert.deepEqual(JSON.parse(f.read("work/app/.pi/settings.json")).skills, ["-" + key], "the rule belongs to the project layer");
	assert.equal(f.exists("home/tester/.pi/agent/settings.json"), false, "the host's settings are untouched");
	assert.equal(f.exists("work/other/.pi/settings.json"), false, "the sibling project is untouched");
	assert.deepEqual(plain(f.a.list({ scope: "project" }).discovery.overrides.disabledGlobalSkills), [key.toLowerCase()]);
	assert.deepEqual(plain(f.a.list({ scope: "global" }).discovery.overrides.disabledGlobalSkills), [], "the host itself still inherits nothing disabled");

	f.a.toggleInherited({ scope: "project", kind: "skill", key, enabled: true });
	assert.deepEqual(JSON.parse(f.read("work/app/.pi/settings.json")).skills, ["+" + key]);
	assert.deepEqual(plain(f.a.list({ scope: "project" }).discovery.overrides.disabledGlobalSkills), []);

	// Builtin extensions and the host's own settings are not part of a project layer.
	assert.throws(() => f.a.toggleInherited({ kind: "skill", key, enabled: false }), /RESOURCE_INPUT_INVALID/);
	assert.throws(() => f.a.builtin({ scope: "project", name: "mcp", expectedVersion: "a".repeat(64), enabled: false }), /RESOURCE_INPUT_INVALID/);
	assert.throws(() => f.a.toggleInherited({ scope: "project", kind: "skill", key: "relative/path", enabled: false }), /RESOURCE_INPUT_INVALID/);
});

test("the backend routes a project layer to that project's session and refuses a crossed host", async () => {
	const calls = [];
	const snapshots = new Map();
	const backend = createRemotePiResourceBackend({
		request: async (hostId, method, params) => {
			calls.push({ hostId, method, params, root: null });
			return (
				snapshots.get("global") ?? {
					home: HOME,
					scope: "global",
					projectRoot: null,
					files: [],
					settings: {},
					settingsVersion: "a".repeat(64),
					discovery: { projectResourcesAllowed: false, overrides: { disabledGlobalSkills: [], disabledGlobalPrompts: [], disabledGlobalExtensions: [] }, skills: [], prompts: [], extensions: [] },
				}
			);
		},
		requestProject: async (hostId, root, method, params) => {
			calls.push({ hostId, method, params, root });
			return { home: HOME, scope: "project", projectRoot: root, files: [], settings: {}, settingsVersion: "b".repeat(64), discovery: { projectResourcesAllowed: true, overrides: { disabledGlobalSkills: [], disabledGlobalPrompts: [], disabledGlobalExtensions: [] }, skills: [], prompts: [], extensions: [] } };
		},
		resolveProject: async (projectId) => (projectId === "p-a" ? { hostId: HOST, root: PROJECT_A } : { code: "REMOTE_RESOURCE_PROJECT_NOT_FOUND" }),
		resolveFacts: async () => ({ piPath: "/usr/bin/pi", nodePath: "/usr/bin/node", version: "1.5.2", home: HOME }),
		run: async () => ({ exitCode: 0, stdout: "" }),
	});

	const listed = await backend.execute(HOST, { action: "list", scope: "project", projectId: "p-a" });
	assert.equal(listed.projectRoot, PROJECT_A);
	assert.deepEqual(plain(calls.map((call) => [call.root, call.method])), [[PROJECT_A, "resources.list"]], "the project layer runs on the session confined to that root");
	assert.equal(calls[0].params.scope, "project", "the helper must be told which layer to read");
	assert.equal("projectId" in calls[0].params, false, "the project id never reaches the host");

	await backend.execute(HOST, { action: "list" });
	assert.deepEqual(
		plain(calls.map((call) => [call.root, call.method])),
		[
			[PROJECT_A, "resources.list"],
			[null, "resources.list"],
		],
		"the global layer keeps using the host session",
	);

	// A project layer without a project id, an unknown project, or another host's project is refused instead of
	// falling back to the host's global files or to a warm session.
	await assert.rejects(() => backend.execute(HOST, { action: "list", scope: "project" }), /PI_RESOURCE_TARGET_INVALID/);
	await assert.rejects(() => backend.execute(HOST, { action: "list", scope: "project", projectId: "missing" }), /PI_RESOURCE_TARGET_INVALID/);
	await assert.rejects(() => backend.execute("22222222-2222-4222-8222-222222222222", { action: "list", scope: "project", projectId: "p-a" }), /PI_RESOURCE_TARGET_INVALID/);
	// Pi package verbs are host-level and stay out of the project layer.
	await assert.rejects(() => backend.execute(HOST, { action: "packages", operation: "list", scope: "project", projectId: "p-a" }), /PI_RESOURCE_WRITE_UNSUPPORTED/);
});

test("the renderer facade keeps the project and host layers apart", async (t) => {
	const f = fixture(t);
	fs.mkdirSync(f.disk("home/tester/.pi/agent/skills/global-skill"), { recursive: true });
	fs.writeFileSync(f.disk("home/tester/.pi/agent/skills/global-skill/SKILL.md"), '---\nname: global-skill\ndescription: "global"\n---\n');

	const backend = createRemotePiResourceBackend({
		request: async (hostId, method, params) => {
			const operation = method.slice("resources.".length);
			const value = { ...params, scope: "global" };
			return operation === "list" ? f.global.list(value) : operation === "read" ? f.global.read(value) : f.global[operation === "delete" ? "remove" : operation](value);
		},
		requestProject: async (_hostId, root, method, params) => {
			const scope = root === PROJECT_A ? f.a : f.b;
			const operation = method.slice("resources.".length);
			return operation === "list" ? scope.list(params) : operation === "read" ? scope.read(params) : scope[operation === "delete" ? "remove" : operation](params);
		},
		resolveProject: async (projectId) => (projectId === "p-a" ? { hostId: HOST, root: PROJECT_A } : { hostId: HOST, root: PROJECT_B }),
		resolveFacts: async () => ({ piPath: "/usr/bin/pi", nodePath: "/usr/bin/node", version: "1.5.2", home: HOME }),
		run: async () => ({ exitCode: 0, stdout: "" }),
	});
	const trap = new Proxy(
		{},
		{
			get: () => () => {
				throw new Error("local resource API called");
			},
		},
	);
	const api = { remotePiResources: (host, request) => backend.execute(host, request), skills: trap, prompts: trap, extensions: trap, files: trap, config: trap, projectResources: trap, skillHub: trap, promptStore: trap, skillStore: trap, yaoPrompts: { detail: async () => ({ description: "", promptContent: "" }) } };
	const { createRemoteResourceEditorApi } = loadTsCommonJs("src/renderer/src/config/remoteResourceEditorApi.ts", { stubs: { "../utils/clipboard": { writeClipboard: async () => {} }, "../utils/notice": { showNotice: () => {} }, "../i18n": { t: (key) => key } } });
	const editor = createRemoteResourceEditorApi(api, HOST, async () => {}, "p-a");

	const project = await editor.projectResources.list("p-a");
	assert.equal(project.skills.length, 0);
	assert.deepEqual(plain(project.skillLocations.map((location) => location.path)), [PROJECT_A + "/.pi/skills", PROJECT_A + "/.agents/skills"]);
	assert.equal((await editor.skills.list()).skills.map((skill) => skill.name).join(","), "global-skill", "the host's global skills stay the inherited source");

	const created = await editor.projectResources.createSkill({ projectId: "p-a", name: "local", description: "project only", locationId: "project-pi" });
	assert.equal(created.sourceId, "project-pi");
	assert.equal(created.path, PROJECT_A + "/.pi/skills/local/SKILL.md");
	assert.ok(f.exists("work/app/.pi/skills/local/SKILL.md"));
	assert.equal(f.exists("home/tester/.pi/agent/skills/local/SKILL.md"), false, "creating a project skill never touches the host's files");
	assert.equal((await editor.skills.list()).skills.length, 1, "and it does not appear as a global skill");

	// Switching an inherited global skill off from the project page writes the project's settings only.
	const globalPath = HOME + "/.pi/agent/skills/global-skill/SKILL.md";
	await editor.projectResources.toggleInherited({ projectId: "p-a", kind: "skill", key: globalPath, enabled: false });
	assert.deepEqual(JSON.parse(f.read("work/app/.pi/settings.json")).skills, ["-" + globalPath]);
	assert.equal(f.exists("home/tester/.pi/agent/settings.json"), false);
	assert.equal((await editor.projectResources.list("p-a")).overrides.disabledGlobalSkills.includes(globalPath.toLowerCase()), true);

	// Project deletions stay inside the project.
	await editor.projectResources.deleteSkill("p-a", created.path);
	assert.equal(f.exists("work/app/.pi/skills/local/SKILL.md"), false);
	assert.ok(f.exists("home/tester/.pi/agent/skills/global-skill/SKILL.md"), "the inherited global file is never deleted");
});

test("a stale write and a lost receipt stay failures in the project layer, never a silent host write", async (t) => {
	const f = fixture(t);
	const created = f.a.create({ scope: "project", ref: { root: "skills", path: "typed/SKILL.md" }, content: '---\nname: typed\ndescription: "x"\n---\n' });
	f.a.write({ scope: "project", ref: { root: "skills", path: "typed/SKILL.md" }, expectedVersion: created.version, content: created.content + " edited" });
	// 同一份 expectedVersion 只能写一次：第二写必须报版本冲突，而不是覆盖别人的改动。
	assert.throws(() => f.a.write({ scope: "project", ref: { root: "skills", path: "typed/SKILL.md" }, expectedVersion: created.version, content: "stale" }), /RESOURCE_VERSION_CONFLICT/);

	const calls = [];
	let lose = false;
	const backend = createRemotePiResourceBackend({
		request: async () => ({}),
		requestProject: async (_hostId, root, method, params) => {
			calls.push({ root, method, params: plain(params) });
			if (lose) throw new Error("REMOTE_CONNECTION_LOST");
			const operation = method.slice("resources.".length);
			const value = { ...params, scope: "project" };
			return operation === "list" ? f.a.list(value) : operation === "read" ? f.a.read(value) : f.a[operation === "delete" ? "remove" : operation](value);
		},
		resolveProject: async () => ({ hostId: HOST, root: PROJECT_A }),
		resolveFacts: async () => ({ piPath: "/usr/bin/pi", nodePath: "/usr/bin/node", version: "1.5.2", home: HOME }),
		run: async () => ({ exitCode: 0, stdout: "" }),
	});
	// 连不上主机：写入不得重放，也不得退回主机全局层（宁可报不确定，让用户重读后再决定）。
	lose = true;
	await assert.rejects(() => backend.execute(HOST, { action: "write", scope: "project", projectId: "p-a", ref: { root: "skills", path: "typed/SKILL.md" }, expectedVersion: "a".repeat(64), content: "x" }), /PI_RESOURCE_RESULT_UNCONFIRMED/);
	assert.equal(calls.length, 1, "mutations are sent once, never replayed");
});
