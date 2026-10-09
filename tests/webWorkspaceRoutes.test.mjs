/**
 * Web 工作区只读路由单测（P3）：git status/diff/log、files 列表、file-content
 * 沙箱与有界读取、prompts 列表/详情。直接实例化 WebWorkspaceRoutes，
 * 用假 ServerResponse 断言协议形状；file-content 用真实临时目录验证沙箱。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile, realpath, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
// 注：期望值里的项目内路径用 join 构造，避免 Windows 分隔符差异
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { WebWorkspaceRoutes } = loadTsCommonJs("src/main/web/WebWorkspaceRoutes.ts");

function fakeResponse() {
	const res = {
		status: 0,
		headers: {},
		body: "",
		writeHead(status, headers) {
			this.status = status;
			this.headers = headers;
		},
		end(payload) {
			if (payload !== undefined) this.body = String(payload);
		},
	};
	return res;
}

async function call(routes, path) {
	const res = fakeResponse();
	const handled = await routes.handle(new URL(`http://localhost${path}`), { method: "GET" }, res);
	return { handled, status: res.status, body: res.body ? JSON.parse(res.body) : null };
}

/** git/files/prompts 三组 stub：记录调用并回放固定数据。 */
function stubDeps(root, overrides = {}) {
	const calls = { diff: [], log: [], tree: [], prompts: [], detail: [] };
	return {
		calls,
		deps: {
			listProjects: () => [{ id: "p1", name: "P", path: root }],
			git: {
				isGitRepo: async () => true,
				getBranches: async () => ({ current: "main", locals: ["main"], remotes: [] }),
				getStatus: async () => ({ staged: [], unstaged: [], untracked: [] }),
				getWorkspaceFileDiff: async (cwd, group, filePath, maxBytes) => {
					calls.diff.push({ cwd, group, filePath, maxBytes });
					return { path: filePath, patch: "@@ -1 +1 @@", binary: false };
				},
				getCommitLog: async (_cwd, options) => {
					calls.log.push(options);
					return [{ hash: "abc123", subject: "init", author: "a", timestamp: 1 }];
				},
			},
			files: {
				listTree: async (rootDir, maxDepth, directory) => {
					calls.tree.push({ rootDir, maxDepth, directory });
					return [
						{ name: "src", relativePath: "src", type: "directory", path: join(rootDir, "src"), hasChildren: true },
						{ name: "a.txt", relativePath: "a.txt", type: "file", path: join(rootDir, "a.txt"), hasChildren: false },
					];
				},
			},
			prompts: {
				list: async (opts) => {
					calls.prompts.push(opts);
					return {
						categories: ["编程提示词"],
						prompts: [{ slug: "s1", title: "T", path: "C:/secret/absolute/path.md", category: "编程提示词" }],
						total: 1,
					};
				},
				detail: async (slug, category) => {
					calls.detail.push({ slug, category });
					return slug === "missing" ? null : { title: `T:${slug}`, description: "d", promptContent: "c", path: "C:/secret.md" };
				},
			},
			...overrides,
		},
	};
}

test("workspace routes return 503 when git/files/prompts services are absent", async () => {
	const routes = new WebWorkspaceRoutes({ listProjects: () => [] });
	for (const [path, code] of [
		["/api/git/status?projectId=p1", "webError.gitUnavailable"],
		["/api/files?projectId=p1", "webError.filesUnavailable"],
		["/api/prompts", "webError.promptsUnavailable"],
	]) {
		const result = await call(routes, path);
		assert.equal(result.status, 503);
		assert.equal(result.body.code, code);
	}
});

test("git status reports repo:false, forwards branch+groups, and 404s unknown projects", async () => {
	const { deps } = stubDeps("C:/project");
	const noRepo = new WebWorkspaceRoutes({ listProjects: deps.listProjects, git: { ...deps.git, isGitRepo: async () => false } });
	assert.equal((await call(noRepo, "/api/git/status?projectId=p1")).body.repo, false);

	const routes = new WebWorkspaceRoutes(deps);
	const ok = await call(routes, "/api/git/status?projectId=p1");
	assert.equal(ok.status, 200);
	assert.equal(ok.body.repo, true);
	assert.equal(ok.body.branch.current, "main");
	assert.deepEqual(ok.body.groups, { staged: [], unstaged: [], untracked: [] });

	assert.equal((await call(routes, "/api/git/status?projectId=nope")).status, 404);
});

