import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { REMOTE_CONFIG_SOURCE } = loadTsCommonJs("src/main/remote/RemoteConfigSource.ts");
const { REMOTE_RESOURCE_SOURCE } = loadTsCommonJs("src/main/remote/RemoteResourceSource.ts");
const factory = (source, name) => new Function(source.replace("export function " + name, "function " + name) + "\nreturn " + name + ";")();
const HOST = "11111111-1111-4111-8111-111111111111";
function fixture(t) {
	const directory = fs.mkdtempSync(path.join(tmpdir(), "pideck-ssh-management-"));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const home = "/ssh-management";
	const resolve = (value) => (typeof value === "string" && value.startsWith(home) ? directory + value.slice(home.length) : value);
	const mappedFs = new Proxy(fs, {
		get(target, key) {
			const value = target[key];
			if (key === "lstatSync") return (p) => fs.lstatSync(resolve(p), { bigint: true });
			return typeof value === "function" ? (...args) => value(...args.map(resolve)) : value;
		},
	});
	fs.mkdirSync(path.join(directory, ".pi/agent"), { recursive: true });
	const config = factory(REMOTE_CONFIG_SOURCE, "createConfigScope")(home, mappedFs, path.posix, crypto);
	const resources = factory(REMOTE_RESOURCE_SOURCE, "createResourceScope")(home, "/home/tester/project", mappedFs, path.posix, crypto, factory(REMOTE_CONFIG_SOURCE, "createConfigScope"), config);
	return { config, resources, directory, home };
}

test("SSH auth CRUD retains and copies credentials on the host, never returns values, and checks stale versions", (t) => {
	const f = fixture(t);
	const authPath = path.join(f.directory, ".pi/agent/auth.json");
	fs.writeFileSync(authPath, JSON.stringify({ p: { type: "api_key", key: "original-secret", custom: true }, oauth: { type: "oauth", access: "access-secret", refresh: "refresh-secret", expires: 9999 } }));
	const initial = f.config.readAuth();
	const result = f.config.replaceAuth({
		expectedVersion: initial.version,
		entries: [
			{ provider: "p", apiKey: "replacement-secret" },
			{ provider: "copy", retain: true, source: "oauth" },
			{ provider: "oauth", retain: true },
		],
	});
	const stored = JSON.parse(fs.readFileSync(authPath, "utf8"));
	assert.equal(stored.p.key, "replacement-secret");
	assert.deepEqual(stored.copy, stored.oauth);
	assert.equal(JSON.stringify(result).includes("secret"), false);
	assert.throws(() => f.config.replaceAuth({ expectedVersion: initial.version, entries: [] }), /CONFIG_VERSION_CONFLICT/);
	for (const entry of [
		{ provider: "__proto__", apiKey: "x" },
		{ provider: "p", retain: true, apiKey: "x" },
		{ provider: "p", type: "oauth", access: "x" },
		{ provider: "p", retain: true, source: "missing" },
	]) {
		assert.throws(() => f.config.replaceAuth({ expectedVersion: result.version, entries: [entry] }), /CONFIG_FILE_INVALID/);
		assert.deepEqual(JSON.parse(fs.readFileSync(authPath, "utf8")), stored);
	}
	f.config.replaceAuth({ expectedVersion: result.version, entries: [{ provider: "copy", retain: true }] });
	assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(authPath, "utf8"))), ["copy"]);
});

