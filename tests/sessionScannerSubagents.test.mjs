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
		process,
		require: (id) => (overrides.has(id) ? overrides.get(id) : require(id)),
		setTimeout,
		setImmediate: typeof setImmediate === "function" ? setImmediate : (fn) => setTimeout(fn, 0),
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

function loadMessageContentModule() {
	const compilerOptions = {
		module: ts.ModuleKind.CommonJS,
		target: ts.ScriptTarget.ES2022,
	};
	const docActions = { exports: {} };
	vm.runInNewContext(ts.transpileModule(readFileSync("src/main/feishu/docActions.ts", "utf8"), { compilerOptions }).outputText, docActions, { filename: "docActions.ts" });
	const messageContent = {
		exports: {},
		require: (id) => {
			if (id === "../feishu/docActions") return docActions.exports;
			throw new Error(`Unexpected messageContent import: ${id}`);
		},
	};
	vm.runInNewContext(ts.transpileModule(readFileSync("src/main/pi/messageContent.ts", "utf8"), { compilerOptions }).outputText, messageContent, { filename: "messageContent.ts" });
	return messageContent.exports;
}

function loadWslPathsModule() {
	const source = readFileSync("src/main/wsl/WslPaths.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const sandbox = {
		exports: {},
		require,
	};
	vm.runInNewContext(outputText, sandbox, { filename: "WslPaths.ts" });
	return sandbox.exports;
}

function loadFsRetryModule() {
	// fsRetry 只依赖 node:fs/promises，随 sessionSummaryCache 一起编译注入，
	// 让真实实现（含 EPERM 退避重试）在测试中同样生效
	const source = readFileSync("src/main/utils/fsRetry.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const sandbox = {
		clearTimeout,
		exports: {},
		process,
		require,
		setTimeout,
	};
	vm.runInNewContext(outputText, sandbox, { filename: "fsRetry.ts" });
	return sandbox.exports;
}

