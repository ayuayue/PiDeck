import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { applyDirectoryIgnore, repoScopeOfPath, repoRelativePathOf, DIRECTORY_IGNORE_BATCH_SIZE } = loadTsCommonJs("src/main/files/DirectoryIgnore.ts");
const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");

const projectId = "remote-project";
const locator = { kind: "ssh", hostId: "remote-host", remotePath: "/workspace/project" };
const plain = (value) => JSON.parse(JSON.stringify(value));

/**
 * T6 收尾：把 `git.checkIgnore` 接进公共目录页（只加修饰，不过滤）。
 *
 * 验收点：
 * 1. 仓库归因只有一条规则——最长目录前缀（`packages/nested-other` 不属于 `packages/nested`）；
 * 2. helper 只看到**仓库内**路径，且按 64 路径/批切分；
 * 3. 无能力/无仓库/判定失败 → 整页**不填** ignored（字段缺失），绝不填 false 冒充“查过了”；
 * 4. 目录页本身不因判定失败而失败。
 */
function fixture(options = {}) {
	const handlers = new Map();
	const calls = [];
	const { registerRemoteGitReadIpc } = loadTsCommonJs("src/main/ipc/remoteGitReadIpc.ts", { stubs: { electron: { ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) } } } });
	const sender = new EventEmitter();
	sender.id = 1;
	sender.isDestroyed = () => false;
	const capabilities = options.capabilities ?? ["git.status", "git.repos", "git.checkIgnore"];
	const session = {
		hostRevision: 1,
		async request(method, params, requestOptions) {
			calls.push({ method, params, ...(requestOptions?.repo === undefined ? {} : { repo: requestOptions.repo }) });
			requestOptions?.onRequestId?.(`request-${calls.length}`);
			if (method === "hello") return { protocolVersion: 1, root: locator.remotePath, capabilities };
			if (method === "git.repos") return { repos: options.repos ?? [{ path: "", name: "project" }], truncated: false };
			if (method === "git.checkIgnore") {
				if (options.checkIgnoreFails === true) throw new Error("GIT_COMMAND_FAILED");
				if (options.failPaths !== undefined && params.paths.some((path) => options.failPaths.includes(path))) throw new Error("GIT_COMMAND_FAILED");
				const ignored = params.paths.map((path) => (options.ignoredPaths ?? []).includes(path));
				return { ignored };
			}
			throw new Error("UNEXPECTED_METHOD");
		},
		async cancel() {
			return undefined;
		},
	};
	const port = registerRemoteGitReadIpc({
		enabled: true,
		locator: (id) => (id === projectId ? locator : undefined),
		trusted: async () => options.trusted !== false,
		service: async () => ({
			async withProjectSession(_hostId, _root, work, withOptions) {
				assert.equal(withOptions.requireReady, true);
				return { ok: true, value: await work(session) };
			},
			projectConnectionFacts: () => ({ connectionId: "conn-1", state: "ready" }),
		}),
	});
	return { port, calls, sender, handlers, session };
}

test("仓库归因：最长目录前缀，严格边界；没有仓库覆盖就是未知", () => {
	const repos = ["", "packages/nested", "packages/nested/deeper"];
	assert.equal(repoScopeOfPath(repos, "root.txt"), "");
	assert.equal(repoScopeOfPath(repos, "packages/nested/a.txt"), "packages/nested");
	assert.equal(repoScopeOfPath(repos, "packages/nested/deeper/b.txt"), "packages/nested/deeper");
	// 同名前缀不是前缀：不属于任何嵌套仓库，只能落在根仓库。
	assert.equal(repoScopeOfPath(repos, "packages/nested-other/a.txt"), "");
	assert.equal(repoScopeOfPath([], "a.txt"), undefined, "项目不是仓库：未知，不是“未忽略”");
	assert.equal(repoScopeOfPath(["packages/a"], "packages/a"), "packages/a", "仓库根自身也算被覆盖");
	assert.equal(repoRelativePathOf("packages/nested", "packages/nested/a.txt"), "a.txt");
	assert.equal(repoRelativePathOf("", "root.txt"), "root.txt");
});

test("修饰只落 true：false 与未知都不写字段，结果长度不符时整页不动", () => {
	const entries = [{ ignored: undefined }, { ignored: true }];
	assert.deepEqual(plain(applyDirectoryIgnore([{}, {}], [true, false])), [{ ignored: true }, {}]);
	assert.deepEqual(plain(applyDirectoryIgnore(entries, undefined)), [{}, { ignored: true }], "未知 → 保留原样");
	assert.deepEqual(plain(applyDirectoryIgnore([{}, {}], [true])), [{}, {}], "长度不符不猜");
});

