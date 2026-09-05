import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const nodeRequire = createRequire(import.meta.url);

function extractMessageText(content) {
  return Array.isArray(content)
    ? content
      .filter((item) => item?.type === "text")
      .map((item) => item.text ?? "")
      .join("\n")
    : "";
}

function loadAgentMessageProjectorModule() {
  const output = ts.transpileModule(
    readFileSync("src/main/pi/AgentMessageProjector.ts", "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
      fileName: "AgentMessageProjector.ts",
    },
  ).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require: (specifier) => {
      if (specifier === "../../shared/formatToolDetail") {
        return {
          extractToolResultText: (result) => typeof result === "string" ? result : "",
          formatToolDetail: () => "",
          safeJson: (value) => JSON.stringify(value),
          truncateDetailWithMeta: (text) => ({ text, truncated: false, fullLength: text.length }),
          truncateForDetail: (text) => typeof text === "string" ? text : String(text ?? ""),
        };
      }
      if (specifier === "./messageContent") return { extractMessageText };
      if (specifier === "./sessionEntryIds") {
        return {
          takeActiveEntryId: (ids, index) => ({ entryId: ids?.[index], nextIndex: index + 1 }),
        };
      }
      // 25fd516 起 AgentManager 引入内置扩展参数拼接；本测试不涉及扩展加载，透传即可
      if (specifier === "../extensions/builtInExtensions") {
        return { appendBuiltInExtensionArgs: (args) => [...args] };
      }
      // 扩展白名单解析器（禁用功能）；本测试不涉及，返回 null（关闭白名单）
      if (specifier === "../extensions/enabledExtensionResolver") {
        return { resolveEnabledExtensionPaths: () => null };
      }
      // 并行提交给 AgentManager 新增的扩展启动回落纯函数：无依赖，就地编译注入
      if (specifier === "./extensionStartupFallback") {
        // 无依赖纯函数：就地编译注入（测试文件无独立 transpile，用 ts.transpileModule）
        const fallbackModule = { exports: {} };
        vm.runInNewContext(
          ts.transpileModule(readFileSync("src/main/pi/extensionStartupFallback.ts", "utf8"), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
            fileName: "extensionStartupFallback.ts",
          }).outputText,
          { module: fallbackModule, exports: fallbackModule.exports },
          { filename: "extensionStartupFallback.ts" },
        );
        return fallbackModule.exports;
      }
      if (specifier === "./extensionError") {
        // AgentManager 依赖的扩展错误原因格式化；本测试不涉及错误文案，透传字符串即可
        return { formatExtensionErrorReason: (reason) => String(reason ?? "") };
      }
      // 工具推导纯函数：本测试不覆盖（另有 sessionAcpDelegateDerive.test.mjs），空实现满足依赖契约
      if (specifier === "./derivedSubagents") {
        return { mergeSubagentSources: (records) => records };
      }
      // rewind checkpoint 纯 git 模块：本测试不涉及，空桩满足依赖契约
      if (specifier === "../rewind/index.ts") return {};
      return nodeRequire(specifier);
    },
    Date,
    Map,
    JSON,
  }, { filename: "AgentMessageProjector.ts" });
  return module.exports;
}

