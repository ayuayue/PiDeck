import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function readLines(filePath) {
	return readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
}

/** 与 pi buildSessionInfo 相同的首行校验：首条可解析记录必须是 type:"session"。 */
function firstParseableEntry(lines) {
	for (const line of lines) {
		try {
			return JSON.parse(line);
		} catch {
			// 跳过不可解析行
		}
	}
	return null;
}

/** 与 pi getSessionName 一致：倒序取最后一条 session_info 的 name。 */
function piSessionName(lines) {
	for (let i = lines.length - 1; i >= 0; i--) {
		try {
			const entry = JSON.parse(lines[i]);
			if (entry.type === "session_info") return entry.name?.trim() || undefined;
		} catch {
			// 跳过不可解析行
		}
	}
	return undefined;
}

const healthySession = [
	{ type: "session", id: "aaaa0001", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", cwd: "C:\\proj" },
	{ type: "message", id: "aaaa0002", parentId: "aaaa0001", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "hello" } },
	{ type: "message", id: "aaaa0003", parentId: "aaaa0002", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: "hi" } },
];

test("rename appends a pi-native session_info entry and keeps the header first (#114)", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-rename-native-"));
	try {
		const { SessionScanner } = loadSessionScanner(home);
		const scanner = new SessionScanner();
		const file = join(home, "session-a.jsonl");
		writeSession(file, healthySession);

		await scanner.rename(file, "新会话名");

		const lines = readLines(file);
		// 首行仍是 type:"session" 头，pi 可以正常加载（#114 的核心回归点）
		assert.equal(firstParseableEntry(lines)?.type, "session");
		assert.equal(lines.length, healthySession.length + 1);

		const appended = JSON.parse(lines[lines.length - 1]);
		assert.equal(appended.type, "session_info");
		assert.equal(appended.name, "新会话名");
		assert.match(appended.id, /^[0-9a-f]{8}$/);
		// parentId 指向追加前最后一条带 id 的记录，保持会话树链条完整
		assert.equal(appended.parentId, "aaaa0003");
		assert.equal(typeof appended.timestamp, "string");
		// pi 语义：倒序读取到的名字就是新名字
		assert.equal(piSessionName(lines), "新会话名");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("rename heals legacy PiDeck sessionName head lines that broke pi loading (#114)", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-rename-heal-"));
	try {
		const { SessionScanner } = loadSessionScanner(home);
		const scanner = new SessionScanner();
		const file = join(home, "session-b.jsonl");
		// 旧版 PiDeck 的破坏产物：头部前置无 type 的 sessionName 私有行
		writeSession(file, [{ sessionName: "Old PiDeck name", ts: 1700000000000 }, ...healthySession]);
		assert.notEqual(firstParseableEntry(readLines(file))?.type, "session");

		await scanner.rename(file, "Healed");

		const lines = readLines(file);
		// 私有行被剔除，首条记录恢复为 type:"session"，pi 重新可见
		assert.equal(firstParseableEntry(lines)?.type, "session");
		assert.ok(!lines.some((line) => line.includes("sessionName")));
		assert.equal(piSessionName(lines), "Healed");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("repeated rename keeps the file flat and the latest name authoritative", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-rename-twice-"));
	try {
		const { SessionScanner } = loadSessionScanner(home);
		const scanner = new SessionScanner();
		const file = join(home, "session-c.jsonl");
		writeSession(file, healthySession);

		await scanner.rename(file, "first");
		await scanner.rename(file, "second");

		const lines = readLines(file);
		const infoCount = lines.filter((line) => line.includes('"session_info"')).length;
		assert.equal(infoCount, 2);
		assert.equal(piSessionName(lines), "second");
		// PiDeck 摘要同样以最后一条 session_info 为准
		const summary = await scanner["readSummary"](file);
		assert.equal(summary?.name, "second");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("rename sanitizes newlines in the name like pi appendSessionInfo", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-rename-sanitize-"));
	try {
		const { SessionScanner } = loadSessionScanner(home);
		const scanner = new SessionScanner();
		const file = join(home, "session-d.jsonl");
		writeSession(file, healthySession);

		await scanner.rename(file, "line1\nline2\r\nline3");

		const lines = readLines(file);
		assert.equal(lines.length, healthySession.length + 1);
		assert.equal(piSessionName(lines), "line1 line2 line3");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("readSummary skips pi file-stem timestamps and uses the first user prompt", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-timestamp-title-"));
	try {
		const { SessionScanner } = loadSessionScanner(home);
		const scanner = new SessionScanner();
		const file = join(home, "2026-08-08T10-47-19-239Z_abc.jsonl");
		writeSession(file, [
			{
				...healthySession[0],
				sessionName: "2026-08-08T10-47-19-239Z_abc",
			},
			{
				...healthySession[1],
				message: { role: "user", content: "帮我看看这个报错" },
			},
			healthySession[2],
		]);
		// copy() 走 readSummary：时间戳不是标题，复制名应来自首条 user 文本。
		const summary = await scanner.copy(file);
		assert.equal(summary.name, "帮我看看这个报错 copy");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("copy produces a pi-loadable session with the copy name as session_info (#114)", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-copy-native-"));
	try {
		const { SessionScanner } = loadSessionScanner(home);
		const scanner = new SessionScanner();
		const file = join(home, "session-e.jsonl");
		writeSession(file, [healthySession[0], { type: "session_info", id: "bbbb0001", parentId: "aaaa0001", timestamp: "2026-01-01T00:00:00.500Z", name: "Origin" }, healthySession[1], healthySession[2]]);

		const summary = await scanner.copy(file);

		const lines = readLines(summary.filePath);
		assert.equal(firstParseableEntry(lines)?.type, "session");
		assert.equal(piSessionName(lines), "Origin copy");
		assert.equal(summary.name, "Origin copy");
		// 追加记录的 id 不与文件内既有 id 冲突
		const appended = JSON.parse(lines[lines.length - 1]);
		assert.notEqual(appended.id, "bbbb0001");
		assert.equal(appended.parentId, "aaaa0003");
		assert.equal(appended.copiedFrom, file);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

// 通过正常的 SessionScanner 入口强制小阈值，真实文件读写仍走生产实现。
function createScannerWithSmallLineLimit(home) {
	const stream = loadTsCommonJs("src/main/sessions/jsonlLineStream.ts");
	const { SessionScanner } = loadProductionSessionScanner(home, {
		stubs: {
			"./jsonlLineStream": {
				...stream,
				rewriteJsonlLines: (src, dst, transform, options) => stream.rewriteJsonlLines(src, dst, transform, { ...options, chunkBytes: 4096, maxLineBytes: 1024 }),
			},
		},
	});
	return new SessionScanner();
}

for (const operation of ["rename", "copy"]) {
	test(`${operation} preserves oversized entries and appends the title to the real leaf`, async () => {
		const home = mkdtempSync(join(tmpdir(), "pideck-oversized-session-"));
		try {
			const scanner = createScannerWithSmallLineLimit(home);
			const file = join(home, "session.jsonl");
			const message = { role: "assistant", id: "nested-id", content: "内容🪴".repeat(31000) };
			// id follows the large body (beyond the prefix). CRLF and the final missing LF must keep their byte boundaries.
			const middle = "  " + JSON.stringify({ type: "message", message, id: "middle", parentId: "aaaa0003" }) + "  ";
			const small = JSON.stringify({ type: "message", id: "small", parentId: "middle", message: { role: "user", content: "ok" } });
			const leaf = JSON.stringify({ type: "message", message, parentId: "small", id: "leaf" });
			const original = healthySession.map((entry) => JSON.stringify(entry)).join("\n") + "\n" + middle + "\r\n" + small + "\n" + leaf;
			const source = JSON.stringify({ sessionName: "legacy".repeat(500) }) + "\n" + original;
			writeFileSync(file, source);

			let target = file;
			if (operation === "copy") target = (await scanner.copy(file)).filePath;
			else await scanner.rename(file, "Renamed");
			const result = readFileSync(target, "utf8");
			assert.ok(result.startsWith(original + "\n"), "all historical records must survive byte-for-byte");
			const title = JSON.parse(result.slice(original.length + 1));
			assert.equal(title.type, "session_info");
			assert.equal(title.parentId, "leaf");
			if (operation === "copy") assert.equal(readFileSync(file, "utf8"), source);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test(`${operation} leaves the source intact and removes partial output on an oversized parse failure`, async () => {
		const home = mkdtempSync(join(tmpdir(), "pideck-oversized-failure-"));
		try {
			const scanner = createScannerWithSmallLineLimit(home);
			const file = join(home, "session.jsonl");
			const original = JSON.stringify(healthySession[0]) + '\n{"id":"leaf","body":"' + "x".repeat(2048);
			writeFileSync(file, original);
			await assert.rejects(operation === "copy" ? scanner.copy(file) : scanner.rename(file, "Renamed"), /parser|expected/i);
			assert.equal(readFileSync(file, "utf8"), original);
			assert.deepEqual(readdirSync(home), ["session.jsonl"]);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
}
