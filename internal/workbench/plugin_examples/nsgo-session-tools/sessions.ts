export type SessionTotals = {
  sessions: number;
  messages: number;
  pi: number;
  acp: number;
};

// Only this bounded projection crosses the example's host channel. A real
// host must bound and validate its response before sending it as well.
export function summarizeSessions(value: unknown): SessionTotals {
  if (!Array.isArray(value) || value.length > 200) {
    throw new Error("一次最多处理 200 个会话摘要");
  }
  const totals: SessionTotals = { sessions: value.length, messages: 0, pi: 0, acp: 0 };
  for (const row of value) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error("会话摘要格式无效");
    }
    const { backend, messages } = row as Record<string, unknown>;
    if (backend !== "pi" && backend !== "acp") throw new Error("后端标识无效");
    if (typeof messages !== "number" || !Number.isSafeInteger(messages) || messages < 0) {
      throw new Error("消息数量无效");
    }
    totals[backend]++;
    totals.messages += messages;
    if (!Number.isSafeInteger(totals.messages)) throw new Error("消息总数超出范围");
  }
  return totals;
}
