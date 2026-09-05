import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const nodeRequire = createRequire(import.meta.url);

function compileModule(filePath, imports = {}) {
  const source = readFileSync(filePath, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filePath,
  }).outputText;
  const module = { exports: {} };
  const localRequire = (specifier) => imports[specifier] ?? nodeRequire(specifier);
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require: localRequire,
    console,
    setTimeout,
    clearTimeout,
  }, { filename: filePath });
  return module.exports;
}

function loadCoordinator() {
  const identity = compileModule("src/shared/sessionIdentity.ts");
  return compileModule("src/main/sessions/SessionRuntimeCoordinator.ts", {
    "../../shared/sessionIdentity": identity,
    // rewind 校验纯函数在 Coordinator 里运行时 import（isRewindCheckpointId/isRewindRestoreScope）；
    // 本测试不触发 rewind 方法，空桩满足加载契约。
    "../../shared/types": {},
  });
}

test("runtime and catalog message mutations keep gateway this when calling optional methods", () => {
  const source = readFileSync("src/main/sessions/SessionRuntimeCoordinator.ts", "utf8");
  assert.doesNotMatch(
    source,
    /const (?:editMessage|deleteMessage|exportHtml|getCommands|setPermission|mutate) = this\.agents\./,
  );
  assert.match(source, /typeof this\.agents\.editMessage !== "function"/);
  assert.match(source, /typeof this\.agents\.mutatePersistedSessionMessage !== "function"/);
});

test("session performance instrumentation keeps activation and dispatch phase markers", () => {
  const source = readFileSync("src/main/sessions/SessionRuntimeCoordinator.ts", "utf8");
  assert.match(source, /Prompt pipeline started/);
  assert.match(source, /Runtime activation started/);
  assert.match(source, /Runtime activation completed/);
  assert.match(source, /Prompt dispatch started/);
  assert.match(source, /Prompt dispatch completed/);
  assert.match(source, /activationMs/);
  assert.match(source, /dispatchMs/);
});

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function catalogEntry(overrides = {}) {
  return {
    id: "session-1",
    projectId: "project-1",
    title: "Session 1",
    source: "pi",
    environment: "native",
    status: "draft",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function createHarness(options = {}) {
  const entry = catalogEntry(options.entry);
  const calls = {
    create: 0,
    /** agents.create 收到的入参列表（断言会话身份/sessionPath 透传用） */
    createInputs: [],
    restart: 0,
    stop: 0,
	abort: 0,
	compact: 0,
	runtimeState: 0,
	commands: 0,
	messages: 0,
	exportHtml: 0,
	editMessage: 0,
	deleteMessage: 0,
	prepareResend: 0,
	mutatePersisted: [],
    setModel: 0,
    setModelArgs: [],
    setThinking: 0,
    setPermission: 0,
    publishRuntimeState: 0,
	update: 0,
    attach: 0,
    send: 0,
    uiResponse: 0,
  };
  const tabs = options.tabs ? [...options.tabs] : [];
  const catalog = {
    get: (sessionId) => sessionId === entry.id ? { ...entry } : undefined,
    getRecord: (sessionId) => sessionId === entry.id ? {
      ...entry,
      preview: "",
      messageCount: 0,
    } : undefined,
    update: async (_sessionId, patch) => {
      calls.update += 1;
      Object.assign(entry, patch);
      return { ...entry };
    },
    attachRuntime: async (input) => {
      calls.attach += 1;
      entry.filePath = input.filePath;
      entry.status = input.filePath ? "active" : entry.status;
    },
  };
  const agents = {
    backend: "pi",
    list: () => tabs,
	getMessages: (agentId) => {
	  calls.messages += 1;
	  if (options.getMessages) return options.getMessages(agentId);
	  return [{ id: "message-1", role: "assistant", text: agentId, timestamp: 1 }];
	},
    create: async (input) => {
      calls.create += 1;
      calls.createInputs.push(input);
      if (options.createHold) await options.createHold.promise;
      if (options.createDelay) {
        await new Promise((resolve) => setTimeout(resolve, options.createDelay));
      }
      const tab = options.createdTab ?? {
        id: "agent-1",
        projectId: input.projectId,
        cwd: "C:/project",
        title: input.title ?? "Session 1",
        status: "idle",
        sessionId: "pi-session-1",
        sessionPath: input.sessionPath ?? "C:/sessions/session-1.jsonl",
        sessionEnvironment: input.environment,
        sessionSource: input.source,
        wslDistro: input.wslDistro,
        wslUser: input.wslUser,
        importedSourceId: input.importedSourceId,
        createdAt: 1,
      };
      tabs.push(tab);
      return tab;
    },
    restart: async (agentId) => {
      calls.restart += 1;
      const index = tabs.findIndex((tab) => tab.id === agentId);
      const previous = index >= 0 ? tabs.splice(index, 1)[0] : undefined;
      const tab = options.restartedTab ?? {
        ...previous,
        id: "agent-restarted",
        status: "idle",
        createdAt: 2,
      };
      tabs.push(tab);
      return tab;
    },
    stop: async (agentId) => {
      calls.stop += 1;
      if (options.stopDelay) await options.stopDelay;
      const index = tabs.findIndex((tab) => tab.id === agentId);
      if (index >= 0) tabs.splice(index, 1);
    },
    abort: async () => {
      calls.abort += 1;
      if (options.abortError) throw new Error(options.abortError);
    },
    compact: async () => {
      calls.compact += 1;
      return options.runtimeState ?? { isStreaming: false };
    },
    getRuntimeState: async () => {
      calls.runtimeState += 1;
      return options.runtimeState ?? { isStreaming: false };
    },
    // 这些方法读 this：Coordinator 若抽成 const fn = this.agents.fn 再调用，
    // 会复现 CompositeAgentGateway 的 resolveBackend 崩溃。
    async getCommands() {
      if (!this?.backend) throw new Error("Cannot read properties of undefined (reading 'resolveBackend')");
      calls.commands += 1;
      return options.commands ?? [{ name: "compact" }];
    },
    async exportHtml() {
      if (!this?.backend) throw new Error("Cannot read properties of undefined (reading 'resolveBackend')");
      calls.exportHtml += 1;
      return { path: "C:/export.html" };
    },
    async editMessage() {
      if (!this?.backend) throw new Error("Cannot read properties of undefined (reading 'resolveBackend')");
      calls.editMessage += 1;
    },
    async deleteMessage() {
      if (!this?.backend) throw new Error("Cannot read properties of undefined (reading 'resolveBackend')");
      calls.deleteMessage += 1;
    },
    prepareResendFromMessage: async () => {
      calls.prepareResend += 1;
      return { text: "hello" };
    },
    async mutatePersistedSessionMessage(sessionPath, messageId, operation, extra) {
      if (!this?.backend) throw new Error("Cannot read properties of undefined (reading 'resolveBackend')");
      calls.mutatePersisted.push({ sessionPath, messageId, operation, extra });
      if (operation === "resend") return { text: "hello" };
      return undefined;
    },
    setModel: async (_agentId, provider, modelId) => {
      calls.setModel += 1;
      calls.setModelArgs.push({ provider, modelId });
      if (options.modelError) throw new Error(options.modelError);
    },
    setThinking: async () => {
      calls.setThinking += 1;
    },
    async setPermission(_agentId, _preset) {
      if (!this?.backend) throw new Error("Cannot read properties of undefined (reading 'resolveBackend')");
      calls.setPermission += 1;
      if (options.permissionError) throw new Error(options.permissionError);
    },
    publishRuntimeState: async () => {
      calls.publishRuntimeState += 1;
    },
    sendUIResponse: async () => {
      calls.uiResponse += 1;
    },
    notifyAskPending: () => {
      calls.askNotify += 1;
    },
  };
  const sender = async (input) => {
    calls.send += 1;
    if (options.sender) return options.sender(input);
    return options.sendResult ?? { accepted: true };
  };
  return { entry, calls, tabs, catalog, agents, sender };
}

function prompt(overrides = {}) {
  return {
    sessionId: "session-1",
    requestId: "request-1",
    message: "hello",
    ...overrides,
  };
}

test("rejects an empty prompt before activating a runtime", async () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const harness = createHarness();
  const coordinator = new SessionRuntimeCoordinator(
    harness.catalog,
    harness.agents,
    harness.sender,
  );
  const result = await coordinator.send(prompt({ message: "   " }));
  assert.equal(result.accepted, false);
  assert.equal(result.delivery, "rejected");
  assert.equal(harness.calls.create, 0);
  assert.equal(harness.calls.send, 0);
});

test("session security override key = catalog session id, distinct from sessionPath", async () => {
	// 回归：UI 保存安全等级覆盖用 SessionRecord.id（UUID），主进程必须注入同一个 key
	// 给 PIDECK_SESSION_ID，否则安全门扩展在 sessionLevels 里永远查不到覆盖，回落全局默认。
	const { SessionRuntimeCoordinator } = loadCoordinator();
	const sessionId = "e5a4ef67-2c16-4ddc-ac03-d2e105182645";
	const filePath = "C:\\Users\\14012\\.pi\\agent\\sessions\\2026-08-11T13-33-50-880Z_019ff107-89a0-7947-9001-c3fc25237198.jsonl";
	const harness = createHarness({ entry: { id: sessionId, filePath } });
	const coordinator = new SessionRuntimeCoordinator(
		harness.catalog,
		harness.agents,
		harness.sender,
	);

	const result = await coordinator.activateRuntime(sessionId);

	assert.equal(result.ok, true);
	assert.equal(harness.calls.create, 1);
	const createInput = harness.calls.createInputs[0];
	// deckSessionId 必须等于 catalog 会话身份（UI 保存覆盖用的 key），而非文件路径。
	assert.equal(createInput.deckSessionId, sessionId);
	assert.equal(createInput.sessionPath, filePath);
	assert.notEqual(createInput.deckSessionId, createInput.sessionPath);
});

test("explicit activation creates a runtime that is bound to the requested Session", async () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const harness = createHarness();
  const coordinator = new SessionRuntimeCoordinator(
    harness.catalog,
    harness.agents,
    harness.sender,
  );

  const result = await coordinator.activateRuntime("session-1");

  assert.equal(result.ok, true);
  assert.equal(result.value.sessionId, "session-1");
  assert.equal(result.value.agentId, "agent-1");
  assert.equal(result.value.runtimeGeneration, 1);
  assert.equal(harness.calls.create, 1);
  assert.equal(harness.calls.send, 0);
});