test("SSH resources create/read/edit/rename/toggle and recoverable delete operate within fixed roots", (t) => {
	const f = fixture(t);
	const ref = { root: "skills", path: "sample/SKILL.md" };
	const first = f.resources.create({ ref, content: '---\nname: sample\ndescription: "example"\n---\n\nBody' });
	assert.throws(() => f.resources.create({ ref, content: "overwrite" }), /VERSION_CONFLICT/);
	const edited = f.resources.write({ ref, expectedVersion: first.version, content: first.content + " edited" });
	assert.throws(() => f.resources.write({ ref, expectedVersion: first.version, content: "stale" }), /VERSION_CONFLICT/);
	const list = f.resources.list();
	assert.equal(list.files.length, 1);
	f.resources.toggle({ ref, expectedVersion: list.settingsVersion, enabled: false });
	const renamed = f.resources.rename({ ref, expectedVersion: edited.version, name: "renamed" });
	assert.match(renamed.content, /name: "renamed"/);
	assert.deepEqual(f.config.read({ file: "settings" }).data.skills, ["-" + f.home + "/.pi/agent/skills/renamed/SKILL.md"]);
	f.resources.remove({ ref: { root: renamed.root, path: renamed.path }, expectedVersion: renamed.version });
	assert.equal(f.resources.list().files.length, 0);
	assert.equal(fs.readdirSync(path.join(f.directory, ".pi/agent/skills/.pideck-trash")).length, 1);
	for (const target of [
		{ root: "skills", path: "../auth.json" },
		{ root: "other", path: "x" },
		{ root: "extensions", path: ".hidden/x" },
	])
		assert.throws(() => f.resources.read({ ref: target }), /RESOURCE_PATH_INVALID/);
});

test("SSH package disable/enable preserves selective filters and unrelated settings", (t) => {
	const f = fixture(t);
	const settingsPath = path.join(f.directory, ".pi/agent/settings.json");
	const entry = { source: "npm:example", extensions: ["one.ts"], skills: [], unknown: "survives" };
	fs.writeFileSync(settingsPath, JSON.stringify({ packages: [entry], apiKey: "settings-secret", other: true }));
	f.resources.togglePackage({ source: entry.source, expectedVersion: f.resources.list().settingsVersion, enabled: false });
	assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, "utf8")).packages[0].extensions, []);
	f.resources.togglePackage({ source: entry.source, expectedVersion: f.resources.list().settingsVersion, enabled: true });
	const stored = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
	assert.deepEqual(stored.packages, [entry]);
	assert.equal(stored.apiKey, "settings-secret");
	assert.equal(stored.other, true);
});

test("auth editor copies retain references, isolates raw versions, and locks writes after uncertain receipts", async () => {
	const { createRemoteAuthEditor } = loadTsCommonJs("src/renderer/src/config/remoteAuthEditorApi.ts");
	const calls = [];
	let version = "a".repeat(64);
	let lose = false;
	const api = {
		config: {
			getRaw: async () => ({ remoteAuth: { kind: "remote-auth", hostId: HOST, version, sha256: version, providers: [{ provider: "p", type: "api_key", configured: true }] } }),
			replaceRemoteAuth: async (input) => {
				calls.push(input);
				if (lose) throw new Error("REMOTE_CONFIG_RESULT_UNCONFIRMED");
				version = "b".repeat(64);
				return { valid: true, remoteAuth: { kind: "remote-auth", hostId: HOST, version, sha256: version, providers: [] } };
			},
		},
	};
	const editor = createRemoteAuthEditor(
		api,
		HOST,
		async () => {},
		() => {},
	);
	const form = await editor.read();
	const raw = await editor.read("raw");
	await editor.write({ p: { ...form.parsed.p, key: "new-secret" }, copy: form.parsed.p });
	assert.deepEqual(JSON.parse(JSON.stringify(calls[0].entries)), [
		{ provider: "p", apiKey: "new-secret" },
		{ provider: "copy", retain: true, source: "p" },
	]);
	await editor.write(JSON.parse(raw.raw), "raw");
	assert.equal(calls[1].expectedVersion, "a".repeat(64));
	await editor.read();
	lose = true;
	await assert.rejects(() => editor.write({}), /RESULT_UNCONFIRMED/);
	await assert.rejects(() => editor.write({}), /RESULT_UNCONFIRMED/);
	assert.equal(calls.length, 3);
	editor.reset();
	await editor.read();
	lose = false;
	await editor.write({});
});

