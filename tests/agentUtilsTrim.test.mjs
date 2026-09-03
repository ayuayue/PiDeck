import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const {
  trimHistoryMessages,
  turnTrimStartIndex,
  countRoleMessagesBefore,
  isDefaultAgentTitle,
  inferTitleFromMessages,
  looksLikePiSessionFileStem,
} = loadTsCommonJs("src/main/pi/agentUtils.ts");

const message = (role) => ({ role });

test("trimHistoryMessages default caps runtime cache at 12 turns (2026-11)", () => {
  // 15 轮输入 → 保留最近 12 轮（user 消息为轮起点）
  const input = [];
  for (let turn = 0; turn < 15; turn += 1) {
    input.push(message("user"), message("assistant"), message("tool"));
  }
  const trimmed = trimHistoryMessages(input);
  assert.equal(trimmed.length, 12 * 3);
  assert.equal(trimmed[0].role, "user");
});

test("trimHistoryMessages keeps the tail intact and aligns to turn boundary", () => {
  const input = [
    { role: "system", text: "compaction summary" },
    { role: "user", text: "q1" },
    { role: "assistant", text: "a1" },
    { role: "user", text: "q2" },
    { role: "assistant", text: "a2" },
  ];
  const trimmed = trimHistoryMessages(input, 1);
  assert.deepEqual(trimmed.map((m) => m.role), ["user", "assistant"]);
  assert.equal(trimmed[0].text, "q2");
});

test("trimHistoryMessages keeps the last message batch when no user turn exists", () => {
  const input = Array.from({ length: 80 }, (_, i) => ({ role: "assistant", text: `a${i}` }));
  const trimmed = trimHistoryMessages(input, 12);
  assert.equal(trimmed.length, 50);
});

test("turnTrimStartIndex/countRoleMessagesBefore align entryId slots after trim", () => {
  // 15 轮 user/assistant → trim 到 12 轮：首条保留消息是 q4（0-based 下标 6）
  const input = [];
  for (let turn = 0; turn < 15; turn += 1) {
    input.push({ role: "user", text: `q${turn + 1}` });
    input.push({ role: "assistant", text: `a${turn + 1}` });
  }
  const start = turnTrimStartIndex(input);
  assert.equal(start, 6);
  assert.equal(input[start].text, "q4");
  // 被裁掉 6 个角色消息 → activeEntryIds 应从下标 6 起切，保留消息拿到 u4..a15
  const dropped = countRoleMessagesBefore(input, start);
  assert.equal(dropped, 6);
  const entryIds = Array.from({ length: 30 }, (_, i) => `e${i}`);
  assert.equal(entryIds.slice(dropped)[0], "e6");
  assert.equal(entryIds.slice(dropped).length, 24);
});

test("countRoleMessagesBefore ignores compaction summary and non-role entries", () => {
  const input = [
    { role: "compactionSummary", summary: "compacted" },
    { role: "system", text: "sys" },
    { role: "user", text: "q1" },
    { role: "assistant", text: "a1" },
    { role: "toolResult", toolCallId: "t1" },
    { role: "user", text: "q2" },
  ];
  // 只统计消费槽位的角色消息：compactionSummary/system 不消费
  assert.equal(countRoleMessagesBefore(input, 3), 1);
  assert.equal(countRoleMessagesBefore(input, 6), 4);
});

test("trim keeps a leading system summary card + last turns (compaction retention)", () => {
  const input = [
    { role: "system", text: "compacted", meta: { type: "compaction" } },
    { role: "user", text: "q1" },
    { role: "assistant", text: "a1" },
    { role: "user", text: "q2" },
    { role: "assistant", text: "a2" },
  ];
  // 卡片不是 user 轮次：trim 只按 user 计数，卡片本身被头部裁剪丢掉的场景
  // 由 trimRuntimeCache 的 leadingSummaryCards 重新 prepend（AgentManager 测试覆盖）。
  // 此处验证 turnTrimStartIndex 不会把卡片当作轮次起点。
  const start = turnTrimStartIndex(input, 1);
  assert.equal(input[start].text, "q2");
});

test("consecutive user messages merge into a single turn for trim", () => {
  // 连发 3 条 user 无回复（同一发言权）→ 与后续 assistant 算 1 轮。
  const input = [
    { role: "user", text: "q1" },
    { role: "user", text: "q2" },
    { role: "user", text: "q3" },
    { role: "assistant", text: "a1" },
    { role: "user", text: "q4" },
    { role: "assistant", text: "a2" },
  ];
  // 整段 2 轮：trim 到 1 轮只保留 q4 起；q1-q3+a1 是同一轮，整段丢弃。
  const start = turnTrimStartIndex(input, 1);
  assert.equal(start, 4);
  assert.equal(input[start].text, "q4");
  // 4 轮上限：全段保留（起点 0）
  assert.equal(turnTrimStartIndex(input, 4), 0);
});