test("reports a draft activation before its runtime binding completes", async () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const harness = createHarness({ createDelay: 20 });
  const coordinator = new SessionRuntimeCoordinator(
    harness.catalog,
    harness.agents,
    harness.sender,
  );

  const activation = coordinator.activateRuntime("session-1");
  assert.equal(coordinator.isActivating("session-1"), true);
  await activation;
  assert.equal(coordinator.isActivating("session-1"), false);
});

test("deduplicates concurrent retries by session ID and request ID", async () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const harness = createHarness({ createDelay: 20 });
  const coordinator = new SessionRuntimeCoordinator(
    harness.catalog,
    harness.agents,
    harness.sender,
  );
  const [first, second] = await Promise.all([
    coordinator.send(prompt()),
    coordinator.send(prompt()),
  ]);
  assert.equal(first.accepted, true);
  assert.equal(second.accepted, true);
  assert.equal(first.agentId, "agent-1");
  assert.equal(harness.calls.create, 1);
  assert.equal(harness.calls.send, 1);
  assert.equal(harness.calls.attach, 2);
});

test("serializes activation but delivers distinct requests once each", async () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const harness = createHarness({
    createDelay: 20,
    entry: {
      model: { provider: "openai", modelId: "gpt-test" },
      thinkingLevel: "high",
    },
  });
  const coordinator = new SessionRuntimeCoordinator(
    harness.catalog,
    harness.agents,
    harness.sender,
  );
  const [first, second] = await Promise.all([
    coordinator.send(prompt({ requestId: "request-1" })),
    coordinator.send(prompt({ requestId: "request-2" })),
  ]);
  assert.equal(first.accepted, true);
  assert.equal(second.accepted, true);
  assert.equal(harness.calls.create, 1);
  assert.equal(harness.calls.setModel, 1);
  assert.equal(harness.calls.setThinking, 1);
  assert.equal(harness.calls.send, 2);
});

test("dispatch lease blocks restart, direct bind, and catalog scan until send settles", async () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const started = deferred();
  const release = deferred();
  const harness = createHarness({
    entry: { status: "active", filePath: "C:/sessions/session-1.jsonl" },
    tabs: [{
      id: "agent-1",
      projectId: "project-1",
      cwd: "C:/project",
      title: "Session 1",
      status: "idle",
      sessionPath: "C:/sessions/session-1.jsonl",
      sessionEnvironment: "native",
      sessionSource: "pi",
      createdAt: 1,
    }, {
      id: "agent-2",
      projectId: "project-1",
      cwd: "C:/project",
      title: "Session 1 duplicate",
      status: "idle",
      sessionPath: "C:/sessions/session-1.jsonl",
      sessionEnvironment: "native",
      sessionSource: "pi",
      createdAt: 2,
    }],
    sender: async () => {
      started.resolve();
      await release.promise;
      return { accepted: true };
    },
  });
  const coordinator = new SessionRuntimeCoordinator(harness.catalog, harness.agents, harness.sender);
  coordinator.bindExistingAgent("session-1", "agent-1");

  const sending = coordinator.send(prompt());
  await started.promise;
  assert.throws(
    () => coordinator.bindExistingAgent("session-1", "agent-2"),
    /prompt dispatch is in progress/,
  );
  await assert.rejects(
    coordinator.restartSession("session-1", "agent-1"),
    /prompt dispatch is in progress/,
  );
  assert.equal(coordinator.attachCatalogRuntimes([{
    ...catalogEntry({ status: "active", filePath: "C:/sessions/session-1.jsonl" }),
    preview: "",
    messageCount: 0,
  }]).length, 0);
  assert.equal(harness.calls.restart, 0);

  release.resolve();
  const result = await sending;
  assert.equal(result.accepted, true);
  const restarted = await coordinator.restartSession("session-1", "agent-1");
  assert.equal(restarted.id, "agent-restarted");
  assert.equal(harness.calls.restart, 1);
});