test("host-bound resource facade confines resource operations to the host, with shared PiDeck built-in settings", async (t) => {
	const f = fixture(t);
	const otherHost = "22222222-2222-4222-8222-222222222222";
	const other = fixture(t);
	const calls = [],
		commands = [];
	const stubs = {
		"../extensions/piExtensionCatalog": {
			parsePiListOutput: () => [
				{ id: "user:npm:example", source: "npm:example", scope: "user" },
				{ id: "user:/opt/local pkg", source: "/opt/local pkg", scope: "user", local: true },
			],
		},
		"../pi/piSelfUpdateRunner": { supportsPiSelfUpdate: (version) => version === "0.70.3" },
	};
	const { createRemotePiResourceBackend } = loadTsCommonJs("src/main/config/RemotePiResourceBackend.ts", { stubs });
	const backend = createRemotePiResourceBackend({
		request: async (hostId, method, input) => {
			calls.push({ hostId, method, input });
			const resource = hostId === HOST ? f.resources : other.resources;
			const operation = method.slice("resources.".length);
			return operation === "list" ? resource.list(input) : operation === "read" ? resource.read(input) : resource[operation === "delete" ? "remove" : operation](input);
		},
		resolveFacts: async () => ({ home: f.home, nodePath: "/opt/node/bin/node", piPath: "/opt/pi/cli.js", version: "0.70.3" }),
		run: async (input) => {
			commands.push(input);
			return { exitCode: 0, stdout: input.remoteCommand.includes("'-e'") ? JSON.stringify([{ currentVersion: "1.0.0", latestVersion: "1.2.0" }, {}]) : "not exposed logs", stderr: "not exposed secret" };
		},
	});
	const { createRemoteResourceEditorApi } = loadTsCommonJs("src/renderer/src/config/remoteResourceEditorApi.ts", { stubs: { "../utils/clipboard": { writeClipboard: async () => {} }, "../utils/notice": { showNotice: () => {} }, "../i18n": { t: (key) => key } } });
	const trap = new Proxy(
		{},
		{
			get: () => () => {
				throw new Error("local resource API called");
			},
		},
	);
	const api = {
		remotePiResources: (host, request) => backend.execute(host, request),
		skills: trap,
		prompts: trap,
		extensions: new Proxy({ builtInStatus: async () => ({ effectiveVersion: "1.0.0" }) }, { get: (target, key) => (key in target ? target[key] : trap[key]) }),
		settings: { get: async () => ({ removedBuiltInExtensions: [] }) },
		files: trap,
		config: trap,
		projectResources: trap,
		skillHub: trap,
		promptStore: trap,
		skillStore: trap,
		yaoPrompts: { detail: async () => ({ description: "Yao", promptContent: "Yao content" }) },
	};
	const editor = createRemoteResourceEditorApi(api, HOST, async () => {});
	await editor.skills.list();
	const skill = await editor.skills.create({ name: "sample", description: "description", locationId: "pi-global" });
	assert.match(await editor.files.readContent(skill.path), /name: "sample"/);
	await editor.files.writeContent(skill.path, "---\nname: sample\ndescription: example\n---\nchanged body");
	await editor.skills.toggle(skill.path, false);
	assert.equal((await editor.skills.list()).skills[0].enabled, false);
	const renamed = await editor.skills.rename(skill.path, "renamed");
	assert.match(renamed.path, /renamed\/SKILL.md$/);
	await editor.skills.delete(renamed.path);
	assert.equal((await editor.skills.list()).skills.length, 0);
	const prompt = await editor.prompts.create({ name: "review", description: "review files" });
	assert.match(await editor.prompts.edit(prompt.path), /description/);
	await editor.prompts.edit(prompt.path, "saved prompt");
	const renamedPrompt = await editor.prompts.rename("review", "review-next");
	await editor.prompts.toggle(renamedPrompt.path, false);
	assert.equal((await editor.prompts.list()).templates[0].enabled, false);
	await editor.prompts.delete(renamedPrompt.path);
	const imported = await editor.promptStore.import({ title: "Store import", description: "description", content: "Hello ${NAME} ${LANG:English} ${NAME}" });
	assert.match(await editor.prompts.edit(imported.path), /Hello \$1 \$\{2:-English\} \$1/);
	assert.match(await editor.prompts.edit(imported.path), /argument-hint:/);
	await editor.skillStore.import({ title: "Remote imported", description: "description", content: "Imported body" });
	await editor.yaoPrompts.import("yao", "code");
	assert.equal((await editor.prompts.list()).templates.length, 2);
	const secondEditor = createRemoteResourceEditorApi(api, otherHost, async () => {});
	assert.equal((await secondEditor.skills.list()).skills.length, 0);
	await assert.rejects(() => secondEditor.files.readContent(imported.path), /FILE_INVALID/);
	const extensions = await editor.extensions.list();
	assert.equal(extensions.extensions.filter((entry) => !entry.builtIn).length, 2, "remote local-path packages must remain visible");
	assert.ok(
		extensions.extensions.some((entry) => entry.builtIn),
		"shared PiDeck built-ins are visible",
	);
	assert.equal(extensions.extensions[0].latestVersion, "1.2.0");
	const refreshed = await editor.extensions.list(false);
	assert.equal(refreshed.extensions[0].latestVersion, "1.2.0", "a lightweight refresh retains the last version results");
	assert.equal(commands.length, 3, "the lightweight refresh does not run another version query");
	await editor.extensions.install("npm:new-package");
	await editor.extensions.update();
	await editor.extensions.updateOne("npm:new-package");
	await editor.extensions.uninstall("npm:new-package");
	await editor.skillHub.install("owner/repo/sample");
	assert.equal(commands.length, 8);
	assert.ok(commands.every((input) => input.hostId === HOST));
	assert.match(commands[4].remoteCommand, /'update' '--extensions'/, "0.70.3 already supports Pi self-update; package updates must exclude it");
	assert.match(commands[7].remoteCommand, /'--copy'/, "editable installed skills cannot be symlinks");
	assert.ok(calls.some((input) => input.hostId === otherHost));
	await assert.rejects(() => backend.execute(HOST, { action: "packages", operation: "install", source: "--help" }), /FILE_INVALID/);
	await assert.rejects(() => backend.execute(HOST, { action: "read", ref: { root: "skills", path: "../../auth.json" } }), /FILE_INVALID/);
});