function loadAgentManagerModule() {
	// AgentManager 新增 streamGate 依赖（abort 流式封印），真实加载以保持闸门行为。
	const streamGateModule = { exports: {} };
	vm.runInNewContext(
		ts.transpileModule(readFileSync("src/main/pi/streamGate.ts", "utf8"), {
			compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
			fileName: "streamGate.ts",
		}).outputText,
		{ module: streamGateModule, exports: streamGateModule.exports },
		{ filename: "streamGate.ts" },
	);
	// cacheHitStats：纯函数真实加载（getRuntimeState 读会话文件统计缓存命中率）
	const cacheHitStatsModule = { exports: {} };
	vm.runInNewContext(
		ts.transpileModule(readFileSync("src/main/pi/cacheHitStats.ts", "utf8"), {
			compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
			fileName: "cacheHitStats.ts",
		}).outputText,
		{ module: cacheHitStatsModule, exports: cacheHitStatsModule.exports },
		{ filename: "cacheHitStats.ts" },
	);
	const messageProjectorModule = loadAgentMessageProjectorModule();
	const historyReaderModule = { exports: {} };
	const historyReaderOutput = ts.transpileModule(
		readFileSync("src/main/pi/SessionHistoryReader.ts", "utf8"),
		{
			compilerOptions: {
				module: ts.ModuleKind.CommonJS,
				target: ts.ScriptTarget.ES2022,
				esModuleInterop: true,
			},
			fileName: "SessionHistoryReader.ts",
		},
	).outputText;
	vm.runInNewContext(historyReaderOutput, {
		module: historyReaderModule,
		exports: historyReaderModule.exports,
		require: (specifier) => {
			// todo 快照解析纯函数：本测试不覆盖，空实现满足依赖契约
			if (specifier === "../../shared/sessionTodo") return { parseTodoSnapshotData: () => undefined };
			// acp_delegate 推导纯函数：本测试不覆盖（另有 sessionAcpDelegateDerive.test.mjs），空实现满足依赖契约
			if (specifier === "./derivedSubagents") return { deriveToolSubagentEntries: () => [] };
			// 会话文件汇总纯函数：本测试不覆盖，空实现满足 AgentManager 依赖契约
			if (specifier === "../../shared/fileChanges") return { collectSessionFileChanges: () => [] };
			return nodeRequire(specifier);
		},
		Buffer,
		Date,
		Map,
		Set,
		Promise,
		JSON,
		console,
	}, { filename: "SessionHistoryReader.ts" });
	const output = ts.transpileModule(
    readFileSync("src/main/pi/AgentManager.ts", "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
      fileName: "AgentManager.ts",
    },
  ).outputText;
  const module = { exports: {} };
  class LatestByKeyEmitter {
    constructor() {}
    cancel() {}
  }
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require: (specifier) => {
      if (specifier === "electron") {
        return { app: { getName: () => "PiDeck" }, Notification: { isSupported: () => false } };
      }
      // 共享扩展 resolver（issue #181）：本测试不涉及扩展加载，透传空实现即可
      if (specifier === "../extensions/piProcessExtensionResolvers") {
        return {
          createPiProcessExtensionResolvers: () => ({
            resolveBuiltInExtensionPaths: () => [],
            resolveEnabledExtensionPaths: () => null,
          }),
        };
      }
      if (specifier === "../../shared/ipc") return { ipcChannels: {} };
      if (specifier === "./PiProcess") return { PiProcess: class {} };
      if (specifier === "./bashResult") return { formatBashToolMessage: () => "" };
      if (specifier === "./AgentMessageProjector") return messageProjectorModule;
      if (specifier === "./historyMessages") return { mergeHistoryWithPreservedMessages: (messages) => messages };
      if (specifier === "./agentSessionIdentity") {
        return { buildAgentSessionKey: () => undefined };
      }
		if (specifier === "./SessionFileEditor") {
			return { SessionFileEditor: class {} };
		}
		// 会话文件汇总纯函数：本测试不覆盖，空实现满足 AgentManager 依赖契约
		if (specifier === "../../shared/fileChanges") return { collectSessionFileChanges: () => [] };
		if (specifier === "./SessionHistoryReader") return historyReaderModule.exports;
      if (specifier === "./sessionEntryIds") {
        return {
          assertResendRootEntry: () => undefined,
          findLastUserMessageLine: () => undefined,
          takeActiveEntryId: (ids, index) => ({ entryId: ids?.[index], nextIndex: index + 1 }),
        };
      }
      if (specifier === "./agentUtils") {
        return {
          stripAnsi: (text) => text,
          pickNumber: (...values) => { for (const v of values) if (typeof v === "number") return v; },
          clampPercent: (v) => v,
          trimHistoryMessages: (msgs) => msgs,
          stripToolResultForDelivery: (messages) => messages,
          leadingSummaryCards: () => [],
          cleanTitle: (t) => t,
          inferTitleFromMessages: () => undefined,
          isDefaultAgentTitle: () => false,
        };
      }
      if (specifier === "./LatestByKeyEmitter") return { LatestByKeyEmitter };
      if (specifier === "./thinkingLevels") {
        return { parseAvailableThinkingLevelsResponse: (response) => response?.data?.levels };
      }
      if (specifier === "./compactRpc") {
        return {
          createCompactRpcRequest: (prompt) => prompt
            ? { type: "compact", prompt, customInstructions: prompt }
            : { type: "compact" },
        };
      }
      if (specifier === "./streamGate") return streamGateModule.exports;
      if (specifier === "./cacheHitStats") return cacheHitStatsModule.exports;
      if (specifier === "../../shared/toolRuntimeState") return { updateActiveToolCalls: () => undefined };
      if (specifier === "../wsl/WslPaths") {
        return { toWindowsHostPath: (path) => path, toWslLinuxPath: (path) => path };
      }
      // 25fd516 起 AgentManager 引入内置扩展参数拼接；本测试不涉及扩展加载，透传即可
      if (specifier === "../extensions/builtInExtensions") {
        return { appendBuiltInExtensionArgs: (args) => [...args] };
      }
      // 扩展白名单解析器（禁用功能）；本测试不涉及，返回 null（关闭白名单）
      if (specifier === "../extensions/enabledExtensionResolver") {
        return { resolveEnabledExtensionPaths: () => null };
      }
      // 并行提交给 AgentManager 新增的扩展启动回落纯函数：无依赖，就地编译注入
      if (specifier === "./extensionStartupFallback") {
        // 无依赖纯函数：就地编译注入（测试文件无独立 transpile，用 ts.transpileModule）
        const fallbackModule = { exports: {} };
        vm.runInNewContext(
          ts.transpileModule(readFileSync("src/main/pi/extensionStartupFallback.ts", "utf8"), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
            fileName: "extensionStartupFallback.ts",
          }).outputText,
          { module: fallbackModule, exports: fallbackModule.exports },
          { filename: "extensionStartupFallback.ts" },
        );
        return fallbackModule.exports;
      }
      if (specifier === "./extensionError") {
        // AgentManager 依赖的扩展错误原因格式化；本测试不涉及错误文案，透传字符串即可
        return { formatExtensionErrorReason: (reason) => String(reason ?? "") };
      }
      // 工具推导纯函数：本测试不覆盖（另有 sessionAcpDelegateDerive.test.mjs），空实现满足依赖契约
      if (specifier === "./derivedSubagents") {
        return { mergeSubagentSources: (records) => records };
      }
      // rewind checkpoint 纯 git 模块：本测试不涉及，空桩满足依赖契约
      if (specifier === "../rewind/index.ts") return {};
      return nodeRequire(specifier);
    },
    Date,
    Map,
    Set,
    Promise,
	JSON,
	Buffer,
    Error,
    setTimeout,
    clearTimeout,
    console,
  }, { filename: "AgentManager.ts" });
  return module.exports;
}