test("dispatch lease is released when sender throws", async () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const started = deferred();
  const release = deferred();
  const harness = createHarness({
    sender: async () => {
      started.resolve();
      await release.promise;
      throw new Error("transport uncertain");
    },
  });
  const coordinator = new SessionRuntimeCoordinator(harness.catalog, harness.agents, harness.sender);
  const sending = coordinator.send(prompt());
  await started.promise;
  assert.throws(
    () => coordinator.bindExistingAgent("session-1", "agent-1"),
    /prompt dispatch is in progress/,
  );
  release.resolve();
  const result = await sending;
  assert.equal(result.accepted, false);
  assert.equal(result.delivery, "unknown");
  assert.equal(result.agentId, "agent-1");
  assert.doesNotThrow(() => coordinator.bindExistingAgent("session-1", "agent-1"));
});

test("stale send result fails closed without exposing a runtime handle", async () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const started = deferred();
  const release = deferred();
  const harness = createHarness({
    sender: async () => {
      started.resolve();
      await release.promise;
      return { accepted: true };
    },
  });
  const coordinator = new SessionRuntimeCoordinator(harness.catalog, harness.agents, harness.sender);
  const sending = coordinator.send(prompt());
  await started.promise;

  coordinator.agentIdBySession.set("session-1", "agent-stale");
  coordinator.sessionIdByAgent.delete("agent-1");
  coordinator.generationBySession.set("session-1", 2);
  release.resolve();

  const result = await sending;
  assert.equal(result.accepted, false);
  assert.equal(result.delivery, "unknown");
  assert.equal(result.agentId, undefined);
  assert.equal(result.runtimeGeneration, undefined);
  assert.equal(result.sessionPath, undefined);
  coordinator.agentIdBySession.delete("session-1");
  assert.doesNotThrow(() => coordinator.bindExistingAgent("session-1", "agent-1"));
});

test("reuses an already-running historical session by canonical path", async () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const harness = createHarness({
    entry: {
      status: "active",
      filePath: "C:\\Sessions\\History.jsonl",
      model: { provider: "anthropic", modelId: "claude-test" },
    },
    tabs: [{
      id: "agent-history",
      projectId: "project-1",
      cwd: "C:/project",
      title: "History",
      status: "idle",
      sessionId: "pi-history",
      sessionPath: "c:/sessions/history.jsonl",
      createdAt: 1,
    }],
  });
  const coordinator = new SessionRuntimeCoordinator(
    harness.catalog,
    harness.agents,
    harness.sender,
  );
  const result = await coordinator.send(prompt());
  assert.equal(result.accepted, true);
  assert.equal(result.agentId, "agent-history");
  assert.equal(harness.calls.create, 0);
  assert.equal(harness.calls.setModel, 1);
  assert.equal(harness.calls.send, 1);
});

test("keeps a draft unbound when Agent startup fails", async () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const harness = createHarness({
    getMessages: () => [{
      id: "startup-error",
      agentId: "agent-error",
      role: "error",
      text: "Agent 运行时发生错误。",
      meta: { debugDetails: "pi --mode rpc failed: executable not found" },
      timestamp: 1,
    }],
    createdTab: {
      id: "agent-error",
      projectId: "project-1",
      cwd: "C:/project",
      title: "Session 1",
      status: "error",
      createdAt: 1,
    },
  });
  const coordinator = new SessionRuntimeCoordinator(
    harness.catalog,
    harness.agents,
    harness.sender,
  );
  const result = await coordinator.send(prompt());
  assert.equal(result.accepted, false);
  assert.equal(result.delivery, "rejected");
  assert.match(result.error, /pi --mode rpc failed: executable not found/);
  assert.equal(harness.entry.status, "draft");
  assert.equal(harness.calls.attach, 0);
  assert.equal(harness.calls.send, 0);
  assert.equal(harness.calls.stop, 1);
});

test("moves the Session binding when a runtime is restarted", () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const harness = createHarness({
    tabs: [{ id: "agent-new", status: "idle", createdAt: 2 }],
  });
  const coordinator = new SessionRuntimeCoordinator(
    harness.catalog,
    harness.agents,
    harness.sender,
  );
  coordinator.bindExistingAgent("session-1", "agent-old");
  coordinator.bindExistingAgent("session-1", "agent-new");
  assert.equal(coordinator.getSessionId("agent-old"), undefined);
  assert.equal(coordinator.getSessionId("agent-new"), "session-1");
  assert.equal(coordinator.getAgentId("session-1"), "agent-new");
});

test("restart reapplies catalog preferences before binding a new generation", async () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const harness = createHarness({
    entry: {
      status: "active",
      filePath: "C:/sessions/session-1.jsonl",
      model: { provider: "openai", modelId: "gpt-test" },
      thinkingLevel: "high",
    },
    tabs: [{
      id: "agent-old",
      projectId: "project-1",
      cwd: "C:/project",
      title: "Session 1",
      status: "idle",
      sessionPath: "C:/sessions/session-1.jsonl",
      sessionEnvironment: "native",
      sessionSource: "pi",
      createdAt: 1,
    }],
  });
  const coordinator = new SessionRuntimeCoordinator(
    harness.catalog,
    harness.agents,
    harness.sender,
  );
  const firstGeneration = coordinator.bindExistingAgent("session-1", "agent-old");
  const restarted = await coordinator.restartSession("session-1", "agent-old");

  assert.equal(firstGeneration, 1);
  assert.equal(restarted.id, "agent-restarted");
  assert.equal(restarted.runtimeGeneration, 2);
  assert.equal(harness.calls.restart, 1);
  assert.equal(harness.calls.setModel, 1);
  assert.equal(harness.calls.setThinking, 1);
  assert.equal(harness.calls.attach, 1);
  assert.equal(harness.calls.publishRuntimeState, 1);
  assert.equal(coordinator.getSessionId("agent-old"), undefined);
  assert.deepEqual(
    { ...coordinator.getRuntimeBinding("agent-restarted") },
    { sessionId: "session-1", runtimeGeneration: 2 },
  );
});

test("restart of a terminal (error) agent recovers a fresh runtime instead of rejecting", async () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  // 服务商不可用 → 发送失败 → Agent 进入 error 态（仍在 agent 列表与绑定表中）；
  // 此时用户点重启不应被「会话运行实例已发生变化」误拒。
  const harness = createHarness({
    entry: { status: "active", filePath: "C:/sessions/session-1.jsonl" },
    tabs: [{
      id: "agent-error",
      projectId: "project-1",
      cwd: "C:/project",
      title: "Session 1",
      status: "error",
      sessionPath: "C:/sessions/session-1.jsonl",
      sessionEnvironment: "native",
      sessionSource: "pi",
      createdAt: 1,
    }],
  });
  const coordinator = new SessionRuntimeCoordinator(
    harness.catalog,
    harness.agents,
    harness.sender,
  );
  const generation = coordinator.bindExistingAgent("session-1", "agent-error");

  const restarted = await coordinator.restartRuntime({
    sessionId: "session-1",
    agentId: "agent-error",
    runtimeGeneration: generation,
  });

  assert.equal(restarted.ok, true);
  assert.equal(restarted.value.runtime.agentId, "agent-restarted");
  assert.equal(harness.calls.restart, 1);
  assert.equal(coordinator.getSessionId("agent-error"), undefined);
  assert.equal(coordinator.getSessionId("agent-restarted"), "session-1");
});

