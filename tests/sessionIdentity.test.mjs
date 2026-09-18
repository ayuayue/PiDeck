import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function loadModule() {
  const source = readFileSync("src/shared/sessionIdentity.ts", "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: "sessionIdentity.ts",
  }).outputText;
  const sandbox = { exports: {}, module: { exports: {} } };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(output, sandbox, { filename: "sessionIdentity.ts" });
  return sandbox.module.exports;
}

function loadAgentIdentity() {
  const identity = loadModule();
  const filePath = "src/main/pi/agentSessionIdentity.ts";
  const output = ts.transpileModule(readFileSync(filePath, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filePath,
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(
    output,
    {
      module,
      exports: module.exports,
      require: (specifier) => {
        if (specifier === "../../shared/sessionIdentity") return identity;
        throw new Error(`Unexpected import: ${specifier}`);
      },
    },
    { filename: filePath },
  );
  return module.exports;
}

test("treats pi JSONL file-stem timestamps as placeholders, not session titles", () => {
  const { looksLikePiSessionFileStem } = loadModule();
  // 文件名把 ISO 的 `:` / `.` 换成 `-`：`19-239Z` 不是 `.239Z`。
  assert.equal(
    looksLikePiSessionFileStem("2026-08-08T10-47-19-239Z_abc"),
    true,
  );
  assert.equal(looksLikePiSessionFileStem("2026-08-08T10:47:19.239Z"), true);
  assert.equal(looksLikePiSessionFileStem("2026-08-08T10-47-19Z"), true);
  assert.equal(looksLikePiSessionFileStem("帮我看看这个报错"), false);
  assert.equal(looksLikePiSessionFileStem("Untitled"), false);
});

test("canonicalizes native session paths without collapsing WSL case", () => {
  const { canonicalizeSessionPath } = loadModule();
  assert.equal(
    canonicalizeSessionPath(
      "C:\\Users\\Dev\\.pi\\sessions\\A.jsonl/",
      "native",
    ),
    "c:/users/dev/.pi/sessions/a.jsonl",
  );
  assert.equal(
    canonicalizeSessionPath("/home/dev/.pi/sessions/Case.jsonl/", "wsl"),
    "/home/dev/.pi/sessions/Case.jsonl",
  );
});

test("keeps source and WSL identity in the session origin key", () => {
  const { buildSessionOriginKey } = loadModule();
  const native = buildSessionOriginKey({
    source: "pi",
    environment: "native",
    filePath: "C:\\Users\\Dev\\session.jsonl",
  });
  const wsl = buildSessionOriginKey({
    source: "pi",
    environment: "wsl",
    filePath: "/mnt/c/Users/Dev/session.jsonl",
    wslDistro: "Ubuntu",
    wslUser: "dev",
  });
  const imported = buildSessionOriginKey({
    source: "codex",
    environment: "native",
    filePath: "C:\\Users\\Dev\\session.jsonl",
    importedSourceId: "thread-1",
  });
  assert.notEqual(native, wsl);
  assert.notEqual(native, imported);
  assert.match(wsl, /^pi:wsl:Ubuntu:dev:/);
});

// 回归 #168：扫描索引前校验会话头，拒绝无 type 头的产物转储（transcript 用 recordType）。
test("isValidPiSessionFileHead accepts real pi session headers", () => {
  const { isValidPiSessionFileHead } = loadModule();
  // pi 原生会话头：首条记录 type:"session"。
  const real = `${JSON.stringify({
    type: "session",
    version: 3,
    id: "abc12345",
    timestamp: "2026-08-26T08:00:00.000Z",
    cwd: "C:/repo",
  })}\n${JSON.stringify({ type: "message", message: { role: "user", content: "hi" } })}\n`;
  assert.equal(isValidPiSessionFileHead(real), true);
  // session_info 作为首条（带 type）亦接受，兼容历史格式与导入会话。
  assert.equal(
    isValidPiSessionFileHead(
      `${JSON.stringify({ type: "session_info", name: "x", cwd: "C:/repo" })}\n`,
    ),
    true,
  );
});

test("isValidPiSessionFileHead rejects pi-subagents transcript dumps without a type header", () => {
  const { isValidPiSessionFileHead } = loadModule();
  // transcript 首条记录用 recordType 而非 type——pi 无法作为会话加载。
  const transcript = `${JSON.stringify({
    version: 1,
    recordType: "message",
    source: "foreground",
    runId: "abc",
    agent: "worker",
    cwd: "C:/repo",
    sourceEventType: "initial_prompt",
    role: "user",
    message: {
      role: "user",
      content: [{ type: "text", text: "review prompt" }],
    },
  })}\n`;
  assert.equal(
    isValidPiSessionFileHead(transcript),
    false,
    "transcript without type header must be rejected",
  );
});

test("isValidPiSessionFileHead skips legacy sessionName heads before judging the first real record", () => {
  const { isValidPiSessionFileHead } = loadModule();
  // 旧版 PiDeck 私有 sessionName 头行（#114 存量损坏）：跳过后首条真实记录带 type → 接受。
  const legacyHead = `${JSON.stringify({ sessionName: "老版私有头", ts: 1 })}\n${JSON.stringify(
    {
      type: "session_info",
      name: "老版私有头",
      cwd: "C:/repo",
    },
  )}\n`;
  assert.equal(isValidPiSessionFileHead(legacyHead), true);
  // 空/损坏内容不接受。
  assert.equal(isValidPiSessionFileHead(""), false);
  assert.equal(isValidPiSessionFileHead("not json\n"), false);
});

test("AgentManager keys preserve WSL case and identity at the process boundary", () => {
  const { buildAgentSessionKey } = loadAgentIdentity();
  const defaults = {
    environment: "wsl",
    wslDistro: "Ubuntu",
    wslUser: "dev",
  };
  const upper = buildAgentSessionKey(
    {
      projectId: "project-1",
      sessionPath: "/home/dev/Case.jsonl",
    },
    defaults,
  );
  const lower = buildAgentSessionKey(
    {
      projectId: "project-1",
      sessionPath: "/home/dev/case.jsonl",
    },
    defaults,
  );
  const otherDistro = buildAgentSessionKey(
    {
      projectId: "project-1",
      sessionPath: "/home/dev/Case.jsonl",
      wslDistro: "Debian",
    },
    defaults,
  );
  assert.notEqual(upper, lower);
  assert.notEqual(upper, otherDistro);

  const agentManagerSource = readFileSync(
    "src/main/pi/AgentManager.ts",
    "utf8",
  );
  assert.match(agentManagerSource, /buildAgentSessionKey\(\s*input/);
  assert.doesNotMatch(agentManagerSource, /normalizeSessionPathForCompare/);
});

// ── toAbsoluteSessionPath（相对 sessionFile 归一化）──────────────
// 回归背景：pi 的 sessionDir 配置为 ".pi/sessions" 时，get_state 返回的
// sessionFile 是相对 cwd 的；原样写入 catalog 会与扫描器绝对路径构成同文件双记录
// （侧栏重复显示两个会话），且文件操作落到错误位置。

test("resolves a native relative sessionFile against the project path", () => {
  const { toAbsoluteSessionPath } = loadModule();
  assert.equal(
    toAbsoluteSessionPath(
      ".pi\\sessions\\2026-08-08T10-47-19-239Z_abc.jsonl",
      "D:\\Project\\PiDeck",
      "native",
    ),
    "D:\\Project\\PiDeck\\.pi\\sessions\\2026-08-08T10-47-19-239Z_abc.jsonl",
  );
});

test("resolves native relative paths with forward slashes and normalizes output to backslashes", () => {
  const { toAbsoluteSessionPath } = loadModule();
  assert.equal(
    toAbsoluteSessionPath(
      ".pi/sessions/session.jsonl",
      "D:/Project/PiDeck",
      "native",
    ),
    "D:\\Project\\PiDeck\\.pi\\sessions\\session.jsonl",
  );
});

test("passes through already-absolute native and WSL paths", () => {
  const { toAbsoluteSessionPath } = loadModule();
  assert.equal(
    toAbsoluteSessionPath(
      "C:\\Users\\dev\\.pi\\sessions\\a.jsonl",
      "D:\\Project",
      "native",
    ),
    "C:\\Users\\dev\\.pi\\sessions\\a.jsonl",
  );
  assert.equal(
    toAbsoluteSessionPath(
      "/mnt/d/Project/.pi/sessions/a.jsonl",
      "D:\\Project",
      "wsl",
    ),
    "/mnt/d/Project/.pi/sessions/a.jsonl",
  );
});

test("resolves a WSL relative sessionFile against the /mnt/<drive> project base", () => {
  const { toAbsoluteSessionPath } = loadModule();
  assert.equal(
    toAbsoluteSessionPath(
      ".pi/sessions/session.jsonl",
      "D:\\Project\\PiDeck",
      "wsl",
    ),
    "/mnt/d/Project/PiDeck/.pi/sessions/session.jsonl",
  );
});

test("relative and absolute forms canonicalize to the same origin key", () => {
  const { buildSessionOriginKey, toAbsoluteSessionPath } = loadModule();
  const relative = buildSessionOriginKey({
    source: "pi",
    environment: "native",
    filePath: toAbsoluteSessionPath(
      ".pi/sessions/session.jsonl",
      "D:\\Project\\PiDeck",
      "native",
    ),
  });
  const absolute = buildSessionOriginKey({
    source: "pi",
    environment: "native",
    filePath: "D:\\Project\\PiDeck\\.pi\\sessions\\session.jsonl",
  });
  assert.equal(relative, absolute);
});

// 归档/删除父会话时必须能认出 sibling-dir 与 parentSessionPath 两种子会话，
// 否则 catalog 缓存里会留下幽灵子会话，侧栏孤儿提升后再打开就是残留聊天框。
test("treats sibling-dir and parentSessionPath sessions as descendants of the parent", () => {
  const { isSessionDescendantOf, collectSessionSubtreeIds } = loadModule();
  const parent = {
    id: "parent",
    filePath: "C:\\sessions\\parent.jsonl",
    environment: "native",
  };
  const linkedChild = {
    id: "linked-child",
    filePath: "C:\\sessions\\parent\\child.jsonl",
    parentSessionPath: "c:/sessions/parent.jsonl",
    environment: "native",
  };
  const siblingOnly = {
    id: "sibling-only",
    filePath: "C:/sessions/parent/run/session.jsonl",
    environment: "native",
  };
  const grandchild = {
    id: "grandchild",
    filePath: "C:/sessions/parent/child/nested.jsonl",
    parentSessionPath: "C:/sessions/parent/child.jsonl",
    environment: "native",
  };
  const unrelated = {
    id: "unrelated",
    filePath: "C:/sessions/other.jsonl",
    environment: "native",
  };
  const anonymous = { id: "anon", environment: "native" };

  assert.equal(isSessionDescendantOf(linkedChild, parent), true);
  assert.equal(isSessionDescendantOf(siblingOnly, parent), true);
  assert.equal(isSessionDescendantOf(grandchild, linkedChild), true);
  assert.equal(isSessionDescendantOf(unrelated, parent), false);
  assert.equal(isSessionDescendantOf(anonymous, parent), false);
  assert.equal(isSessionDescendantOf(parent, parent), false);

  const subtree = collectSessionSubtreeIds(
    [linkedChild, siblingOnly, grandchild, unrelated, anonymous],
    parent,
  );
  // vm 沙箱里的 Array 与宿主 Array 不是同一构造器，deepEqual 会误报；按值比较即可。
  assert.equal(
    [...subtree].sort().join(","),
    "grandchild,linked-child,parent,sibling-only",
  );
});