test("probeIgnore：只对当前仓库发帧，helper 只看到仓库内路径", async () => {
	const f = fixture({
		repos: [
			{ path: "", name: "project" },
			{ path: "packages/nested", name: "nested" },
		],
		ignoredPaths: ["a.txt", "dist"],
	});
	const ignored = await f.port.probeIgnore(projectId, ["packages/nested/a.txt", "packages/nested/dist", "packages/nested-other/b.txt"]);
	assert.deepEqual(plain(ignored), [true, true, false]);
	const frames = f.calls.filter((call) => call.method === "git.checkIgnore");
	assert.equal(frames.length, 2, "两个仓库各一次：根仓库与嵌套仓库");
	const nested = frames.find((frame) => frame.repo === "packages/nested");
	assert.deepEqual(plain(nested.params.paths), ["a.txt", "dist"], "helper 只认仓库内路径");
	const root = frames.find((frame) => frame.repo === undefined);
	assert.deepEqual(plain(root.params.paths), ["packages/nested-other/b.txt"], "同名前缀归根仓库");
});

test("probeIgnore：64 路径/批；仓库列表按 TTL 缓存，暖命中不再发现仓库", async () => {
	const f = fixture({ ignoredPaths: ["f-70"] });
	const paths = Array.from({ length: 70 }, (_, index) => `f-${index + 1}`);
	const ignored = await f.port.probeIgnore(projectId, paths);
	assert.equal(plain(ignored)[69], true);
	const frames = f.calls.filter((call) => call.method === "git.checkIgnore");
	assert.equal(frames.length, Math.ceil(70 / DIRECTORY_IGNORE_BATCH_SIZE), "按 64 切批");
	assert.equal(frames[0].params.paths.length, 64);

	f.calls.length = 0;
	await f.port.probeIgnore(projectId, ["f-1", "f-2"]);
	assert.equal(f.calls.filter((call) => call.method === "git.repos").length, 0, "仓库列表在 TTL 内复用");
	assert.equal(f.calls.filter((call) => call.method === "git.checkIgnore").length, 1);
});

test("probeIgnore：无能力 / 无仓库 / 判定失败 / 未授权 → undefined（不填字段）", async () => {
	const noCapability = fixture({ capabilities: ["git.status", "git.repos"] });
	assert.equal(await noCapability.port.probeIgnore(projectId, ["a.txt"]), undefined);
	assert.equal(noCapability.calls.filter((call) => call.method === "git.checkIgnore").length, 0, "没有能力就一个判定帧都不发");

	const noRepo = fixture({ repos: [] });
	assert.equal(await noRepo.port.probeIgnore(projectId, ["a.txt"]), undefined, "项目不是仓库：未知");

	const failing = fixture({ checkIgnoreFails: true });
	assert.equal(await failing.port.probeIgnore(projectId, ["a.txt"]), undefined, "失败不是“未忽略”");

	const untrusted = fixture({ trusted: false });
	assert.equal(await untrusted.port.probeIgnore(projectId, ["a.txt"]), undefined);

	const empty = fixture();
	assert.equal(await empty.port.probeIgnore(projectId, []), undefined, "空目录页不判定");
	assert.equal(empty.calls.length, 0);
});

/* ------------------------------------------------ 目录页接线 */