test("lazy activation publishes runtime state after binding", async () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const harness = createHarness({
    entry: {
      model: { provider: "openai", modelId: "gpt-test" },
      thinkingLevel: "high",
    },
  });
  const coordinator = new SessionRuntimeCoordinator(
    harness.catalog,
    harness.agents,
    harness.sender,
  );
  const result = await coordinator.send(prompt());
  assert.equal(result.accepted, true);
  // 懒启动链路：create → waitUntilReady → applyPreferences(setModel/setThinking) →
  // bind → publishRuntimeState。推送必须发生在 bind 之后，否则 emitSessionRuntimeEvent
  // 因无 binding 直接丢弃，渲染层底栏永远看不到应用后的真实模型。
  assert.equal(harness.calls.create, 1);
  assert.equal(harness.calls.setModel, 1);
  assert.equal(harness.calls.setThinking, 1);
  // attach 有两次（activate 内 + dispatch 成功后），这里只断言本测试关注的行为
  assert.equal(harness.calls.publishRuntimeState, 1);
});

// 用户在 Agent 未启动时改模型：输入会预热 activateRuntime，catalog.update 可能发生在
// activate() 已 snapshot 旧 entry 之后。套模型必须再读一次 catalog，否则发送仍走旧模型。
test("applies the latest catalog model when the user changes it during activation", async () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const createHold = deferred();
  const harness = createHarness({
    entry: { model: { provider: "openai", modelId: "old-model" } },
    createHold,
  });
  const coordinator = new SessionRuntimeCoordinator(
    harness.catalog,
    harness.agents,
    harness.sender,
  );

  const activating = coordinator.activateRuntime("session-1");
  await new Promise((resolve) => setTimeout(resolve, 5));
  await harness.catalog.update("session-1", {
    model: { provider: "anthropic", modelId: "new-model" },
  });
  createHold.resolve();
  const result = await activating;

  assert.equal(result.ok, true);
  assert.equal(harness.calls.setModel, 1);
  assert.deepEqual(harness.calls.setModelArgs[0], {
    provider: "anthropic",
    modelId: "new-model",
  });
});

// 预热已把 Agent 绑上后，用户再改 catalog 模型然后发送：activate 对已绑定 runtime 直接
// 返回，必须在发送前再套一次最新偏好，否则本轮仍用预热时的旧模型。
test("send applies a catalog model change made after the runtime is already bound", async () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const harness = createHarness({
    entry: { model: { provider: "openai", modelId: "old-model" } },
  });
  const coordinator = new SessionRuntimeCoordinator(
    harness.catalog,
    harness.agents,
    harness.sender,
  );

  const activated = await coordinator.activateRuntime("session-1");
  assert.equal(activated.ok, true);
  assert.deepEqual(harness.calls.setModelArgs[0], {
    provider: "openai",
    modelId: "old-model",
  });

  await harness.catalog.update("session-1", {
    model: { provider: "anthropic", modelId: "new-model" },
  });
  const sent = await coordinator.send(prompt());

  assert.equal(sent.accepted, true);
  assert.equal(harness.calls.create, 1);
  assert.equal(harness.calls.setModel, 2);
  assert.deepEqual(harness.calls.setModelArgs[1], {
    provider: "anthropic",
    modelId: "new-model",
  });
});

test("does not send or bind a new runtime when model setup fails", async () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const harness = createHarness({
    entry: { model: { provider: "bad", modelId: "missing" } },
    modelError: "model unavailable",
  });
  const coordinator = new SessionRuntimeCoordinator(
    harness.catalog,
    harness.agents,
    harness.sender,
  );
  const result = await coordinator.send(prompt());
  assert.equal(result.accepted, false);
  assert.equal(result.delivery, "rejected");
  assert.match(result.error, /model unavailable/);
  assert.equal(harness.entry.status, "draft");
  assert.equal(harness.calls.attach, 0);
  assert.equal(harness.calls.send, 0);
  assert.equal(harness.calls.stop, 1);
});

test("attaches catalog runtimes by full origin identity", () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const harness = createHarness({
    tabs: [{
      id: "agent-existing",
      projectId: "project-1",
      cwd: "/workspace",
      title: "Existing",
      status: "idle",
      sessionPath: "/home/dev/session.jsonl",
      sessionEnvironment: "wsl",
      sessionSource: "pi",
      wslDistro: "Ubuntu",
      wslUser: "dev",
      createdAt: 1,
    }],
  });
  const coordinator = new SessionRuntimeCoordinator(
    harness.catalog,
    harness.agents,
    harness.sender,
  );
  const bindings = coordinator.attachCatalogRuntimes([{
    ...catalogEntry({
      environment: "wsl",
      filePath: "/home/dev/session.jsonl",
      wslDistro: "Ubuntu",
      wslUser: "dev",
      status: "active",
    }),
    preview: "",
    messageCount: 0,
  }]);

  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].agentId, "agent-existing");
  assert.deepEqual(
    { ...coordinator.getRuntimeBinding("agent-existing") },
    { sessionId: "session-1", runtimeGeneration: 1 },
  );
});

test("Session UI response requires the current binding, generation, and pending request", async () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const harness = createHarness({
    tabs: [{ id: "agent-a", status: "idle", createdAt: 1 }],
  });
  const coordinator = new SessionRuntimeCoordinator(
    harness.catalog,
    harness.agents,
    harness.sender,
  );
  const generation = coordinator.bindExistingAgent("session-1", "agent-a");
  coordinator.observeRuntimeEvent({
    sessionId: "session-1",
    agentId: "agent-a",
    runtimeGeneration: generation,
    sourceChannel: "agents:ui-request",
    payload: {
      agentId: "agent-a",
      requestId: "request-ui",
      method: "confirm",
      title: "Continue?",
    },
  });
  const pending = coordinator.listPendingUiRequests("session-1");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].title, "Continue?");
  assert.equal(pending[0].method, "confirm");

  await assert.rejects(
    coordinator.respondToUi({
      sessionId: "session-1",
      requestId: "request-ui",
      agentId: "agent-a",
      runtimeGeneration: generation - 1,
      response: { confirmed: true },
    }),
    /runtime binding changed/i,
  );
  await coordinator.respondToUi({
    sessionId: "session-1",
    requestId: "request-ui",
    agentId: "agent-a",
    runtimeGeneration: generation,
    response: { confirmed: true },
  });
  await assert.rejects(
    coordinator.respondToUi({
      sessionId: "session-1",
      requestId: "request-ui",
      agentId: "agent-a",
      runtimeGeneration: generation,
      response: { confirmed: true },
    }),
    /not pending/i,
  );
  assert.equal(harness.calls.uiResponse, 1);
});

