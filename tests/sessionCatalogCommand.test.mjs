import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const projectSync = readFileSync("src/renderer/src/hooks/useProjectSync.ts", "utf8");

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createHookForRuntimeTest() {
  const output = ts.transpileModule(projectSync, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const module = { exports: {} };
  const context = {
    module,
    exports: module.exports,
    require(request) {
      if (request === "react") {
        return {
          useRef: (initial) => ({ current: initial }),
          useState: (initial) => [initial, () => undefined],
          // catalog-refreshed 订阅的 effect：测试不驱动推送事件，注册后丢弃即可
          useEffect: () => undefined,
        };
      }
      if (request === "../atoms/session-selectors") {
        return {
          sessionRecordToSummary: (session) => session.filePath ? {
            id: session.id,
            filePath: session.filePath,
            preview: session.preview,
            updatedAt: session.updatedAt,
            messageCount: session.messageCount,
          } : undefined,
        };
      }
      throw new Error(`Unexpected runtime import: ${request}`);
    },
    setTimeout,
    clearTimeout,
    Promise,
  };
  vm.runInNewContext(output, context);
  return context.module.exports.useProjectSync;
}

function makeRecord(id, updatedAt) {
  return {
    id,
    projectId: "project-1",
    title: id,
    source: "pi",
    environment: "native",
    filePath: `/sessions/${id}.jsonl`,
    preview: id,
    messageCount: 1,
    status: "active",
    createdAt: updatedAt,
    updatedAt,
  };
}

function makeHookInput(listCatalog) {
  return {
    projects: [],
    activeProjectId: undefined,
    setProjects: () => undefined,
    setActiveProjectId: () => undefined,
    replaceProjectSessions: () => undefined,
    api: {
      projects: { list: async () => [] },
      git: {
        worktreeList: async () => [],
        branches: async () => ({ current: null, branches: [] }),
      },
      sessions: { listCatalog },
      files: { list: async () => [] },
    },
    showToast: () => undefined,
    setSessionCatalogLoadState: () => undefined,
    t: (key) => key,
  };
}

async function settleAfterMicrotasks() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

test("initial and collision callers share the final pending completion", async () => {
  const firstScan = createDeferred();
  const pendingScan = createDeferred();
  const latestScan = createDeferred();
  const finalScan = createDeferred();
  let requestCount = 0;
  const useProjectSync = createHookForRuntimeTest();
  const sync = useProjectSync(makeHookInput(async () => {
    requestCount += 1;
    if (requestCount === 1) return firstScan.promise;
    if (requestCount === 2) return pendingScan.promise;
    if (requestCount === 3) return latestScan.promise;
    return finalScan.promise;
  }));

  const first = sync.refreshProjectSessions("project-1");
  await settleAfterMicrotasks();
  const collision = sync.refreshProjectSessions("project-1");
  assert.strictEqual(first, collision);
  assert.equal(requestCount, 1);

  firstScan.resolve([makeRecord("first", 10)]);
  await settleAfterMicrotasks();
  assert.equal(requestCount, 2);
  const collisionDuringPending = sync.refreshProjectSessions("project-1");
  assert.strictEqual(collisionDuringPending, collision);

  pendingScan.resolve([makeRecord("pending", 20)]);
  await settleAfterMicrotasks();
  assert.equal(requestCount, 3);
  const collisionDuringLatest = sync.refreshProjectSessions("project-1");
  assert.strictEqual(collisionDuringLatest, collision);

  latestScan.resolve([makeRecord("latest", 30)]);
  await settleAfterMicrotasks();
  assert.equal(requestCount, 4);
  const completedBeforeQuietCycle = await Promise.race([
    first.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 10)),
  ]);
  assert.equal(completedBeforeQuietCycle, false);

  finalScan.resolve([makeRecord("final", 40)]);
  const results = await Promise.all([
    first,
    collision,
    collisionDuringPending,
    collisionDuringLatest,
  ]);
  assert.equal(requestCount, 4);
  for (const result of results) {
    assert.deepEqual(result.map((session) => session.id), ["final"]);
  }

  const afterCompletion = sync.refreshProjectSessions("project-1");
  assert.notStrictEqual(afterCompletion, first);
  const afterCompletionResult = await afterCompletion;
  assert.equal(requestCount, 5);
  assert.deepEqual(afterCompletionResult.map((session) => session.id), ["final"]);
});

test("collision propagates a pending scan error", async () => {
  const firstScan = createDeferred();
  const pendingScan = createDeferred();
  let requestCount = 0;
  const useProjectSync = createHookForRuntimeTest();
  const sync = useProjectSync(makeHookInput(async () => {
    requestCount += 1;
    return requestCount === 1 ? firstScan.promise : pendingScan.promise;
  }));

  const first = sync.refreshProjectSessions("project-1");
  await settleAfterMicrotasks();
  const collision = sync.refreshProjectSessions("project-1");
  assert.strictEqual(first, collision);
  await settleAfterMicrotasks();
  firstScan.resolve([makeRecord("first", 10)]);
  await settleAfterMicrotasks();
  pendingScan.reject(new Error("pending scan failed"));

  const [firstError, collisionError] = await Promise.all([
    first.catch((error) => error),
    collision.catch((error) => error),
  ]);
  assert.equal(requestCount, 2);
  assert.match(firstError?.message ?? "", /pending scan failed/);
  assert.match(collisionError?.message ?? "", /pending scan failed/);
});

