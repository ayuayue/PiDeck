import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const require = createRequire(import.meta.url);

/**
 * AgentManager 的「上下文接管探测」桩：本测试与压缩归属无关，按「没有接管者」透传，
 * 让 compact 走原生 RPC 分支（真模块会读磁盘配置，沙箱里不该发生 IO）。
 */
const noCompactionOwner = {
	MAGIC_CONTEXT_WRAPUP_COMMAND: "/ctx-wrapup",
	readPiCompactionOwnership: () => ({
		owners: [],
		conflicted: false,
		piAutoCompactionEnabled: true,
		ownerReady: true,
		notes: [],
	}),
};

/**
 * 未显式打桩的相对 import → 交给统一沙箱按**源文件目录**解析。
 * 原先的 tryRequireLocalTs 只是绕过「解析基准是 tests/」的补丁；统一到 createTsSandbox。
 */
const piSandbox = createTsSandbox();
const nodeRequire = createRequire(import.meta.url);

function resolveUnstubbedRequire(specifier) {
	if (!specifier.startsWith(".")) return nodeRequire(specifier);
	const target = path.resolve("src/main/pi", /\.(ts|tsx|js)$/.test(specifier) ? specifier : `${specifier}.ts`);
	return piSandbox(target);
}

function transpile(filePath) {
	return ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText;
}

function loadWslPaths() {
	const sandbox = { exports: {}, require };
	vm.runInNewContext(transpile("src/main/wsl/WslPaths.ts"), sandbox, { filename: "WslPaths.ts" });
	return sandbox.exports;
}