test("error runtime keeps its binding until the pending Session UI request is answered", async () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const harness = createHarness({
    tabs: [{ id: "agent-a", status: "idle", createdAt: 1 }],
  });
  const coordinator = new SessionRuntimeCoordinator(
    harness.catalog,
    harness.agents,
    harness.sender,
  );
  const runtimeGeneration = coordinator.bindExistingAgent("session-1", "agent-a");
  coordinator.observeRuntimeEvent({
    sessionId: "session-1",
    agentId: "agent-a",
    runtimeGeneration,
    sourceChannel: "agents:ui-request",
    payload: {
      agentId: "agent-a",
      requestId: "request-ui",
      method: "confirm",
      title: "Continue?",
    },
  });
  harness.tabs[0].status = "error";

  assert.deepEqual(JSON.parse(JSON.stringify(coordinator.getTarget("session-1"))), {
    sessionId: "session-1",
    agentId: "agent-a",
    runtimeGeneration,
  });
  await coordinator.respondToUi({
    sessionId: "session-1",
    requestId: "request-ui",
    agentId: "agent-a",
    runtimeGeneration,
    response: { confirmed: true },
  });

  assert.equal(harness.calls.uiResponse, 1);
  assert.equal(coordinator.getTarget("session-1"), undefined);
});

test("batch Ask Question is accepted by the Session UI response gate", async () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const harness = createHarness({
    tabs: [{ id: "agent-a", status: "idle", createdAt: 1 }],
  });
  const coordinator = new SessionRuntimeCoordinator(
    harness.catalog,
    harness.agents,
    harness.sender,
  );
  const generation = coordinator.bindExistingAgent("session-1", "agent-a");
  coordinator.observeRuntimeEvent({
    sessionId: "session-1",
    agentId: "agent-a",
    runtimeGeneration: generation,
    sourceChannel: "agents:ui-request",
    payload: {
      agentId: "agent-a",
      requestId: "batch-ui",
      method: "batch_ask",
      batchQuestions: [{ id: "runtime", type: "select", question: "Runtime?" }],
    },
  });

  await coordinator.respondToUi({
    sessionId: "session-1",
    requestId: "batch-ui",
    agentId: "agent-a",
    runtimeGeneration: generation,
    response: { value: JSON.stringify({ answers: [{ id: "runtime", value: "node" }] }) },
  });

  assert.equal(harness.calls.uiResponse, 1);
});

test("Session UI response is rejected after the closed runtime is unbound", async () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const harness = createHarness({
    tabs: [{ id: "agent-a", status: "idle", createdAt: 1 }],
  });
  const coordinator = new SessionRuntimeCoordinator(
    harness.catalog,
    harness.agents,
    harness.sender,
  );
  const generation = coordinator.bindExistingAgent("session-1", "agent-a");
  coordinator.observeRuntimeEvent({
    sessionId: "session-1",
    agentId: "agent-a",
    runtimeGeneration: generation,
    sourceChannel: "agents:ui-request",
    payload: {
      agentId: "agent-a",
      requestId: "request-ui",
      method: "confirm",
      title: "Continue?",
    },
  });

  coordinator.unbindAgent("agent-a");

  await assert.rejects(
    coordinator.respondToUi({
      sessionId: "session-1",
      requestId: "request-ui",
      agentId: "agent-a",
      runtimeGeneration: generation,
      response: { confirmed: true },
    }),
    /runtime binding changed/i,
  );
  assert.equal(harness.calls.uiResponse, 0);
});

test("session runtime inventory and target expose the stable binding triple", () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const harness = createHarness({
    tabs: [{
      id: "agent-a",
      projectId: "project-1",
      cwd: "C:/project",
      status: "idle",
      sessionPath: "C:/sessions/session-1.jsonl",
      createdAt: 10,
    }],
  });
  const coordinator = new SessionRuntimeCoordinator(harness.catalog, harness.agents, harness.sender);
  const generation = coordinator.bindExistingAgent("session-1", "agent-a");
  assert.deepEqual(JSON.parse(JSON.stringify(coordinator.getTarget("session-1"))), {
    sessionId: "session-1",
    agentId: "agent-a",
    runtimeGeneration: generation,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(coordinator.listRuntimes())), [{
    sessionId: "session-1",
    agentId: "agent-a",
    runtimeGeneration: generation,
    projectId: "project-1",
    cwd: "C:/project",
    status: "idle",
    sessionPath: "C:/sessions/session-1.jsonl",
    createdAt: 10,
  }]);
});

test("anonymous runtime binds an existing --no-session process without attaching a file", async () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const harness = createHarness({
    entry: { noSession: true, status: "active" },
    tabs: [{
      id: "anonymous-agent",
      projectId: "project-1",
      cwd: "C:/project",
      title: "Anonymous Chat",
      status: "idle",
      noSession: true,
      createdAt: 1,
    }],
  });
  const coordinator = new SessionRuntimeCoordinator(harness.catalog, harness.agents, harness.sender);
  const runtime = coordinator.bindAnonymousRuntime("session-1", "anonymous-agent");
  assert.equal(runtime.noSession, true);
  assert.equal(runtime.sessionPath, undefined);

  const sent = await coordinator.send(prompt());
  assert.equal(sent.accepted, true);
  assert.equal(harness.calls.create, 0);
  assert.equal(harness.calls.attach, 0);

  const restarted = await coordinator.restartRuntime(runtime);
  assert.equal(restarted.ok, true);
  assert.equal(restarted.value.runtime.noSession, true);
  assert.equal(harness.calls.attach, 0);
});

test("concurrent activation waits for an anonymous runtime already being created", async () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const harness = createHarness({
    entry: { noSession: true, status: "active" },
  });
  const coordinator = new SessionRuntimeCoordinator(harness.catalog, harness.agents, harness.sender);
  const pending = deferred();
  const tab = {
    id: "anonymous-agent",
    projectId: "project-1",
    cwd: "C:/project",
    title: "Anonymous Chat",
    status: "idle",
    noSession: true,
    createdAt: 1,
  };
  const pendingActivation = pending.promise.then(() => {
    harness.tabs.push(tab);
    coordinator.bindAnonymousRuntime("session-1", tab.id);
    return tab;
  });

  coordinator.registerPendingRuntime("session-1", pendingActivation);
  const activation = coordinator.activateRuntime("session-1");
  assert.equal(harness.calls.create, 0);
  pending.resolve();

  const result = await activation;
  assert.equal(result.ok, true);
  assert.equal(result.value.agentId, tab.id);
  assert.equal(harness.calls.create, 0);
  assert.equal(coordinator.isActivating("session-1"), false);
});

test("stale generation is rejected before a runtime command reaches AgentManager", async () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const harness = createHarness({
    tabs: [{ id: "agent-a", status: "idle", createdAt: 1 }],
  });
  const coordinator = new SessionRuntimeCoordinator(harness.catalog, harness.agents, harness.sender);
  const generation = coordinator.bindExistingAgent("session-1", "agent-a");
  const result = await coordinator.abortRuntime({
    sessionId: "session-1",
    agentId: "agent-a",
    runtimeGeneration: generation - 1,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "SESSION_RUNTIME_CHANGED");
  assert.equal(harness.calls.abort, 0);
});