function projectFixture(options = {}) {
	const handlers = new Map();
	const calls = { list: 0, probe: [] };
	const HOST = "6f1b7c1e-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
	const { registerRemoteProjectIpc } = loadTsCommonJs("src/main/ipc/remoteProjectIpc.ts", {
		stubs: {
			electron: { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } },
			"../remote/RemoteBrowseRoot": {
				async resolveRemoteBrowseRoot() {
					return { canonicalPath: locator.remotePath };
				},
			},
			"../remote/RemoteSearchReader": {
				REMOTE_SEARCH_READER_CODES: { queryInvalid: "QUERY_INVALID", requestFailed: "REMOTE_WORKSPACE_REQUEST_FAILED", optionsInvalid: "REMOTE_WORKSPACE_READER_OPTIONS_INVALID" },
				createRemoteSearchReader: () => ({
					async search() {
						return { entries: [], scanned: 0, truncated: false };
					},
				}),
			},
			"../remote/RemoteWorkspaceReader": {
				createRemoteWorkspaceReader: () => ({
					async readFile() {
						return { content: Buffer.from("x"), bytes: 1, mtimeMs: 1 };
					},
				}),
			},
		},
	});
	const service = {
		async withProjectSession(_hostId, _root, work) {
			return { ok: true, value: await work({ connectionId: "conn-1", request: async (method) => (method === "fs.watch" ? { watchId: "w1" } : { ok: true }), cancel: async () => undefined }) };
		},
		projectConnectionFacts: () => ({ connectionId: "conn-1", state: "ready" }),
		projectHelperCapabilities: () => ["fs.watch"],
		retainProjectSessionWatch: () => undefined,
		releaseProjectSessionWatch: () => undefined,
	};
	const facts = registerRemoteProjectIpc({
		enabled: true,
		userDataDir: "/tmp/unused",
		service: async () => service,
		directoryReader: {
			async read() {
				calls.list += 1;
				return {
					ok: true,
					value: {
						entries: [
							{ name: "dist", kind: "directory" },
							{ name: "a.txt", kind: "file" },
							{ name: "b.txt", kind: "file" },
						],
						scanned: 3,
						truncated: false,
					},
				};
			},
		},
		projects: {
			enroll: async () => ({ projectId }),
			locator: (id) => (id === projectId ? { kind: "ssh", hostId: HOST, remotePath: locator.remotePath } : undefined),
		},
	});
	if (options.probe !== "none") {
		facts.setIgnoreProbe(async (_projectId, paths) => {
			calls.probe.push([...paths]);
			if (options.probe === "throws") throw new Error("GIT_COMMAND_FAILED");
			return paths.map((path) => path === "dist");
		});
	}
	const page = () => facts.directoryPage(projectId, "", false);
	return { facts, calls, page };
}

test("目录页：ignored 只落在被忽略的条目上，其余条目没有该字段", async () => {
	const f = projectFixture();
	const result = await f.page();
	assert.equal(result.ok, true);
	assert.deepEqual(plain(f.calls.probe), [["dist", "a.txt", "b.txt"]], "目录页一次批判定，顺序与条目一致");
	const byPath = new Map(result.value.entries.map((entry) => [entry.relativePath, entry]));
	assert.equal(byPath.get("dist").ignored, true);
	assert.equal(Object.hasOwn(byPath.get("a.txt"), "ignored"), false, "未被忽略 = 没有修饰，不是 false");
	assert.equal(byPath.get("dist").type, "directory");
});

test("目录页：探测失败/未装配都只丢修饰，页面仍然成功且不重复装载", async () => {
	for (const probe of ["throws", "none"]) {
		const f = projectFixture({ probe });
		const result = await f.page();
		assert.equal(result.ok, true, probe + "：判定不是读的前置条件");
		assert.equal(f.calls.list, 1);
		for (const entry of result.value.entries) assert.equal(Object.hasOwn(entry, "ignored"), false, probe + "：“没判定”不能写成“未忽略”");
	}
});

test("probeIgnore：.git 是保留名，不送进 check-ignore（也不因它整页放弃修饰）", async () => {
	const f = fixture({ ignoredPaths: ["ignored.log"] });
	const flags = await f.port.probeIgnore(projectId, [".git", "ignored.log", "visible.txt"]);
	assert.deepEqual(plain(flags), [false, true, false], ".git 保持“没判定”（false 不落修饰）");
	const frames = f.calls.filter((call) => call.method === "git.checkIgnore");
	assert.equal(frames.length, 1);
	assert.deepEqual(plain(frames[0].params.paths), ["ignored.log", "visible.txt"], ".git 不进帧");

	// 整页都是保留名：直接返回，不发现仓库也不发判定帧。
	const onlyGit = fixture();
	const reserved = await onlyGit.port.probeIgnore(projectId, [".git"]);
	assert.deepEqual(plain(reserved), [false]);
	assert.equal(onlyGit.calls.length, 0);
});

test("probeIgnore：单批失败只丢这一批，其它批照常修饰（修饰不是读的前置条件）", async () => {
	const f = fixture({ ignoredPaths: ["f-1", "f-70"], failPaths: ["f-70"] });
	const paths = Array.from({ length: 70 }, (_, index) => `f-${index + 1}`);
	const flags = await f.port.probeIgnore(projectId, paths);
	assert.equal(plain(flags)[0], true, "第 1 批成功：批内命中照常落 used");
	assert.equal(plain(flags)[69], false, "第 2 批失败：该批不修饰，但不影响第 1 批");
});