test("consecutive users with misc entries still merge (no split by system card)", () => {
  const input = [
    { role: "user", text: "q1" },
    { role: "system", text: "diag card" },
    { role: "user", text: "q2" },
    { role: "assistant", text: "a1" },
  ];
  // 一张轮：system 卡不打断发言权，q1+q2 合并为一个 turn。
  assert.equal(turnTrimStartIndex(input, 1), 0);
  assert.equal(turnTrimStartIndex(input, 2), 0);
});

const translateTitle = (key, params = {}) => {
  if (key === "session.newTitle") return params.locale === "en" ? "New session" : "新会话";
  if (key === "session.historyTitle") return `${params.project} 历史会话`;
  if (key === "session.historyFallbackTitle") return "历史会话";
  return key;
};

const project = { id: "p1", name: "pi-desktop", path: "D:\\proj" };

test("isDefaultAgentTitle treats draft placeholder titles as default so first prompt can auto-rename", () => {
  // 新建会话 catalog/draft 标题是 session.newTitle（「新会话」/「New session」），
  // 不是 `${project} agent`。漏判则 refreshAutoTitle 在首轮回话后直接 return，
  // 侧栏/Tab 一直停在占位名。
  assert.equal(isDefaultAgentTitle("新会话", project, translateTitle), true);
  assert.equal(
    isDefaultAgentTitle("New session", project, (key) => (
      key === "session.newTitle" ? "New session" : translateTitle(key)
    )),
    true,
  );
  assert.equal(isDefaultAgentTitle(`${project.name} agent`, project, translateTitle), true);
  assert.equal(isDefaultAgentTitle(`${project.name} DSH`, project, translateTitle), true);
  assert.equal(isDefaultAgentTitle("帮我看看这个报错", project, translateTitle), false);
  // pi 未 set_session_name 时 sessionName 是 JSONL 文件名：必须当占位，才能用首条消息自动改名。
  assert.equal(looksLikePiSessionFileStem("2026-08-08T10-47-19-239Z_abc"), true);
  // Pi 新会话通常使用带连字符的 UUID 后缀，必须继续识别为文件名而非用户标题。
  assert.equal(looksLikePiSessionFileStem("2026-08-21T03-13-27-517Z_01a01e4a-ea07-4f21-9c9a-2a4c4bbd7e91"), true);
  assert.equal(looksLikePiSessionFileStem("2026-08-08T10:47:19.239Z"), true);
  assert.equal(looksLikePiSessionFileStem("帮我看看这个报错"), false);
  assert.equal(
    isDefaultAgentTitle("2026-08-08T10-47-19-239Z_abc", project, translateTitle),
    true,
  );
  // catalog 把时间戳清成 Untitled 后仍要能自动改名，否则历史会话打开后永远叫 Untitled。
  assert.equal(isDefaultAgentTitle("Untitled", project, translateTitle), true);
  assert.equal(isDefaultAgentTitle("Untitled session", project, translateTitle), true);
});

test("inferTitleFromMessages uses the first user prompt as the session title", () => {
  const title = inferTitleFromMessages([
    { role: "user", text: "帮我看看这个报错" },
    { role: "assistant", text: "好的" },
  ]);
  assert.equal(title, "帮我看看这个报错");
});

test("inferTitleFromMessages preserves long prompts for the visual sidebar clamp", () => {
  const prompt = "修复侧栏标题：这是一个超过三十二字符的自动命名请求，末尾信息不能被截断";
  assert.equal(inferTitleFromMessages([{ role: "user", text: prompt }]), prompt);
});

test("pi runtime title changes notify catalog the same way DSH does", () => {
  // 侧栏/Tab 读 SessionRecord.title。DSH 已有 onTitleChanged → catalog.update → catalog-refreshed；
  // pi 必须走同一条，否则 refreshAutoTitle 只改 AgentTab，回话后 UI 仍显示「新会话」。
  const agentManager = readFileSync("src/main/pi/AgentManager.ts", "utf8");
  const index = readFileSync("src/main/index.ts", "utf8");
  const utils = readFileSync("src/main/pi/agentUtils.ts", "utf8");
  assert.match(utils, /session\.newTitle/);
  assert.match(utils, /session\.dshUntitled/);
  assert.match(agentManager, /setTitleChangedHandler\(/);
  assert.match(agentManager, /if \(changed \|\| forceCatalogSync\) this\.onTitleChanged\?\.\(agentId, next\)/);
  assert.match(agentManager, /applyRuntimeTitle\(agentId, data\?\.sessionName \?\? runtime\.tab\.title, false, true\)/);
  assert.match(agentManager, /looksLikePiSessionFileStem\(next\)/);
  assert.match(agentManager, /piSessionName/);
  assert.match(agentManager, /return this\.applyRuntimeTitle\(agentId, nextTitle\)/);
  assert.match(index, /agentManager\.setTitleChangedHandler\(/);
  assert.match(index, /sessionCatalog\.update\(sessionId, \{ title \}\)/);
  assert.match(index, /sessionsCatalogRefreshed/);
  assert.match(index, /Pi title sync to catalog failed/);
});