test("targeted runtime commands return the validated target and command value", async () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const harness = createHarness({
    tabs: [{ id: "agent-a", status: "idle", createdAt: 1 }],
    runtimeState: { isStreaming: false, modelId: "model-a" },
  });
  const coordinator = new SessionRuntimeCoordinator(harness.catalog, harness.agents, harness.sender);
  const runtimeGeneration = coordinator.bindExistingAgent("session-1", "agent-a");
  const target = { sessionId: "session-1", agentId: "agent-a", runtimeGeneration };
  const [state, commands, compact, edited, deleted, resend, exported, aborted] = await Promise.all([
    coordinator.getRuntimeState(target),
    coordinator.listRuntimeCommands(target),
    coordinator.compactRuntime(target, "compact now"),
    coordinator.editRuntimeMessage(target, "message-1", "updated"),
    coordinator.deleteRuntimeMessage(target, "message-2"),
    coordinator.prepareRuntimeResend(target, "message-3"),
    coordinator.exportRuntimeHtml(target),
    coordinator.abortRuntime(target),
  ]);
  for (const result of [state, commands, compact, edited, deleted, resend, exported, aborted]) {
    assert.equal(result.ok, true);
    assert.deepEqual(JSON.parse(JSON.stringify(result.value.target)), target);
  }
  assert.equal(harness.calls.runtimeState, 1);
  assert.equal(harness.calls.commands, 1);
  assert.equal(harness.calls.compact, 1);
  assert.equal(harness.calls.editMessage, 1);
  assert.equal(harness.calls.deleteMessage, 1);
  assert.equal(harness.calls.prepareResend, 1);
  assert.equal(harness.calls.exportHtml, 1);
  assert.equal(harness.calls.abort, 1);
});

test("runtime message snapshots retain the validated Session target", () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const harness = createHarness({
    tabs: [{ id: "agent-a", projectId: "project-1", cwd: "C:/project", status: "idle", createdAt: 1 }],
  });
  const coordinator = new SessionRuntimeCoordinator(harness.catalog, harness.agents, harness.sender);
  const runtimeGeneration = coordinator.bindExistingAgent("session-1", "agent-a");

  assert.deepEqual(JSON.parse(JSON.stringify(coordinator.getRuntimeMessages("session-1"))), {
    target: { sessionId: "session-1", agentId: "agent-a", runtimeGeneration },
    value: [{ id: "message-1", role: "assistant", text: "agent-a", timestamp: 1 }],
  });
  assert.equal(harness.calls.messages, 1);
});

test("runtime message snapshots fail closed when the runtime is replaced during the read", () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  let coordinator;
  const harness = createHarness({
    tabs: [
      { id: "agent-a", projectId: "project-1", cwd: "C:/project", status: "idle", createdAt: 1 },
      { id: "agent-b", projectId: "project-1", cwd: "C:/project", status: "idle", createdAt: 2 },
    ],
    getMessages: (agentId) => {
      assert.equal(agentId, "agent-a");
      coordinator.bindExistingAgent("session-1", "agent-b");
      return [{ id: "message-a", role: "assistant", text: "stale", timestamp: 1 }];
    },
  });
  coordinator = new SessionRuntimeCoordinator(harness.catalog, harness.agents, harness.sender);
  coordinator.bindExistingAgent("session-1", "agent-a");

  assert.equal(coordinator.getRuntimeMessages("session-1"), undefined);
  assert.equal(coordinator.getTarget("session-1").agentId, "agent-b");
});

test("runtime model preference is not persisted when AgentManager fails", async () => {
  // 先写 catalog 再调 pi：用户取消「重启生效」后，下次启动仍会套上未确认模型。
  // 失败路径不得改会话记录；needsRestart 由渲染层在用户确认后再 updateRecord。
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const harness = createHarness({
    tabs: [{ id: "agent-a", status: "idle", createdAt: 1 }],
    modelError: "model apply failed",
  });
  const previousModel = harness.entry.model ? { ...harness.entry.model } : undefined;
  const coordinator = new SessionRuntimeCoordinator(harness.catalog, harness.agents, harness.sender);
  const runtimeGeneration = coordinator.bindExistingAgent("session-1", "agent-a");
  const result = await coordinator.setRuntimeModel(
    { sessionId: "session-1", agentId: "agent-a", runtimeGeneration },
    "openai",
    "gpt-test",
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "SESSION_COMMAND_FAILED");
  assert.deepEqual(harness.entry.model, previousModel);
  assert.equal(harness.calls.update, 0);
  assert.equal(harness.calls.setModel, 1);
});

test("runtime thinking persists the backend-confirmed level in the session catalog", async () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const harness = createHarness({
    entry: { thinkingLevel: "off" },
    tabs: [{ id: "agent-a", status: "idle", createdAt: 1 }],
    runtimeState: { thinkingLevel: "max" },
  });
  const coordinator = new SessionRuntimeCoordinator(harness.catalog, harness.agents, harness.sender);
  const runtimeGeneration = coordinator.bindExistingAgent("session-1", "agent-a");

  const result = await coordinator.setRuntimeThinking(
    { sessionId: "session-1", agentId: "agent-a", runtimeGeneration },
    "high",
  );

  assert.equal(result.ok, true);
  assert.equal(result.value.value.thinkingLevel, "max");
  assert.equal(harness.entry.thinkingLevel, "max");
});
test("DSH model change preserves the recorded thinking preference", async () => {
  // 模型和思考档位是独立选择。即使 host 此次返回了规范化后的 high，PiDeck 也不能
  // 擅自把用户保存的 max 改掉；用户切回别的模型时仍应保留原选择。
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const harness = createHarness({
    entry: { backend: "dsh", thinkingLevel: "max" },
    tabs: [{ id: "agent-a", status: "idle", createdAt: 1 }],
    runtimeState: { provider: "jiyuan", modelId: "deepseek-v4-flash-0731", thinkingLevel: "high" },
  });
  harness.agents.backend = "dsh";
  const coordinator = new SessionRuntimeCoordinator(harness.catalog, harness.agents, harness.sender);
  const runtimeGeneration = coordinator.bindExistingAgent("session-1", "agent-a");

  const result = await coordinator.setRuntimeModel(
    { sessionId: "session-1", agentId: "agent-a", runtimeGeneration },
    "jiyuan",
    "deepseek-v4-flash-0731",
  );

  assert.equal(result.ok, true);
  assert.equal(harness.entry.model?.provider, "jiyuan");
  assert.equal(harness.entry.model?.modelId, "deepseek-v4-flash-0731");
  assert.equal(harness.entry.thinkingLevel, "max", "换模型不得改写用户保存的思考档位");
});

test("DSH model change keeps the thinking preference when the new model reports none", async () => {
  // 模型目录没有 reasoningEfforts 不是 PiDeck 清空选择的理由；后端后续决定如何处理。
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const harness = createHarness({
    entry: { backend: "dsh", thinkingLevel: "max" },
    tabs: [{ id: "agent-a", status: "idle", createdAt: 1 }],
    runtimeState: { provider: "jiyuan", modelId: "deepseek-v4-flash-0731" },
  });
  harness.agents.backend = "dsh";
  const coordinator = new SessionRuntimeCoordinator(harness.catalog, harness.agents, harness.sender);
  const runtimeGeneration = coordinator.bindExistingAgent("session-1", "agent-a");

  const result = await coordinator.setRuntimeModel(
    { sessionId: "session-1", agentId: "agent-a", runtimeGeneration },
    "jiyuan",
    "deepseek-v4-flash-0731",
  );

  assert.equal(result.ok, true);
  assert.equal(harness.entry.thinkingLevel, "max", "新模型未返回档位时也不得清除用户选择");
});

