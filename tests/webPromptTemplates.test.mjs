import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { WebWorkspaceRoutes } = loadTsCommonJs("src/main/web/WebWorkspaceRoutes.ts");
const CONTENT_LIMIT = 2 * 1024 * 1024;

async function fixture(t, extraStubs = {}) {
	const home = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "web-prompt-templates-")));
	t.after(() => fs.rm(home, { recursive: true, force: true }));
	const globalDir = join(home, ".pi", "agent", "prompts");
	const project = join(home, "project");
	const projectDir = join(project, ".pi", "prompts");
	await fs.mkdir(globalDir, { recursive: true });
	await fs.mkdir(projectDir, { recursive: true });
	const { PromptManager } = loadTsCommonJs("src/main/prompts/PromptManager.ts", {
		stubs: {
			electron: { shell: { openPath: async () => "" } },
			"../fs/trash": { trashPath: async () => {} },
			...extraStubs,
		},
	});
	const manager = new PromptManager(home);
	const deps = { listProjects: () => [{ id: "p1", name: "Project", path: project }], promptTemplates: manager };
	return { home, globalDir, project, projectDir, manager, deps, routes: new WebWorkspaceRoutes(deps) };
}

async function call(routes, path, method = "GET") {
	const response = {
		status: 0,
		headers: {},
		payload: "",
		writeHead(status, headers) {
			this.status = status;
			this.headers = headers;
		},
		end(payload) {
			if (payload !== undefined) this.payload = String(payload);
		},
	};
	const handled = await routes.handle(new URL(`http://localhost${path}`), { method }, response);
	return { handled, status: response.status, headers: response.headers, body: response.payload ? JSON.parse(response.payload) : null };
}

async function link(t, target, path, type) {
	try {
		await fs.symlink(target, path, type);
		await fs.lstat(path);
	} catch (error) {
		if (["EPERM", "EACCES", "ENOTSUP", "ENOENT"].includes(error.code)) {
			t.skip(`Filesystem does not support this symlink fixture (${error.code})`);
			return false;
		}
		throw error;
	}
	return true;
}

test("prompt templates are available without the cloud library and list only global metadata", async (t) => {
	const { globalDir, manager, routes } = await fixture(t, {
		"node:fs/promises": {
			...fs,
			open: async (path, ...args) => {
				if (basename(path) === "unreadable.md") throw new Error("private filesystem diagnostic");
				return fs.open(path, ...args);
			},
		},
	});
	await fs.writeFile(join(globalDir, "review.md"), '---\ndescription: "Review code"\n---\nprivate body');
	await fs.writeFile(join(globalDir, "plain.md"), "\n\n# First non-empty line\nprivate body");
	await fs.writeFile(join(globalDir, "ignored.d.md"), "declaration");
	await fs.writeFile(join(globalDir, "ignored.txt"), "not a template");
	await fs.writeFile(join(globalDir, "empty.md"), "");
	await fs.writeFile(join(globalDir, "unreadable.md"), "must be skipped");
	manager.configureSettings(
		() => ({ disabledPrompts: ["REVIEW"] }),
		async () => assert.fail("read-only route must not patch settings"),
	);

	const result = await call(routes, "/api/prompt-templates");
	assert.equal(result.status, 200);
	assert.equal(result.body.globalDir, globalDir);
	assert.equal("projectDir" in result.body, false);
	assert.deepEqual(result.body.templates, [
		{ name: "plain", description: "# First non-empty line", scope: "global", enabled: true },
		{ name: "review", description: "Review code", scope: "global", enabled: false },
	]);
	for (const template of result.body.templates) {
		assert.deepEqual(Object.keys(template).sort(), ["description", "enabled", "name", "scope"]);
	}
	assert.equal(result.headers["access-control-allow-origin"], "*");
	assert.equal(result.headers["cache-control"], "no-store");
});

test("projectId overlays project templates, with project-local enabled state and no duplicate names", async (t) => {
	const { globalDir, project, projectDir, manager, routes } = await fixture(t);
	await fs.writeFile(join(globalDir, "shared.md"), "global shared");
	await fs.writeFile(join(globalDir, "global-only.md"), "global only");
	await fs.writeFile(join(projectDir, "shared.md"), "project shared");
	await fs.writeFile(join(projectDir, "local-only.md"), "local only");
	await fs.writeFile(join(projectDir, "local-off.md"), "local off");
	await fs.writeFile(join(projectDir, "ignored.d.md"), "declaration");
	await fs.writeFile(join(project, ".pi", "settings.json"), JSON.stringify({ disabledPrompts: ["LOCAL-OFF"] }));
	manager.configureSettings(
		() => ({ disabledPrompts: ["shared", "local-only"] }),
		async () => assert.fail("must not write"),
	);

	const result = await call(routes, "/api/prompt-templates?projectId=p1");
	assert.equal(result.status, 200);
	assert.equal(result.body.globalDir, globalDir);
	assert.equal(result.body.projectDir, projectDir);
	assert.deepEqual(result.body.templates, [
		{ name: "global-only", description: "global only", scope: "global", enabled: true },
		{ name: "local-off", description: "local off", scope: "project", enabled: false },
		{ name: "local-only", description: "local only", scope: "project", enabled: true },
		{ name: "shared", description: "project shared", scope: "project", enabled: true },
	]);
});

