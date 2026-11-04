import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { WslProjectFileBackend } = loadTsCommonJs("src/main/files/WslProjectFileBackend.ts");

const PROJECT = "p1";
const SESSION_TARGET = { distro: "Debian", user: "root", root: "/root/p" };
const FIXED_MTIME = 1_700_000_000_000;

/** 盘面：目录 → 单层条目（helper 只答单层），文件 → 内容。 */
const LISTING = new Map([
	[
		".",
		[
			{ name: "src", kind: "directory" },
			{ name: "node_modules", kind: "directory" },
			{ name: ".git", kind: "directory" },
			{ name: "README.md", kind: "file", bytes: 5 },
		],
	],
	[
		"src",
		[
			{ name: "app", kind: "directory" },
			{ name: "index.ts", kind: "file", bytes: 4 },
		],
	],
	["src/app", [{ name: "main.tsx", kind: "file", bytes: 4 }]],
]);
const FILES = new Map([
	["README.md", Buffer.from("hello", "utf8")],
	["src/index.ts", Buffer.from("main", "utf8")],
	["src/app/main.tsx", Buffer.from("view", "utf8")],
]);
const SEARCH_ENTRIES = [
	{ path: "src/index.ts", name: "index.ts", kind: "file", bytes: 4 },
	{ path: "src", name: "src", kind: "directory" },
];

function statOf(path, files = FILES) {
	if (LISTING.has(path)) return { kind: "directory", bytes: 0, mtimeMs: FIXED_MTIME };
	const content = files.get(path);
	if (content !== undefined) return { kind: "file", bytes: content.length, mtimeMs: FIXED_MTIME };
	return undefined;
}

/** 假 helper：只实现读面方法；不支持的方法用 PROTOCOL_INVALID 拒绝。 */
function helperAnswer(method, params, files = FILES) {
	if (method === "fs.list") {
		const entries = LISTING.get(params.path);
		return entries === undefined ? new Error("PATH_NOT_FOUND") : { entries };
	}
	if (method === "fs.statMany") {
		const entries = params.paths.map((path) => {
			const described = statOf(path, files);
			return described === undefined ? undefined : { path, ...described };
		});
		if (entries.some((entry) => entry === undefined)) return new Error("PATH_NOT_FOUND");
		return { entries };
	}
	if (method === "fs.stat") {
		const entry = statOf(params.path, files);
		return entry === undefined ? new Error("PATH_NOT_FOUND") : entry;
	}
	if (method === "fs.read") {
		const content = files.get(params.path);
		if (content === undefined) return new Error("PATH_NOT_FOUND");
		const chunk = content.subarray(params.offset, params.offset + params.bytes);
		return { chunk: chunk.toString("base64"), bytes: chunk.length, eof: params.offset + params.bytes >= content.length };
	}
	if (method === "fs.searchNames") return { entries: SEARCH_ENTRIES, scanned: 8, truncated: false };
	return new Error("PROTOCOL_INVALID");
}

/**
 * 假会话池。`mode` 决定整条 helper 链是否可用：
 * - "ok"：正常回答；
 * - "unavailable"：每个请求都抛会话层稳定码（触发回退）；
 * - "path-not-found"：只让 fs.list 报 PATH_NOT_FOUND（权威结论，不触发回退）。
 */
function makePool(mode = "ok", files = FILES) {
	const calls = [];
	return {
		async request(target, method, params) {
			calls.push({ target, method, params });
			if (mode === "unavailable") throw new Error("WSL_HELPER_SESSION_UNAVAILABLE");
			if (mode === "path-not-found" && method === "fs.list") throw new Error("PATH_NOT_FOUND");
			const answer = helperAnswer(method, params, files);
			if (answer instanceof Error) throw answer;
			return answer;
		},
		async cancel() {},
		async close() {},
		async closeAll() {},
		activeCount: () => 1,
		calls,
	};
}

function makeFallback() {
	const calls = [];
	return {
		locationKind: "local",
		calls,
		async list(...args) {
			calls.push(["list", ...args]);
			return [{ name: "from-fallback", relativePath: "x", target: { projectId: PROJECT, relativePath: "x" }, type: "file" }];
		},
		async directoryPage(...args) {
			calls.push(["directoryPage", ...args]);
			return { entries: [], truncated: false };
		},
		async search(...args) {
			calls.push(["search", ...args]);
			return [{ name: "fallback-hit", relativePath: "y", target: { projectId: PROJECT, relativePath: "y" }, type: "file" }];
		},
		async readContent(...args) {
			calls.push(["readContent", ...args]);
			return "fallback-content";
		},
		async readBase64(...args) {
			calls.push(["readBase64", ...args]);
			return "ZmFsbGJhY2s=";
		},
		async pathsExist(...args) {
			calls.push(["pathsExist", ...args]);
			return [true, true];
		},
		async stat(...args) {
			calls.push(["stat", ...args]);
			return { exists: true, isDirectory: false };
		},
		async writeContent(...args) {
			calls.push(["writeContent", ...args]);
		},
		async create(...args) {
			calls.push(["create", ...args]);
			return { projectId: PROJECT, relativePath: "new" };
		},
		async delete(...args) {
			calls.push(["delete", ...args]);
		},
		async rename(...args) {
			calls.push(["rename", ...args]);
			return { projectId: PROJECT, relativePath: "renamed" };
		},
		async copy(...args) {
			calls.push(["copy", ...args]);
			return [];
		},
		async move(...args) {
			calls.push(["move", ...args]);
			return [];
		},
	};
}

