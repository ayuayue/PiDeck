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

function loadSessionScanner(homePath, execFileMock, wslHostRoot) {
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
			["../utils/fsRetry", fsRetry],
		]),
	);
	// WSL 会话文件读写现在映射到 \\wsl.localhost UNC 宿主路径（SessionScanner.hostPathFor）。
	// 本测试没有真实 WSL：把 UNC 前缀替换成本机临时目录，让流式读写落在真实磁盘上。
	const wslPathsReal = loadTranspiledModule("src/main/wsl/WslPaths.ts");
	const wslPaths = wslHostRoot
		? {
				...wslPathsReal,
				toWindowsHostPath: (linuxPath) => {
					const raw = String(linuxPath);
					if (!raw.startsWith("/")) return raw;
					return join(wslHostRoot, ...raw.replace(/^\/+/, "").split("/"));
				},
			}
		: wslPathsReal;
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
			if (id === "node:child_process") return { execFile: execFileMock };
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
			if (id === "./sessionNameLine") return loadSessionNameLineModule();
			if (id === "../../shared/sessionIdentity") return sessionIdentity;
			if (id === "../../shared/expandedRefBlocks") return expandedRefBlocks;
			if (id === "./jsonlLineStream") return jsonlLineStream;
			if (id === "../logging/sharedLogger") return { getAppLogger: () => null };
			return require(id);
		},
	};
	vm.runInNewContext(outputText, sandbox, { filename: "SessionScanner.ts" });
	return sandbox.exports;
}

/**
 * 模拟 Node child_process.execFile 的 maxBuffer 语义：stdout 超过
 * options.maxBuffer（默认 1024*1024，与 Node 一致）时报
 * ERR_CHILD_PROCESS_STDIO_MAXBUFFER 并终止回调。
 * 文件内容是内存 Map（key = Linux 绝对路径），不入真实磁盘。
 */
function createWslExecFileMock(files) {
	const calls = [];
	const writes = [];
	const execFile = (cmd, args, options, callback) => {
		if (typeof options === "function") {
			callback = options;
			options = {};
		}
		calls.push({ cmd, args, options });
		const command = args[4];
		const maxBuffer = options.maxBuffer ?? 1024 * 1024;
		const maxBufferError = (bytes) => {
			const err = new Error(`maxBuffer exceeded: stdout (${bytes} > ${maxBuffer})`);
			err.code = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
			return err;
		};
		const enoent = (path) => {
			const err = new Error(`cat: ${path}: No such file or directory`);
			err.code = "ENOENT";
			return err;
		};

		switch (command) {
			case "cat": {
				const path = args[5];
				const content = files.get(path);
				if (content === undefined) return setImmediate(() => callback(enoent(path), "", ""));
				const size = Buffer.byteLength(content, "utf8");
				// 与真实 Node 行为一致：stdout 超过 maxBuffer 时报错，调用方只能拿到 reject
				const err = size > maxBuffer ? maxBufferError(size) : null;
				return setImmediate(() => callback(err, err ? "" : content, ""));
			}
			case "stat": {
				const path = args[7];
				const content = files.get(path) ?? "";
				const size = Buffer.byteLength(content, "utf8");
				return setImmediate(() => callback(null, `1700000000 ${size}`, ""));
			}
			case "find": {
				const root = args[5];
				const lines = [...files.keys()].filter((p) => p.startsWith(root) && p.endsWith(".jsonl"));
				return setImmediate(() => callback(null, lines.join("\n"), ""));
			}
			case "head": {
				const path = args[8];
				const content = files.get(path) ?? "";
				return setImmediate(() => callback(null, content.slice(0, Number(args[6])), ""));
			}
			case "test": {
				const path = args[5];
				return setImmediate(() => callback(files.has(path) ? null : enoent(path), "", ""));
			}
			case "tee": {
				// tee 会把 stdin 内容回显到 stdout：大文件回写同样会撞 maxBuffer
				// （真实环境里 Node 会 kill 子进程，文件可能只写了一半）
				const path = args[5];
				return {
					stdin: {
						end: (content) => {
							files.set(path, content);
							writes.push({ path, content, command: "tee" });
							const size = Buffer.byteLength(content, "utf8");
							const err = size > maxBuffer ? maxBufferError(size) : null;
							setImmediate(() => callback(err, err ? "" : content, ""));
						},
					},
				};
			}
			case "dd": {
				// dd of=path 从 stdin 写入，无 stdout 回显，永不触发 maxBuffer
				const target = args[5].startsWith("of=") ? args[5].slice(3) : null;
				return {
					stdin: {
						end: (content) => {
							if (target !== null) {
								files.set(target, content);
								writes.push({ path: target, content, command: "dd" });
							}
							setImmediate(() => callback(null, "", ""));
						},
					},
				};
			}
			default:
				return setImmediate(() => callback(null, "", ""));
		}
	};
	return { execFile, calls, writes };
}

