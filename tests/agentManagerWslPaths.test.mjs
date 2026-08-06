import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

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

function loadAgentManager() {
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
		readFile: [],
		readdir: [],
		readdirSync: [],
		statSync: [],
		unlink: [],
		writeFile: [],
	};
	const fsPromises = {
		copyFile: async (...args) => { calls.copyFile.push(args); },
		readFile: async (...args) => {
			calls.readFile.push(args);
			return `${JSON.stringify({ id: "entry-user", type: "message", message: { role: "user", content: "hello" } })}\n`;
		},
		readdir: async (...args) => {
			calls.readdir.push(args);
			return [];
		},
		unlink: async (...args) => { calls.unlink.push(args); },
		writeFile: async (...args) => { calls.writeFile.push(args); },
	};
	const historyReaderModule = { exports: {} };
	vm.runInNewContext(transpile("src/main/pi/SessionHistoryReader.ts"), {
		Buffer,
		console: { log() {}, warn() {}, error() {} },
		exports: historyReaderModule.exports,
		module: historyReaderModule,
		Promise,
		require: (id) => id === "node:fs/promises" ? fsPromises : require(id),
	}, { filename: "SessionHistoryReader.ts" });
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
			if (id === "electron") return { app: {}, Notification: class {} };
			if (id === "node:fs/promises") return fsPromises;
			if (id === "node:fs") {
				return {
					existsSync: (filePath) => {
						calls.existsSync.push(filePath);
						return false;
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
					pickNumber: (...values) => { for (const v of values) if (typeof v === "number") return v; },
					clampPercent: (v) => v,
					trimHistoryMessages: (msgs) => msgs,
					cleanTitle: (t) => t,
					inferTitleFromMessages: () => undefined,
					isDefaultAgentTitle: () => false,
				};
			}
			if (id === "./LatestByKeyEmitter") return { LatestByKeyEmitter };
			if (id === "./streamGate") return streamGate;
			if (id === "./cacheHitStats") return cacheHitStats;
			if (id === "../../shared/toolRuntimeState") return { updateActiveToolCalls: () => new Map() };
			if (id === "../wsl/WslPaths") return wslPaths;
			// 25fd516 起 AgentManager 引入内置扩展参数拼接；WSL 路径测试不涉及扩展加载，透传即可
			if (id === "../extensions/builtInExtensions") {
				return { appendBuiltInExtensionArgs: (args) => [...args] };
			}
			return require(id);
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

	assert.equal(
		wslPaths.toWslLinuxPath("//wsl$/Ubuntu-24.04/root/.pi/agent/sessions/session.jsonl", manager.wslEnvironment),
		sessionPath,
	);
	assert.notEqual(
		wslPaths.toWslLinuxPath("/root/.pi/agent/sessions/Session.jsonl", manager.wslEnvironment),
		wslPaths.toWslLinuxPath("/root/.pi/agent/sessions/session.jsonl", manager.wslEnvironment),
	);
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
	manager.messages.set("agent", [
		{ id: "message", agentId: "agent", role: "user", text: "hello", meta: { entryId: "entry-user" } },
	]);
	manager.reloadSession = async () => {};
	manager.loadMessages = async () => {};
	await manager.prepareResendFromMessage("agent", "message");

	const expectedHostPath = "\\\\wsl.localhost\\Ubuntu-24.04\\root\\.pi\\agent\\sessions\\session.jsonl";
	assert.equal(calls.statSync[0], expectedHostPath);
	assert.equal(calls.readFile[0][0], expectedHostPath);
	assert.equal(calls.readFile[1][0], expectedHostPath);
	assert.equal(calls.writeFile[0][0], expectedHostPath);
});

test("keeps switch_session RPC paths in Linux form", async () => {
	const { AgentManager, wslPaths } = loadAgentManager();
	const manager = createManager(AgentManager);
	manager.configureWsl(wslPaths.createWslEnvironment("Ubuntu-24.04", "root", "/root"));
	const requests = [];
	manager.agents.set("agent", {
		process: { client: { request: async (request) => { requests.push(request); return { success: true }; } } },
		tab: { id: "agent", projectId: "project", title: "Agent", status: "idle", createdAt: 1 },
	});
	manager.refreshRuntimeAfterSessionReplacement = async () => {};

	await manager.switchSession(
		"agent",
		"\\\\wsl.localhost\\Ubuntu-24.04\\root\\.pi\\agent\\sessions\\session.jsonl",
	);

	assert.equal(requests[0].sessionPath, "/root/.pi/agent/sessions/session.jsonl");
});

test("uses host paths for trust resource checks and Linux paths for trust keys", async () => {
	const { AgentManager, calls, wslPaths } = loadAgentManager();
	const trustedDirectories = [];
	const manager = createManager(AgentManager, {
		ensureTrustedDirectory: async (cwd) => { trustedDirectories.push(cwd); },
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