function loadAgentManager(existsPredicate = () => false) {
	const wslPaths = loadWslPaths();
	// AgentManager 新增 streamGate 依赖（abort 流式封印）；与 WslPaths 一样显式沙箱加载。
	const streamGate = (() => {
		const sandbox = { exports: {}, require };
		vm.runInNewContext(transpile("src/main/pi/streamGate.ts"), sandbox, { filename: "streamGate.ts" });
		return sandbox.exports;
	})();
	// cacheHitStats：纯函数真实加载（getRuntimeState 读会话文件统计缓存命中率）
	const cacheHitStats = (() => {
		const sandbox = { exports: {}, require };
		vm.runInNewContext(transpile("src/main/pi/cacheHitStats.ts"), sandbox, { filename: "cacheHitStats.ts" });
		return sandbox.exports;
	})();
	const sessionEntryIds = (() => {
		const sandbox = { exports: {}, require };
		vm.runInNewContext(transpile("src/main/pi/sessionEntryIds.ts"), sandbox, {
			filename: "sessionEntryIds.ts",
		});
		return sandbox.exports;
	})();
	const calls = {
		copyFile: [],
		existsSync: [],
		open: [],
		readFile: [],
		readdir: [],
		readdirSync: [],
		statSync: [],
		unlink: [],
		writeFile: [],
	};
	const sessionJsonl = `${JSON.stringify({ id: "entry-user", type: "message", message: { role: "user", content: "hello" } })}\n`;
	const fsPromises = {
		copyFile: async (...args) => {
			calls.copyFile.push(args);
		},
		readFile: async (...args) => {
			calls.readFile.push(args);
			return sessionJsonl;
		},
		stat: async () => ({ size: Buffer.byteLength(sessionJsonl), mtimeMs: 1 }),
		// 定位读替身：按 position/length 返回真实字节，读到 EOF 返回 bytesRead=0
		// （SessionHistoryReader 的索引重建已改为流式 open+read，靠 EOF 收尾）
		open: async (...args) => {
			calls.open.push(args);
			const source = Buffer.from(sessionJsonl, "utf8");
			return {
				read: async (buffer, _offset, length, position) => {
					const start = Number.isFinite(position) ? position : 0;
					const bytesRead = Math.min(length, Math.max(0, source.length - start));
					if (bytesRead > 0) source.copy(buffer, 0, start, start + bytesRead);
					return { bytesRead };
				},
				close: async () => {},
			};
		},
		readdir: async (...args) => {
			calls.readdir.push(args);
			return [];
		},
		unlink: async (...args) => {
			calls.unlink.push(args);
		},
		writeFile: async (...args) => {
			calls.writeFile.push(args);
		},
	};
	const historyReaderModule = { exports: {} };
	vm.runInNewContext(
		transpile("src/main/pi/SessionHistoryReader.ts"),
		{
			Buffer,
			console: { log() {}, warn() {}, error() {} },
			exports: historyReaderModule.exports,
			module: historyReaderModule,
			Promise,
			require: (id) =>
				id === "node:fs/promises"
					? fsPromises
					: // 停止身份缓存（72fe93da 起 SessionHistoryReader 依赖）：真实加载保持身份核对行为
						id === "./stoppedMessageIdentity"
						? loadTsCommonJs("src/main/pi/stoppedMessageIdentity.ts")
						: // entryId 槽位判定（isRoleMessageRole）：真实加载，0.86 system 条目对齐依赖它
							id === "./sessionEntryIds"
							? loadTsCommonJs("src/main/pi/sessionEntryIds.ts")
							: id === "../../shared/sessionTodo"
								? // todo 快照解析纯函数：本测试不覆盖，空实现满足依赖契约
									{ parseTodoSnapshotData: () => undefined }
								: // 工具推导纯函数：本测试不覆盖（另有 sessionAcpDelegateDerive.test.mjs），空实现满足依赖契约
									id === "./derivedSubagents"
									? { deriveToolSubagentEntries: () => [] }
									: // 会话 JSONL 流式行扫描器：真实加载，但注入被断言的 fs 替身（读到 host 路径）
										id === "../sessions/jsonlLineStream"
										? loadTsCommonJs("src/main/sessions/jsonlLineStream.ts", { stubs: { "node:fs/promises": fsPromises } })
										: // 会话文件汇总纯函数：本测试不覆盖，空实现满足 AgentManager 依赖契约
											id === "../../shared/fileChanges"
											? { collectLatestTurnFileChanges: () => [] }
											: require(id),
		},
		{ filename: "SessionHistoryReader.ts" },
	);
	class SessionFileEditor {
		async truncateForResend({ file }) {
			const content = await fsPromises.readFile(file.hostPath, "utf8");
			await fsPromises.writeFile(file.hostPath, content, "utf8");
		}
	}
	class LatestByKeyEmitter {
		push() {}
		flush() {}
		cancel() {}
	}
	const sandbox = {
		Buffer,
		clearTimeout,
		console: { log() {}, warn() {}, error() {} },
		exports: {},
		process: { ...process, platform: "win32" },
		setTimeout,
		require: (id) => {
			// 停止身份缓存（72fe93da 起 AgentManager 依赖）：真实加载保持身份核对行为
			if (id === "./stoppedMessageIdentity") return loadTsCommonJs("src/main/pi/stoppedMessageIdentity.ts");
			if (id === "electron") return { app: {}, Notification: class {} };
			if (id === "node:fs/promises") return fsPromises;
			if (id === "node:fs") {
				return {
					existsSync: (filePath) => {
						calls.existsSync.push(filePath);
						return existsPredicate(filePath);
					},
					readdirSync: (dir) => {
						calls.readdirSync.push(dir);
						return ["session.jsonl.100.edit-backup", "session.jsonl.200.edit-backup"];
					},
					statSync: (filePath) => {
						calls.statSync.push(filePath);
						return { size: 128 };
					},
				};
			}
			if (id === "node:path") return path.win32;
			if (id === "node:os") return { homedir: () => "C:\\Users\\tester" };
			if (id === "../../shared/ipc") return { ipcChannels: {} };
			if (id === "./PiProcess") return { PiProcess: class {} };
			if (id === "./bashResult") return { formatBashToolMessage: () => ({}) };
			if (id === "./messageContent") return { extractMessageText: (value) => String(value ?? "") };
			if (id === "./historyMessages") return { mergeHistoryWithPreservedMessages: (value) => value };
			if (id === "./agentSessionIdentity") return { buildAgentSessionKey: () => undefined };
			if (id === "./SessionFileEditor") return { SessionFileEditor };
			if (id === "./SessionHistoryReader") return historyReaderModule.exports;
			if (id === "./AgentMessageProjector") {
				return {
					AgentMessageProjector: class {},
					buildActiveBranchEntryIds: () => [],
				};
			}
			if (id === "./sessionEntryIds") return sessionEntryIds;
			if (id === "./agentUtils") {
				return {
					stripAnsi: (text) => text,
					pickNumber: (...values) => {
						for (const v of values) if (typeof v === "number") return v;
					},
					clampPercent: (v) => v,
					trimHistoryMessages: (msgs) => msgs,
					cleanTitle: (t) => t,
					inferTitleFromMessages: () => undefined,
					isDefaultAgentTitle: () => false,
				};
			}
			if (id === "./LatestByKeyEmitter") return { LatestByKeyEmitter };
			if (id === "./extensionStartupFallback") {
				return {
					shouldRetryWithoutExtensions: () => false,
					formatExtensionFallbackDebug: () => "",
				};
			}
			if (id === "./extensionError") {
				return { formatExtensionErrorReason: (error) => String(error) };
			}
			// 工具推导纯函数：本测试不覆盖（另有 sessionAcpDelegateDerive.test.mjs），空实现满足依赖契约
			if (id === "./derivedSubagents") {
				return { mergeSubagentSources: (records) => records };
			}
			if (id === "./thinkingLevels") {
				return { parseAvailableThinkingLevelsResponse: (response) => response?.data?.levels };
			}
			if (id === "./compactRpc") {
				return {
					createCompactRpcRequest: (prompt) => (prompt ? { type: "compact", prompt, customInstructions: prompt } : { type: "compact" }),
				};
			}
			// 上下文接管探测：本测试不涉及压缩归属，按「没有接管者」透传（会退回原生 compact RPC）
			if (id === "./compactionOwner") return noCompactionOwner;
			if (id === "./streamGate") return streamGate;
			if (id === "./cacheHitStats") return cacheHitStats;
			if (id === "../../shared/toolRuntimeState") return { updateActiveToolCalls: () => new Map() };
			if (id === "../wsl/WslPaths") return wslPaths;
			// 25fd516 起 AgentManager 引入内置扩展参数拼接；WSL 路径测试不涉及扩展加载，透传即可
			if (id === "../extensions/builtInExtensions") {
				return { appendBuiltInExtensionArgs: (args) => [...args] };
			}
			// 扩展白名单解析器（禁用功能）；本测试不涉及，返回 null（关闭白名单）
			if (id === "../extensions/enabledExtensionResolver") {
				return { resolveEnabledExtensionPaths: () => null };
			}
			// 共享扩展 resolver（issue #181）：本测试不涉及扩展加载，透传空实现即可
			if (id === "../extensions/piProcessExtensionResolvers") {
				return {
					createPiProcessExtensionResolvers: () => ({
						resolveBuiltInExtensionPaths: () => [],
						resolveEnabledExtensionPaths: () => null,
					}),
				};
			}
			// 技能白名单 resolver：本测试不涉及技能加载，透传空实现即可
			if (id === "../skills/piProcessSkillResolvers") {
				return {
					createPiProcessSkillResolvers: () => ({
						resolveEnabledSkillPaths: () => null,
					}),
				};
			}
			// 提示词模板白名单 resolver：本测试不涉及模板加载，透传空实现即可
			if (id === "../prompts/piProcessPromptResolvers") {
				return {
					createPiProcessPromptResolvers: () => ({
						resolveEnabledPromptPaths: () => null,
					}),
				};
			}
			// 会话文件汇总纯函数：本测试不覆盖，空实现满足 AgentManager 依赖契约
			if (id === "../../shared/fileChanges") return { collectLatestTurnFileChanges: () => [] };
			// rewind checkpoint 纯 git 模块：WSL 路径测试不涉及回退，空桩满足依赖契约
			// （桩返回空对象即可——命名导入在调用时才取属性，本测试不触发 rewind 方法）。
			if (id === "../rewind/index.ts") return {};
			// 相对 import 按 src/main/pi 解析后交给 Node 原生 TS 加载（见 helper 注释）；
			// 直接交 require(id) 会以 tests/ 为基准，生产新增本地模块（#213 的
			// ./messagePayloadSize）就会让本文件整片 MODULE_NOT_FOUND。
			// 未显式打桩的相对 import：交给统一沙箱按**源文件目录**（src/main/pi）解析。
			return resolveUnstubbedRequire(id);
		},
	};
	vm.runInNewContext(transpile("src/main/pi/AgentManager.ts"), sandbox, { filename: "AgentManager.ts" });
	return { ...sandbox.exports, calls, wslPaths };
}