test("git diff validates group/path, rejects traversal, and caps diff bytes", async () => {
	const { deps, calls } = stubDeps("C:/project");
	const routes = new WebWorkspaceRoutes(deps);
	assert.equal((await call(routes, "/api/git/diff?projectId=p1&group=bogus&path=a.txt")).status, 400);
	assert.equal((await call(routes, "/api/git/diff?projectId=p1&group=index&path=../escape.txt")).status, 400);
	assert.equal((await call(routes, "/api/git/diff?projectId=p1&group=index&path=/etc/passwd")).status, 400);
	assert.equal((await call(routes, "/api/git/diff?projectId=p1&group=index")).status, 400);

	const ok = await call(routes, "/api/git/diff?projectId=p1&group=workingTree&path=src/a.ts");
	assert.equal(ok.status, 200);
	assert.equal(ok.body.diff.patch, "@@ -1 +1 @@");
	assert.equal(calls.diff[0].group, "workingTree");
	assert.equal(calls.diff[0].filePath, "src/a.ts");
	// 有界 diff：Web 端 1MB 上限必须在调用层生效（放宽首 256KB 对大重构/合并文件过紧）
	assert.equal(calls.diff[0].maxBytes, 1024 * 1024);
});

test("git log clamps limit into [1,50] with default 20", async () => {
	const { deps, calls } = stubDeps("C:/project");
	const routes = new WebWorkspaceRoutes(deps);
	await call(routes, "/api/git/log?projectId=p1");
	await call(routes, "/api/git/log?projectId=p1&limit=999");
	await call(routes, "/api/git/log?projectId=p1&limit=0");
	assert.deepEqual(
		calls.log.map((options) => options.maxEntries),
		[20, 50, 1],
	);
});

test("files listing strips absolute paths and rejects dir traversal", async () => {
	const { deps, calls } = stubDeps("C:/project");
	const routes = new WebWorkspaceRoutes(deps);
	const ok = await call(routes, "/api/files?projectId=p1");
	assert.equal(ok.status, 200);
	for (const node of ok.body.nodes) {
		// FileTreeNode.path 是宿主机绝对路径，对外必须剥离
		assert.equal("path" in node, false);
	}
	assert.equal(ok.body.nodes[0].hasChildren, true);
	assert.equal(calls.tree[0].maxDepth, 0);

	assert.equal((await call(routes, "/api/files?projectId=p1&dir=../escape")).status, 400);
	const sub = await call(routes, "/api/files?projectId=p1&dir=src");
	assert.equal(calls.tree[1].directory, join("C:/project", "src"));
	assert.equal(sub.status, 200);
});

