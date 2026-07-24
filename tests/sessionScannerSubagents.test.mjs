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
		require: (id) => overrides.has(id) ? overrides.get(id) : require(id),
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

function loadSessionScanner(homePath, fsOverrides = {}) {
	const source = readFileSync("src/main/sessions/SessionScanner.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const codexMeta = loadCodexMetaModule();
	const messageContent = loadTranspiledModule(
		"src/main/pi/messageContent.ts",
		new Map([["../feishu/docActions", { stripFeishuDocActionHint: (text) => text }]]),
	);
	const sessionSummaryCache = loadTranspiledModule(
		"src/main/sessions/sessionSummaryCache.ts",
		new Map([["electron", { app: { getPath: () => homePath } }]]),
	);
	const wslPaths = loadTranspiledModule("src/main/wsl/WslPaths.ts");
	const sandbox = {
		AbortController,
		AbortSignal,
		Buffer,
		clearTimeout,
		exports: {},
		setTimeout,
		require: (id) => {
			if (id === "electron") return { app: { getPath: () => homePath } };
			if (id === "../../shared/codexSessionMeta") return codexMeta;
			if (id === "../pi/messageContent") return messageContent;
			if (id === "./sessionSummaryCache") return sessionSummaryCache;
			if (id === "../wsl/WslPaths") return wslPaths;
			if (id === "node:fs") return { ...require(id), ...fsOverrides };
			return require(id);
		},
	};
	vm.runInNewContext(outputText, sandbox, { filename: "SessionScanner.ts" });
	return sandbox.exports;
}

function writeSession(filePath, entries) {
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`, "utf8");
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
			closeSync: () => { closed = true; },
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
		scanner.collectWslJsonl = async (signal) => {
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
		writeSession(workerFile, [
			...session("Worker without generated name", projectPath),
			{ type: "custom", customType: "pi-subagents.child-session", data: { schemaVersion: 1 } },
		]);
		// Generated naming plus the standard path retains compatibility with old runs.
		writeSession(reviewerFile, session("subagent-reviewer-run-abc-1", projectPath));

		const { SessionScanner } = loadSessionScanner(home);
		const summaries = await new SessionScanner().list(projectPath);
		const visiblePaths = new Set(summaries.map(summary => summary.filePath));

		assert.equal(visiblePaths.has(parentFile), true);
		assert.equal(visiblePaths.has(nestedUserFile), true);
		assert.equal(visiblePaths.has(lookalikeFile), true);
		// 子会话仍然在摘要列表中，但标记了父会话路径
		assert.equal(visiblePaths.has(workerFile), true);
		assert.equal(visiblePaths.has(reviewerFile), true);
		assert.equal(summaries.some(summary => summary.name === "subagent-worker-manual-0"), true);
		assert.equal(existsSync(workerFile), true);
		assert.equal(existsSync(reviewerFile), true);
		// 验证子会话的 parentSessionPath 指向正确的父会话文件
		const workerSummary = summaries.find(s => s.filePath === workerFile);
		assert.equal(workerSummary.parentSessionPath, parentFile);
		const reviewerSummary = summaries.find(s => s.filePath === reviewerFile);
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
			[parentFile, `${session("Parent", projectPath).map((entry) => JSON.stringify(entry)).join("\n")}\n`],
			[forkParentFile, `${session("Fork parent", projectPath).map((entry) => JSON.stringify(entry)).join("\n")}\n`],
			[childFile, `${session("subagent-worker-wsl-0", projectPath).map((entry) => JSON.stringify(entry)).join("\n")}\n`],
			[forkChildFile, `${[
				{ type: "session", id: "wsl-fork-child", parentSession: "../../../fork-parent.jsonl", cwd: projectPath },
				...session("subagent-worker-wsl-fork-0", projectPath),
			].map((entry) => JSON.stringify(entry)).join("\n")}\n`],
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
			size: files.get(filePath)?.length ?? 0,
		});
		scanner.existsWslFile = async (filePath) => files.has(filePath);

		const summaries = await scanner.list(selectedProjectPath);
		assert.equal(summaries.length, 4);
		assert.equal(summaries.find((item) => item.filePath === childFile)?.parentSessionPath, parentFile);
		assert.equal(summaries.find((item) => item.filePath === forkChildFile)?.parentSessionPath, forkParentFile);
		assert.equal(summaries.some((item) => item.parentSessionPath?.includes("\\")), false);
		assert.equal(fullReadCount.get(parentFile), 1);
		assert.equal(fullReadCount.get(forkParentFile), 1);
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

		writeSession(parentFile, [
			{ sessionName: "Renamed parent", ts: Date.now() },
			...session("Original parent", projectPath),
		]);
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
		writeSession(renamedChildFile, [
			{ sessionName: "Renamed child", cwd: projectPath },
			...session("subagent-worker-old-run-0", projectPath),
		]);
		writeSession(legacyForkFile, [
			{ type: "session", id: "legacy-child", parentSession: "parent-session.jsonl", cwd: projectPath },
			...session("subagent-worker-fork-run-0", projectPath),
		]);
		writeSession(manualForkFile, [
			{ type: "session", id: "manual-child", parentSession: "parent-session.jsonl", cwd: projectPath },
			{ type: "session_info", name: "subagent-worker-copied-parent-0", cwd: projectPath },
			...session("Manual user fork", projectPath),
		]);
		writeSession(markedCustomFile, [
			...session("Custom-location child", projectPath),
			{ type: "custom", customType: "pi-subagents.child-session", data: { schemaVersion: 1 } },
		]);
		writeSession(join(piDir, "codex-parent.jsonl"), session("Codex owner", projectPath));
		writeSession(importedFile, [
			...session("subagent-reviewer-import-run-0", projectPath),
			{ type: "custom", customType: "pi-subagents.child-session", data: { schemaVersion: 1 } },
			{ type: "codex_import", version: 1, codexSessionId: "codex-child", sourcePath: join(home, "missing.jsonl") },
		]);

		const { SessionScanner } = loadSessionScanner(home);
		const summaries = await new SessionScanner().list(projectPath);
		const visiblePaths = new Set(summaries.map(summary => summary.filePath));

		// 子会话包含在摘要列表中，但标记了 parentSessionPath
		assert.equal(visiblePaths.has(orphanFile), true);
		assert.equal(visiblePaths.has(renamedChildFile), true);
		assert.equal(visiblePaths.has(legacyForkFile), true);
		assert.equal(visiblePaths.has(manualForkFile), true);
		assert.equal(visiblePaths.has(markedCustomFile), true);
		assert.equal(visiblePaths.has(importedFile), true);
		// 父文件不存在时不能把路径形似扩展产物的 JSONL 静默挂到虚构父会话下。
		const orphanSummary = summaries.find(s => s.filePath === orphanFile);
		assert.equal(orphanSummary.parentSessionPath, undefined);
		// renamedChild: 父文件不存在，不能挂到虚构父会话下。
		const renamedSummary = summaries.find(s => s.filePath === renamedChildFile);
		assert.equal(renamedSummary.parentSessionPath, undefined);
		// legacyFork: 标准 .jsonl 文件路径不可推断父会话，fork parent 文件不存在
		const forkSummary = summaries.find(s => s.filePath === legacyForkFile);
		assert.equal(forkSummary.parentSessionPath, undefined);
		// markedCustomFile: 显式标记，路径不可推断父会话（无 parentSessionPath）
		const customSummary = summaries.find(s => s.filePath === markedCustomFile);
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
		writeSession(forkChildFile, [
			{ type: "session", parentSession: parentFile, cwd: projectPath },
			...session("subagent-reviewer-abc-1", projectPath),
		]);

		const { SessionScanner } = loadSessionScanner(home);
		const summaries = await new SessionScanner().list(projectPath);
		assert.equal(summaries.length, 2);
		const forkSummary = summaries.find(s => s.filePath === forkChildFile);
		assert.equal(forkSummary.parentSessionPath, parentFile);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