test("remote pi built-in switches persist on the host, respect filters and reject project writes", async (t) => {
	const f = fixture(t);
	fs.writeFileSync(path.join(f.directory, ".pi/agent/settings.json"), JSON.stringify({ extensions: ["!builtin:*", "+builtin:codemode"], defaultTools: ["+codemode"] }));
	const { createRemoteResourceEditorApi } = loadTsCommonJs("src/renderer/src/config/remoteResourceEditorApi.ts", { stubs: { "../utils/clipboard": { writeClipboard: async () => {} }, "../utils/notice": { showNotice: () => {} }, "../i18n": { t: (key) => key } } });
	const editor = createRemoteResourceEditorApi({ remotePiResources: async (_host, { action, ...input }) => (action === "list" ? f.resources.list(input) : f.resources.builtin(input)) }, HOST, async () => {});
	let summary = await editor.config.piResourcesSummary({ scope: "global" });
	assert.equal(summary.builtins.find((item) => item.name === "mcp").enabled, false);
	assert.equal(summary.builtins.find((item) => item.name === "codemode").toolEnabled, true);
	await editor.config.piResourcesSetBuiltin({ scope: { scope: "global" }, name: "mcp", enabled: true, expectedRevision: summary.revision });
	summary = await editor.config.piResourcesSummary({ scope: "global" });
	assert.equal(summary.builtins.find((item) => item.name === "mcp").enabled, true);
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.directory, ".pi/agent/settings.json"), "utf8")).extensions, ["!builtin:*", "+builtin:codemode", "+builtin:mcp"]);
	await assert.rejects(() => editor.config.piResourcesSetBuiltin({ scope: { scope: "project", projectId: "p" }, name: "mcp", enabled: false }), /UNSUPPORTED/);
	await assert.rejects(() => editor.config.piResourcesSummary({ scope: "project", projectId: "p" }), /UNSUPPORTED/);
});

