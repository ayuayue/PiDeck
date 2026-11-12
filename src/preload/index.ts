import { contextBridge, ipcRenderer } from "electron";
import { ipcChannels } from "../shared/ipc";
import type { GitReadSnapshotResult } from "../shared/types";
import { appApi } from "./api/app";
import { chatApi } from "./api/chat";
import { cloudSyncApi } from "./api/cloudSync";
import { configApi } from "./api/config";
import { gitApi } from "./api/git";
import { integrationsApi } from "./api/integrations";
import { platformApi } from "./api/platform";
import { remoteApi } from "./api/remote";
import { resourcesApi } from "./api/resources";
import { runtimeApi } from "./api/runtime";
import { sessionGroupsApi } from "./api/sessionGroups";
import { sessionSourcesApi } from "./api/sessionSources";
import { sessionsApi } from "./api/sessions";
import { settingsApi } from "./api/settings";
import { workspaceApi } from "./api/workspace";

/**
 * 暴露面组装口。各命名空间域在 `./api/*.ts`（与 `src/renderer/src/preview/<域>.ts` 同名同域），
 * 这里只做 spread + contextBridge：方法体、通道引用与 `on*` 退订语义都在域文件里，未改变。
 */
const api = {
	...platformApi,
	...appApi,
	...workspaceApi,
	...sessionsApi,
	...sessionGroupsApi,
	...sessionSourcesApi,
	...gitApi,
	...remoteApi,
	...runtimeApi,
	...resourcesApi,
	...settingsApi,
	...configApi,
	...chatApi,
	...integrationsApi,
	...cloudSyncApi,
};

try {
	contextBridge.exposeInMainWorld("piDesktop", api);
	ipcRenderer.send(ipcChannels.preloadReady);
} catch (error) {
	const detail = error instanceof Error ? { message: error.message, stack: error.stack } : { message: String(error) };
	console.error("[PiDeck preload] Failed to expose desktop API", detail);
	ipcRenderer.send(ipcChannels.preloadError, detail);
}

/**
 * 纯事实强刷是渐进能力：真实 preload 提供实现，Web / 预览模式的 PiDesktopApi 桩不需要为一个它们用不到的
 * 远端通道补桩，因此对外类型里它是可选的（provider 用可选链做特性检测，缺省回落 refreshRemoteSnapshot）。
 */
type GitFactsRefreshSlot = { refreshRemoteGitFacts?: (projectId: string, repo?: string) => Promise<GitReadSnapshotResult> };
export type PiDesktopApi = Omit<typeof api, "git"> & { git: Omit<typeof api.git, "refreshRemoteGitFacts"> & GitFactsRefreshSlot };