function makeBackend(overrides = {}) {
	const pool = overrides.pool ?? makePool();
	const fallback = overrides.fallback ?? makeFallback();
	const backend = new WslProjectFileBackend({
		pool,
		resolveSessionTarget: overrides.resolveSessionTarget ?? (() => SESSION_TARGET),
		fallback,
		skipGeneratedDirs: overrides.skipGeneratedDirs,
	});
	return { backend, pool, fallback };
}

async function rejectsWith(promise, code) {
	let outcome;
	try {
		await promise;
	} catch (error) {
		outcome = error;
	}
	assert.ok(outcome !== undefined, `expected ${code}`);
	const actual = typeof outcome.message === "string" && outcome.message.length > 0 ? outcome.message : outcome.code;
	assert.ok(outcome.message === code || outcome.code === code, `expected ${code}, got ${String(actual)}`);
}

const plain = (value) => JSON.parse(JSON.stringify(value));

test("list walks the helper's single-level answers and applies the local ignore/sort/metadata rules", async () => {
	const { backend } = makeBackend();
	// maxDepth 0 = 只读本层，与本地 listTree 的深度语义一致。
	const nodes = plain(await backend.list({ projectId: PROJECT, relativePath: "" }, 0));
	assert.deepEqual(
		nodes.map((node) => [node.name, node.type, node.relativePath]),
		[
			["src", "directory", "src"],
			["README.md", "file", "README.md"],
		],
	);
	// 深度边界：child 未查过，不写 children/hasChildren（不能把「没查」写成「没有子项」）。
	const src = nodes[0];
	assert.equal(src.children === undefined, true);
	assert.equal(src.hasChildren === undefined, true);
	// 文件带 helper 的元数据，目录不带大小。
	assert.equal(src.size, undefined);
	assert.equal(nodes[1].size, 5);
	assert.equal(nodes[1].mtimeMs, FIXED_MTIME);
	assert.deepEqual(nodes[1].target, { projectId: PROJECT, relativePath: "README.md" });
});

test("list reads nested levels and reports hasChildren where children were loaded", async () => {
	const { backend } = makeBackend();
	const nodes = plain(await backend.list({ projectId: PROJECT, relativePath: "" }, 2));
	const src = nodes[0];
	assert.deepEqual(
		src.children.map((child) => child.name),
		["app", "index.ts"],
	);
	const app = src.children[0];
	assert.equal(app.hasChildren, true);
	assert.deepEqual(
		app.children.map((child) => child.relativePath),
		["src/app/main.tsx"],
	);
});

test("skipGeneratedDirs adds the scan-only ignore set on top of .git/node_modules", async () => {
	const { backend } = makeBackend({ skipGeneratedDirs: true });
	const nodes = plain(await backend.list({ projectId: PROJECT, relativePath: "" }, 0));
	// 盘面没有 dist/build，这里只验证开关不改变基础忽略：.git 与 node_modules 仍被隐藏。
	assert.deepEqual(
		nodes.map((node) => node.name),
		["src", "README.md"],
	);
});

test("list falls back to the local backend only when the helper chain is unavailable", async () => {
	const { backend, fallback } = makeBackend({ pool: makePool("unavailable") });
	const nodes = plain(await backend.list({ projectId: PROJECT, relativePath: "" }, 0));
	assert.deepEqual(
		nodes.map((node) => node.name),
		["from-fallback"],
	);
	assert.equal(fallback.calls.length, 1);
	assert.equal(fallback.calls[0][0], "list");
});

test("a helper PATH_NOT_FOUND is authoritative and does not fall back", async () => {
	const { backend, fallback } = makeBackend({ pool: makePool("path-not-found") });
	await rejectsWith(backend.list({ projectId: PROJECT, relativePath: "" }, 0), "PATH_NOT_FOUND");
	assert.equal(fallback.calls.length, 0);
});

test("non-WSL targets bypass the helper entirely", async () => {
	const { backend, pool, fallback } = makeBackend({ resolveSessionTarget: () => undefined });
	await backend.list({ projectId: PROJECT, relativePath: "" }, 0);
	await backend.readContent({ projectId: PROJECT, relativePath: "README.md" });
	assert.equal(pool.calls.length, 0);
	assert.deepEqual(
		fallback.calls.map((call) => call[0]),
		["list", "readContent"],
	);
});

