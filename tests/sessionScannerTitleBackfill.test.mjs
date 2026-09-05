import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

/**
 * 标题回填（SessionScanner.inferSessionNameFromFile）测试。
 *
 * 背景：344b9abc 之后侧栏列表用轻量扫描（listPathSummary 只 stat，不带 name），
 * 未打开过的 pi 会话标题保持 Untitled。本测试锁定补名推断与 readSummary 相同的
 * 优先级（session_info 名 > 旧版私有 sessionName > 首条 user 文本 > 首条 assistant 文本），
 * 防止两处推断日后分叉。
 */

function loadTranspiledModule(filePath, overrides = new Map()) {
	const source = require("node:fs").readFileSync(filePath, "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const sandbox = {
		AbortController,
		AbortSignal,
		Buffer,
		clearTimeout,
		exports: {},
		process,
		setTimeout,
		require: (id) => (overrides.has(id) ? overrides.get(id) : require(id)),
	};
	vm.runInNewContext(outputText, sandbox, { filename: filePath });
	return sandbox.exports;
}

function loadSessionScanner(homePath) {
	const codexMeta = loadTranspiledModule("src/shared/codexSessionMeta.ts");
	const messageContent = loadTranspiledModule(
		"src/main/pi/messageContent.ts",
		new Map([["../feishu/docActions", { stripFeishuDocActionHint: (text) => text }]]),
	);
	const fsRetry = loadTranspiledModule("src/main/utils/fsRetry.ts");
	const sessionSummaryCache = loadTranspiledModule(
		"src/main/sessions/sessionSummaryCache.ts",
		new Map([
			["electron", { app: { getPath: () => homePath } }],
			["../utils/fsRetry", fsRetry],
		]),
	);
	const wslPaths = loadTranspiledModule("src/main/wsl/WslPaths.ts");
	const sessionIdentity = loadTranspiledModule("src/shared/sessionIdentity.ts");
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
			if (id === "../pi/messageContent") return messageContent;
			if (id === "./sessionSummaryCache") return sessionSummaryCache;
			if (id === "../wsl/WslPaths") return wslPaths;
			if (id === "./sessionNameLine") return loadTranspiledModule("src/main/sessions/sessionNameLine.ts");
			if (id === "../../shared/sessionIdentity") return sessionIdentity;
			if (id === "../logging/sharedLogger") return { getAppLogger: () => null };
			return require(id);
		},
	};
	const source = require("node:fs").readFileSync("src/main/sessions/SessionScanner.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	vm.runInNewContext(outputText, sandbox, { filename: "SessionScanner.ts" });
	return sandbox.exports;
}

function writeSession(filePath, entries) {
	mkdirSync(join(filePath, ".."), { recursive: true });
	writeFileSync(filePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

function makeHeader(id) {
	return { type: "session", version: 3, id, timestamp: "2026-08-22T04:00:00.000Z", cwd: "C:/work" };
}

function makeUser(id, text) {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-08-22T04:00:01.000Z",
		message: { role: "user", content: [{ type: "text", text }] },
	};
}

function makeAssistant(id, text) {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-08-22T04:00:02.000Z",
		message: { role: "assistant", content: [{ type: "text", text }] },
	};
}

