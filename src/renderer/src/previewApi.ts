import type { PiDesktopApi } from "../../preload";
import type { AgentTab, AppSettings, ChatMessage, FileTreeNode, Project, SessionSummary } from "../../shared/types";

const now = Date.now();

const projects: Project[] = [
  { id: "preview-project", name: "preview-project", path: "C:/Users/14012/preview-project", lastOpenedAt: now },
];

const agents: AgentTab[] = [
  { id: "preview-agent", projectId: "preview-project", cwd: projects[0].path, title: "预览会话", status: "idle", sessionId: "preview", createdAt: now },
];

const messages: ChatMessage[] = [
  { id: "m1", agentId: "preview-agent", role: "user", text: "帮我总结一下这个项目", timestamp: now - 120000 },
  { id: "m2", agentId: "preview-agent", role: "assistant", text: "## 项目概览\n\n这是浏览器预览模式，用来检查 UI 响应式布局。\n\n- 支持 Markdown\n- 支持消息定位\n- 支持工具详情展开", timestamp: now - 90000 },
  { id: "m3", agentId: "preview-agent", role: "tool", text: "✓ read done", timestamp: now - 60000, meta: { detailText: "工具：read\n状态：完成\n结果：预览模式工具调用详情" } },
];

const files: FileTreeNode[] = [
  { name: "src", path: "C:/Users/14012/preview-project/src", relativePath: "src", type: "directory", children: [
    { name: "App.tsx", path: "C:/Users/14012/preview-project/src/App.tsx", relativePath: "src/App.tsx", type: "file" },
  ] },
  { name: "README.md", path: "C:/Users/14012/preview-project/README.md", relativePath: "README.md", type: "file" },
];

const sessions: SessionSummary[] = [
  { id: "s1", filePath: "preview.jsonl", projectPath: projects[0].path, name: "预览历史会话", preview: "这里展示历史会话摘要", updatedAt: now, messageCount: 3 },
];

export function createPreviewApi(): PiDesktopApi {
  const noop = (() => () => undefined) as any;
  return {
    projects: {
      list: async () => projects,
      add: async () => projects[0],
      remove: async () => projects,
      onChanged: noop,
    },
    files: {
      list: async () => files,
      open: async () => undefined,
      showInFolder: async () => undefined,
    },
    sessions: {
      list: async () => sessions,
      rename: async () => undefined,
    },
    git: {
      branches: async () => ({ current: "main", branches: ["main", "dev"] }),
      checkout: async (_projectId, branch) => ({ current: branch, branches: ["main", "dev"] }),
    },
    pi: {
      check: async () => ({ installed: true, command: "pi", version: "preview", searchedDirs: [] }),
    },
    app: {
      info: async () => ({ version: "preview", releasesUrl: "https://github.com/ayuayue/pi-desktop/releases" }),
      openExternal: async () => undefined,
    },
    settings: {
      get: async (): Promise<AppSettings> => ({ useNativeTitleBar: true, showNativeMenu: false, sendShortcut: "enter-send", piEnvironmentChecked: true, closeToTray: true }),
      update: async (patch): Promise<AppSettings> => ({ useNativeTitleBar: true, showNativeMenu: false, sendShortcut: "enter-send", piEnvironmentChecked: true, closeToTray: true, ...patch }),
      onApplyWindow: noop,
    },
    agents: {
      list: async () => agents,
      create: async () => agents[0],
      stop: async () => undefined,
      prompt: async () => undefined,
      abort: async () => undefined,
      exportHtml: async () => ({ path: "preview.html" }),
      reload: async () => undefined,
      restart: async (agentId: string) => ({ id: agentId, projectId: "preview", cwd: "/preview", title: "Preview Agent", status: "idle" as const, createdAt: Date.now() }),
      compact: async () => ({ modelName: "Preview GPT", provider: "preview", modelId: "preview", thinkingLevel: "low", contextPercent: 5, contextTokens: 5000, contextWindow: 100000, cacheTotal: 53000000 }),
      runtimeState: async () => ({ modelName: "Preview GPT", provider: "preview", modelId: "preview", thinkingLevel: "low", contextPercent: 12, contextTokens: 12000, contextWindow: 100000, cacheTotal: 53000000 }),
      cycleModel: async () => ({ modelName: "Preview GPT", thinkingLevel: "low" }),
      availableModels: async () => [{ id: "preview", name: "Preview GPT", provider: "preview" }],
      setModel: async () => ({ modelName: "Preview GPT", thinkingLevel: "low" }),
      cycleThinking: async () => ({ modelName: "Preview GPT", thinkingLevel: "medium" }),
      setThinking: async (_agentId, level) => ({ modelName: "Preview GPT", thinkingLevel: level }),
      commands: async () => [{ name: "reload", description: "Reload runtime", source: "builtin" }],
      onState: noop,
      onMessages: ((callback: (payload: { agentId: string; messages: ChatMessage[] }) => void) => { setTimeout(() => callback({ agentId: "preview-agent", messages }), 0); return () => undefined; }) as any,
      onLog: noop,
    },
  };
}