test("directoryPage is a single level with honest hasChildren and an explicit truncation", async () => {
	const { backend } = makeBackend();
	const page = plain(await backend.directoryPage({ projectId: PROJECT, relativePath: "" }, 2));
	assert.equal(page.truncated, false);
	assert.deepEqual(
		page.entries.map((entry) => [entry.relativePath, entry.type, entry.hasChildren]),
		[
			["src", "directory", "unknown"],
			["README.md", "file", false],
		],
	);
	assert.deepEqual(page.entries[0].target, { projectId: PROJECT, relativePath: "src" });

	const limited = plain(await backend.directoryPage({ projectId: PROJECT, relativePath: "" }, 1));
	assert.equal(limited.truncated, true);
	assert.equal(limited.entries.length, 1);
});

test("search maps helper hits onto project targets", async () => {
	const { backend, pool } = makeBackend();
	const hits = plain(await backend.search({ projectId: PROJECT, relativePath: "" }, "index"));
	assert.deepEqual(
		hits.map((hit) => [hit.name, hit.relativePath, hit.type]),
		[
			["index.ts", "src/index.ts", "file"],
			["src", "src", "directory"],
		],
	);
	assert.deepEqual(hits[0].target, { projectId: PROJECT, relativePath: "src/index.ts" });
	const call = pool.calls.find((entry) => entry.method === "fs.searchNames");
	assert.equal(call.params.query, "index");
	assert.equal(call.params.path, ".");
});

test("readContent returns UTF-8 text and refuses non-text with the same codes as the local guard", async () => {
	const { backend } = makeBackend();
	assert.equal(await backend.readContent({ projectId: PROJECT, relativePath: "README.md" }), "hello");

	const binary = new Map(FILES);
	binary.set("blob.bin", Buffer.from([0xff, 0xfe, 0x00, 0x01]));
	const nonUtf8 = makeBackend({ pool: makePool("ok", binary) });
	await rejectsWith(nonUtf8.backend.readContent({ projectId: PROJECT, relativePath: "blob.bin" }), "FILE_NOT_TEXT:4");

	const controls = new Map(FILES);
	controls.set("log.bin", Buffer.from("\u0001\u0002\u0003\u0004\u0005\u0006\u0007", "utf8"));
	const nonText = makeBackend({ pool: makePool("ok", controls) });
	await rejectsWith(nonText.backend.readContent({ projectId: PROJECT, relativePath: "log.bin" }), "FILE_NOT_TEXT:7");
});

test("readContent enforces the byte budget before reading the file body", async () => {
	const { backend } = makeBackend();
	await rejectsWith(backend.readContent({ projectId: PROJECT, relativePath: "README.md" }, 3), "FILE_TOO_LARGE:5:3");
});

test("readBase64 returns the exact bytes as base64", async () => {
	const { backend } = makeBackend();
	assert.equal(await backend.readBase64({ projectId: PROJECT, relativePath: "README.md" }), Buffer.from("hello").toString("base64"));
});

test("pathsExist answers per path when the all-or-nothing batch contains a missing entry", async () => {
	const { backend } = makeBackend();
	const states = plain(
		await backend.pathsExist([
			{ projectId: PROJECT, relativePath: "README.md" },
			{ projectId: PROJECT, relativePath: "missing.txt" },
			{ projectId: PROJECT, relativePath: "src" },
		]),
	);
	assert.deepEqual(states, [true, false, true]);
});

test("stat reports absence from PATH_NOT_FOUND instead of failing", async () => {
	const { backend } = makeBackend();
	assert.deepEqual(plain(await backend.stat({ projectId: PROJECT, relativePath: "README.md" })), { exists: true, isDirectory: false });
	assert.deepEqual(plain(await backend.stat({ projectId: PROJECT, relativePath: "src" })), { exists: true, isDirectory: true });
	assert.deepEqual(plain(await backend.stat({ projectId: PROJECT, relativePath: "missing.txt" })), { exists: false, isDirectory: false });
});

test("read paths fall back to the local backend when the helper chain is unavailable", async () => {
	const { backend, fallback } = makeBackend({ pool: makePool("unavailable") });
	assert.equal(await backend.readContent({ projectId: PROJECT, relativePath: "README.md" }), "fallback-content");
	assert.deepEqual(await backend.pathsExist([{ projectId: PROJECT, relativePath: "README.md" }]), [true, true]);
	assert.deepEqual(await backend.stat({ projectId: PROJECT, relativePath: "README.md" }), { exists: true, isDirectory: false });
	assert.deepEqual(
		fallback.calls.map((call) => call[0]),
		["readContent", "pathsExist", "stat"],
	);
});

test("writes stay delegated to the local backend in Wave 1a", async () => {
	const { backend, pool, fallback } = makeBackend();
	await backend.writeContent({ projectId: PROJECT, relativePath: "README.md" }, "x");
	assert.deepEqual(
		fallback.calls.map((call) => call[0]),
		["writeContent"],
	);
	assert.equal(pool.calls.length, 0);
});