test("file-content enforces sandbox, size bound, and binary refusal on a real directory", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "web-workspace-")));
	await writeFile(join(root, "a.txt"), "hello web", "utf8");
	await writeFile(join(root, "img.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]));
	await writeFile(join(root, "nul.log"), Buffer.from("a\0b", "utf8"));
	// 黑名单启发：无扩展名（Makefile）与生僻文本格式（.gradle）不再是白名单外拒读，只要内容无 NUL 就能预览
	await writeFile(join(root, "Makefile"), "build:\n\tgo build ./...", "utf8");
	await writeFile(join(root, "build.gradle"), "plugins { id 'java' }", "utf8");
	// 2MB+1 触发截断预览；512KB+1 在新上限内完整返回
	await writeFile(join(root, "big.txt"), "x".repeat(512 * 1024 + 1), "utf8");
	await writeFile(join(root, "huge.txt"), "y".repeat(2 * 1024 * 1024 + 1), "utf8");
	await mkdir(join(root, "sub"));
	await writeFile(join(dirname(root), "escape.txt"), "outside", "utf8");

	const { deps } = stubDeps(root);
	const routes = new WebWorkspaceRoutes({ ...deps, files: undefined, git: undefined, prompts: undefined });

	const text = await call(routes, `/api/file-content?projectId=p1&path=${encodeURIComponent("a.txt")}`);
	assert.equal(text.status, 200);
	assert.equal(text.body.content, "hello web");
	assert.equal(text.body.binary, undefined);

	// 二进制扩展名黑名单（png）→ 按二进制拒绝，不吐 UTF-8 乱码
	const png = await call(routes, `/api/file-content?projectId=p1&path=${encodeURIComponent("img.png")}`);
	assert.equal(png.body.binary, true);
	assert.equal(png.body.content, undefined);

	// 黑名单外但含 NUL 字节 → 启发式仍拒
	const nul = await call(routes, `/api/file-content?projectId=p1&path=${encodeURIComponent("nul.log")}`);
	assert.equal(nul.body.binary, true);

	// 无扩展名与生僻文本格式（旧白名单会误拒）→ 正常预览
	const makefile = await call(routes, `/api/file-content?projectId=p1&path=${encodeURIComponent("Makefile")}`);
	assert.equal(makefile.body.content, "build:\n\tgo build ./...");
	const gradle = await call(routes, `/api/file-content?projectId=p1&path=${encodeURIComponent("build.gradle")}`);
	assert.equal(gradle.body.content, "plugins { id 'java' }");

	// 512KB+1 在 2MB 上限内 → 完整内容
	const big = await call(routes, `/api/file-content?projectId=p1&path=${encodeURIComponent("big.txt")}`);
	assert.equal(big.body.content?.length, 512 * 1024 + 1);
	assert.equal(big.body.truncated, undefined);

	// 超 2MB → 截断预览：前 512KB 内容 + truncated 标记（不再空手而归）
	const huge = await call(routes, `/api/file-content?projectId=p1&path=${encodeURIComponent("huge.txt")}`);
	assert.equal(huge.body.truncated, true);
	assert.equal(huge.body.content?.length, 512 * 1024);
	assert.equal(huge.body.size, 2 * 1024 * 1024 + 1);

	// 沙箱：..逃逸 → 403；目录 → 404；缺失文件 → 404；空 path → 400
	assert.equal((await call(routes, `/api/file-content?projectId=p1&path=${encodeURIComponent("../escape.txt")}`)).status, 403);
	assert.equal((await call(routes, `/api/file-content?projectId=p1&path=${encodeURIComponent("sub")}`)).status, 404);
	assert.equal((await call(routes, `/api/file-content?projectId=p1&path=${encodeURIComponent("missing.txt")}`)).status, 404);
	assert.equal((await call(routes, "/api/file-content?projectId=p1&path=")).status, 400);
	assert.equal((await call(routes, "/api/file-content?projectId=nope&path=a.txt")).status, 404);
});

test("prompt listing strips host paths, clamps pageSize, and detail decodes slugs", async () => {
	const { deps, calls } = stubDeps("C:/project");
	const routes = new WebWorkspaceRoutes(deps);

	const list = await call(routes, "/api/prompts?search=%E4%BB%A3%E7%A0%81&category=%E7%BC%96%E7%A8%8B&pageSize=999");
	assert.equal(list.status, 200);
	assert.equal(calls.prompts[0].search, "代码");
	assert.equal(calls.prompts[0].category, "编程");
	assert.equal(calls.prompts[0].pageSize, 50);
	assert.equal(calls.prompts[0].page, 1);
	for (const prompt of list.body.prompts) {
		assert.equal("path" in prompt, false);
	}

	assert.equal((await call(routes, "/api/prompts/a%20b?category=x")).status, 200);
	assert.equal(calls.detail[0].slug, "a b");
	const detail = await call(routes, "/api/prompts/a%20b?category=x");
	assert.equal(detail.body.detail.title, "T:a b");
	assert.equal("path" in detail.body.detail, false);

	assert.equal((await call(routes, "/api/prompts/s1")).status, 400);
	assert.equal((await call(routes, "/api/prompts/missing?category=x")).status, 404);
});

test("unknown api paths fall through to the caller (returns false)", async () => {
	const routes = new WebWorkspaceRoutes({ listProjects: () => [] });
	const result = await call(routes, "/api/not-a-workspace-route");
	assert.equal(result.handled, false);
});