test("resource discovery lists package and settings resources with native filters, without granting edits", (t) => {
	const f = fixture(t);
	const agent = path.join(f.directory, ".pi/agent");
	fs.mkdirSync(path.join(agent, "npm/node_modules/example/skills/sample"), { recursive: true });
	fs.mkdirSync(path.join(agent, "npm/node_modules/example/prompts"), { recursive: true });
	fs.mkdirSync(path.join(agent, "custom-prompts"), { recursive: true });
	fs.writeFileSync(path.join(agent, "npm/node_modules/example/package.json"), JSON.stringify({ pi: { skills: ["skills"], prompts: ["prompts/**/*.md"] } }));
	fs.writeFileSync(path.join(agent, "npm/node_modules/example/skills/sample/SKILL.md"), "---\nname: package-skill\ndescription: From package\n---\nBody");
	fs.writeFileSync(path.join(agent, "npm/node_modules/example/prompts/review.md"), "---\ndescription: From package\n---\nReview");
	fs.writeFileSync(path.join(agent, "custom-prompts/custom.md"), "---\ndescription: From settings\n---\nCustom");
	fs.writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ packages: [{ source: "npm:example", prompts: [] }], prompts: ["custom-prompts", "!*.md"], skills: ["-" + f.home + "/.pi/agent/npm/node_modules/example/skills/sample/SKILL.md"] }));
	const result = f.resources.list();
	assert.equal(result.discovery.skills.length, 1);
	assert.equal(result.discovery.skills[0].enabled, false);
	assert.equal(result.discovery.skills[0].name, "package-skill");
	assert.equal(result.discovery.prompts.length, 2);
	assert.ok(result.discovery.prompts.every((entry) => entry.managed && !entry.enabled));
	assert.equal(result.files.length, 0, "discovered resources never enter the editable fixed-root map");
	assert.throws(() => f.resources.read({ ref: { root: "extensions", path: "../../npm/node_modules/example/package.json" } }), /PATH_INVALID/);
});

test("resource backend rejects secret-bearing replies, mismatched files and lost mutation receipts", async () => {
	const { createRemotePiResourceBackend } = loadTsCommonJs("src/main/config/RemotePiResourceBackend.ts", { stubs: { "../extensions/piExtensionCatalog": {}, "../pi/piSelfUpdateRunner": {} } });
	let calls = 0;
	let reply = { home: "/home/test", files: [], settings: { apiKey: "plaintext-secret" }, settingsVersion: "a".repeat(64) };
	const backend = createRemotePiResourceBackend({
		request: async () => {
			calls++;
			if (reply instanceof Error) throw reply;
			return reply;
		},
	});
	await assert.rejects(() => backend.execute(HOST, { action: "list" }), /FILE_INVALID/);
	reply = { root: "skills", path: "other/SKILL.md", content: "body", version: crypto.createHash("sha256").update("body").digest("hex") };
	await assert.rejects(() => backend.execute(HOST, { action: "write", ref: { root: "skills", path: "sample/SKILL.md" }, expectedVersion: "a".repeat(64), content: "body" }), /RESULT_UNCONFIRMED/);
	reply = new Error("REMOTE_CONNECTION_LOST");
	await assert.rejects(() => backend.execute(HOST, { action: "delete", ref: { root: "prompts", path: "review.md" }, expectedVersion: "a".repeat(64) }), /RESULT_UNCONFIRMED/);
	assert.equal(calls, 3, "mutations are sent once, never replayed");
});