test("history conversion preserves an assistant turn that contains only thinking", () => {
  const { AgentManager } = loadAgentManagerModule();
  const manager = new AgentManager(
    () => undefined,
    () => null,
    { get: () => ({}) },
    {},
  );

  const messages = manager.convertAgentMessages("agent-1", [{
    role: "assistant",
    content: [{ type: "thinking", thinking: "reason through the tool result" }],
    timestamp: 1,
  }], ["entry-1"]);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "assistant");
  assert.equal(messages[0].text, "");
  assert.equal(messages[0].thinking, "reason through the tool result");
  assert.equal(messages[0].meta.entryId, "entry-1");
});

test("offline Session Viewer preserves the full active branch for renderer pagination", async () => {
  const { AgentManager } = loadAgentManagerModule();
  const manager = new AgentManager(
    () => undefined,
    () => null,
    { get: () => ({}) },
    {},
  );
  const lines = [JSON.stringify({ id: "session", type: "session" })];
  let parentId = "session";
  for (let index = 0; index < 100; index += 1) {
    const id = `message-${index}`;
    lines.push(JSON.stringify({
      id,
      parentId,
      type: "message",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: {
        role: index % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: `fixture message ${index}` }],
      },
    }));
    parentId = id;
  }

  const messages = await manager.readSessionDisplayMessages(
    "C:/fixtures/messages-100.jsonl",
    "viewer",
    `${lines.join("\n")}\n`,
  );

  assert.equal(messages.length, 100);
  assert.equal(messages[0].text, "fixture message 0");
	assert.equal(messages.at(-1).text, "fixture message 99");
});

