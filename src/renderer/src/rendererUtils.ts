import type {
  Project,
  SessionSummary,
  SessionEnvironment,
  AgentTab,
} from "../../shared/types";
import { isSameSessionPath } from "./agentListDisplay";
import {
  parseSessionFilterState,
  serializeSessionFilterState,
  type SessionFilterPill,
} from "./sessionFilterPills";

// 输入卡本身的最小高度：输入区 + 模式/模型底栏。footer 的 8px 底 padding 由内容撑开。
export const COMPOSER_DEFAULT_HEIGHT = 160;
const COMPOSER_MIN_HEIGHT = 112;
export { COMPOSER_MIN_HEIGHT };
// 输入栏在时间线列内的高度上限：再高就让独立卡内部滚动，不吃掉对话区。
export const COMPOSER_MAX_HEIGHT = 480;

/** 输入正文区封顶高度（px），对齐 dsh-web `--dsh-composer-text-max-height`。
 *  超过后 ProseMirror 内部滚动，不再把输入卡/面板无限撑高。 */
export const COMPOSER_TEXT_MAX_HEIGHT = 336;

/**
 * 粘贴大文本转文件的最小字符数（含换行）。
 * 低于该阈值仍直接插入编辑器（打字/短文本体验不受影响）；
 * 达到阈值后落盘成文件 + chip 展示，发送时折叠 @引用——
 * 避免超大文本进入 ProseMirror 文档模型后输入/光标/建议框逐键变卡。
 */
export const PASTE_TO_FILE_MIN_CHARS = 5000;

// timeline 列（对话区 + 固有高度输入栏）保底：窗口再矮也不把对话区压没。
export const TIMELINE_MIN_HEIGHT = 160;

/** 当前垂直 Group 实际挂了哪些面板（timeline 始终在；composer 是列内固有高度，不是面板）。 */
export type SessionPanelSet = {
	terminal: boolean;
};

/**
 * 是否在时间线列底部挂输入栏。
 *
 * 起始页（空会话且磁盘已就绪）在 timeline 内居中挂同一 ComposerArea，底部栏不重复。
 * 加载中即使 messages 仍为空也要挂底部栏，避免历史会话首帧闪一下居中起始页。
 */
export function shouldMountBottomComposer(input: {
	hasActiveConversation: boolean;
	messageCount: number;
	isConversationLoading: boolean;
}): boolean {
	if (!input.hasActiveConversation) return false;
	if (input.messageCount > 0) return true;
	return input.isConversationLoading;
}

/** 终端面板挂载变化时强制重建 Group，避免 2 值缓存套到 1 面板上。 */
export function sessionResizableGroupKey(panels: SessionPanelSet): string {
	return panels.terminal ? "session-group-2p" : "session-group-1p";
}

/**
 * setLayout 的键必须与当前已注册面板一致，否则 K() 抛
 * `Invalid N panel layout: a%, b%`。关终端后 getLayout 仍可能带旧键。
 * 差额全部还给 timeline。
 */
export function sanitizeSessionPanelLayout(
	layout: Record<string, number>,
	panels: SessionPanelSet,
): Record<string, number> {
	const terminal = panels.terminal ? layout.terminal : undefined;
	const timeline = Math.max(0, 100 - (terminal ?? 0));
	const next: Record<string, number> = {};
	// 必须沿用 getLayout() 的键序：K() 用 Object.values 下标对齐 panelConstraints。
	for (const key of Object.keys(layout)) {
		if (key === "timeline") next.timeline = timeline;
		else if (key === "terminal" && terminal !== undefined) next.terminal = terminal;
	}
	if (next.timeline === undefined) next.timeline = timeline;
	if (terminal !== undefined && next.terminal === undefined) next.terminal = terminal;
	return next;
}

/**
 * Group 首帧 defaultLayout（百分比，键序 = DOM：timeline → terminal）。
 * 不传时库 He() 在 groupSize=0 会均分。
 */
export function sessionGroupDefaultLayout(
	panels: SessionPanelSet,
	terminalPx: number,
	groupPx: number,
): Record<string, number> {
	const safeGroup = Math.max(groupPx, 1);
	const terminalPct = panels.terminal
		? Math.min(50, Math.max(0, (Math.max(terminalPx, 0) / safeGroup) * 100))
		: 0;
	const next: Record<string, number> = {
		timeline: Math.max(0, 100 - terminalPct),
	};
	if (panels.terminal) next.terminal = terminalPct;
	return next;
}

/**
 * 折叠/展开终端后重排：差额全部由 timeline 承担。
 * 输入栏在列内固有高度，不占 Group 百分比，因此这里不再锁 composer。
 */
export function redistributeTerminalAgainstTimeline(
	layout: Record<string, number>,
	terminalPct: number,
	timelineMinPct = 0,
): Record<string, number> | null {
	if (layout.timeline === undefined || layout.terminal === undefined) return null;
	let terminal = Math.max(0, terminalPct);
	let timeline = 100 - terminal;
	if (timeline < timelineMinPct) {
		terminal = Math.max(0, terminal - (timelineMinPct - timeline));
		timeline = 100 - terminal;
	}
	return {
		...layout,
		terminal,
		timeline: Math.max(0, timeline),
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
  const dirName = normalizedPath.split("/").pop() || "";
  // 用户重命名过（name 与目录名不同）时优先展示自定义名，否则回退目录名：
  // 未重命名的项目 name 就是目录 basename，展示行为与旧版完全一致。
  if (!dirName) return project.name || project.path;
  return project.name && project.name !== dirName ? project.name : dirName;
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

/** 从 localStorage 恢复会话来源过滤配置（v2 格式，含旧版迁移，见 sessionFilterPills） */
export function loadSessionSourceFilter(): Record<string, Set<SessionFilterPill> | null> {
  try {
    return parseSessionFilterState(localStorage.getItem("pideck-session-source-filter"));
  } catch {
    return {};
  }
}

/** 将会话来源过滤持久化到 localStorage（与侧栏过滤菜单共用同一份配置） */
export function saveSessionSourceFilter(filter: Record<string, Set<SessionFilterPill> | null>) {
  try {
    localStorage.setItem("pideck-session-source-filter", serializeSessionFilterState(filter));
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

/**
 * 会话时长只在 running → idle 边沿落一次。
 * 旧实现只要 status===idle 且还有 start 就 Date.now() setState；displayAgents
 * 每帧换新引用时会把 React 更新深度打满（设置/关窗点不动）。
 */
export function stampIdleSessionDuration(input: {
  previousStatus: AgentTab["status"] | undefined;
  status: AgentTab["status"];
  startedAt: number | undefined;
  now: number;
}): { startedAt?: number; durationMs?: number; clearStart?: boolean } {
  if (input.status === "running") {
    if (input.previousStatus !== "running") {
      return { startedAt: input.now };
    }
    return { startedAt: input.startedAt };
  }
  if (input.status === "idle" && input.previousStatus === "running" && input.startedAt) {
    return {
      startedAt: input.startedAt,
      durationMs: input.now - input.startedAt,
      clearStart: true,
    };
  }
  return { startedAt: input.startedAt };
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
