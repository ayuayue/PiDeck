import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
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
      // 本测试不覆盖会话文件汇总；提供空实现满足 AgentManager 依赖契约
      if (specifier === "../../shared/fileChanges") return { collectLatestTurnFileChanges: () => [] };
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
      if (specifier === "./historyMessages") {
        return {
          mergeHistoryWithPreservedMessages: (messages) => messages,
          // 本测试通过被覆写的 loadMessages / 直接调用 mutate* 路径执行，不触发真实投影稳定化；
          // 提供透传实现避免 harness 加载后调用真实 loadMessages 时崩在未定义的导入。
          stabilizeReloadedMessageIds: (_previous, messages) => messages,
          stabilizeProjectedIdsFromIdentities: (_identities, messages) => messages,
        };
      }
      if (specifier === "./agentSessionIdentity") return { buildAgentSessionKey: () => undefined };
      if (specifier === "./extensionStartupFallback") {
        return {
          formatExtensionFallbackDebug: () => "",
          shouldRetryWithoutExtensions: () => false,
        };
      }
      if (specifier === "./extensionError") {
        return { formatExtensionErrorReason: () => "" };
      }
      if (specifier === "./SessionFileEditor") return { SessionFileEditor: class {} };
      if (specifier === "./stoppedMessageIdentity") return loadTsCommonJs("src/main/pi/stoppedMessageIdentity.ts");
      if (specifier === "./SessionHistoryReader") {
        return {
          SessionHistoryReader: class {
            async getActiveLeafId() {
              return "file-leaf";
            }
            async readMessageByMessageId(_sessionPath, messageId) {
              return {
                entryId: "a1",
                role: "user",
                text: "answer",
                messageId,
              };
            }
          },
        };
      }
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
      // 25fd516 起 AgentManager 引入内置扩展参数拼接；本测试不涉及扩展加载，透传即可
      if (specifier === "../extensions/builtInExtensions") {
        return { appendBuiltInExtensionArgs: (args) => [...args] };
      }
      // 扩展白名单解析器（禁用功能）；本测试不涉及，返回 null（关闭白名单）
      if (specifier === "../extensions/enabledExtensionResolver") {
        return { resolveEnabledExtensionPaths: () => null };
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
      // 技能白名单 resolver：本测试不涉及技能加载，透传空实现即可
      if (specifier === "../skills/piProcessSkillResolvers") {
        return {
          createPiProcessSkillResolvers: () => ({
            resolveEnabledSkillPaths: () => null,
          }),
        };
      }
      // 提示词模板白名单 resolver：本测试不涉及模板加载，透传空实现即可
      if (specifier === "../prompts/piProcessPromptResolvers") {
        return {
          createPiProcessPromptResolvers: () => ({
            resolveEnabledPromptPaths: () => null,
          }),
        };
      }
      if (specifier === "../wsl/WslPaths") {
        return { toWindowsHostPath: (path) => path, toWslLinuxPath: (path) => path };
      }
      // AgentManager 依赖 ./derivedSubagents（纯函数，仅类型 import）；.ts 经 node 类型剥离可 require。
      if (specifier === "./derivedSubagents") {
        return nodeRequire("../src/main/pi/derivedSubagents.ts");
      }
      // sessionFileEditor 测试不覆盖 rewind 业务；保留模块形状以便加载 AgentManager。
      if (specifier === "../rewind/index.ts") {
        return {
          currentIndexTree: async () => "",
          createCheckpoint: async () => undefined,
          diffCheckpoints: async () => "",
          loadAllCheckpoints: async () => [],
          loadCheckpointFromRef: async () => undefined,
          MUTATING_TOOLS: new Set(),
          restoreCheckpoint: async () => undefined,
          toCheckpointSummary: (checkpoint) => checkpoint,
        };
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
const { SessionHistoryReader } = loadTsCommonJs("src/main/pi/SessionHistoryReader.ts");
const { SessionFileEditor } = loadTsCommonJs("src/main/pi/SessionFileEditor.ts");
const { AgentMessageProjector } = loadTsCommonJs("src/main/pi/AgentMessageProjector.ts");

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

test("edit/delete/resend leaf lookup uses the session file, not get_entries", () => {
  const source = readFileSync("src/main/pi/AgentManager.ts", "utf8");
  const start = source.indexOf("private async getActiveSessionLeafId(");
  const end = source.indexOf("private createSessionEntryTarget(");
  assert.ok(start >= 0 && end > start, "getActiveSessionLeafId slice must be non-empty");
  const fn = source.slice(start, end);
  // 历史会话展示与定位必须同口径：JSONL leaf 优先，RPC 只在无文件时兜底。
  assert.match(fn, /sessionHistoryReader\.getActiveLeafId/);
  const rpcIndex = fn.indexOf('type: "get_entries"');
  const fileIndex = fn.indexOf("getActiveLeafId");
  assert.ok(fileIndex >= 0 && rpcIndex > fileIndex, "file leaf must be attempted before get_entries");
});

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
  // 有会话文件时 leaf 必须走 JSONL 索引，禁止 get_entries：RPC leaf 可能不在文件里，
  // 编辑器会报「活动分支已不在文件中」，用户只看到泛化「会话操作失败」。
  assert.equal(received.target.activeLeafId, "file-leaf");
  assert.equal(received.newText, "changed");
  assert.deepEqual(commands.map((command) => command.type), ["switch_session"]);
  assert.equal(commands.some((command) => command.type === "get_entries"), false);
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

test("mutatePersistedSessionMessage writes the file without switch_session when idle", async () => {
  const received = [];
  const editor = {
    editMessage: async (input) => { received.push(["edit", input]); },
    deleteMessage: async (input) => { received.push(["delete", input]); },
    truncateForResend: async (input) => { received.push(["resend", input]); },
  };
  const { manager, commands } = createHarness(editor);
  manager.agents.clear();
  await manager.mutatePersistedSessionMessage(
    "C:/sessions/session.jsonl",
    "agent-1-history-a1",
    "edit",
    { newText: "changed" },
  );
  await manager.mutatePersistedSessionMessage(
    "C:/sessions/session.jsonl",
    "agent-1-history-a1",
    "delete",
  );
  const draft = await manager.mutatePersistedSessionMessage(
    "C:/sessions/session.jsonl",
    "agent-1-history-a1",
    "resend",
  );
  assert.equal(received.length, 3);
  assert.equal(received[0][0], "edit");
  assert.equal(received[0][1].newText, "changed");
  assert.equal(received[0][1].target.entryId, "a1");
  assert.equal(received[0][1].target.activeLeafId, "file-leaf");
  assert.equal(received[1][0], "delete");
  assert.equal(received[2][0], "resend");
  assert.equal(draft.text, "answer");
  assert.equal(commands.filter((command) => command.type === "switch_session").length, 0);
});

/**
 * 真实文件 + 真实 SessionHistoryReader / SessionFileEditor 的 live 消息夹具。
 * 会话文件里已落盘 entry-user，而 runtime 缓存里那条消息仍是 live 身份（随机 UUID、无 entryId）。
 */
async function withLiveMessageSession(run) {
  const directory = await mkdtemp(join(tmpdir(), "pideck-stop-edit-"));
  const sessionPath = join(directory, "session.jsonl");
  const liveMessage = chatMessage({
    id: "live-user-uuid", role: "user", text: "original question", timestamp: 1234, meta: {},
  });
  try {
    await writeFile(sessionPath, [
      { type: "session", id: "session", version: 3 },
      { type: "message", id: "entry-user", parentId: null,
        message: { role: "user", content: [{ type: "text", text: liveMessage.text }], timestamp: 1234 } },
    ].map(JSON.stringify).join("\n") + "\n");
    const { manager, runtime } = createHarness(new SessionFileEditor(), { messages: [liveMessage] });
    runtime.tab.sessionPath = sessionPath;
    runtime.process.stop = () => {};
    const projector = new AgentMessageProjector({ translate: (key) => key, isAskAborted: () => false });
    manager.sessionHistoryReader = new SessionHistoryReader({
      toHostPath: (path) => path,
      convertMessages: (...args) => projector.convert(...args),
      trimMessages: (messages) => messages,
      translate: (key) => key,
    });
    await run({ manager, runtime, sessionPath, liveMessage });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** 重放编辑确认框捕获 live ID → 停止 runtime → catalog 改文件，文件读写均使用真实实现。 */
async function withStoppedLiveMessage(operation) {
  await withLiveMessageSession(async ({ manager, sessionPath, liveMessage }) => {
    await manager.stop("agent-1");
    await operation(manager, sessionPath, liveMessage);
  });
}

test("editing a live message after stopping resolves its persisted entry without restarting", async () => {
  await withStoppedLiveMessage(async (manager, sessionPath, message) => {
    await manager.mutatePersistedSessionMessage(sessionPath, message.id, "edit", { newText: "edited question" });
    const reader = manager.sessionHistoryReader;
    const located = await reader.readMessageByMessageId(sessionPath, "entry-user");
    assert.equal(located.text, "edited question");
  });
});

test("a persisted entry hint makes the same stopped live message editable", async () => {
  await withStoppedLiveMessage(async (manager, sessionPath, message) => {
    await manager.mutatePersistedSessionMessage(sessionPath, message.id, "edit", {
      entryId: "entry-user", newText: "edited with entry anchor",
    });
    assert.equal((await manager.sessionHistoryReader.readMessageByMessageId(sessionPath, "entry-user")).text,
      "edited with entry anchor");
  });
});

test("resending a live message after stopping returns the persisted prompt without restarting", async () => {
  await withStoppedLiveMessage(async (manager, sessionPath, message) => {
    const result = await manager.mutatePersistedSessionMessage(sessionPath, message.id, "resend");
    assert.equal(result.text, "original question");
    const content = await readFile(sessionPath, "utf8");
    // tombstone 必须保留 id（pi SessionManager._buildIndex 以最后一条带 id 的记录为叶）；
    // resend 把原根转标成 type:deleted + reason:resend-truncate，而不是从文件里擦掉 id。
    assert.match(content, /"type":"deleted"/);
    assert.match(content, /"reason":"resend-truncate"/);
    assert.match(content, /"id":"entry-user"/);
  });
});

/**
 * 2026-09 用户反馈（开启代理 → 重启会话 → 重发报「消息未找到」）：
 * restart 与 stop 一样会释放 runtime 消息缓存，但旧实现只在 stop 留存身份摘要，
 * 且 capture 是覆盖式写入 —— UI 手中的 live ID 被「新 runtime 的身份」挤掉后，
 * 主进程只剩「按 ID 找文件条目」一条路，live 随机 ID 在 JSONL 里必然落空。
 */
test("restart releases the runtime cache but keeps live identities resolvable", async () => {
  await withLiveMessageSession(async ({ manager, runtime, sessionPath, liveMessage }) => {
    // 真实 create（spawn + 握手）超出本测试范围，用替身承接「同一会话文件的新 runtime」
    manager.create = async () => ({ ...runtime.tab, id: "agent-2", status: "idle" });
    await manager.restart("agent-1");

    // 重启后新 runtime 从文件投影出带 entryId 的消息，但渲染层窗口未重下发，
    // UI 仍持有 live id；重发前渲染层会先停 Agent，于是新身份再次 capture。
    manager.agents.set("agent-2", { ...runtime, tab: { ...runtime.tab, id: "agent-2" } });
    manager.messages.set("agent-2", [chatMessage({
      id: "agent-2-history-entry-user", role: "user",
      text: liveMessage.text, timestamp: liveMessage.timestamp,
      meta: { entryId: "entry-user" },
    })]);
    await manager.stop("agent-2");

    const result = await manager.mutatePersistedSessionMessage(sessionPath, liveMessage.id, "resend");
    assert.equal(result.text, "original question", "重启前的 live id 必须仍能落到文件条目");
  });
});

test("identity cache merges repeated captures for the same session and stays bounded", () => {
  const { StoppedMessageIdentityCache } = loadTsCommonJs("src/main/pi/stoppedMessageIdentity.ts");
  const cache = new StoppedMessageIdentityCache();
  const session = "C:/sessions/session.jsonl";
  cache.capture(session, [
    chatMessage({ id: "live-1", role: "user", text: "q", timestamp: 1, meta: {} }),
  ]);
  cache.capture(session, [
    chatMessage({ id: "agent-2-history-e1", role: "user", text: "q", timestamp: 1, meta: { entryId: "e1" } }),
  ]);
  // 覆盖式写入会把 live-1 挤掉，导致重启后按 live id 定位落空
  assert.ok(cache.get(session, "live-1"), "重启前留存的 live 身份必须仍在");
  assert.equal(cache.get(session, "agent-2-history-e1").entryId, "e1", "新身份照常写入");

  // 容量上限：超限淘汰最早插入者，最近的仍可定位
  cache.capture(session, Array.from({ length: 300 }, (_, index) => chatMessage({
    id: `m-${index}`, role: "user", text: `t${index}`, timestamp: index, meta: {},
  })));
  assert.equal(cache.get(session, "m-299").timestamp, 299);
  assert.equal(cache.get(session, "m-0"), undefined, "超出上限的旧身份应被淘汰");
});

test("mutatePersistedSessionMessage refuses a live runtime", async () => {
  let called = false;
  const editor = {
    editMessage: async () => { called = true; },
  };
  const { manager } = createHarness(editor, { status: "idle" });
  await assert.rejects(
    manager.mutatePersistedSessionMessage(
      "C:/sessions/session.jsonl",
      "agent-1-history-a1",
      "edit",
      { newText: "changed" },
    ),
    /BUSY_GENERIC/,
  );
  assert.equal(called, false);
});

test("mutatePersistedSessionMessage delete accepts a message absent from the file (unpersisted turn)", async () => {
  // 发送中/刚结束即中断后删除：渲染层先停 agent，stop 已清空内存缓存，文件定位又找不到
  // 该消息（JSONL 尚未落盘）。删除目标是让消息从会话消失——文件里本来就没有，应返回
  // 成功而非 MESSAGE_NOT_FOUND（对应活 runtime 路径 removeUnpersistedRuntimeTurn 的语义）。
  const editor = {
    editMessage: async () => {},
    deleteMessage: async () => {},
    truncateForResend: async () => {},
  };
  const { manager } = createHarness(editor);
  manager.agents.clear();
  manager.sessionHistoryReader.readMessageByMessageId = async () => undefined;

  const deleted = await manager.mutatePersistedSessionMessage(
    "C:/sessions/session.jsonl",
    "agent-1-history-missing",
    "delete",
  );
  assert.equal(deleted, undefined);

  // edit/resend 依赖文件正文，对象缺失必须保留报错（错误映射层会提示 MESSAGE_NOT_FOUND）
  await assert.rejects(
    manager.mutatePersistedSessionMessage(
      "C:/sessions/session.jsonl",
      "agent-1-history-missing",
      "edit",
      { newText: "changed" },
    ),
    /Message not found/,
  );
  await assert.rejects(
    manager.mutatePersistedSessionMessage(
      "C:/sessions/session.jsonl",
      "agent-1-history-missing",
      "resend",
    ),
    /Message not found/,
  );
});
