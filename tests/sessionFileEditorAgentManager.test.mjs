import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const nodeRequire = createRequire(import.meta.url);

function loadAgentManager() {
  const filePath = "src/main/pi/AgentManager.ts";
  const output = ts.transpileModule(readFileSync(filePath, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: filePath,
  }).outputText;
  const module = { exports: {} };
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
  class LatestByKeyEmitter {
    constructor() {}
    cancel() {}
    schedule() {}
    flush() {}
  }
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require: (specifier) => {
      if (specifier === "electron") {
        return {
          app: { getName: () => "PiDeck", getPath: () => "C:/tmp" },
          Notification: { isSupported: () => false },
        };
      }
      if (specifier === "../../shared/ipc") return { ipcChannels: {} };
      if (specifier === "./PiProcess") return { PiProcess: class {} };
      if (specifier === "./bashResult") return { formatBashToolMessage: () => "" };
      if (specifier === "./messageContent") return { extractMessageText: () => "" };
      if (specifier === "./historyMessages") return { mergeHistoryWithPreservedMessages: (messages) => messages };
      if (specifier === "./agentSessionIdentity") return { buildAgentSessionKey: () => undefined };
      if (specifier === "./SessionFileEditor") return { SessionFileEditor: class {} };
      if (specifier === "./SessionHistoryReader") return { SessionHistoryReader: class {} };
      if (specifier === "./AgentMessageProjector") {
        return {
          AgentMessageProjector: class {},
          buildActiveBranchEntryIds: () => [],
        };
      }
      if (specifier === "./sessionEntryIds") {
        return { takeActiveEntryId: (ids, index) => ({ entryId: ids?.[index], nextIndex: index + 1 }) };
      }
      if (specifier === "./agentUtils") {
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
      if (specifier === "./LatestByKeyEmitter") return { LatestByKeyEmitter };
      if (specifier === "./streamGate") return streamGateModule.exports;
      if (specifier === "./cacheHitStats") return cacheHitStatsModule.exports;
      if (specifier === "../../shared/toolRuntimeState") return { updateActiveToolCalls: () => undefined };
      // 25fd516 起 AgentManager 引入内置扩展参数拼接；本测试不涉及扩展加载，透传即可
      if (specifier === "../extensions/builtInExtensions") {
        return { appendBuiltInExtensionArgs: (args) => [...args] };
      }
      if (specifier === "../wsl/WslPaths") {
        return { toWindowsHostPath: (path) => path, toWslLinuxPath: (path) => path };
      }
      return nodeRequire(specifier);
    },
    Date,
    Map,
    Set,
    Promise,
    JSON,
    Error,
    Buffer,
    setTimeout,
    clearTimeout,
    console,
  }, { filename: filePath });
  return module.exports.AgentManager;
}

const AgentManager = loadAgentManager();

function chatMessage(overrides = {}) {
  return {
    id: "agent-1-history-a1",
    agentId: "agent-1",
    role: "assistant",
    text: "answer",
    timestamp: 1,
    meta: { entryId: "a1" },
    ...overrides,
  };
}

function createHarness(editor, options = {}) {
  const commands = [];
  const runtime = {
    tab: {
      id: "agent-1",
      projectId: "project-1",
      cwd: "C:/project",
      title: "Session",
      status: options.status ?? "idle",
      sessionPath: "C:/sessions/session.jsonl",
      sessionEnvironment: "native",
      sessionSource: "pi",
      createdAt: 1,
    },
    process: {
      client: {
        request: async (command) => {
          commands.push(command);
          if (command.type === "get_entries") {
            return { success: true, data: { leafId: options.leafId ?? "a1" } };
          }
          if (command.type === "switch_session") return { success: true };
          return { success: true, data: {} };
        },
      },
    },
  };
  const manager = new AgentManager(
    () => ({ id: "project-1", name: "Project", path: "C:/project" }),
    () => null,
    { get: () => ({}) },
    {},
    undefined,
    undefined,
    editor,
  );
  manager.agents.set("agent-1", runtime);
  manager.messages.set("agent-1", options.messages ?? [chatMessage()]);
  const loads = [];
  manager.loadMessages = async (agentId) => {
    loads.push(agentId);
    return [];
  };
  return { manager, runtime, commands, loads };
}