test("enabled state uses PromptManager native global and project projections", async (t) => {
	const { globalDir, projectDir, manager, routes } = await fixture(t);
	await fs.writeFile(join(globalDir, "native.md"), "native global");
	await fs.writeFile(join(globalDir, "legacy.md"), "legacy disabled");
	await fs.writeFile(join(projectDir, "local.md"), "native project");
	manager.configureSettings(
		() => ({ disabledPrompts: ["native", "legacy"] }),
		async () => assert.fail("must not write"),
	);
	manager.configureNativeEnabledReader((path) => (basename(path) === "native.md" ? true : undefined));
	const projectIds = [];
	manager.configureNativeProjectEntriesReader(async (projectId) => {
		projectIds.push(projectId);
		return ["-prompts/local.md"];
	});

	const result = await call(routes, "/api/prompt-templates?projectId=p1");
	assert.equal(result.status, 200);
	assert.deepEqual(projectIds, ["p1"]);
	assert.equal(result.body.templates.find((template) => template.name === "native").enabled, true);
	assert.equal(result.body.templates.find((template) => template.name === "legacy").enabled, false);
	assert.equal(result.body.templates.find((template) => template.name === "local").enabled, false);
});

test("search matches names or descriptions case-insensitively after applying the project overlay", async (t) => {
	const { globalDir, projectDir, routes } = await fixture(t);
	await fs.writeFile(join(globalDir, "review.md"), "---\ndescription: Global metadata\n---\nbody-only-keyword");
	await fs.writeFile(join(projectDir, "review.md"), "---\ndescription: Project metadata\n---\nbody-only-keyword");
	for (const [query, expected] of [
		[" ReViEw ", ["review"]],
		[" PROJECT METADATA ", ["review"]],
		["Global metadata", []],
		["body-only-keyword", []],
	]) {
		const result = await call(routes, `/api/prompt-templates?projectId=p1&search=${encodeURIComponent(query)}`);
		assert.equal(result.status, 200);
		assert.deepEqual(
			result.body.templates.map((template) => template.name),
			expected,
		);
	}
});

test("detail returns full raw markdown, Unicode names and project-over-global precedence", async (t) => {
	const { globalDir, projectDir, routes } = await fixture(t);
	const raw = `---\ndescription: Review code\nargument-hint: <file>\n---\n${"body\n".repeat(20_000)}END`;
	const name = "检查 code_name";
	await fs.writeFile(join(globalDir, `${name}.md`), raw);
	const global = await call(routes, `/api/prompt-templates/${encodeURIComponent(name)}`);
	assert.equal(global.status, 200);
	assert.deepEqual(global.body, { detail: { name, description: "Review code", content: raw, scope: "global" } });
	assert.ok(Buffer.byteLength(global.body.detail.content) > 64 * 1024, "detail must not use the truncated list body");

	const localRaw = "---\ndescription: Local review\n---\nProject body";
	await fs.writeFile(join(projectDir, `${name}.md`), localRaw);
	const local = await call(routes, `/api/prompt-templates/${encodeURIComponent(name)}?projectId=p1`);
	assert.equal(local.status, 200);
	assert.deepEqual(local.body, { detail: { name, description: "Local review", content: localRaw, scope: "project" } });
});

test("remote projects are rejected before reading local prompt templates", async () => {
	let reads = 0;
	const unexpectedRead = async () => {
		reads++;
		assert.fail("remote projects must not enter the local prompt reader");
	};
	const routes = new WebWorkspaceRoutes({
		listProjects: () => [{ id: "remote", name: "Remote", lastOpenedAt: 0, locator: { kind: "ssh", hostId: "unused-host", remotePath: "/workspace/example" } }],
		promptTemplates: { list: unexpectedRead, listByProject: unexpectedRead, readTemplateContent: unexpectedRead },
	});
	for (const path of ["/api/prompt-templates?projectId=remote", "/api/prompt-templates/review?projectId=remote"]) {
		const result = await call(routes, path);
		assert.equal(result.status, 404);
		assert.equal(result.body.code, "webError.projectNotFound");
	}
	assert.equal(reads, 0);
});

