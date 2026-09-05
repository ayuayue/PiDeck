import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
	vm.runInNewContext(
		ts.transpileModule(readFileSync("src/main/feishu/docActions.ts", "utf8"), { compilerOptions }).outputText,
		docActions,
		{ filename: "docActions.ts" },
	);
	const messageContent = {
		exports: {},
		require: (id) => {
			if (id === "../feishu/docActions") return docActions.exports;
			throw new Error(`Unexpected messageContent import: ${id}`);
		},
	};
	vm.runInNewContext(
		ts.transpileModule(readFileSync("src/main/pi/messageContent.ts", "utf8"), { compilerOptions }).outputText,
		messageContent,
		{ filename: "messageContent.ts" },
	);
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
		process,
		require,
		setTimeout,
	};
	vm.runInNewContext(outputText, sandbox, { filename: "WslPaths.ts" });
	return sandbox.exports;
}

function loadFsRetryModule() {
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
						getPath: (name) => name === "userData" ? join(homePath, "user-data") : homePath,
					},
				};
			}
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
			if (id === "../pi/messageContent") return messageContent;
			if (id === "../wsl/WslPaths") return wslPaths;
			if (id === "./sessionSummaryCache") return sessionSummaryCache;
			if (id === "./sessionNameLine") return loadSessionNameLineModule();
			if (id === "../../shared/sessionIdentity") return sessionIdentity;
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
	writeFileSync(filePath, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

function forkFile(name, parentPath = "../../../parent.jsonl") {
	return [
		{ type: "session", id: "fork-child", parentSession: parentPath, cwd: "C:/project" },
		{ type: "session_info", name, cwd: "C:/project" },
		{ type: "message", message: { role: "user", content: "hello" } },
	];
}

test("header parentSession + user-chosen name is detected as a fork", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-scanner-forked-"));
	try {
		const filePath = join(home, "fork.jsonl");
		writeSession(filePath, forkFile("我的大会话", "C:/sessions/parent.jsonl"));

		const { SessionScanner } = loadSessionScanner(home);
		const result = await new SessionScanner().inferSessionNameAndValidity(filePath);
		assert.equal(result.forked, true);
		// 用户 fork 不是子代理：不得拿到 parentSessionPath（列表折叠字段）
		assert.equal(result.parentSessionPath, undefined);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("tintinweb flat subagent shape is not a fork and still resolves its parent path", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-scanner-forked-tintinweb-"));
	try {
		// 标准会话目录布局（.pi/agent/sessions/<编码 cwd>/），与子代理真实落盘一致
		const piDir = join(home, ".pi", "agent", "sessions", "--C--project--");
		const parentFile = join(piDir, "parent.jsonl");
		const childFile = join(piDir, "detached", "run-xyz", "run-0", "session.jsonl");
		writeSession(parentFile, [
			{ type: "session", id: "parent", cwd: "C:/project" },
			{ type: "session_info", name: "Parent", cwd: "C:/project" },
		]);
		writeSession(childFile, forkFile("agent#12345678", "../../../parent.jsonl"));

		const { SessionScanner } = loadSessionScanner(home);
		const result = await new SessionScanner().inferSessionNameAndValidity(childFile);
		assert.equal(result.forked, undefined);
		assert.equal(result.parentSessionPath, parentFile);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("plain sessions without a parentSession header are never forks", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-scanner-forked-plain-"));
	try {
		const filePath = join(home, "plain.jsonl");
		writeSession(filePath, [
			{ type: "session", id: "plain", cwd: "C:/project" },
			{ type: "session_info", name: "Plain", cwd: "C:/project" },
		]);

		const { SessionScanner } = loadSessionScanner(home);
		const result = await new SessionScanner().inferSessionNameAndValidity(filePath);
		assert.equal(result.forked, undefined);
		assert.equal(result.parentSessionPath, undefined);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