test("DSH activation preserves a thinking preference the host explicitly rejects", async () => {
  // 能力判断属于 host / pi-ai。当前模型拒绝档位时仍保留用户偏好，以便 provider、
  // 模型或其配置随后变化后再次应用；PiDeck 不可根据一次错误静默清空选择。
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const harness = createHarness({
    entry: {
      status: "active",
      backend: "dsh",
      model: { provider: "jiyuan", modelId: "deepseek-v4-flash-0731" },
      thinkingLevel: "max",
    },
    tabs: [{
      id: "agent-old",
      projectId: "project-1",
      cwd: "C:/project",
      title: "Session 1",
      status: "idle",
      createdAt: 1,
    }],
  });
  harness.agents.backend = "dsh";
  harness.agents.setThinking = async () => {
    harness.calls.setThinking += 1;
    throw new Error(
      'provider "jiyuan" model "deepseek-v4-flash-0731" does not support reasoning effort "max"',
    );
  };
  const coordinator = new SessionRuntimeCoordinator(harness.catalog, harness.agents, harness.sender);
  const firstGeneration = coordinator.bindExistingAgent("session-1", "agent-old");

  const restarted = await coordinator.restartSession("session-1", "agent-old");

  assert.ok(restarted, "DSH 档位被拒不应让重启失败（警告 + 保留偏好）");
  assert.equal(firstGeneration, 1);
  assert.equal(harness.entry.thinkingLevel, "max", "host 拒绝也不得清空用户选择");
});

test("DSH activation keeps the thinking preference on non-effort host errors", async () => {
  // busy/未就绪等 host 错误不代表档位不受支持：不得误清用户偏好。
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const harness = createHarness({
    entry: {
      status: "active",
      backend: "dsh",
      model: { provider: "jiyuan", modelId: "deepseek-v4-flash-0731" },
      thinkingLevel: "max",
    },
    tabs: [{
      id: "agent-old",
      projectId: "project-1",
      cwd: "C:/project",
      title: "Session 1",
      status: "idle",
      createdAt: 1,
    }],
  });
  harness.agents.backend = "dsh";
  harness.agents.setThinking = async () => {
    harness.calls.setThinking += 1;
    throw new Error("dsh selectModel busy: {}");
  };
  const coordinator = new SessionRuntimeCoordinator(harness.catalog, harness.agents, harness.sender);
  coordinator.bindExistingAgent("session-1", "agent-old");

  await coordinator.restartSession("session-1", "agent-old");

  assert.equal(harness.entry.thinkingLevel, "max", "非档位类 host 错误不得清掉用户偏好");
});

test("pi model change keeps the recorded thinking level untouched", async () => {
  // pi 的思考档位是独立偏好，换模型不改变它；catalog.thinkingLevel 只由
  // setRuntimeThinking / applyPreferences 管理，换模型不得顺带清掉。
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const harness = createHarness({
    entry: { thinkingLevel: "max" },
    tabs: [{ id: "agent-a", status: "idle", createdAt: 1 }],
    runtimeState: { provider: "openai", modelId: "gpt-test", thinkingLevel: "low" },
  });
  const coordinator = new SessionRuntimeCoordinator(harness.catalog, harness.agents, harness.sender);
  const runtimeGeneration = coordinator.bindExistingAgent("session-1", "agent-a");

  const result = await coordinator.setRuntimeModel(
    { sessionId: "session-1", agentId: "agent-a", runtimeGeneration },
    "openai",
    "gpt-test",
  );

  assert.equal(result.ok, true);
  assert.equal(harness.entry.thinkingLevel, "max", "pi 换模型不得改 catalog 思考档位");
});
test("runtime permission preference persists only after the live agent applies it", async () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const harness = createHarness({
    tabs: [{ id: "agent-a", status: "idle", createdAt: 1 }],
    permissionError: "permission apply failed",
  });
  const coordinator = new SessionRuntimeCoordinator(harness.catalog, harness.agents, harness.sender);
  const runtimeGeneration = coordinator.bindExistingAgent("session-1", "agent-a");
  const target = { sessionId: "session-1", agentId: "agent-a", runtimeGeneration };

  const failed = await coordinator.setRuntimePermission(target, "workspace-write");
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, "SESSION_COMMAND_FAILED");
  assert.equal(harness.calls.setPermission, 1);
  assert.equal(harness.calls.update, 0);
  assert.notEqual(harness.entry.permissionPreset, "workspace-write");

  harness.agents.setPermission = async (_agentId, preset) => {
    harness.calls.setPermission += 1;
    harness.runtimeState = { permissionPreset: preset };
  };
  const applied = await coordinator.setRuntimePermission(target, "workspace-write");
  assert.equal(applied.ok, true);
  assert.equal(harness.entry.permissionPreset, "workspace-write");
  assert.equal(harness.calls.update, 1);
});

test("stop invalidates the target and restart replaces it with a higher generation", async () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const baseTab = {
    id: "agent-a",
    projectId: "project-1",
    cwd: "C:/project",
    title: "Session",
    status: "idle",
    sessionPath: "C:/sessions/session-1.jsonl",
    createdAt: 1,
  };

  const stopHarness = createHarness({ tabs: [{ ...baseTab }] });
  const stopCoordinator = new SessionRuntimeCoordinator(
    stopHarness.catalog,
    stopHarness.agents,
    stopHarness.sender,
  );
  const stopGeneration = stopCoordinator.bindExistingAgent("session-1", "agent-a");
  const stopped = await stopCoordinator.stopRuntime({
    sessionId: "session-1",
    agentId: "agent-a",
    runtimeGeneration: stopGeneration,
  });
  assert.equal(stopped.ok, true);
  assert.equal(stopCoordinator.getTarget("session-1"), undefined);

  const restartHarness = createHarness({ tabs: [{ ...baseTab }] });
  const restartCoordinator = new SessionRuntimeCoordinator(
    restartHarness.catalog,
    restartHarness.agents,
    restartHarness.sender,
  );
  const restartGeneration = restartCoordinator.bindExistingAgent("session-1", "agent-a");
  const restarted = await restartCoordinator.restartRuntime({
    sessionId: "session-1",
    agentId: "agent-a",
    runtimeGeneration: restartGeneration,
  });
  assert.equal(restarted.ok, true);
  assert.equal(restarted.value.previousTarget.runtimeGeneration, restartGeneration);
  assert.equal(restarted.value.runtime.agentId, "agent-restarted");
  assert.equal(restarted.value.runtime.runtimeGeneration > restartGeneration, true);
  assert.equal(restarted.value.session.id, "session-1");
});

test("releaseRuntimeForDelete unbinds immediately and stops the agent in the background", async () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const stopGate = deferred();
  const harness = createHarness({
    tabs: [{
      id: "agent-a",
      projectId: "project-1",
      cwd: "C:/project",
      title: "Session",
      status: "running",
      sessionPath: "C:/sessions/session-1.jsonl",
      createdAt: 1,
    }],
    stopDelay: stopGate.promise,
  });
  const coordinator = new SessionRuntimeCoordinator(
    harness.catalog,
    harness.agents,
    harness.sender,
  );
  coordinator.bindExistingAgent("session-1", "agent-a");
  const pending = coordinator.releaseRuntimeForDelete("session-1");
  // 删除路径不能等 stop 完成：侧栏要立刻解绑，agent 在后台停。
  assert.equal(coordinator.getTarget("session-1"), undefined);
  assert.equal(harness.calls.stop, 1);
  stopGate.resolve();
  await pending;
  assert.equal(coordinator.getTarget("session-1"), undefined);
});