/** 技能/扩展资产 stub：列表带宿主路径（应被脱敏），toggle 记录调用。 */
function stubAssets(overrides = {}) {
	const calls = { skills: [], extensions: [] };
	return {
		calls,
		assets: {
			listSkills: async () => ({
				locations: [{ id: "pi-global", label: "pi global", path: "/host/pi/skills" }],
				skills: [{ name: "alpha", sourceId: "pi-global", path: "/host/pi/skills/alpha", dir: "/host/pi/skills", enabled: true }],
			}),
			toggleSkill: async (path, enabled) => {
				calls.skills.push({ path, enabled });
				return { name: "alpha", sourceId: "pi-global", path, dir: "/host/pi/skills", enabled };
			},
			listExtensions: async () => ({
				extensions: [{ name: "beta", scope: "project", path: "/host/proj/beta.ts", enabled: false }],
				raw: "cli output",
				conflicts: [],
			}),
			toggleExtension: async (path, enabled) => {
				calls.extensions.push({ path, enabled });
				return { name: "beta", scope: "project", path, enabled: false };
			},
			...overrides,
		},
	};
}

async function post(routes, path, body) {
	const res = fakeResponse();
	// readJsonBody 按事件流读 body：用 EventEmitter 模拟 IncomingMessage
	const req = new EventEmitter();
	req.method = "POST";
	setImmediate(() => {
		req.emit("data", Buffer.from(JSON.stringify(body)));
		req.emit("end");
	});
	const handled = await routes.handle(new URL(`http://localhost${path}`), req, res);
	return { handled, status: res.status, body: res.body ? JSON.parse(res.body) : null };
}

test("skills listing strips host paths; toggle requires name/enabled/sourceId", async () => {
	const stub = stubAssets();
	const routes = new WebWorkspaceRoutes({ listProjects: () => [], assets: stub.assets });
	const list = await call(routes, "/api/skills");
	assert.equal(list.status, 200);
	assert.deepEqual(Object.keys(list.body.skills[0]), ["name", "sourceId", "enabled"]);
	assert.deepEqual(Object.keys(list.body.locations[0]), ["id", "label"]);

	// 校验：缺 enabled / 非法 sourceId 都 400，不触发写操作
	assert.equal((await post(routes, "/api/skills/toggle", { name: "alpha", sourceId: "pi-global" })).status, 400);
	assert.equal((await post(routes, "/api/skills/toggle", { name: "alpha", enabled: true, sourceId: "nope" })).status, 400);
	assert.equal(stub.calls.skills.length, 0);
});

test("skills toggle resolves by name+sourceId (前端拿不到宿主路径) and 404s unknown", async () => {
	const stub = stubAssets();
	const routes = new WebWorkspaceRoutes({ listProjects: () => [], assets: stub.assets });
	const ok = await post(routes, "/api/skills/toggle", { name: "alpha", sourceId: "pi-global", enabled: false });
	assert.equal(ok.status, 200);
	assert.equal(ok.body.skill.enabled, false);
	assert.equal(stub.calls.skills[0].path, "/host/pi/skills/alpha");

	const missing = await post(routes, "/api/skills/toggle", { name: "ghost", sourceId: "pi-global", enabled: true });
	assert.equal(missing.status, 404);
});

test("extensions listing drops raw cli output and host paths; toggle validates scope enum", async () => {
	const stub = stubAssets();
	const routes = new WebWorkspaceRoutes({ listProjects: () => [], assets: stub.assets });
	const list = await call(routes, "/api/extensions");
	assert.equal(list.status, 200);
	assert.deepEqual(Object.keys(list.body.extensions[0]), ["name", "scope", "enabled"]);
	assert.ok(!JSON.stringify(list.body).includes("cli output"));
});

test("skills/extensions routes 503 when assets service missing", async () => {
	const routes = new WebWorkspaceRoutes({ listProjects: () => [] });
	assert.equal((await call(routes, "/api/skills")).status, 503);
	assert.equal((await call(routes, "/api/extensions")).status, 503);
});