function createManager(AgentManager, configManager = {}) {
	return new AgentManager(
		() => undefined,
		() => null,
		{ get: () => ({}) },
		configManager,
	);
}

test("maps WSL Session file operations to host paths while retaining Linux protocol identity", async () => {
	const { AgentManager, calls, wslPaths } = loadAgentManager();
	const manager = createManager(AgentManager);
	manager.configureWsl(wslPaths.createWslEnvironment("Ubuntu-24.04", "root", "/root"));
	const sessionPath = "/root/.pi/agent/sessions/session.jsonl";

	assert.equal(wslPaths.toWslLinuxPath("//wsl$/Ubuntu-24.04/root/.pi/agent/sessions/session.jsonl", manager.wslEnvironment), sessionPath);
	assert.notEqual(wslPaths.toWslLinuxPath("/root/.pi/agent/sessions/Session.jsonl", manager.wslEnvironment), wslPaths.toWslLinuxPath("/root/.pi/agent/sessions/session.jsonl", manager.wslEnvironment));
	const loadDecision = manager.getHistoryAutoLoadDecision(sessionPath);
	assert.equal(loadDecision.shouldLoad, true);
	assert.equal(loadDecision.sizeBytes, 128);
	await manager.readRecentMessagesFromSessionFile(sessionPath, 1);
	manager.agents.set("agent", {
		process: { client: {} },
		tab: {
			id: "agent",
			projectId: "project",
			title: "Agent",
			status: "idle",
			createdAt: 1,
			sessionPath,
		},
	});
	manager.messages.set("agent", [{ id: "message", agentId: "agent", role: "user", text: "hello", meta: { entryId: "entry-user" } }]);
	manager.reloadSession = async () => {};
	manager.loadMessages = async () => {};
	await manager.prepareResendFromMessage("agent", "message");

	const expectedHostPath = "\\\\wsl.localhost\\Ubuntu-24.04\\root\\.pi\\agent\\sessions\\session.jsonl";
	assert.equal(calls.statSync[0], expectedHostPath);
	// 会话 JSONL 的读取入口：索引重建走流式 open+定位 read（不再整文件 readFile）
	assert.equal(calls.open[0][0], expectedHostPath);
	// SessionFileEditor 的读写仍走 readFile/writeFile，同样必须落在 host 路径
	assert.equal(calls.readFile[0][0], expectedHostPath);
	assert.equal(calls.writeFile[0][0], expectedHostPath);
});