test("offline Session Viewer reads complete historical turns only", async () => {
	const { AgentManager } = loadAgentManagerModule();
	const manager = new AgentManager(
		() => undefined,
		() => null,
		{ get: () => ({}) },
		{},
	);
	const directory = await mkdtemp(join(tmpdir(), "pideck-history-page-"));
	const sessionPath = join(directory, "large.jsonl");
	const lines = [JSON.stringify({ id: "session", type: "session" })];
	let parentId = "session";
	for (let index = 0; index < 150; index += 1) {
		const id = `message-${index}`;
		lines.push(JSON.stringify({
			id,
			parentId,
			type: "message",
			timestamp: "2026-01-01T00:00:00.000Z",
			message: {
				role: index % 2 === 0 ? "user" : "assistant",
				content: [{ type: "text", text: `fixture message ${index}` }],
			},
		}));
		parentId = id;
	}
	try {
		await writeFile(sessionPath, `${lines.join("\n")}\n`, "utf8");
		const newest = await manager.readSessionDisplayTurnPage(sessionPath, "viewer", undefined, 25);
		assert.equal(newest.total, 150);
		assert.equal(newest.messages.length, 20);
		assert.equal(newest.messages[0].text, "fixture message 130");
		assert.equal(newest.messages.at(-1).text, "fixture message 149");
		assert.equal(newest.nextBefore, 130);

		const older = await manager.readSessionDisplayTurnPage(sessionPath, "viewer", newest.nextBefore ?? undefined, 25);
		assert.equal(older.messages[0].text, "fixture message 110");
		assert.equal(older.messages.at(-1).text, "fixture message 129");
		assert.equal(older.nextBefore, 110);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("offline Session Viewer keeps whole turns under the unified turn protocol", async () => {
	const { AgentManager } = loadAgentManagerModule();
	const manager = new AgentManager(() => undefined, () => null, { get: () => ({}) }, {});
	const directory = await mkdtemp(join(tmpdir(), "pideck-history-page-turns-"));
	const sessionPath = join(directory, "large-text.jsonl");
	const lines = [JSON.stringify({ id: "session", type: "session" })];
	let parentId = "session";
	for (let index = 0; index < 10; index += 1) {
		const userId = `user-${index}`;
		lines.push(JSON.stringify({
			id: userId,
			parentId,
			type: "message",
			message: { role: "user", content: [{ type: "text", text: "x" }] },
		}));
		parentId = userId;
		const assistantId = `assistant-${index}`;
		lines.push(JSON.stringify({
			id: assistantId,
			parentId,
			type: "message",
			message: { role: "assistant", content: [{ type: "text", text: "x".repeat(100_000) }] },
		}));
		parentId = assistantId;
	}
	try {
		await writeFile(sessionPath, `${lines.join("\n")}\n`, "utf8");
		const page = await manager.readSessionDisplayTurnPage(sessionPath, "viewer", undefined, 100);
		// 2026-09 统一轮次协议：字节预算已删除——单轮再大也整轮保留，
		// 页大小只以轮数计（夹紧到 MAX_TURN_PAGE_SIZE）；大文本轮不能被切成半页。
		assert.equal(page.messages.at(-1).text.length, 100_000);
		assert.equal(page.messages.length, 20, "a large turn must be kept whole, never byte-split");
		assert.equal(page.nextBefore, null, "10 turns fit the page; no older history remains");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
