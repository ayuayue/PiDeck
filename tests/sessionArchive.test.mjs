import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { loadSessionScanner as loadProductionSessionScanner } from "./helpers/loadSessionScanner.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

function loadTranspiledModule(filePath, overrides = new Map()) {
	const source = readFileSync(filePath, "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const sandbox = {
		clearTimeout,
		exports: {},
		// jsonlLineStream（会话 JSONL 流式扫描）运行时需要 Buffer
		Buffer,
		process,
		require: (id) => (overrides.has(id) ? overrides.get(id) : require(id)),
		setTimeout,
	};
	vm.runInNewContext(outputText, sandbox, { filename: filePath });
	return sandbox.exports;
}

function loadCodexMetaModule() {
	const source = readFileSync("src/shared/codexSessionMeta.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const sandbox = { exports: {} };
	vm.runInNewContext(outputText, sandbox, { filename: "codexSessionMeta.ts" });
	return sandbox.exports;
}

function loadSessionNameLineModule() {
	const source = readFileSync("src/main/sessions/sessionNameLine.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const sandbox = { exports: {}, process, require, setTimeout };
	vm.runInNewContext(outputText, sandbox, { filename: "sessionNameLine.ts" });
	return sandbox.exports;
}

function loadSessionScannerLegacy(homePath) {
	const source = readFileSync("src/main/sessions/SessionScanner.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const codexMeta = loadCodexMetaModule();
	const messageContent = loadTranspiledModule("src/main/pi/messageContent.ts", new Map([["../feishu/docActions", { stripFeishuDocActionHint: (text) => text }]]));
	const fsRetry = loadTranspiledModule("src/main/utils/fsRetry.ts");
	const sessionSummaryCache = loadTranspiledModule(
		"src/main/sessions/sessionSummaryCache.ts",
		new Map([
			["electron", { app: { getPath: () => homePath } }],
			// fsRetry 只依赖 node:fs/promises，编译注入真实实现
			["../utils/fsRetry", fsRetry],
		]),
	);
	const wslPaths = loadTranspiledModule("src/main/wsl/WslPaths.ts");
	const sessionIdentity = loadTranspiledModule("src/shared/sessionIdentity.ts");
	// SessionScanner 新增的自包含块折叠（无依赖纯函数）
	const expandedRefBlocks = loadTranspiledModule("src/shared/expandedRefBlocks.ts");
	// 会话 JSONL 流式行扫描器（只依赖 node:fs/promises，测试注入真实实现）
	const jsonlLineStream = loadTranspiledModule("src/main/sessions/jsonlLineStream.ts");
	const sandbox = {
		AbortController,
		AbortSignal,
		Buffer,
		clearTimeout,
		exports: {},
		setTimeout,
		require: (id) => {
			if (id === "electron") {
				return {
					app: {
						getPath: (key) => (key === "home" ? homePath : join(homePath, String(key))),
					},
					shell: { trashItem: async () => {} },
				};
			}
			if (id === "../../shared/codexSessionMeta") return codexMeta;
			if (id === "../pi/sessionEntryIds") return loadTranspiledModule("src/main/pi/sessionEntryIds.ts");
			if (id === "../pi/messageContent") return messageContent;
			if (id === "./sessionSummaryCache") return sessionSummaryCache;
			if (id === "../wsl/WslPaths") return wslPaths;
			// sessionNameLine 为无依赖纯函数模块，直接编译加载真实实现，保证清理口径一致
			if (id === "./sessionNameLine") return loadSessionNameLineModule();
			if (id === "../../shared/sessionIdentity") return sessionIdentity;
			if (id === "../../shared/expandedRefBlocks") return expandedRefBlocks;
			if (id === "./jsonlLineStream") return jsonlLineStream;
			// sharedLogger 未注册时 getAppLogger 返回 null，SessionScanner 埋点静默跳过
			if (id === "../logging/sharedLogger") return { getAppLogger: () => null };
			return require(id);
		},
	};
	vm.runInNewContext(outputText, sandbox, { filename: "SessionScanner.ts" });
	return sandbox.exports;
}

function loadSessionScanner(homePath) {
	return loadProductionSessionScanner(homePath);
}

function writeSession(filePath, entries) {
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

const healthySession = [
	{ type: "session", id: "bbbb0001", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", cwd: "C:\\proj" },
	{ type: "message", id: "bbbb0002", parentId: "bbbb0001", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "hello archive" } },
	{ type: "message", id: "bbbb0003", parentId: "bbbb0002", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: "hi" } },
];

test("archive moves the session into .pideck-archive and list no longer returns it", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-archive-"));
	try {
		const sessionsRoot = join(home, ".pi", "agent", "sessions");
		const sessionPath = join(sessionsRoot, "archive-me.jsonl");
		writeSession(sessionPath, healthySession);

		const { SessionScanner } = loadSessionScanner(home);
		const scanner = new SessionScanner();
		// 先让 activeScanRoots 有值（list 会写入），归档路径解析依赖扫描根
		await scanner.list();

		const archived = await scanner.archive(sessionPath);
		assert.ok(archived.includes(".pideck-archive"), `archived path must live in archive dir: ${archived}`);
		assert.ok(!existsSync(sessionPath), "original file must be moved away");
		assert.ok(existsSync(archived), "archived file must exist");

		// 归档后常规列表不再包含该会话
		const summaries = await scanner.list();
		assert.ok(!summaries.some((s) => s.filePath === sessionPath), "archived session must not appear in list");

		// 归档列表能看到它（带归档前原始路径，供弹窗按项目归属过滤）
		const archivedList = await scanner.listArchived();
		assert.ok(
			archivedList.some((s) => s.summary.filePath === archived),
			"archived session must appear in listArchived",
		);
		const item = archivedList.find((s) => s.summary.filePath === archived);
		assert.equal(item?.originalPath, sessionPath, "listArchived must carry the original path from index.json");
		assert.equal(item?.summary.projectPath, "c:/proj", "archived summary must retain the JSONL cwd for project attribution");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("archived native POSIX sessions match the original project case after upgrading the summary cache", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "pideck-archive-posix-cwd-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const cwd = "/home/demo/Projects/MixedCase";
	const sessionPath = join(home, ".pi", "agent", "sessions", "archive-me.jsonl");
	writeSession(sessionPath, [{ ...healthySession[0], cwd }, ...healthySession.slice(1)]);

	const { SessionScanner } = loadSessionScanner(home);
	const scanner = new SessionScanner();
	const archivedPath = await scanner.archive(sessionPath);
	await scanner.listArchived();
	await scanner.flushSummaryCache();

	// 模拟升级前留下的 v3 摘要，保留原文件指纹，让旧缓存确实能命中。
	const cachePath = join(home, "userData", "session-summary-cache.json");
	const cache = JSON.parse(readFileSync(cachePath, "utf8"));
	cache.version = 3;
	cache.entries[archivedPath].value.projectPath = cwd.toLowerCase();
	writeFileSync(cachePath, JSON.stringify(cache));

	const restarted = new SessionScanner();
	await restarted.list();
	const items = await restarted.listArchived();
	const { filterArchivedPiByFamily } = loadTsCommonJs("src/renderer/src/sessionManagerModel.ts");
	const [match] = filterArchivedPiByFamily(items, [{ path: cwd }]);
	assert.equal(match?.summary.filePath, archivedPath);
	assert.equal(filterArchivedPiByFamily(items, [{ path: cwd.toLowerCase() }]).length, 0);
	assert.equal(await restarted.unarchive(match.summary.filePath), sessionPath);
	await restarted.flushSummaryCache();
});

test("readSummary preserves WSL cwd casing for archived project attribution", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-archive-wsl-cwd-"));
	try {
		const { SessionScanner } = loadSessionScanner(home);
		const scanner = new SessionScanner();
		await scanner.configureWsl({ distro: "Ubuntu", user: "dev", linuxHome: "/home/dev", windowsHome: "\\\\wsl.localhost\\Ubuntu\\home\\dev" });
		scanner.readWslFileVersion = async () => ({ mtimeMs: 1, size: 256 });
		scanner.readWslFileHead = async () => `${JSON.stringify({ type: "session", id: "wsl-archive", cwd: "/home/dev/Work" })}\n`;
		scanner.inferWslParentSessionFromPath = async () => undefined;

		const summary = await scanner.readSummary("/home/dev/.pi/agent/sessions/.pideck-archive/archive.jsonl");
		assert.equal(summary?.projectPath, "/home/dev/Work");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("listArchived without index.json entries still lists sessions without originalPath", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-archive-noindex-"));
	try {
		const sessionsRoot = join(home, ".pi", "agent", "sessions");
		const sessionPath = join(sessionsRoot, "noindex.jsonl");
		writeSession(sessionPath, healthySession);

		const { SessionScanner } = loadSessionScanner(home);
		const scanner = new SessionScanner();
		await scanner.list();
		await scanner.archive(sessionPath);
		// 删除索引模拟「极旧归档/索引损坏」：归档仍在，但无法反查原路径
		rmSync(join(home, ".pi", "agent", "sessions", ".pideck-archive", "index.json"), { force: true });

		const archivedList = await scanner.listArchived();
		assert.equal(archivedList.length, 1);
		assert.equal(archivedList[0]?.originalPath, undefined, "索引缺失时 originalPath 应为 undefined（弹窗不展示，配置页仍可恢复）");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("unarchive restores the session to its original path", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-unarchive-"));
	try {
		const sessionsRoot = join(home, ".pi", "agent", "sessions");
		const sessionPath = join(sessionsRoot, "restore-me.jsonl");
		writeSession(sessionPath, healthySession);

		const { SessionScanner } = loadSessionScanner(home);
		const scanner = new SessionScanner();
		await scanner.list();

		const archived = await scanner.archive(sessionPath);
		const restored = await scanner.unarchive(archived);

		assert.equal(restored, sessionPath, "unarchive must return the original path");
		assert.ok(!existsSync(archived), "archived file must be gone after restore");
		assert.ok(existsSync(sessionPath), "original file must be back");

		const summaries = await scanner.list();
		assert.ok(
			summaries.some((s) => s.filePath === sessionPath),
			"restored session must appear in list again",
		);
		const archivedList = await scanner.listArchived();
		assert.ok(!archivedList.some((s) => s.filePath === archived), "restored session must leave the archive list");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("archive moves the sibling sub-session directory along with the file", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-archive-sibling-"));
	try {
		const sessionsRoot = join(home, ".pi", "agent", "sessions");
		const sessionPath = join(sessionsRoot, "parent-session.jsonl");
		writeSession(sessionPath, healthySession);
		// 子会话目录 <stem>/ 与父文件相邻
		const childDir = join(sessionsRoot, "parent-session");
		const childPath = join(childDir, "sub", "child.jsonl");
		writeSession(childPath, [
			{ type: "session", id: "bbbb0004", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", cwd: "C:\\proj" },
			{ type: "message", id: "bbbb0005", parentId: "bbbb0004", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "child" } },
		]);

		const { SessionScanner } = loadSessionScanner(home);
		const scanner = new SessionScanner();
		await scanner.list();

		const archived = await scanner.archive(sessionPath);
		const archivedChild = archived.replace(/\.jsonl$/, "");
		assert.ok(!existsSync(childDir), "sibling dir must be moved away");
		assert.ok(existsSync(join(archivedChild, "sub", "child.jsonl")), "child session must move with parent");

		// 恢复时子目录一并回来
		await scanner.unarchive(archived);
		assert.ok(existsSync(childDir), "sibling dir must be restored");
		assert.ok(existsSync(childPath), "child session must be restored");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("archive directory is excluded from regular scans", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-archive-scan-"));
	try {
		const sessionsRoot = join(home, ".pi", "agent", "sessions");
		const sessionPath = join(sessionsRoot, "hidden.jsonl");
		writeSession(sessionPath, healthySession);

		const { SessionScanner } = loadSessionScanner(home);
		const scanner = new SessionScanner();
		await scanner.list();
		await scanner.archive(sessionPath);

		// 直接触发完整扫描：即使归档目录内还有 .jsonl，常规 list 也必须跳过
		const summaries = await scanner.list();
		assert.ok(!summaries.some((s) => s.filePath.includes(".pideck-archive")), "archive dir must be excluded from list");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("summary messageCount ignores pi 0.86 system message entries", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-archive-message-count-"));
	try {
		const sessionsRoot = join(home, ".pi", "agent", "sessions");
		const sessionPath = join(sessionsRoot, "with-system.jsonl");
		// 0.86 会话首条 entry 是系统提示 sections；侧栏消息数不能把它算成一条消息。
		writeSession(sessionPath, [
			{ type: "session", id: "cccc0001", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", cwd: "C:\\proj" },
			{ type: "message", id: "cccc0002", parentId: "cccc0001", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "system", content: "", sections: { preamble: "You are pi." } } },
			{ type: "message", id: "cccc0003", parentId: "cccc0002", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "user", content: "hello" } },
			{ type: "message", id: "cccc0004", parentId: "cccc0003", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "assistant", content: "hi" } },
		]);

		const { SessionScanner } = loadSessionScanner(home);
		const scanner = new SessionScanner();
		await scanner.list();
		const archived = await scanner.archive(sessionPath);
		const archivedList = await scanner.listArchived();
		const item = archivedList.find((entry) => entry.summary.filePath === archived);
		assert.ok(item, "archived summary must be readable (readSummary path)");
		assert.equal(item.summary.messageCount, 2, "system 条目不计入消息数");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

function writeSubagent(filePath, parentSession, cwd = dirname(filePath), name = "scout#1234abcd") {
	writeSession(filePath, [
		{ type: "session", cwd, parentSession },
		{ type: "session_info", name },
	]);
}

test("unarchive follows original flat and bundled parent paths but leaves independently archived forks", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "pideck-unarchive-tree-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const root = join(home, ".pi", "agent", "sessions");
	const dir = join(root, "project");
	const parent = join(dir, "parent.jsonl");
	const child = join(dir, "child.jsonl");
	const nested = join(dir, "child", "run", "nested.jsonl");
	const grandchild = join(dir, "elsewhere", "grandchild.jsonl");
	const leaf = join(dir, "leaf.jsonl");
	const fork = join(dir, "fork.jsonl");
	const forkChild = join(dir, "fork-child.jsonl");
	const forkOfSubagent = join(dir, "fork-of-subagent.jsonl");
	writeSession(parent, healthySession);
	writeSubagent(child, "parent.jsonl");
	writeSession(nested, healthySession);
	writeSubagent(grandchild, nested);
	writeSubagent(leaf, join("elsewhere", "grandchild.jsonl"), dir);
	writeSubagent(fork, parent, dir, "my fork");
	writeSubagent(forkChild, fork);
	writeSession(forkOfSubagent, [
		{ type: "session", cwd: dir, parentSession: child, timestamp: "2026-11-21T12:00:00.000Z" },
		{ type: "session_info", name: "scout#1234abcd", timestamp: "2026-11-21T11:00:00.000Z" },
	]);
	const { SessionScanner } = loadSessionScanner(home);
	const scanner = new SessionScanner();
	const archivedParent = await scanner.archive(parent);
	for (const file of [child, grandchild, leaf]) await scanner.archive(file);
	const archivedFork = await scanner.archive(fork);
	const archivedForkChild = await scanner.archive(forkChild);
	const archivedForkOfSubagent = await scanner.archive(forkOfSubagent);

	assert.equal(await scanner.unarchive(archivedParent), parent);
	for (const file of [parent, child, nested, grandchild, leaf]) assert.ok(existsSync(file), file);
	for (const file of [fork, forkChild, forkOfSubagent]) assert.ok(!existsSync(file), file);
	for (const file of [archivedFork, archivedForkChild, archivedForkOfSubagent]) assert.ok(existsSync(file), file);
	assert.deepEqual(JSON.parse(readFileSync(join(dirname(archivedParent), "index.json"), "utf8")), { [archivedFork]: fork, [archivedForkChild]: forkChild, [archivedForkOfSubagent]: forkOfSubagent });
});

test("unarchive checks every destination before moving any member of the subtree", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "pideck-unarchive-conflict-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const root = join(home, ".pi", "agent", "sessions");
	const parent = join(root, "parent.jsonl");
	const child = join(root, "child.jsonl");
	const sibling = join(root, "child");
	writeSession(parent, healthySession);
	writeSubagent(child, parent);
	writeSession(join(sibling, "nested.jsonl"), healthySession);
	const { SessionScanner } = loadSessionScanner(home);
	const scanner = new SessionScanner();
	const archivedParent = await scanner.archive(parent);
	const archivedChild = await scanner.archive(child);
	const index = join(dirname(archivedParent), "index.json");
	const before = readFileSync(index, "utf8");
	for (const conflict of [child, sibling]) {
		writeFileSync(conflict, "occupied");
		await assert.rejects(scanner.unarchive(archivedParent), /原路径已被占用/);
		assert.equal(readFileSync(conflict, "utf8"), "occupied");
		assert.ok(!existsSync(parent) && existsSync(archivedParent) && existsSync(archivedChild));
		assert.equal(readFileSync(index, "utf8"), before);
		rmSync(conflict);
	}
	await scanner.unarchive(archivedParent);
	assert.ok(existsSync(child) && existsSync(join(sibling, "nested.jsonl")));
});

test("same-named sessions keep their bundled directories with the corresponding archived file", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "pideck-unarchive-name-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const root = join(home, ".pi", "agent", "sessions");
	const first = join(root, "first", "parent.jsonl");
	const second = join(root, "second", "parent.jsonl");
	const nested = join(root, "second", "parent", "nested.jsonl");
	const flat = join(root, "second", "flat.jsonl");
	writeSession(first, healthySession);
	writeSession(second, healthySession);
	writeSession(nested, healthySession);
	writeSubagent(flat, nested);
	const { SessionScanner } = loadSessionScanner(home);
	const scanner = new SessionScanner();
	const archivedFirst = await scanner.archive(first);
	const archivedSecond = await scanner.archive(second);
	await scanner.archive(flat);

	await scanner.unarchive(archivedFirst);
	assert.ok(!existsSync(join(root, "first", "parent")), "the first archive must not claim the second archive's directory");
	await scanner.unarchive(archivedSecond);
	assert.ok(existsSync(nested) && existsSync(flat));
});

test("restoring can be retried after a descendant finishes and the parent's index update fails", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "pideck-unarchive-retry-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const root = join(home, ".pi", "agent", "sessions");
	const parent = join(root, "parent.jsonl");
	const child = join(root, "child.jsonl");
	const nested = join(root, "parent", "nested.jsonl");
	const indexPath = join(root, ".pideck-archive", "index.json");
	writeSession(parent, healthySession);
	writeSession(nested, healthySession);
	writeSubagent(child, parent);
	let writesBeforeFailure = Number.POSITIVE_INFINITY;
	const { SessionScanner } = loadProductionSessionScanner(home, {
		stubs: {
			"node:fs/promises": {
				...fsPromises,
				async writeFile(file, content, options) {
					if ((file === indexPath || file.startsWith(`${indexPath}.`)) && writesBeforeFailure-- === 0) {
						await fsPromises.writeFile(file, content.slice(0, 1), options);
						throw new Error("simulated partial index write");
					}
					return fsPromises.writeFile(file, content, options);
				},
			},
		},
	});
	const scanner = new SessionScanner();
	const archivedParent = await scanner.archive(parent);
	await scanner.archive(child);
	writesBeforeFailure = 1;
	await assert.rejects(scanner.unarchive(archivedParent), /simulated partial index write/);
	assert.ok(existsSync(child) && existsSync(archivedParent) && !existsSync(nested));
	assert.deepEqual(JSON.parse(readFileSync(indexPath, "utf8")), { [archivedParent]: parent });
	// 重建扫描器验证重试只依赖磁盘，没有内存中的归档快照也能恢复。
	await new SessionScanner().unarchive(archivedParent);
	assert.ok(existsSync(parent) && existsSync(nested));
});

test("overlapping parent and child restore requests leave the index consistent", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "pideck-unarchive-overlap-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const root = join(home, ".pi", "agent", "sessions");
	const parent = join(root, "parent.jsonl");
	const child = join(root, "child.jsonl");
	writeSession(parent, healthySession);
	writeSubagent(child, parent);
	const { SessionScanner } = loadSessionScanner(home);
	const scanner = new SessionScanner();
	const archivedParent = await scanner.archive(parent);
	const archivedChild = await scanner.archive(child);
	const [parentResult, childResult] = await Promise.allSettled([scanner.unarchive(archivedParent), scanner.unarchive(archivedChild)]);
	assert.equal(parentResult.value, parent);
	assert.equal(childResult.status, "rejected");
	assert.ok(existsSync(parent) && existsSync(child));
	assert.deepEqual(JSON.parse(readFileSync(join(dirname(archivedParent), "index.json"), "utf8")), {});
});
