import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { FileSystemService } = loadTsCommonJs("src/main/fs/FileSystemService.ts");
const { LocalProjectFileBackend } = loadTsCommonJs("src/main/files/LocalProjectFileBackend.ts");
const { registerRemoteProjectIpc } = loadTsCommonJs("src/main/ipc/remoteProjectIpc.ts", {
	stubs: { electron: { ipcMain: { handle: () => undefined } } },
});

const HOST = "6f1b7c1e-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const PROJECT = "project-remote-1";
const plain = (value) => JSON.parse(JSON.stringify(value));

/**
 * T6（v5 §10.4）：文件域公共读契约的 conformance。
 *
 * 钉住的不是实现细节，而是两条 backend 必须给出同一份语义：
 * - 目录页 = 单层 + 显式 truncated + revision/generation；本机 hasChildren 精确，远端只能是 `"unknown"`；
 * - stat/pathsExist 只走只读 fs 面：128 路径 ≤2 帧（64/帧），不签 entry 令牌；批量失败不伪装成部分成功。
 */
test("本地目录页：单层、目录优先、hasChildren 精确、2000/2001 显式截断", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-page-"));
	try {
		mkdirSync(join(root, "with-child"));
		writeFileSync(join(root, "with-child", "a.txt"), "a");
		mkdirSync(join(root, "empty"));
		writeFileSync(join(root, "b.txt"), "b");

		const backend = new LocalProjectFileBackend({
			fileSystemService: new FileSystemService(),
			resolveProjectRoot: () => root,
		});
		const page = await backend.directoryPage({ projectId: "p1", relativePath: "" });
		assert.deepEqual(
			plain(page.entries.map((entry) => [entry.relativePath, entry.type, entry.hasChildren])),
			[
				["empty", "directory", false],
				["with-child", "directory", true],
				["b.txt", "file", false],
			],
			"目录优先；空目录明确 false，不伪装成“未查”",
		);
		assert.equal(page.truncated, false);
		assert.deepEqual(plain(page.entries[1].target), { projectId: "p1", relativePath: "with-child" });
		// Phase B：本机目录页必须带绝对路径与排序元数据，文件树才能无损迁到 services。
		assert.ok(page.entries.every((entry) => typeof entry.path === "string" && entry.path.length > 0));
		assert.equal(typeof page.entries[0].mtimeMs, "number");
		assert.equal(typeof page.entries[2].size, "number");
		assert.equal(Object.hasOwn(page, "totalEntries"), false, "不截断时不带 totalEntries");

		// 2001 个直接子项：页只返回 2000 并显式 truncated（不是抛错，也不是假装完整）。
		const many = Array.from({ length: 2001 }, (_, index) => ({ name: `n${index}`, relativePath: `n${index}`, type: "file", hasChildren: false }));
		const paged = new LocalProjectFileBackend({
			fileSystemService: {
				listTree: async () => many,
				listTreePage: async () => ({ nodes: many, truncated: false }),
				searchNames: async () => [],
				create: async () => undefined,
				delete: async () => undefined,
				rename: async () => undefined,
			},
			resolveProjectRoot: () => root,
		});
		const full = await paged.directoryPage({ projectId: "p1", relativePath: "" }, 2000);
		assert.equal(full.entries.length, 2000);
		assert.equal(full.truncated, true);
		assert.equal(full.totalEntries, 2001, "截断前总数用于“目录过大”提示");
		assert.equal(full.entries.at(-1).relativePath, "n1999");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

function remoteHarness(options = {}) {
	const calls = { list: [], statMany: [], stat: [] };
	const handlers = new Map();
	const sender = new EventEmitter();
	sender.id = 1;
	sender.isDestroyed = () => false;
	const session = {
		connectionId: "conn-1",
		async request(method, params) {
			calls[method.replace("fs.", "")]?.push(method === "fs.list" ? params.path : method === "fs.statMany" ? [...params.paths] : params.path);
			if (method === "fs.watch") return { watchId: "w1" };
			if (method === "fs.statMany") {
				if (options.statManyError !== undefined) throw new Error(options.statManyError);
				return { entries: params.paths.map((path) => ({ path, kind: options.kinds?.[path] ?? "file", bytes: 1, mtimeMs: 1 })) };
			}
			if (method === "fs.stat") {
				const kind = options.kinds?.[params.path];
				if (kind === undefined) throw new Error("PATH_NOT_FOUND");
				return { kind, bytes: 1, mtimeMs: 1 };
			}
			throw new Error("UNEXPECTED_METHOD");
		},
		async cancel() {
			return undefined;
		},
	};
	const service = {
		async withProjectSession(_hostId, _root, task) {
			return { ok: true, value: await task(session) };
		},
		// 项目级连接事实（P 的 root-scoped 面）：主机级 connectionFacts 证明不了这份缓存属于哪个 root。
		projectConnectionFacts: () => ({ connectionId: "conn-1", state: "ready" }),
	};
	const facts = registerRemoteProjectIpc({
		enabled: true,
		userDataDir: "/tmp/unused",
		service: async () => service,
		...(options.withoutDirectoryReader === true
			? {}
			: {
					directoryReader: {
						async read({ relative }) {
							calls.list.push(relative === "" ? "." : relative);
							if (options.listError !== undefined) return { ok: false, code: options.listError };
							const entries = options.entries ?? [];
							return {
								ok: true,
								value: {
									entries,
									scanned: options.scanned ?? entries.length,
									truncated: options.truncated ?? false,
								},
							};
						},
					},
				}),
		projects: {
			enroll: async () => ({ projectId: PROJECT }),
			locator: (projectId) => (projectId === PROJECT ? { kind: "ssh", hostId: HOST, remotePath: "/srv/app" } : undefined),
		},
	});
	return { calls, facts, handlers, sender };
}

test("远端目录页：target 项目相对、hasChildren=unknown、2000/2001 显式截断、带 revision/generation", async () => {
	const entries = Array.from({ length: 2001 }, (_, index) => ({ name: `n${index}`, kind: index === 0 ? "directory" : "file", ...(index === 0 ? {} : { bytes: 1 }) }));
	const h = remoteHarness({ entries });
	const page = await h.facts.directoryPage(PROJECT, "packages/app");
	assert.equal(page.ok, true);
	assert.equal(page.value.entries.length, 2000);
	assert.equal(page.value.truncated, true);
	assert.equal(page.value.scanned, 2001);
	assert.equal(page.value.generation, "conn-1");
	assert.ok(page.value.revision > 0);
	assert.deepEqual(plain(page.value.entries[0]), {
		target: { projectId: PROJECT, relativePath: "packages/app/n0" },
		relativePath: "packages/app/n0",
		type: "directory",
		hasChildren: "unknown",
	});

	// 恰好 2000 条：不能声称截断（没有证据）。
	const exact = remoteHarness({ entries: entries.slice(0, 2000) });
	const exactPage = await exact.facts.directoryPage(PROJECT, "");
	assert.equal(exactPage.value.entries.length, 2000);
	assert.equal(exactPage.value.truncated, false);
	assert.equal(exactPage.value.scanned, 2000);
});

test("远端目录页失败如实返回稳定码，不缓存成空目录", async () => {
	let h;
	for (const code of ["SFTP_PERMISSION_DENIED", "SFTP_REMOTE_NOT_FOUND", "SFTP_REMOTE_CONNECTION_LOST"]) {
		h = remoteHarness({ listError: code });
		const failed = await h.facts.directoryPage(PROJECT, "");
		assert.equal(failed.ok, false);
		assert.equal(failed.code, code);
		assert.equal("value" in failed, false, `${code} must not be projected as an empty directory`);
		assert.equal(h.calls.list.length, 1);
	}
	// 失败不缓存为事实：下一次读会重新询问。
	assert.ok(h);
	const retried = await h.facts.directoryPage(PROJECT, "");
	assert.equal(retried.ok, false);
	assert.equal(h.calls.list.length, 2);
});

test("远端空目录成功但不伪造截断", async () => {
	const h = remoteHarness({ entries: [] });
	const page = await h.facts.directoryPage(PROJECT, "");
	assert.equal(page.ok, true);
	assert.deepEqual(plain(page.value.entries), []);
	assert.equal(page.value.truncated, false);
	assert.equal(page.value.scanned, 0);
});

test("未装配 SFTP 目录端口时显式失败，不回退 helper fs.list", async () => {
	const h = remoteHarness({ withoutDirectoryReader: true });
	const page = await h.facts.directoryPage(PROJECT, "");
	assert.equal(page.ok, false);
	assert.equal(page.code, "REMOTE_SFTP_DIRECTORY_READ_FAILED");
	assert.equal(h.calls.list.length, 0, "no directory port means no read at all, not a helper fallback");
});

test("远端目录页：SFTP 截断不会被 2000 条投影边界掩盖", async () => {
	const h = remoteHarness({
		entries: [
			{ name: ".env", kind: "file", bytes: 4 },
			{ name: ".pideck-trash", kind: "directory" },
			{ name: ".0123456789abcdef0123456789abcdef.pideck-put", kind: "file", bytes: 1 },
			{ name: ".short.pideck-put", kind: "file", bytes: 1 },
			{ name: "src", kind: "directory" },
			{ name: "link", kind: "other" },
		],
		scanned: 4100,
		truncated: true,
	});
	const page = await h.facts.directoryPage(PROJECT, "");
	assert.equal(page.ok, true);
	assert.equal(page.value.truncated, true, "native truncation is independent of the 2000-entry projection");
	assert.equal(page.value.scanned, 4100);
	assert.deepEqual(
		plain(page.value.entries.map((entry) => [entry.relativePath, entry.type])),
		[
			[".env", "file"],
			[".short.pideck-put", "file"],
			["src", "directory"],
		],
		"hidden files stay visible; reserved names are hidden exactly; unsupported entry kinds are not followed or projected",
	);
});

test("远端 pathsExist：128 路径 = 2 帧（64/帧），只走只读 fs 面", async () => {
	const paths = Array.from({ length: 128 }, (_, index) => `dir/file-${index}.txt`);
	const h = remoteHarness();
	const result = await h.facts.pathsExist(PROJECT, paths);
	assert.equal(result.ok, true);
	assert.equal(result.value.length, 128);
	assert.deepEqual(
		h.calls.statMany.map((batch) => batch.length),
		[64, 64],
		"128 路径按 64 分批，恰好两帧",
	);
	assert.equal(h.calls.statMany[0][0], "dir/file-0.txt");
	assert.equal(h.calls.statMany[1].at(-1), "dir/file-127.txt");
	assert.equal(h.calls.stat.length, 0, "全部存在时不需要逐项 stat");
	assert.ok(result.value.every((state) => state.exists === true && state.isDirectory === false));
	assert.deepEqual(plain(result.value[0].target), { projectId: PROJECT, relativePath: paths[0] });
});

test("远端 pathsExist：批量含缺失路径时退回逐项只读 stat，仍不签令牌、不丢部分结果", async () => {
	// statMany 是全有或全无：请求里有缺失路径时整批 PATH_NOT_FOUND。
	const kinds = { "a.txt": "file", dir: "directory" };
	const h = remoteHarness({ kinds, statManyError: "PATH_NOT_FOUND" });
	const result = await h.facts.pathsExist(PROJECT, ["a.txt", "missing.txt", "dir"]);
	assert.equal(result.ok, true);
	assert.deepEqual(plain(result.value.map((state) => [state.target.relativePath, state.exists, state.isDirectory])), [
		["a.txt", true, false],
		["missing.txt", false, false],
		["dir", true, true],
	]);
	assert.equal(h.calls.statMany.length, 1);
	assert.deepEqual(h.calls.stat, ["a.txt", "missing.txt", "dir"], "逐项只读 stat（根相对路径原样）");
});

test("远端 pathsExist：非“缺失”类失败是整次失败，不返回部分成功数组", async () => {
	const h = remoteHarness({ statManyError: "REMOTE_CONNECTION_LOST" });
	const result = await h.facts.pathsExist(PROJECT, ["a.txt", "b.txt"]);
	assert.equal(result.ok, false);
	assert.equal(result.code, "REMOTE_CONNECTION_LOST");
	assert.equal(result.outcome, "rejected");
	assert.equal("value" in result, false, "失败不得携带半份数组");
});

test("远端目录页显式刷新越过已完成缓存；普通读仍共享同一 revision", async () => {
	const h = remoteHarness({ entries: [{ name: "a.txt", kind: "file", bytes: 1 }] });
	const first = await h.facts.directoryPage(PROJECT, "");
	const shared = await h.facts.directoryPage(PROJECT, "");
	assert.equal(first.ok, true);
	assert.equal(shared.ok, true);
	assert.equal(h.calls.list.length, 1, "普通读命中事实层");
	assert.equal(shared.value.revision, first.value.revision);

	const refreshed = await h.facts.directoryPage(PROJECT, "", true);
	assert.equal(refreshed.ok, true);
	assert.equal(h.calls.list.length, 2, "显式刷新必须真的重读");
	assert.ok(refreshed.value.revision > first.value.revision);
});