/** 生成一个 >1MB 的合法 pi 会话 JSONL（首行 type:"session" 头 + 一条大 assistant 消息）。 */
function buildBigSessionContent() {
	const entries = [
		{ type: "session", id: "aaaa0001", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/mnt/h/justpi", name: "big-session" },
		{ type: "message", id: "aaaa0002", parentId: "aaaa0001", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: "x".repeat(1024 * 1024 + 512 * 1024) } },
	];
	return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
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

const WSL_ENV = { distro: "Ubuntu", user: "u", linuxHome: "/home/u" };
const BIG_PATH = "/home/u/.pi/agent/sessions/big.jsonl";

/** 把 WSL Linux 路径映射到临时目录下的真实文件（模拟 UNC 宿主路径）。 */
function writeWslHostFile(wslHostRoot, linuxPath, content) {
	const hostFilePath = join(wslHostRoot, ...linuxPath.replace(/^\/+/, "").split("/"));
	mkdirSync(dirname(hostFilePath), { recursive: true });
	writeFileSync(hostFilePath, content, "utf8");
	return hostFilePath;
}

test("WSL list() 能识别超过 1MB 的会话（#147 回归：大文件不被 maxBuffer 截断丢弃）", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-wsl-big-"));
	try {
		const bigContent = buildBigSessionContent();
		assert.ok(Buffer.byteLength(bigContent, "utf8") > 1024 * 1024, "fixture 必须超过 1MB 才有效");
		const mock = createWslExecFileMock(new Map([[BIG_PATH, bigContent]]));
		const { SessionScanner } = loadSessionScanner(home, mock.execFile);
		const scanner = new SessionScanner();
		await scanner.configureWsl(WSL_ENV);

		const list = await scanner.list();

		// 列表扫描只 stat 路径，不再整文件 cat；超过 1MB 的会话仍应出现在列表中。
		assert.equal(list.length, 1, "超过 1MB 的 WSL 会话不应从列表消失");
		assert.equal(list[0].filePath, BIG_PATH);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("WSL 重命名超过 1MB 的会话不报错且追加 session_info（#147 回归 + 流式改造）", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-wsl-rename-"));
	const wslHostRoot = mkdtempSync(join(tmpdir(), "pideck-wsl-host-"));
	try {
		const bigContent = buildBigSessionContent();
		// UNC 映射到真实临时目录：Linux 路径 /home/u/... → <wslHostRoot>/home/u/...
		const hostFilePath = writeWslHostFile(wslHostRoot, BIG_PATH, bigContent);

		const mock = createWslExecFileMock(new Map([[BIG_PATH, bigContent]]));
		const { SessionScanner } = loadSessionScanner(home, mock.execFile, wslHostRoot);
		const scanner = new SessionScanner();
		await scanner.configureWsl(WSL_ENV);

		// 修复前：readWslFile（读全文）与 writeWslFile（tee 回显）都会撞 1MB 上限
		await scanner.rename(BIG_PATH, "renamed");

		// 改造后：WSL 会话文件读写走 UNC 宿主路径，不再经过 wsl cat/dd 的 maxBuffer 通道
		assert.equal(mock.calls.filter((call) => call.args.includes("cat")).length, 0, "重命名不应再整文件 cat（maxBuffer 通道）");
		const written = readFileSync(hostFilePath, "utf8");
		assert.equal(piSessionName(written.split(/\r?\n/)), "renamed");
	} finally {
		rmSync(home, { recursive: true, force: true });
		rmSync(wslHostRoot, { recursive: true, force: true });
	}
});

test("WSL 引用消息与整文件读取走 UNC 流式通道（不再 cat 整份会话）", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-wsl-read-"));
	const wslHostRoot = mkdtempSync(join(tmpdir(), "pideck-wsl-readhost-"));
	try {
		const bigContent = buildBigSessionContent();
		writeWslHostFile(wslHostRoot, BIG_PATH, bigContent);
		const mock = createWslExecFileMock(new Map([[BIG_PATH, bigContent]]));
		const { SessionScanner } = loadSessionScanner(home, mock.execFile, wslHostRoot);
		const scanner = new SessionScanner();
		await scanner.configureWsl(WSL_ENV);

		// 引用历史消息（@会话 选择器）：流式尾窗，只回传 user/assistant 文本
		const messages = await scanner.readMessages(BIG_PATH);
		assert.equal(messages.length, 1);
		assert.equal(messages[0].role, "assistant");

		// 整文件读取：走 UNC 宿主路径 + 体量护栏（护栏按真实字节数判定）
		const raw = await scanner.readSessionRawText(BIG_PATH);
		assert.equal(raw.length, bigContent.length);

		assert.equal(mock.calls.filter((call) => call.args.includes("cat")).length, 0, "会话文件本体不应再走 wsl cat（maxBuffer 通道）");
	} finally {
		rmSync(home, { recursive: true, force: true });
		rmSync(wslHostRoot, { recursive: true, force: true });
	}
});