test("AgentManager validates idle state before invoking SessionFileEditor", async () => {
  let called = false;
  const editor = {
    editMessage: async () => { called = true; },
  };
  const { manager } = createHarness(editor, { status: "running" });
  manager.getRuntimeState = async () => ({ isStreaming: true, isCompacting: false, isExecutingTool: false });
  await assert.rejects(
    manager.editMessage("agent-1", "agent-1-history-a1", "changed"),
    /BUSY_STREAMING/,
  );
  assert.equal(called, false);
});

test("AgentManager passes file, active leaf and legacy identity, then loads messages after success", async () => {
  const order = [];
  let received;
  const editor = {
    editMessage: async (input) => {
      order.push("editor");
      received = input;
      await input.reload();
    },
  };
  const { manager, commands, loads } = createHarness(editor);
  manager.loadMessages = async (agentId) => {
    order.push("load");
    loads.push(agentId);
    return [];
  };
  await manager.editMessage("agent-1", "agent-1-history-a1", "changed");

  assert.deepEqual(order, ["editor", "load"]);
  assert.equal(received.file.hostPath, "C:/sessions/session.jsonl");
  assert.equal(received.file.protocolPath, "C:/sessions/session.jsonl");
  assert.equal(received.target.entryId, "a1");
  assert.equal(received.target.legacyMessageId, "agent-1-history-a1");
  assert.equal(received.target.legacyAgentId, "agent-1");
  assert.equal(received.target.activeLeafId, "a1");
  assert.equal(received.newText, "changed");
  assert.deepEqual(commands.map((command) => command.type), ["get_entries", "switch_session"]);
  assert.deepEqual(loads, ["agent-1"]);
});

test("AgentManager does not load messages or report success after editor failure", async () => {
  const editor = {
    deleteMessage: async () => { throw new Error("editor failed"); },
  };
  const { manager, loads } = createHarness(editor);
  await assert.rejects(
    manager.deleteMessage("agent-1", "agent-1-history-a1"),
    /editor failed/,
  );
  assert.deepEqual(loads, []);
});

test("delete, resend and public reload all route through the injected editor and Pi reload callback", async () => {
  const calls = [];
  const editor = {
    deleteMessage: async (input) => {
      calls.push(["delete", input.target.entryId]);
      await input.reload();
    },
    truncateForResend: async (input) => {
      calls.push(["resend", input.target.entryId]);
      await input.reload();
    },
    reload: async (input) => {
      calls.push(["reload", input.file.protocolPath]);
      await input.reload();
    },
  };
  const user = chatMessage({
    id: "agent-1-history-u1",
    role: "user",
    text: "question",
    meta: { entryId: "u1" },
    images: [{ data: "image", mimeType: "image/png" }],
  });
  const assistant = chatMessage();
  const { manager, commands, loads } = createHarness(editor, {
    messages: [user, assistant],
    leafId: "a1",
  });

  await manager.deleteMessage("agent-1", assistant.id);
  const resend = await manager.prepareResendFromMessage("agent-1", user.id);
  await manager.reload("agent-1");

  assert.deepEqual(calls, [
    ["delete", "a1"],
    ["resend", "u1"],
    ["reload", "C:/sessions/session.jsonl"],
  ]);
  assert.equal(resend.text, "question");
  assert.equal(resend.images.length, 1);
  assert.equal(commands.filter((command) => command.type === "switch_session").length, 3);
  assert.deepEqual(loads, ["agent-1", "agent-1", "agent-1"]);
});