test("keeps switch_session RPC paths in Linux form", async () => {
	const { AgentManager, wslPaths } = loadAgentManager();
	const manager = createManager(AgentManager);
	manager.configureWsl(wslPaths.createWslEnvironment("Ubuntu-24.04", "root", "/root"));
	const requests = [];
	manager.agents.set("agent", {
		process: {
			client: {
				request: async (request) => {
					requests.push(request);
					return { success: true };
				},
			},
		},
		tab: { id: "agent", projectId: "project", title: "Agent", status: "idle", createdAt: 1 },
	});
	manager.refreshRuntimeAfterSessionReplacement = async () => {};

	await manager.switchSession("agent", "\\\\wsl.localhost\\Ubuntu-24.04\\root\\.pi\\agent\\sessions\\session.jsonl");

	assert.equal(requests[0].sessionPath, "/root/.pi/agent/sessions/session.jsonl");
});

test("project MCP files require an explicit trust decision", () => {
	for (const suffix of [".mcp.json", ".pi\\mcp.json"]) {
		const { AgentManager } = loadAgentManager((filePath) => filePath.endsWith(suffix));
		const manager = createManager(AgentManager);
		assert.equal(manager.hasTrustRequiringResources("C:\\project"), true, suffix);
	}
});

test("uses host paths for trust resource checks and Linux paths for trust keys", async () => {
	const { AgentManager, calls, wslPaths } = loadAgentManager();
	const trustedDirectories = [];
	const manager = createManager(AgentManager, {
		ensureTrustedDirectory: async (cwd) => {
			trustedDirectories.push(cwd);
		},
	});
	manager.configureWsl(wslPaths.createWslEnvironment("Ubuntu-24.04", "root", "/root"));

	await manager.ensureProjectTrust({
		id: "project",
		name: "ba_cli",
		path: "//wsl.localhost/Ubuntu-24.04/root/ba_cli",
		lastOpenedAt: 1,
	});

	assert.equal(trustedDirectories[0], "/root/ba_cli");
	assert.equal(
		calls.existsSync.every((filePath) => filePath.startsWith("\\\\wsl.localhost\\Ubuntu-24.04\\")),
		true,
	);
});