test("commandFailure classifies message-not-found separately from session-not-found", () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const harness = createHarness();
  const coordinator = new SessionRuntimeCoordinator(
    harness.catalog,
    harness.agents,
    harness.sender,
  );
  // 编辑/删除/重发缓存与文件都未命中的错误 → MESSAGE_NOT_FOUND（不再误报「会话已不存在」）
  const messageMiss = coordinator.commandFailure(new Error("Message not found"));
  assert.equal(messageMiss.ok, false);
  assert.equal(messageMiss.error.code, "MESSAGE_NOT_FOUND");
  const fileMiss = coordinator.commandFailure(
    new Error("Message was not found on the active session branch"),
  );
  assert.equal(fileMiss.error.code, "MESSAGE_NOT_FOUND");
  // SessionFileEditor 在 RPC leaf 不在 JSONL 时抛这条：文案不含 "message not found"，
  // 旧实现落到 SESSION_COMMAND_FAILED（「会话操作失败，请重试」）。
  const staleLeaf = new Error("The active session branch is no longer present in the file");
  staleLeaf.code = "SESSION_ENTRY_NOT_FOUND";
  assert.equal(coordinator.commandFailure(staleLeaf).error.code, "MESSAGE_NOT_FOUND");
  const offBranch = new Error("The requested entry is not part of the active session branch");
  offBranch.code = "SESSION_ENTRY_NOT_FOUND";
  assert.equal(coordinator.commandFailure(offBranch).error.code, "MESSAGE_NOT_FOUND");
  // 回归：真正的会话不存在仍归 SESSION_NOT_FOUND
  const sessionMiss = coordinator.commandFailure(new Error("Session not found: session-1"));
  assert.equal(sessionMiss.ok, false);
  assert.equal(sessionMiss.error.code, "SESSION_NOT_FOUND");
  // Agent 运行实例已不存在（stop/restart 后立即操作）：是「没有可用的运行实例」
  // 而非「会话已不存在」——旧实现归 SESSION_NOT_FOUND，用户删消息收到
  // 「删除失败:会话已不存在，请刷新会话列表后重试」但刷新后依然复现（2026-08 反馈）
  const agentMiss = coordinator.commandFailure(new Error("Agent not found: agent-1"));
  assert.equal(agentMiss.error.code, "SESSION_RUNTIME_UNAVAILABLE");
});

test("commandFailure classifies model-not-found as SESSION_MODEL_NOT_FOUND (not session gone)", () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const harness = createHarness();
  const coordinator = new SessionRuntimeCoordinator(
    harness.catalog,
    harness.agents,
    harness.sender,
  );
  // set_model 报 "Model not found: provider/model"（本地 models.json 也没有该模型，
  // 如手误/解析错位产生的假模型）→ 模型不存在，绝不误报「会话已不存在」。
  const modelMiss = coordinator.commandFailure(
    new Error("Model not found: grok.weishiair.de/copy"),
  );
  assert.equal(modelMiss.ok, false);
  assert.equal(modelMiss.error.code, "SESSION_MODEL_NOT_FOUND");
  // {model} 参数提取：i18n 文案「模型未找到：{model}」有值
  assert.equal(modelMiss.error.params?.model, "grok.weishiair.de/copy");
  // 注意：vm 沙箱里主 realm 的 Error 不满足 instanceof，needsRestart 分支无法行为级验证，
  // 用源码断言确认该分支同样提取 model 参数（本地有模型时引导重启而非误报会话不存在）
  const coordinatorSource = readFileSync(
    "src/main/sessions/SessionRuntimeCoordinator.ts",
    "utf8",
  );
  assert.match(
    coordinatorSource,
    /needsRestart: true,[\s\S]*?params: \{ model: this\.extractModelFromNotFound\(error\.message\) \?\? error\.message \}/,
  );
});

test("catalog message mutation writes the file only after the runtime is stopped", async () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const harness = createHarness({
    entry: catalogEntry({ filePath: "C:/sessions/session-1.jsonl", status: "active" }),
    tabs: [{ id: "agent-a", status: "idle", createdAt: 1 }],
  });
  const coordinator = new SessionRuntimeCoordinator(harness.catalog, harness.agents, harness.sender);
  const generation = coordinator.bindExistingAgent("session-1", "agent-a");
  const liveEdit = await coordinator.editCatalogMessage("session-1", "message-1", "updated");
  assert.equal(liveEdit.ok, false);
  assert.equal(liveEdit.error.code, "SESSION_RUNTIME_BUSY");
  assert.equal(harness.calls.mutatePersisted.length, 0);

  const stopped = await coordinator.stopRuntime({
    sessionId: "session-1",
    agentId: "agent-a",
    runtimeGeneration: generation,
  });
  assert.equal(stopped.ok, true);
  const edited = await coordinator.editCatalogMessage("session-1", "message-1", "updated");
  const deleted = await coordinator.deleteCatalogMessage("session-1", "message-2");
  const resend = await coordinator.prepareCatalogResend("session-1", "message-3");
  assert.equal(edited.ok, true);
  assert.equal(deleted.ok, true);
  assert.equal(resend.ok, true);
  assert.equal(resend.value.text, "hello");
  assert.deepEqual(
    harness.calls.mutatePersisted.map((item) => item.operation),
    ["edit", "delete", "resend"],
  );
});

test("catalog message mutation refuses DSH sessions", async () => {
  const { SessionRuntimeCoordinator } = loadCoordinator();
  const harness = createHarness({
    entry: catalogEntry({ backend: "dsh", dshSessionId: "dsh-1", status: "active" }),
  });
  const coordinator = new SessionRuntimeCoordinator(harness.catalog, harness.agents, harness.sender);
  const result = await coordinator.deleteCatalogMessage("session-1", "message-1");
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "SESSION_COMMAND_FAILED");
  assert.match(result.error.debugDetails, /dsh/);
  assert.equal(harness.calls.mutatePersisted.length, 0);
});

test("SessionCommandIpcError maps MESSAGE_NOT_FOUND to the dedicated copy key", () => {
  const { SessionCommandIpcError } = compileModule(
    "src/main/sessions/SessionCommandIpcError.ts",
  );
  const translate = (key) => key;
  const error = new SessionCommandIpcError(
    { code: "MESSAGE_NOT_FOUND", debugDetails: "Message not found" },
    translate,
  );
  assert.equal(error.code, "MESSAGE_NOT_FOUND");
  assert.equal(error.message, "sessionCommand.messageNotFound");
  // 回归：SESSION_NOT_FOUND 仍映射到会话文案 key
  const sessionError = new SessionCommandIpcError(
    { code: "SESSION_NOT_FOUND", debugDetails: "Session not found" },
    translate,
  );
  assert.equal(sessionError.message, "sessionCommand.sessionNotFound");
});
