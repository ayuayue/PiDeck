import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
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

/**
 * 加载 SessionScanner；shell.trashItem 采用真实删除（模拟回收站把文件移出归档目录），
 * 以便断言 deleteArchived 后归档文件确实离开磁盘且 listArchived 不再包含它。
 */
function loadSessionScanner(homePath) {
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
					// 真实删除，模拟回收站：deleteArchived 依赖它把归档文件移出目录。
					shell: {
						trashItem: async (target) => {
							if (existsSync(target)) rmSync(target, { recursive: true, force: true });
						},
					},
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

function writeSession(filePath, entries) {
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

const healthySession = [
	{ type: "session", id: "bbbb0001", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", cwd: "C:\\proj" },
	{ type: "message", id: "bbbb0002", parentId: "bbbb0001", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "hello archive" } },
	{ type: "message", id: "bbbb0003", parentId: "bbbb0002", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: "hi" } },
];

test("deleteArchived 删除归档文件并移出归档列表（pi 文件归档）", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-delarchived-"));
	try {
		const sessionsRoot = join(home, ".pi", "agent", "sessions");
		const sessionPath = join(sessionsRoot, "del-me.jsonl");
		writeSession(sessionPath, healthySession);

		const { SessionScanner } = loadSessionScanner(home);
		const scanner = new SessionScanner();
		await scanner.list();

		const archived = await scanner.archive(sessionPath);
		assert.ok(existsSync(archived), "归档后归档文件应存在");
		assert.equal((await scanner.listArchived()).length, 1, "归档列表应有 1 条");

		await scanner.deleteArchived(archived);
		assert.ok(!existsSync(archived), "删除后归档文件应移出磁盘（回收站）");
		assert.equal((await scanner.listArchived()).length, 0, "删除后归档列表应不再包含它");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("deleteArchived 拒绝归档目录外的文件（防路径穿越）", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-delarchived-guard-"));
	try {
		const sessionsRoot = join(home, ".pi", "agent", "sessions");
		const sessionPath = join(sessionsRoot, "not-archived.jsonl");
		writeSession(sessionPath, healthySession);

		const { SessionScanner } = loadSessionScanner(home);
		const scanner = new SessionScanner();
		await scanner.list();

		// 未归档的普通会话路径不在 .pideck-archive 内，deleteArchived 必须拒绝。
		await assert.rejects(() => scanner.deleteArchived(sessionPath), /拒绝删除/, "归档目录外的路径应被拒绝");
		assert.ok(existsSync(sessionPath), "拒绝后原文件应仍在磁盘");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("deleteArchived 连带清理归档子会话目录（sibling <stem>/ 一并删除）", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-delarchived-sibling-"));
	try {
		const sessionsRoot = join(home, ".pi", "agent", "sessions");
		const sessionPath = join(sessionsRoot, "parent-del.jsonl");
		writeSession(sessionPath, healthySession);
		// 同级子会话目录 <stem>/ 与父文件相邻（与归档/删除同约定）
		const childDir = join(sessionsRoot, "parent-del");
		writeSession(join(childDir, "sub", "child.jsonl"), [
			{ type: "session", id: "bbbb0004", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", cwd: "C:\\proj" },
			{ type: "message", id: "bbbb0005", parentId: "bbbb0004", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "child" } },
		]);

		const { SessionScanner } = loadSessionScanner(home);
		const scanner = new SessionScanner();
		await scanner.list();

		const archived = await scanner.archive(sessionPath);
		const archivedStem = archived.replace(/\.jsonl$/, "");
		assert.ok(existsSync(join(archivedStem, "sub", "child.jsonl")), "归档后子会话应随父会话进归档");

		await scanner.deleteArchived(archived);
		assert.ok(!existsSync(archived), "父会话归档文件应删除");
		assert.ok(!existsSync(archivedStem), "归档子会话目录应一并删除");
		assert.equal((await scanner.listArchived()).length, 0, "归档列表应清空");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("deleteArchived 幂等：归档文件已被外部清理时视为成功", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-delarchived-idempotent-"));
	try {
		const sessionsRoot = join(home, ".pi", "agent", "sessions");
		const sessionPath = join(sessionsRoot, "already-gone.jsonl");
		writeSession(sessionPath, healthySession);

		const { SessionScanner } = loadSessionScanner(home);
		const scanner = new SessionScanner();
		await scanner.list();

		const archived = await scanner.archive(sessionPath);
		// 外部（系统回收站/用户）提前清掉归档文件，模拟已删除状态
		rmSync(archived, { force: true });
		// 第二次 deleteArchived 不应抛错（与 delete() 同语义的幂等）
		await scanner.deleteArchived(archived);
		assert.equal((await scanner.listArchived()).length, 0, "幂等删除后归档列表应为空");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
