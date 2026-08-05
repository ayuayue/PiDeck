import type {
  Project,
  SessionSummary,
  SessionEnvironment,
  AgentTab,
} from "../../shared/types";
import { isSameSessionPath } from "./agentListDisplay";

// 默认高度偏矮，给 timeline 多留正文。
// 最小高度必须 ≥ composer-box CSS min-height(112) + footer pb(12) + 边框余量，
// 否则拖到最低会裁切模式/模型底栏并出现多余滚动条。
export const COMPOSER_DEFAULT_HEIGHT = 160;
const COMPOSER_MIN_HEIGHT = 148;
export { COMPOSER_MIN_HEIGHT };

// timeline 面板 minSize（px）：composer 自动增高时只能占用 timeline 可让出的空间，
// 不能突破该保底线，否则库的 clamp 会把差额压给 terminal 导致终端被收起。
export const TIMELINE_MIN_HEIGHT = 160;

/**
 * composer 程序化增高时，从 timeline 可让出空间里取预算（百分比）。
 *
 * 背景：AI 输出/发送消息时 composer 上方出现投递通知/widgets，programResize 增高
 * composer 需要从 timeline 扣空间；若 timeline 已到 minSize 保底，库会把 clamp 差额
 * 按面板顺序分摊，最后压到 collapsible 的 terminal 面板，terminal 低于折叠阈值即被
 * 收起。这里把 delta 限制在 timeline 可让出的范围内，保证 setLayout 后各面板不触底。
 *
 * @param layout 当前 group 布局（百分比，键含 timeline）
 * @param composerCurrentPct composer 当前百分比
 * @param targetPct composer 目标百分比
 * @param groupPx group 总高（px），用于把 minSize px 转成百分比
 * @param timelineMinPx timeline minSize（px）
 * @returns 新的 { composer, timeline } 百分比（terminal 不动，由调用方保持）
 */
export function growComposerWithinTimelineBudget(
	layout: Record<string, number>,
	composerCurrentPct: number,
	targetPct: number,
	groupPx: number,
	timelineMinPx: number,
): { composer: number; timeline: number } {
	const timelineCurrent = layout.timeline ?? 0;
	const timelineMinPct = groupPx > 0 ? (timelineMinPx / groupPx) * 100 : 0;
	const maxGive = Math.max(0, timelineCurrent - timelineMinPct);
	const delta = Math.min(targetPct - composerCurrentPct, maxGive);
	return {
		composer: composerCurrentPct + delta,
		timeline: timelineCurrent - delta,
	};
}

// Ask 区域垂直 resize 手把的约束（AskRegionResizer 使用）：
// 180=紧凑展开时默认高度上限，70=收窄下限，280=可在面板内拉高的最大值，
// 8=键盘步进（PageUp/PageDown 为 4 倍）。上限不会强迫留白：Ask 折叠时只显示实际内容。
export const ASK_DEFAULT_MAX_HEIGHT = 180;
export const ASK_MIN_HEIGHT = 70;
export const ASK_MAX_HEIGHT = 280;
export const ASK_STEP_PX = 8;

export function displayProjectDirectoryName(project: Project) {
  if (isChatProject(project)) return "Chat";
  const normalizedPath = project.path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalizedPath.split("/").pop() || project.name || project.path;
}

export function isChatProject(project?: Project) {
  return project?.kind === "chat";
}

export function formatCodexSubagentName(session: SessionSummary) {
  const label = [session.codexAgentNickname, session.codexAgentRole]
    .filter(Boolean)
    .join(" · ");
  return label || session.name || "Codex Subagent";
}

/** pi 原生子会话名称：优先使用会话名，回退到 "子会话" */
export function formatPiSubagentName(session: SessionSummary) {
  return session.name || "Pi Subagent";
}

/** 从 localStorage 恢复会话来源过滤配置 */
export function loadSessionSourceFilter(): Record<string, Set<"pi" | "codex" | "claude" | "opencode"> | null> {
  try {
    const raw = localStorage.getItem("pideck-session-source-filter");
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    const result: Record<string, Set<"pi" | "codex" | "claude" | "opencode"> | null> = {};
    for (const [key, val] of Object.entries(parsed)) {
      if (val === null) {
        result[key] = null;
      } else if (Array.isArray(val)) {
        result[key] = new Set(val);
      }
    }
    return result;
  } catch {
    return {};
  }
}

/** 将会话来源过滤持久化到 localStorage */
export function saveSessionSourceFilter(filter: Record<string, Set<"pi" | "codex" | "claude" | "opencode"> | null>) {
  try {
    const obj: Record<string, string[] | null> = {};
    for (const [key, val] of Object.entries(filter)) {
      obj[key] = val === null ? null : [...val];
    }
    localStorage.setItem("pideck-session-source-filter", JSON.stringify(obj));
  } catch {
    // 静默失败
  }
}

export function inferSessionEnvironment(filePath?: string): SessionEnvironment {
  return filePath?.startsWith("/") ? "wsl" : "native";
}

export type PendingAgentTab = AgentTab & {
  pendingKind?: "create" | "restart";
  pendingStartedAt?: number;
};

export function isReplacementForPendingAgent(agent: AgentTab, pending: PendingAgentTab) {
  if (agent.projectId !== pending.projectId || agent.cwd !== pending.cwd)
    return false;

  const environment = inferSessionEnvironment(pending.sessionPath);
  if (pending.pendingKind === "restart") {
    const startedAt = pending.pendingStartedAt ?? pending.createdAt;
    // 重启占位只匹配本次重启之后出现的新进程，避免误选同项目下已有的同名 Agent。
    if (agent.createdAt < startedAt - 1000) return false;
    if (isSameSessionPath(agent.sessionPath, pending.sessionPath)) return true;
    return !pending.sessionPath && agent.title === pending.title;
  }

  if (!pending.id.startsWith("pending-")) return false;
  if (isSameSessionPath(agent.sessionPath, pending.sessionPath)) return true;
  if (pending.sessionPath && agent.createdAt >= pending.createdAt - 1000)
    return true;
  return (
    agent.title === pending.title && agent.createdAt >= pending.createdAt - 1000
  );
}

export function isPendingAgentId(agentId?: string) {
  return Boolean(agentId?.startsWith("pending-"));
}

export function migrateAgentRecord<T>(
  current: Record<string, T>,
  replacementById: Map<string, string>,
  liveIds: Set<string>,
) {
  const next: Record<string, T> = {};
  for (const [agentId, value] of Object.entries(current)) {
    const nextAgentId = replacementById.get(agentId) ?? agentId;
    if (liveIds.has(nextAgentId)) next[nextAgentId] = value;
  }
  return next;
}