test("unavailable service, unknown projects, missing templates and malformed names return structured errors", async (t) => {
	const { globalDir, manager, routes } = await fixture(t);
	await fs.writeFile(join(globalDir, "ignored.d.md"), "not a prompt template");
	for (const path of ["/api/prompt-templates", "/api/prompt-templates/missing"]) {
		const unavailable = await call(new WebWorkspaceRoutes({ listProjects: () => [] }), path);
		assert.equal(unavailable.status, 503);
		assert.equal(unavailable.body.code, "webError.promptTemplatesUnavailable");
	}
	for (const path of ["/api/prompt-templates?projectId=missing", "/api/prompt-templates/missing?projectId=missing"]) {
		const unknown = await call(routes, path);
		assert.equal(unknown.status, 404);
		assert.equal(unknown.body.code, "webError.projectNotFound");
	}
	for (const name of ["missing", "ignored.d"]) {
		const missing = await call(routes, `/api/prompt-templates/${name}`);
		assert.equal(missing.status, 404);
		assert.equal(missing.body.code, "webError.promptNotFound");
	}
	for (const name of ["%ZZ", "%00", "..%2Foutside", "..%5Coutside"]) {
		const invalid = await call(routes, `/api/prompt-templates/${name}`);
		assert.equal(invalid.status, 400);
		assert.equal(invalid.body.code, "webError.invalidRequest");
	}
	manager.list = async () => {
		throw new Error("private filesystem diagnostic");
	};
	const failed = await call(routes, "/api/prompt-templates");
	assert.equal(failed.status, 500);
	assert.deepEqual(failed.body, { code: "webError.internalError", error: "failed to read prompt templates" });
});

test("template routes are GET-only and cannot use path/confirm to read arbitrary files", async (t) => {
	const { home, globalDir, deps, routes } = await fixture(t);
	await fs.writeFile(join(globalDir, "safe.md"), "safe template");
	const outside = join(home, "secret.md");
	await fs.writeFile(outside, "private data");
	let gateCalls = 0;
	const guarded = new WebWorkspaceRoutes({
		...deps,
		userReadAccess: () => {
			gateCalls++;
			return { access: "allow", reason: "unrestricted" };
		},
	});
	const result = await call(guarded, `/api/prompt-templates/safe?path=${encodeURIComponent(outside)}&confirm=1`);
	assert.equal(result.status, 200);
	assert.equal(result.body.detail.content, "safe template");
	assert.equal(gateCalls, 0, "the template route must not enter the arbitrary-file preview channel");
	for (const method of ["POST", "PUT", "DELETE"]) {
		assert.equal((await call(routes, "/api/prompt-templates", method)).handled, false);
		assert.equal((await call(routes, "/api/prompt-templates/safe", method)).handled, false);
	}
});

test("detail permits exactly 2MB and rejects oversized templates without returning partial bodies", async (t) => {
	const { globalDir, routes } = await fixture(t);
	const raw = "x".repeat(CONTENT_LIMIT);
	await fs.writeFile(join(globalDir, "at-limit.md"), raw);
	await fs.writeFile(join(globalDir, "over-limit.md"), `${raw}x`);
	const allowed = await call(routes, "/api/prompt-templates/at-limit");
	assert.equal(allowed.status, 200);
	assert.equal(allowed.body.detail.content, raw);
	const rejected = await call(routes, "/api/prompt-templates/over-limit");
	assert.equal(rejected.status, 413);
	assert.equal(rejected.body.code, "webError.fileTooLarge");
	assert.equal("detail" in rejected.body, false);
});

test("bounded detail reads handle short reads and enforce the limit even when stat is stale", async (t) => {
	const requested = [];
	const { globalDir, routes } = await fixture(t, {
		"node:fs/promises": {
			...fs,
			open: async (path, ...args) => {
				const handle = await fs.open(path, ...args);
				return {
					stat: async () => ({ isFile: () => true, size: 1 }),
					read: (buffer, offset, length, position) => {
						requested.push(length);
						return handle.read(buffer, offset, Math.min(length, 4096), position);
					},
					close: () => handle.close(),
				};
			},
		},
	});
	const raw = "short reads\n".repeat(10_000);
	await fs.writeFile(join(globalDir, "short.md"), raw);
	await fs.writeFile(join(globalDir, "growing.md"), "x".repeat(CONTENT_LIMIT + 1));
	const complete = await call(routes, "/api/prompt-templates/short");
	assert.equal(complete.status, 200);
	assert.equal(complete.body.detail.content, raw);
	const growing = await call(routes, "/api/prompt-templates/growing");
	assert.equal(growing.status, 413);
	assert.equal(growing.body.code, "webError.fileTooLarge");
	assert.ok(requested.every((length) => length <= CONTENT_LIMIT + 1));
});