function loadSessionSummaryCacheModule(homePath) {
	const source = readFileSync("src/main/sessions/sessionSummaryCache.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const fsRetry = loadFsRetryModule();
	const sandbox = {
		clearTimeout: () => undefined,
		exports: {},
		process,
		require: (id) => {
			if (id === "electron") {
				return {
					app: {
						getPath: (name) => (name === "userData" ? join(homePath, "user-data") : homePath),
					},
				};
			}
			// fsRetry 只依赖 node:fs/promises，走真实 require 即可
			if (id === "../utils/fsRetry") return fsRetry;
			return require(id);
		},
		setTimeout: () => ({ unref: () => undefined }),
	};
	vm.runInNewContext(outputText, sandbox, { filename: "sessionSummaryCache.ts" });
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
	const sandbox = {
		exports: {},
		process,
		require,
		setTimeout,
	};
	vm.runInNewContext(outputText, sandbox, { filename: "sessionNameLine.ts" });
	return sandbox.exports;
}

function loadSessionScanner(homePath, fsOverrides = {}) {
	const source = readFileSync("src/main/sessions/SessionScanner.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const codexMeta = loadCodexMetaModule();
	const messageContent = loadMessageContentModule();
	const sessionSummaryCache = loadSessionSummaryCacheModule(homePath);
	const wslPaths = loadWslPathsModule();
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
		process,
		setTimeout,
		require: (id) => {
			if (id === "electron") return { app: { getPath: () => homePath }, shell: {} };
			if (id === "../../shared/codexSessionMeta") return codexMeta;
			if (id === "../pi/sessionEntryIds") return loadTranspiledModule("src/main/pi/sessionEntryIds.ts");
			if (id === "../pi/messageContent") return messageContent;
			if (id === "../wsl/WslPaths") return wslPaths;
			if (id === "./sessionSummaryCache") return sessionSummaryCache;
			// sessionNameLine 为无依赖纯函数模块，直接编译加载真实实现，保证清理口径一致
			if (id === "./sessionNameLine") return loadSessionNameLineModule();
			if (id === "../../shared/sessionIdentity") return sessionIdentity;
			if (id === "../../shared/expandedRefBlocks") return expandedRefBlocks;
			if (id === "./jsonlLineStream") return jsonlLineStream;
			// sharedLogger 未注册时 getAppLogger 返回 null，SessionScanner 埋点静默跳过
			if (id === "../logging/sharedLogger") return { getAppLogger: () => null };
			if (id === "node:fs") return { ...require(id), ...fsOverrides };
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

function session(name, cwd) {
	return [
		{ type: "session_info", name, cwd },
		{ type: "message", message: { role: "user", content: "hello" } },
	];
}

test("validates a local parent session by reading only the bounded file head", () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-session-head-"));
	try {
		const fixture = Buffer.from(`${JSON.stringify({ type: "session_info", name: "Parent" })}\n`);
		let requestedBytes = 0;
		let closed = false;
		const { SessionScanner } = loadSessionScanner(home, {
			openSync: () => 42,
			readSync: (_fd, buffer, offset, length) => {
				requestedBytes = length;
				fixture.copy(buffer, offset);
				return fixture.length;
			},
			closeSync: () => {
				closed = true;
			},
		});
		const scanner = new SessionScanner();
		assert.equal(scanner.isSessionFile("virtual-parent.jsonl"), true);
		assert.equal(requestedBytes, 4096);
		assert.equal(closed, true);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("aborts a hung WSL scan before the renderer watchdog and allows a clean retry", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-session-scan-timeout-"));
	try {
		const { SessionScanner } = loadSessionScanner(home);
		const scanner = new SessionScanner();
		scanner.wslConfig = { distro: "Ubuntu", user: "dev", home: "/home/dev" };
		scanner.scanTimeoutMs = 10;
		let attempts = 0;
		scanner.collectWslJsonl = async (_sessionsDir, signal) => {
			attempts += 1;
			if (attempts > 1) return [];
			return new Promise((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
		};

		await assert.rejects(scanner.list());
		assert.equal((await scanner.list()).length, 0);
		assert.equal(attempts, 2);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("hides persisted pi-subagents runs without deleting them or unrelated nested sessions", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-subagent-scanner-"));
	try {
		const projectPath = "C:\\repo\\project";
		const piDir = join(home, ".pi", "agent", "sessions", "--C--repo-project--");
		const parentFile = join(piDir, "parent.jsonl");
		const workerFile = join(piDir, "parent", "run-abc", "run-0", "session.jsonl");
		const reviewerFile = join(piDir, "parent", "run-abc", "run-1", "session.jsonl");
		const nestedUserFile = join(piDir, "manual", "notes.jsonl");
		const lookalikeFile = join(piDir, "manual", "arbitrary", "run-0", "session.jsonl");

		writeSession(parentFile, session("Parent", projectPath));
		writeSession(join(piDir, "ordinary.jsonl"), session("Ordinary", projectPath));
		writeSession(join(piDir, "subagent-looking-name.jsonl"), session("subagent-worker-manual-0", projectPath));
		// This sibling makes lookalikeFile collide with the legacy ownership layout.
		writeSession(join(piDir, "manual.jsonl"), session("Manual owner", projectPath));
		writeSession(nestedUserFile, session("Nested user session", projectPath));
		writeSession(lookalikeFile, session("Path lookalike", projectPath));
		// Explicit metadata covers new runs even when intercom naming is unavailable.
		writeSession(workerFile, [...session("Worker without generated name", projectPath), { type: "custom", customType: "pi-subagents.child-session", data: { schemaVersion: 1 } }]);
		// Generated naming plus the standard path retains compatibility with old runs.
		writeSession(reviewerFile, session("subagent-reviewer-run-abc-1", projectPath));

		const { SessionScanner } = loadSessionScanner(home);
		const summaries = await new SessionScanner().list(projectPath);
		const visiblePaths = new Set(summaries.map((summary) => summary.filePath));

		assert.equal(visiblePaths.has(parentFile), true);
		assert.equal(visiblePaths.has(nestedUserFile), true);
		assert.equal(visiblePaths.has(lookalikeFile), true);
		// 子会话仍然在摘要列表中，但标记了父会话路径
		assert.equal(visiblePaths.has(workerFile), true);
		assert.equal(visiblePaths.has(reviewerFile), true);
		// 列表扫描不再读 JSONL 正文，标题留给 catalog / 点开后的 readSummary。
		assert.equal(
			summaries.some((summary) => summary.name === "subagent-worker-manual-0"),
			false,
		);
		assert.equal(existsSync(workerFile), true);
		assert.equal(existsSync(reviewerFile), true);
		// 验证子会话的 parentSessionPath 指向正确的父会话文件
		const workerSummary = summaries.find((s) => s.filePath === workerFile);
		assert.equal(workerSummary.parentSessionPath, parentFile);
		const reviewerSummary = summaries.find((s) => s.filePath === reviewerFile);
		assert.equal(reviewerSummary.parentSessionPath, parentFile);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("groups WSL child sessions with POSIX parent paths", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-wsl-subagent-scanner-"));
	try {
		const projectPath = "/mnt/f/git-optimize";
		const selectedProjectPath = "//wsl.localhost/Ubuntu/mnt/f/git-optimize";
		const sessionsRoot = "/home/dev/.pi/agent/sessions";
		const parentFile = `${sessionsRoot}/--mnt-f-git-optimize--/parent.jsonl`;
		const forkParentFile = `${sessionsRoot}/--mnt-f-git-optimize--/fork-parent.jsonl`;
		const childFile = `${sessionsRoot}/--mnt-f-git-optimize--/parent/run-abc/run-0/session.jsonl`;
		const forkChildFile = `${sessionsRoot}/--mnt-f-git-optimize--/detached/run-xyz/run-0/session.jsonl`;
		const files = new Map([
			[
				parentFile,
				`${session("Parent", projectPath)
					.map((entry) => JSON.stringify(entry))
					.join("\n")}\n`,
			],
			[
				forkParentFile,
				`${session("Fork parent", projectPath)
					.map((entry) => JSON.stringify(entry))
					.join("\n")}\n`,
			],
			[
				childFile,
				`${session("subagent-worker-wsl-0", projectPath)
					.map((entry) => JSON.stringify(entry))
					.join("\n")}\n`,
			],
			[forkChildFile, `${[{ type: "session", id: "wsl-fork-child", parentSession: "../../../fork-parent.jsonl", cwd: projectPath }, ...session("subagent-worker-wsl-fork-0", projectPath)].map((entry) => JSON.stringify(entry)).join("\n")}\n`],
		]);
		const { SessionScanner } = loadSessionScanner(home);
		const scanner = new SessionScanner();
		scanner.wslConfig = { distro: "Ubuntu", user: "dev", home: "/home/dev" };
		scanner.collectWslJsonl = async () => [...files.keys()];
		const fullReadCount = new Map();
		scanner.readWslFile = async (filePath) => {
			fullReadCount.set(filePath, (fullReadCount.get(filePath) ?? 0) + 1);
			const value = files.get(filePath);
			if (value == null) throw new Error(`missing WSL fixture: ${filePath}`);
			return value;
		};
		scanner.readWslFileHead = async (filePath) => {
			const value = files.get(filePath);
			if (value == null) throw new Error(`missing WSL fixture: ${filePath}`);
			return value.slice(0, 4096);
		};
		scanner.readWslFileVersion = async (filePath) => ({
			mtimeMs: 1,
			size: Buffer.byteLength(files.get(filePath) ?? "", "utf8"),
		});
		scanner.existsWslFile = async (filePath) => files.has(filePath);
		// 避免 resolveScanRoots 走真实 wsl.exe 探测自定义 sessionDir
		scanner.existsWslDir = async () => false;

		const summaries = await scanner.list(selectedProjectPath);
		assert.equal(summaries.length, 4);
		assert.equal(summaries.find((item) => item.filePath === childFile)?.parentSessionPath, parentFile);
		// 仅 header 引用的 fork 父路径要读正文；列表扫描只认磁盘嵌套，这里保持平铺。
		assert.equal(summaries.find((item) => item.filePath === forkChildFile)?.parentSessionPath, undefined);
		assert.equal(
			summaries.some((item) => item.parentSessionPath?.includes("\\")),
			false,
		);
		// 摘要扫描与父会话校验都只读头部，禁止对大型 JSONL 再走一次完整 cat。
		assert.equal(fullReadCount.get(parentFile) ?? 0, 0);
		assert.equal(fullReadCount.get(forkParentFile) ?? 0, 0);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("uses a valid renamed parent session and ignores false-positive path owners", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-renamed-parent-subagent-scanner-"));
	try {
		const projectPath = "C:\\repo\\project";
		const piDir = join(home, ".pi", "agent", "sessions", "--C--repo-project--");
		const parentFile = join(piDir, "renamed-parent.jsonl");
		const childFile = join(piDir, "renamed-parent", "run-abc", "run-0", "session.jsonl");
		const fakeOwnerFile = join(piDir, "manual.jsonl");
		const lookalikeFile = join(piDir, "manual", "arbitrary", "run-0", "session.jsonl");

		writeSession(parentFile, [{ sessionName: "Renamed parent", ts: Date.now() }, ...session("Original parent", projectPath)]);
		writeSession(childFile, session("subagent-worker-renamed-parent-0", projectPath));
		writeSession(fakeOwnerFile, [{ sessionName: "Not a Pi session" }]);
		writeSession(lookalikeFile, session("Path lookalike", projectPath));

		const { SessionScanner } = loadSessionScanner(home);
		const summaries = await new SessionScanner().list(projectPath);
		assert.equal(summaries.find((item) => item.filePath === childFile)?.parentSessionPath, parentFile);
		assert.equal(summaries.find((item) => item.filePath === lookalikeFile)?.parentSessionPath, undefined);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("handles orphan, fork, rename and imported-session compatibility without false positives", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-orphan-subagent-scanner-"));
	try {
		const projectPath = "/repo/project";
		const piDir = join(home, ".pi", "agent", "sessions", "--repo-project--");
		const orphanFile = join(piDir, "deleted-parent", "orphan-run", "run-0", "session.jsonl");
		const renamedChildFile = join(piDir, "renamed-parent", "manual-run", "run-0", "session.jsonl");
		const legacyForkFile = join(piDir, "legacy-fork.jsonl");
		const manualForkFile = join(piDir, "manual-fork.jsonl");
		const markedCustomFile = join(piDir, "custom-child-location.jsonl");
		const importedFile = join(piDir, "codex-parent", "import-run", "run-0", "session.jsonl");

		writeSession(orphanFile, session("subagent-worker-orphan-run-0", projectPath));
		// PiDeck rename prepends sessionName; the original generated session_info remains authoritative.
		writeSession(renamedChildFile, [{ sessionName: "Renamed child", cwd: projectPath }, ...session("subagent-worker-old-run-0", projectPath)]);
		writeSession(legacyForkFile, [{ type: "session", id: "legacy-child", parentSession: "parent-session.jsonl", cwd: projectPath }, ...session("subagent-worker-fork-run-0", projectPath)]);
		writeSession(manualForkFile, [{ type: "session", id: "manual-child", parentSession: "parent-session.jsonl", cwd: projectPath }, { type: "session_info", name: "subagent-worker-copied-parent-0", cwd: projectPath }, ...session("Manual user fork", projectPath)]);
		writeSession(markedCustomFile, [...session("Custom-location child", projectPath), { type: "custom", customType: "pi-subagents.child-session", data: { schemaVersion: 1 } }]);
		writeSession(join(piDir, "codex-parent.jsonl"), session("Codex owner", projectPath));
		writeSession(importedFile, [...session("subagent-reviewer-import-run-0", projectPath), { type: "custom", customType: "pi-subagents.child-session", data: { schemaVersion: 1 } }, { type: "codex_import", version: 1, codexSessionId: "codex-child", sourcePath: join(home, "missing.jsonl") }]);

		const { SessionScanner } = loadSessionScanner(home);
		const summaries = await new SessionScanner().list(projectPath);
		const visiblePaths = new Set(summaries.map((summary) => summary.filePath));

		// 子会话包含在摘要列表中，但标记了 parentSessionPath
		assert.equal(visiblePaths.has(orphanFile), true);
		assert.equal(visiblePaths.has(renamedChildFile), true);
		assert.equal(visiblePaths.has(legacyForkFile), true);
		assert.equal(visiblePaths.has(manualForkFile), true);
		assert.equal(visiblePaths.has(markedCustomFile), true);
		assert.equal(visiblePaths.has(importedFile), true);
		// 父文件不存在时不能把路径形似扩展产物的 JSONL 静默挂到虚构父会话下。
		const orphanSummary = summaries.find((s) => s.filePath === orphanFile);
		assert.equal(orphanSummary.parentSessionPath, undefined);
		// renamedChild: 父文件不存在，不能挂到虚构父会话下。
		const renamedSummary = summaries.find((s) => s.filePath === renamedChildFile);
		assert.equal(renamedSummary.parentSessionPath, undefined);
		// legacyFork: 标准 .jsonl 文件路径不可推断父会话，fork parent 文件不存在
		const forkSummary = summaries.find((s) => s.filePath === legacyForkFile);
		assert.equal(forkSummary.parentSessionPath, undefined);
		// markedCustomFile: 显式标记，路径不可推断父会话（无 parentSessionPath）
		const customSummary = summaries.find((s) => s.filePath === markedCustomFile);
		assert.equal(customSummary.parentSessionPath, undefined);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("resolves fork child with absolute Windows parent path via parentSession header", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-abs-fork-scanner-"));
	try {
		const projectPath = "C:\\repo\\project";
		const sessionsRoot = join(home, ".pi", "agent", "sessions");
		const projDir = join(sessionsRoot, "--C--repo-project--");
		const parentFile = join(projDir, "parent.jsonl");
		const forkChildFile = join(projDir, "fork-child.jsonl");

		writeSession(parentFile, session("Parent", projectPath));
		writeSession(forkChildFile, [{ type: "session", parentSession: parentFile, cwd: projectPath }, ...session("subagent-reviewer-abc-1", projectPath)]);

		const { SessionScanner } = loadSessionScanner(home);
		const scanner = new SessionScanner();
		const listed = await scanner.list(projectPath);
		assert.equal(listed.length, 2);
		assert.equal(listed.find((s) => s.filePath === forkChildFile)?.parentSessionPath, undefined);
		const forkSummary = await scanner["readSummary"](forkChildFile);
		assert.equal(forkSummary.parentSessionPath, parentFile);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("recovers last-used model from assistant message when JSONL has no model_change", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-model-fallback-"));
	try {
		const projectPath = "C:\\repo\\project";
		const piDir = join(home, ".pi", "agent", "sessions", "--C--repo-project--");
		const sessionFile = join(piDir, "legacy.jsonl");
		writeSession(sessionFile, [
			{ type: "session_info", name: "Legacy Session", cwd: projectPath },
			// No model_change / thinking_level_change — only message-level provider/model.
			{
				type: "message",
				message: {
					role: "user",
					content: [{ type: "text", text: "hello" }],
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					provider: "deepseek",
					model: "deepseek-v4-pro",
					content: [{ type: "text", text: "hi there" }],
				},
			},
		]);

		const { SessionScanner } = loadSessionScanner(home);
		const scanner = new SessionScanner();
		const listed = await scanner.list(projectPath);
		assert.equal(listed.length, 1);
		assert.equal(listed[0].model, undefined);
		const summaries = [await scanner["readSummary"](sessionFile)];

		assert.equal(summaries.length, 1);
		assert.equal(summaries[0].model?.provider, "deepseek");
		assert.equal(summaries[0].model?.modelId, "deepseek-v4-pro");
		assert.equal(summaries[0].thinkingLevel, "off");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("model_change takes precedence over message-level model", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-model-prec-"));
	try {
		const projectPath = "C:\\repo\\project";
		const piDir = join(home, ".pi", "agent", "sessions", "--C--repo-project--");
		const sessionFile = join(piDir, "mixed.jsonl");
		writeSession(sessionFile, [
			{ type: "session_info", name: "Mixed Session", cwd: projectPath },
			// Assistant message first, then explicit model_change — the latter must win.
			{
				type: "message",
				message: {
					role: "assistant",
					provider: "openai",
					model: "gpt-4o",
					content: [{ type: "text", text: "first" }],
				},
			},
			{
				type: "model_change",
				provider: "anthropic",
				modelId: "claude-sonnet-4",
			},
			{
				type: "thinking_level_change",
				thinkingLevel: "high",
			},
		]);

		const { SessionScanner } = loadSessionScanner(home);
		const scanner = new SessionScanner();
		assert.equal((await scanner.list(projectPath)).length, 1);
		const summaries = [await scanner["readSummary"](sessionFile)];

		assert.equal(summaries.length, 1);
		assert.equal(summaries[0].model?.provider, "anthropic");
		assert.equal(summaries[0].model?.modelId, "claude-sonnet-4");
		assert.equal(summaries[0].thinkingLevel, "high");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("only user messages yield undefined model and undefined thinking", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-user-only-"));
	try {
		const projectPath = "C:\\repo\\project";
		const piDir = join(home, ".pi", "agent", "sessions", "--C--repo-project--");
		const sessionFile = join(piDir, "user-only.jsonl");
		writeSession(sessionFile, [
			{ type: "session_info", name: "User Only", cwd: projectPath },
			{
				type: "message",
				message: {
					role: "user",
					content: [{ type: "text", text: "hello" }],
				},
			},
		]);

		const { SessionScanner } = loadSessionScanner(home);
		const scanner = new SessionScanner();
		assert.equal((await scanner.list(projectPath)).length, 1);
		const summaries = [await scanner["readSummary"](sessionFile)];

		assert.equal(summaries.length, 1);
		assert.equal(summaries[0].model, undefined);
		assert.equal(summaries[0].thinkingLevel, undefined);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

// 回归：pi-subagents artifactDir="session"（默认）把子代理产物转储写进父会话同级的
// subagent-artifacts/ 目录。里面的 *_transcript.jsonl 是扩展私有格式（recordType 行），
// 不是 pi 会话文件；混进扫描会让每个子代理在侧栏出现「嵌套 + 顶层平铺」两条。
test("excludes pi-subagents artifact dumps from scan results", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-subagent-artifacts-"));
	try {
		const projectPath = "C:\\repo\\project";
		const piDir = join(home, ".pi", "agent", "sessions", "--C--repo-project--");
		const parentFile = join(piDir, "parent.jsonl");
		writeSession(parentFile, session("Parent", projectPath));

		// 产物目录与真实子会话并存：子会话仍应正常嵌套，产物必须整体排除。
		const childFile = join(piDir, "parent", "31f02534-c7dc-457e-a1ca-dc9311027461", "run-0", "session.jsonl");
		writeSession(childFile, session("subagent-reviewer-31f02534-1", projectPath));
		writeSession(join(piDir, "subagent-artifacts", "31f02534_reviewer_0_transcript.jsonl"), [{ version: 1, recordType: "message", runId: "31f02534", agent: "reviewer", role: "user", text: "review prompt" }]);

		const { SessionScanner } = loadSessionScanner(home);
		const summaries = await new SessionScanner().list(projectPath);
		const paths = summaries.map((summary) => summary.filePath);

		assert.equal(paths.includes(parentFile), true, "parent session must stay visible");
		assert.equal(paths.includes(childFile), true, "real child session must stay listed for nesting");
		assert.equal(
			paths.some((filePath) => filePath.replace(/\\/g, "/").split("/").includes("subagent-artifacts")),
			false,
			"artifact dumps must not be scanned as sessions",
		);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

// 回归 #168：即便 transcript 转储落在非 subagent-artifacts 目录（目录过滤够不到），
// 会话头校验也应把它挡下。inferSessionNameAndValidity 在补名读头部时顺带校验，
// 把无 type 头的产物标记 valid:false，供 catalog mergeScanned 拒绝索引。
test("inferSessionNameAndValidity flags transcript dumps without a type header as invalid", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-transcript-validity-"));
	try {
		const projectPath = "C:\\repo\\project";
		const piDir = join(home, ".pi", "agent", "sessions", "--C--repo-project--");
		// 真实会话：首条记录 type:"session" → valid:true。
		const realFile = join(piDir, "real.jsonl");
		writeSession(realFile, [
			{ type: "session", version: 3, id: "real1234", timestamp: "2026-08-26T08:00:00.000Z", cwd: projectPath },
			{ type: "session_info", name: "Real", cwd: projectPath },
			{ type: "message", message: { role: "user", content: "hello" } },
		]);
		// transcript 转储：首条记录用 recordType 而无 type → valid:false。
		// 放在普通目录（非 subagent-artifacts），目录过滤够不到，只能靠会话头校验。
		const transcriptFile = join(piDir, "stray_abc_worker_0_transcript.jsonl");
		writeFileSync(
			transcriptFile,
			`${JSON.stringify({
				version: 1,
				recordType: "message",
				source: "foreground",
				runId: "abc",
				agent: "worker",
				cwd: projectPath,
				sourceEventType: "initial_prompt",
				role: "user",
				message: { role: "user", content: [{ type: "text", text: "review prompt" }] },
			})}\n`,
			"utf8",
		);
		// 旧版私有 sessionName 头行（#114 存量损坏）：跳过后首条真实记录带 type → valid:true。
		const legacyFile = join(piDir, "legacy-renamed.jsonl");
		writeSession(legacyFile, [
			{ sessionName: "Legacy rename", ts: 1 },
			{ type: "session_info", name: "Legacy rename", cwd: projectPath },
			{ type: "message", message: { role: "user", content: "hi" } },
		]);

		const { SessionScanner } = loadSessionScanner(home);
		const scanner = new SessionScanner();

		const real = await scanner.inferSessionNameAndValidity(realFile);
		assert.equal(real.valid, true, "real pi session header must be valid");
		assert.equal(real.name, "Real");

		const transcript = await scanner.inferSessionNameAndValidity(transcriptFile);
		assert.equal(transcript.valid, false, "transcript without type header must be flagged invalid");

		const legacy = await scanner.inferSessionNameAndValidity(legacyFile);
		assert.equal(legacy.valid, true, "legacy sessionName head must be skipped, not rejected");

		// 读不到的文件不应被误判为无效（valid 缺省），避免权限/锁定文件被从 catalog 清掉。
		const missing = await scanner.inferSessionNameAndValidity(join(piDir, "missing.jsonl"));
		assert.equal(missing.valid, undefined, "unreadable files must not be flagged invalid");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("probes tintinweb flat subagent parent via <agent>#<8hex> session name", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-tintinweb-scanner-"));
	try {
		const projectPath = "C:\repo\project";
		const piDir = join(home, ".pi", "agent", "sessions", "--C--repo-project--");
		const parentFile = join(piDir, "2026-08-22T04-22-29-162Z_parent.jsonl");
		const childFile = join(piDir, "2026-08-22T04-23-00-162Z_child.jsonl");

		writeSession(parentFile, session("Parent", projectPath));
		// tintinweb 子代理：平铺文件 + session header 的 parentSession + 会话名 <agent>#<8hex>
		writeSession(childFile, [
			{ type: "session", id: "child-1", parentSession: "2026-08-22T04-22-29-162Z_parent.jsonl", cwd: projectPath },
			{ type: "session_info", name: "Explore#a1b2c3d4", cwd: projectPath },
			{ type: "message", message: { role: "user", content: "setup" } },
		]);

		const { SessionScanner } = loadSessionScanner(home);
		const scanner = new SessionScanner();
		const parent = await scanner.probeTintinwebSubagentParent(childFile);
		assert.equal(parent, parentFile);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("does not treat user forks or ordinary flat sessions as tintinweb subagents", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-fork-not-tintinweb-"));
	try {
		const projectPath = "C:\repo\project";
		const piDir = join(home, ".pi", "agent", "sessions", "--C--repo-project--");
		const parentFile = join(piDir, "2026-08-22T04-22-29-162Z_parent.jsonl");
		// fork：名字是用户命名（不匹配 <agent>#<8hex>），即使带 parentSession 也不应判为 tintinweb
		const forkFile = join(piDir, "2026-08-22T04-23-00-162Z_fork.jsonl");
		const ordinaryFile = join(piDir, "2026-08-22T04-24-00-162Z_ordinary.jsonl");

		writeSession(parentFile, session("Parent", projectPath));
		writeSession(forkFile, [
			{ type: "session", id: "fork-1", parentSession: "2026-08-22T04-22-29-162Z_parent.jsonl", cwd: projectPath },
			{ type: "session_info", name: "My manual fork", cwd: projectPath },
			{ type: "message", message: { role: "user", content: "hi" } },
		]);
		writeSession(ordinaryFile, session("Ordinary", projectPath));

		const { SessionScanner } = loadSessionScanner(home);
		const scanner = new SessionScanner();
		assert.equal(await scanner.probeTintinwebSubagentParent(forkFile), undefined);
		assert.equal(await scanner.probeTintinwebSubagentParent(ordinaryFile), undefined);
		// 父文件本身（无 parentSession header、无 #8hex 名）也不应误判
		assert.equal(await scanner.probeTintinwebSubagentParent(parentFile), undefined);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("inferSessionNameAndValidity returns parentSessionPath for tintinweb subagents (catalog backfill path)", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-tintinweb-backfill-"));
	try {
		const projectPath = "C:\repo\project";
		const piDir = join(home, ".pi", "agent", "sessions", "--C--repo-project--");
		const parentFile = join(piDir, "2026-08-22T04-22-29-162Z_parent.jsonl");
		const childFile = join(piDir, "2026-08-22T04-23-00-162Z_child.jsonl");

		writeSession(parentFile, session("Parent", projectPath));
		writeSession(childFile, [
			{ type: "session", id: "child-1", parentSession: parentFile, cwd: projectPath },
			{ type: "session_info", name: "Plan#deadbeef", cwd: projectPath },
			{ type: "message", message: { role: "user", content: "inspect" } },
		]);

		const { SessionScanner } = loadSessionScanner(home);
		const scanner = new SessionScanner();
		const result = await scanner.inferSessionNameAndValidity(childFile);
		assert.equal(result.name, "Plan#deadbeef");
		assert.equal(result.valid, true);
		assert.equal(result.parentSessionPath, parentFile);
		// 普通会话路径不返回 parentSessionPath
		const ordinary = await scanner.inferSessionNameAndValidity(parentFile);
		assert.equal(ordinary.parentSessionPath, undefined);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