test("initial failure and collision share a successful pending retry", async () => {
  const firstScan = createDeferred();
  const pendingScan = createDeferred();
  let requestCount = 0;
  const useProjectSync = createHookForRuntimeTest();
  const sync = useProjectSync(makeHookInput(async () => {
    requestCount += 1;
    return requestCount === 1 ? firstScan.promise : pendingScan.promise;
  }));

  const first = sync.refreshProjectSessions("project-1");
  await settleAfterMicrotasks();
  const collision = sync.refreshProjectSessions("project-1");
  assert.strictEqual(first, collision);
  firstScan.reject(new Error("initial scan failed"));
  await settleAfterMicrotasks();
  pendingScan.resolve([makeRecord("pending", 20)]);

  const [firstResult, collisionResult] = await Promise.all([first, collision]);
  assert.equal(requestCount, 2);
  assert.deepEqual(firstResult.map((session) => session.id), ["pending"]);
  assert.deepEqual(collisionResult.map((session) => session.id), ["pending"]);
});

test("final quiet cycles preserve falsy rejection reasons", async () => {
  const reasons = new Map([
    ["undefined", undefined],
    ["null", null],
    ["false", false],
    ["zero", 0],
    ["empty", ""],
  ]);
  const useProjectSync = createHookForRuntimeTest();
  const sync = useProjectSync(makeHookInput(async (projectId) => {
    throw reasons.get(projectId);
  }));

  for (const [projectId, expectedReason] of reasons) {
    const first = sync.refreshProjectSessions(projectId);
    let rejected = false;
    let reason = Symbol("not rejected");
    try {
      await first;
    } catch (caughtError) {
      rejected = true;
      reason = caughtError;
    }
    assert.equal(rejected, true, `${projectId} should reject`);
    assert.equal(reason, expectedReason);

    const afterRejection = sync.refreshProjectSessions(projectId);
    assert.notStrictEqual(afterRejection, first);
    let repeatedReason = Symbol("not rejected");
    try {
      await afterRejection;
    } catch (caughtError) {
      repeatedReason = caughtError;
    }
    assert.equal(repeatedReason, expectedReason);
  }
});

test("foreground callback failures settle and release the project completion", async () => {
  const callbackError = new Error("load state callback failed");
  let requestCount = 0;
  const input = makeHookInput(async () => {
    requestCount += 1;
    return [makeRecord("unexpected", 10)];
  });
  input.setSessionCatalogLoadState = () => {
    throw callbackError;
  };
  const useProjectSync = createHookForRuntimeTest();
  const sync = useProjectSync(input);

  const first = sync.refreshProjectSessions("project-1");
  const firstOutcome = await Promise.race([
    first.then(
      () => ({ status: "resolved" }),
      (reason) => ({ status: "rejected", reason }),
    ),
    new Promise((resolve) => setTimeout(() => resolve({ status: "timeout" }), 100)),
  ]);
  assert.equal(firstOutcome.status, "rejected");
  assert.strictEqual(firstOutcome.reason, callbackError);

  const second = sync.refreshProjectSessions("project-1");
  assert.notStrictEqual(second, first);
  await assert.rejects(second, callbackError);
  assert.equal(requestCount, 0);
});

test("project completions and pending retries remain isolated", async () => {
  const projectOneFirst = createDeferred();
  const projectOnePending = createDeferred();
  const projectTwoFirst = createDeferred();
  const requestCount = new Map();
  const useProjectSync = createHookForRuntimeTest();
  const sync = useProjectSync(makeHookInput(async (projectId) => {
    const count = (requestCount.get(projectId) ?? 0) + 1;
    requestCount.set(projectId, count);
    if (projectId === "project-1") {
      return count === 1 ? projectOneFirst.promise : projectOnePending.promise;
    }
    return projectTwoFirst.promise;
  }));

  const projectOne = sync.refreshProjectSessions("project-1");
  const projectTwo = sync.refreshProjectSessions("project-2");
  await settleAfterMicrotasks();
  const projectOneCollision = sync.refreshProjectSessions("project-1");
  assert.strictEqual(projectOneCollision, projectOne);
  assert.notStrictEqual(projectTwo, projectOne);

  projectTwoFirst.resolve([makeRecord("project-2", 20)]);
  const projectTwoResult = await projectTwo;
  assert.deepEqual(projectTwoResult.map((session) => session.id), ["project-2"]);
  assert.equal(requestCount.get("project-2"), 1);

  projectOneFirst.resolve([makeRecord("project-1-first", 10)]);
  await settleAfterMicrotasks();
  assert.equal(requestCount.get("project-1"), 2);
  projectOnePending.resolve([makeRecord("project-1-pending", 30)]);
  const [projectOneResult, collisionResult] = await Promise.all([
    projectOne,
    projectOneCollision,
  ]);
  assert.deepEqual(projectOneResult.map((session) => session.id), ["project-1-pending"]);
  assert.deepEqual(collisionResult.map((session) => session.id), ["project-1-pending"]);
});
