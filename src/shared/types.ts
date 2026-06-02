export type Project = {
  id: string;
  name: string;
  path: string;
  lastOpenedAt: number;
  pinned?: boolean;
};

export type AgentStatus = "starting" | "idle" | "running" | "error" | "closed";

export type AgentTab = {
  id: string;
  projectId: string;
  cwd: string;
  title: string;
  status: AgentStatus;
  sessionId?: string;
  sessionPath?: string;
  createdAt: number;
};

export type ChatRole = "user" | "assistant" | "tool" | "system" | "error";

export type ChatMessage = {
  id: string;
  agentId: string;
  role: ChatRole;
  text: string;
  timestamp: number;
  meta?: Record<string, unknown>;
  images?: ImageContent[];  // 用户消息中附加的图片
};

export type FileTreeNode = {
  name: string;
  path: string;
  relativePath: string;
  type: "file" | "directory";
  children?: FileTreeNode[];
};

export type SessionSummary = {
  id: string;
  filePath: string;
  projectPath?: string;
  name?: string;
  preview: string;
  updatedAt: number;
  messageCount: number;
};

export type PiCommand = {
  name: string;
  description?: string;
  source?: string;
};

export type AgentRuntimeState = {
  modelName?: string;
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
  isStreaming?: boolean;
  isCompacting?: boolean;
  contextTokens?: number | null;
  contextWindow?: number | null;
  contextPercent?: number | null;
  cacheRead?: number;
  cacheWrite?: number;
  cacheTotal?: number;
  cost?: number;
};

export type AvailableModel = {
  id: string;
  name?: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;
};

export type SendShortcutMode = "enter-send" | "ctrl-enter-send" | "shift-enter-send";

export type AppSettings = {
  useNativeTitleBar: boolean;
  showNativeMenu: boolean;
  sendShortcut: SendShortcutMode;
  piEnvironmentChecked: boolean;
  /** 关闭窗口时隐藏到系统托盘而不是退出 */
  closeToTray: boolean;
  /** 会话结束时发送系统通知 */
  enableNotifications: boolean;
};

export type PiInstallStatus = {
  installed: boolean;
  command?: string;
  version?: string;
  searchedDirs: string[];
  error?: string;
};

export type AppInfo = {
  version: string;
  releasesUrl: string;
};

export type PiRuntimeEvent = {
  agentId: string;
  event: unknown;
};

export type GitBranchInfo = {
  current: string | null;
  branches: string[];
};

export type CreateAgentInput = {
  projectId: string;
  title?: string;
  sessionPath?: string;
};

/** 图片内容格式，与 pi RPC 的 ImageContent 一致 */
export type ImageContent = {
  type: "image";
  data: string;      // base64 编码的图片数据
  mimeType: string;   // 如 "image/png", "image/jpeg", "image/gif", "image/webp"
};

export type SendPromptInput = {
  agentId: string;
  message: string;
  images?: ImageContent[];  // 可选的图片列表
  streamingBehavior?: "steer" | "followUp";
};
