type SessionSummary = { backend?: string; messages?: number };

// Pure functions take a bounded, explicitly supplied projection. They do
// not own session files, query a global store or require host privileges.
export function summarizeSessions(sessions: SessionSummary[]) {
  if (!Array.isArray(sessions) || sessions.length > 200) {
    throw new Error("一次最多处理 200 个会话摘要");
  }
  const backends: Record<string, number> = {};
  let messages = 0;
  for (const session of sessions) {
    if (!session || typeof session !== "object") throw new Error("会话摘要无效");
    const backend = typeof session.backend === "string" ? session.backend : "unknown";
    if (!["pi", "acp", "unknown"].includes(backend)) throw new Error("后端标识无效");
    const count = session.messages ?? 0;
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("消息数量无效");
    backends[backend] = (backends[backend] ?? 0) + 1;
    messages += count;
    if (!Number.isSafeInteger(messages)) throw new Error("消息总数超出范围");
  }
  return { total: sessions.length, messages, backends };
}