test("global detail revalidates a cached template path against symlink escape", async (t) => {
	const { home, globalDir, routes } = await fixture(t);
	const target = join(globalDir, "cached.md");
	const outside = join(home, "outside.md");
	await fs.writeFile(target, "approved template");
	await fs.writeFile(outside, "private data");
	const listed = await call(routes, "/api/prompt-templates");
	assert.equal(listed.status, 200);
	assert.equal(listed.body.templates.length, 1);
	await fs.unlink(target);
	if (!(await link(t, outside, target, "file"))) return;
	const result = await call(routes, "/api/prompt-templates/cached");
	assert.equal(result.status, 404);
	assert.equal(result.body.code, "webError.promptNotFound");
	assert.equal(JSON.stringify(result.body).includes("private data"), false);
});

test("project detail revalidates its canonical boundary after listing, and skips an escaped template directory", async (t) => {
	const { home, projectDir, manager, routes } = await fixture(t);
	const outsideDir = join(home, "outside");
	await fs.mkdir(outsideDir);
	await fs.writeFile(join(outsideDir, "local.md"), "private data");
	await fs.writeFile(join(projectDir, "local.md"), "approved project template");
	const originalRead = manager.readTemplateContent;
	let linkSupported = true;
	manager.readTemplateContent = async (...args) => {
		await fs.rm(projectDir, { recursive: true, force: true });
		linkSupported = await link(t, outsideDir, projectDir, process.platform === "win32" ? "junction" : "dir");
		if (!linkSupported) return { content: "" };
		return originalRead.apply(manager, args);
	};
	const detail = await call(routes, "/api/prompt-templates/local?projectId=p1");
	if (!linkSupported) return;
	assert.equal(detail.status, 404);
	assert.equal(detail.body.code, "webError.promptNotFound");
	const list = await call(routes, "/api/prompt-templates?projectId=p1");
	assert.equal(list.status, 200);
	assert.deepEqual(list.body.templates, []);
});

test("global templates follow configured WSL windowsHome rather than the original local home", async (t) => {
	const { home, globalDir, manager, routes } = await fixture(t);
	await fs.writeFile(join(globalDir, "local.md"), "local template");
	const wslHome = join(home, "wsl-home");
	const wslPrompts = join(wslHome, ".pi", "agent", "prompts");
	await fs.mkdir(wslPrompts, { recursive: true });
	await fs.writeFile(join(wslPrompts, "wsl.md"), "---\ndescription: WSL template\n---\nWSL body");
	manager.configureWsl({ distro: "Test", user: "tester", linuxHome: "/home/tester", windowsHome: wslHome });
	const listed = await call(routes, "/api/prompt-templates");
	assert.equal(listed.status, 200);
	assert.equal(listed.body.globalDir, wslPrompts);
	assert.deepEqual(
		listed.body.templates.map((template) => template.name),
		["wsl"],
	);
	const detail = await call(routes, "/api/prompt-templates/wsl");
	assert.equal(detail.status, 200);
	assert.equal(detail.body.detail.content, "---\ndescription: WSL template\n---\nWSL body");
});

test("the HTTP service applies the existing Bearer auth and CORS to both template endpoints", async (t) => {
	const { globalDir, routes } = await fixture(t);
	await fs.writeFile(join(globalDir, "review.md"), "review template");
	const { WebServiceManager } = loadTsCommonJs("src/main/web/WebServiceManager.ts", { globals: { fetch: globalThis.fetch } });
	const service = new WebServiceManager({ subscribePiEvents: () => () => undefined });
	service.workspaceRoutes = routes;
	await service.start("127.0.0.1", 0, true);
	try {
		const base = `http://127.0.0.1:${service.current.port}`;
		for (const path of ["/api/prompt-templates", "/api/prompt-templates/review"]) {
			const unauthorized = await fetch(`${base}${path}`);
			assert.equal(unauthorized.status, 401);
			assert.equal(unauthorized.headers.get("access-control-allow-origin"), "*");
			const invalid = await fetch(`${base}${path}`, { headers: { authorization: "Bearer wrong" } });
			assert.equal(invalid.status, 401);
			const authorized = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${service.current.token}` } });
			assert.equal(authorized.status, 200);
			assert.equal(authorized.headers.get("access-control-allow-origin"), "*");
		}
	} finally {
		await service.stop();
	}
});
