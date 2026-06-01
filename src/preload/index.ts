import { contextBridge, ipcRenderer } from "electron";
import { ipcChannels } from "../shared/ipc";
import type { AgentRuntimeState, AgentTab, AppInfo, AppSettings, AvailableModel, ChatMessage, CreateAgentInput, FileTreeNode, GitBranchInfo, PiCommand, PiInstallStatus, Project, SendPromptInput, SessionSummary } from "../shared/types";

const api = {
  projects: {
    list: () => ipcRenderer.invoke(ipcChannels.projectsList) as Promise<Project[]>,
    add: () => ipcRenderer.invoke(ipcChannels.projectsAdd) as Promise<Project | null>,
    remove: (id: string) => ipcRenderer.invoke(ipcChannels.projectsRemove, id) as Promise<Project[]>,
    onChanged: (callback: (projects: Project[]) => void) => subscribe(ipcChannels.projectsChanged, callback),
  },
  files: {
    list: (projectId: string) => ipcRenderer.invoke(ipcChannels.filesList, projectId) as Promise<FileTreeNode[]>,
    open: (path: string) => ipcRenderer.invoke(ipcChannels.filesOpen, path) as Promise<void>,
    showInFolder: (path: string) => ipcRenderer.invoke(ipcChannels.filesShowInFolder, path) as Promise<void>,
  },
  sessions: {
    list: (projectId?: string) => ipcRenderer.invoke(ipcChannels.sessionsList, projectId) as Promise<SessionSummary[]>,
    rename: (filePath: string, newName: string) => ipcRenderer.invoke(ipcChannels.sessionsRename, filePath, newName) as Promise<void>,
  },
  git: {
    branches: (projectId: string) => ipcRenderer.invoke(ipcChannels.gitBranches, projectId) as Promise<GitBranchInfo>,
    checkout: (projectId: string, branch: string) => ipcRenderer.invoke(ipcChannels.gitCheckout, projectId, branch) as Promise<GitBranchInfo>,
  },
  pi: {
    check: () => ipcRenderer.invoke(ipcChannels.piCheck) as Promise<PiInstallStatus>,
  },
  app: {
    info: () => ipcRenderer.invoke(ipcChannels.appInfo) as Promise<AppInfo>,
    openExternal: (url: string) => ipcRenderer.invoke(ipcChannels.appOpenExternal, url) as Promise<void>,
  },
  settings: {
    get: () => ipcRenderer.invoke(ipcChannels.settingsGet) as Promise<AppSettings>,
    update: (patch: Partial<AppSettings>) => ipcRenderer.invoke(ipcChannels.settingsUpdate, patch) as Promise<AppSettings>,
    onApplyWindow: (callback: (settings: AppSettings) => void) => subscribe(ipcChannels.settingsApplyWindow, callback),
  },
  agents: {
    list: () => ipcRenderer.invoke(ipcChannels.agentsList) as Promise<AgentTab[]>,
    create: (input: CreateAgentInput) => ipcRenderer.invoke(ipcChannels.agentsCreate, input) as Promise<AgentTab>,
    stop: (agentId: string) => ipcRenderer.invoke(ipcChannels.agentsStop, agentId) as Promise<void>,
    prompt: (input: SendPromptInput) => ipcRenderer.invoke(ipcChannels.agentsPrompt, input) as Promise<void>,
    abort: (agentId: string) => ipcRenderer.invoke(ipcChannels.agentsAbort, agentId) as Promise<void>,
    exportHtml: (agentId: string) => ipcRenderer.invoke(ipcChannels.agentsExportHtml, agentId) as Promise<{ path: string }>,
    reload: (agentId: string) => ipcRenderer.invoke(ipcChannels.agentsReload, agentId) as Promise<void>,
    restart: (agentId: string) => ipcRenderer.invoke(ipcChannels.agentsRestart, agentId) as Promise<AgentTab>,
    compact: (agentId: string) => ipcRenderer.invoke(ipcChannels.agentsCompact, agentId) as Promise<AgentRuntimeState>,
    runtimeState: (agentId: string) => ipcRenderer.invoke(ipcChannels.agentsRuntimeState, agentId) as Promise<AgentRuntimeState>,
    cycleModel: (agentId: string) => ipcRenderer.invoke(ipcChannels.agentsCycleModel, agentId) as Promise<AgentRuntimeState>,
    availableModels: (agentId: string) => ipcRenderer.invoke(ipcChannels.agentsAvailableModels, agentId) as Promise<AvailableModel[]>,
    setModel: (agentId: string, provider: string, modelId: string) => ipcRenderer.invoke(ipcChannels.agentsSetModel, agentId, provider, modelId) as Promise<AgentRuntimeState>,
    cycleThinking: (agentId: string) => ipcRenderer.invoke(ipcChannels.agentsCycleThinking, agentId) as Promise<AgentRuntimeState>,
    setThinking: (agentId: string, level: string) => ipcRenderer.invoke(ipcChannels.agentsSetThinking, agentId, level) as Promise<AgentRuntimeState>,
    commands: (agentId: string) => ipcRenderer.invoke("agents:commands", agentId) as Promise<PiCommand[]>,
    onState: (callback: (tabs: AgentTab[]) => void) => subscribe(ipcChannels.agentsState, callback),
    onMessages: (callback: (payload: { agentId: string; messages: ChatMessage[] }) => void) => subscribe(ipcChannels.agentsMessage, callback),
    onLog: (callback: (payload: { agentId: string; text: string }) => void) => subscribe(ipcChannels.agentsLog, callback),
  },
};

function subscribe<T>(channel: string, callback: (payload: T) => void) {
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("piDesktop", api);

export type PiDesktopApi = typeof api;