test("inferSessionNameFromFile falls back to the first user text for a new pi session", async () => {
	const home = mkdtempSync(join(tmpdir(), "pi-scan-title-user-"));
	const { SessionScanner: Scanner } = loadSessionScanner(home);
	try {
		const file = join(home, ".pi", "agent", "sessions", "--C--Users-14012-pi-desktop-dev--", "2026-08-22T04-22-29-162Z_abc.jsonl");
		writeSession(file, [
			makeHeader("abc"),
			makeUser("u1", "修复侧栏标题：未打开的会话要显示首条消息，而不是永远 Untitled"),
		]);
		const scanner = new Scanner();
		const name = await scanner.inferSessionNameFromFile(file);
		// 优先级与 readSummary 一致：首条 user 文本，保留完整标题；侧栏只做视觉钳制。
		assert.equal(name, "修复侧栏标题：未打开的会话要显示首条消息，而不是永远 Untitled");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("inferSessionNameFromFile prefers session_info name over the first user text", async () => {
	const home = mkdtempSync(join(tmpdir(), "pi-scan-title-info-"));
	const { SessionScanner: Scanner } = loadSessionScanner(home);
	try {
		const file = join(home, ".pi", "agent", "sessions", "--C--Users-14012-pi-desktop-dev--", "2026-08-22T04-22-29-162Z_abc.jsonl");
		writeSession(file, [
			makeHeader("abc"),
			makeUser("u1", "这是一段用户消息，不应该成为标题"),
			{ type: "session_info", id: "i1", parentId: "u1", timestamp: "2026-08-22T04:23:00.000Z", name: "用户手动改名后的标题" },
		]);
		const scanner = new Scanner();
		const name = await scanner.inferSessionNameFromFile(file);
		assert.equal(name, "用户手动改名后的标题");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("inferSessionNameFromFile preserves a long physical fork title", async () => {
	const home = mkdtempSync(join(tmpdir(), "pi-scan-title-fork-"));
	const { SessionScanner: Scanner } = loadSessionScanner(home);
	try {
		const file = join(home, ".pi", "agent", "sessions", "--C--Users-14012-pi-desktop-dev--", "2026-08-22T04-22-29-162Z_abc.jsonl");
		const title = "复制后的长标题：这个名称超过三十二字符并且必须保留末尾身份标记 (fork)";
		writeSession(file, [
			makeHeader("abc"),
			{ type: "session_info", id: "i1", parentId: "abc", timestamp: "2026-08-22T04:23:00.000Z", name: title },
		]);
		const scanner = new Scanner();
		assert.equal(await scanner.inferSessionNameFromFile(file), title);
		assert.equal((await scanner.inferSessionNameAndValidity(file)).name, title);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("inferSessionNameFromFile reads the latest session_info appended beyond the head window", async () => {
	const home = mkdtempSync(join(tmpdir(), "pi-scan-title-tail-"));
	const { SessionScanner: Scanner } = loadSessionScanner(home);
	try {
		const file = join(home, ".pi", "agent", "sessions", "--C--Users-14012-pi-desktop-dev--", "2026-08-22T04-22-29-162Z_abc.jsonl");
		const padding = "x".repeat(70 * 1024);
		writeSession(file, [
			makeHeader("abc"),
			makeUser("u1", "文件头里的旧回退标题"),
			makeAssistant("a1", padding),
			{ type: "session_info", id: "i1", parentId: "a1", timestamp: "2026-08-22T04:23:00.000Z", name: "pi-tui 在文件末尾追加的新标题" },
		]);
		const scanner = new Scanner();
		const name = await scanner.inferSessionNameFromFile(file);
		assert.equal(name, "pi-tui 在文件末尾追加的新标题");
		// 命中 session_info：权威来源，允许覆盖 catalog 已有真实标题。
		const inferred = await scanner.inferSessionNameAndValidity(file);
		assert.equal(inferred.name, "pi-tui 在文件末尾追加的新标题");
		assert.equal(inferred.nameFromSessionInfo, true);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("inferSessionNameAndValidity marks first-message fallback as non-authoritative when session_info sits in the window gap", async () => {
	const home = mkdtempSync(join(tmpdir(), "pi-scan-title-gap-"));
	const { SessionScanner: Scanner } = loadSessionScanner(home);
	try {
		const file = join(home, ".pi", "agent", "sessions", "--C--Users-14012-pi-desktop-dev--", "2026-08-22T04-22-29-162Z_abc.jsonl");
		// 会话变大（用户第二轮）：session_info 被挤到头部/尾部窗口之外的中间盲区。
		// 头部窗口读不到 session_info，名称只能回退到首条消息文本——弱信号，不得覆盖已有标题。
		const padding = "x".repeat(70 * 1024);
		writeSession(file, [
			makeHeader("abc"),
			makeUser("u1", "首条消息：可以当弱标题但不能覆盖真实标题"),
			makeAssistant("a1", padding),
			{ type: "session_info", id: "i1", parentId: "a1", timestamp: "2026-08-22T04:23:00.000Z", name: "自动生成的真实标题" },
			makeAssistant("a2", padding),
		]);
		const scanner = new Scanner();
		const inferred = await scanner.inferSessionNameAndValidity(file);
		// 窗口盲区：只能回退到首条 user 文本，且必须标记为非权威。
		assert.equal(inferred.name, "首条消息：可以当弱标题但不能覆盖真实标题");
		assert.equal(inferred.nameFromSessionInfo, false);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("inferSessionNameFromFile skips pi timestamp stems and untitled text", async () => {
	const home = mkdtempSync(join(tmpdir(), "pi-scan-title-skip-"));
	const { SessionScanner: Scanner } = loadSessionScanner(home);
	try {
		const file = join(home, ".pi", "agent", "sessions", "--C--Users-14012-pi-desktop-dev--", "2026-08-22T04-22-29-162Z_abc.jsonl");
		// 首条 user 是时间戳文件名（pi 默认 sessionName 的镜像场景），应回退到 assistant 文本。
		writeSession(file, [
			makeHeader("abc"),
			makeUser("u1", "2026-08-22T04-22-29-162Z_abc"),
			makeAssistant("a1", "好的，我来查看这个会话文件。"),
		]);
		const scanner = new Scanner();
		const name = await scanner.inferSessionNameFromFile(file);
		assert.equal(name, "好的，我来查看这个会话文件。");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("inferSessionNameFromFile returns undefined for files without inferable messages", async () => {
	const home = mkdtempSync(join(tmpdir(), "pi-scan-title-empty-"));
	const { SessionScanner: Scanner } = loadSessionScanner(home);
	try {
		const file = join(home, ".pi", "agent", "sessions", "--C--Users-14012-pi-desktop-dev--", "2026-08-22T04-22-29-162Z_abc.jsonl");
		// 只有 session 头与 model_change，没有任何 user/assistant 消息。
		writeSession(file, [
			makeHeader("abc"),
			{ type: "model_change", id: "m1", parentId: null, timestamp: "2026-08-22T04:22:30.000Z", provider: "x", modelId: "y" },
		]);
		const scanner = new Scanner();
		assert.equal(await scanner.inferSessionNameFromFile(file), undefined);
		assert.equal(await scanner.inferSessionNameFromFile(join(home, ".pi", "agent", "sessions", "missing.jsonl")), undefined);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});