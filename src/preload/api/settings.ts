/**
 * preload settings 域：设置面：外部编辑器、应用设置、安全配置。
 *
 * 组装口 `src/preload/index.ts` 只做 spread；方法体 / 参数名 / 通道引用与拆分前逐字一致。
 */
import { ipcRenderer } from "electron";
import { ipcChannels } from "../../shared/ipc";
import { subscribe } from "./ipcHelpers";
import type { AppSettings, ExternalEditor, ExternalEditorId, ExternalEditorSetting, PiProxyTestResult, SecurityConfig, WebServiceStatusInfo } from "../../shared/types";

export const settingsApi = {
	editors: {
		list: () => ipcRenderer.invoke(ipcChannels.editorsList) as Promise<ExternalEditor[]>,
		redetect: () => ipcRenderer.invoke(ipcChannels.editorsRedetect) as Promise<AppSettings>,
		update: (editorId: ExternalEditorId, patch: Partial<ExternalEditorSetting>) => ipcRenderer.invoke(ipcChannels.editorsUpdate, editorId, patch) as Promise<AppSettings>,
		chooseExecutable: () => ipcRenderer.invoke(ipcChannels.editorsChooseExecutable) as Promise<string | null>,
		openProject: (editor: ExternalEditor, projectPath: string) => ipcRenderer.invoke(ipcChannels.editorsOpenProject, editor, projectPath) as Promise<void>,
	},
	settings: {
		get: () => ipcRenderer.invoke(ipcChannels.settingsGet) as Promise<AppSettings>,
		update: (patch: Partial<AppSettings>) => ipcRenderer.invoke(ipcChannels.settingsUpdate, patch) as Promise<AppSettings>,
		restartWebService: () => ipcRenderer.invoke(ipcChannels.settingsRestartWebService) as Promise<void>,
		webServiceStatus: () => ipcRenderer.invoke(ipcChannels.webServiceStatus) as Promise<WebServiceStatusInfo>,
		rotateWebToken: () => ipcRenderer.invoke(ipcChannels.webServiceRotateToken) as Promise<WebServiceStatusInfo>,
		setWebToken: (input: { token?: string; expiresIn?: number }) => ipcRenderer.invoke(ipcChannels.webServiceSetToken, input) as Promise<WebServiceStatusInfo>,
		/** 外网访问：聚合状态（cloudflare 隧道 + tailscale + EasyTier 只读渠道） */
		webRemoteAccessState: () => ipcRenderer.invoke(ipcChannels.webRemoteAccessState) as Promise<import("../../shared/types/remoteAccess").RemoteAccessState>,
		/** 启动外网访问渠道；EasyTier 可附带「当前草稿配置」以便未保存也能直接启动 */
		webRemoteAccessStart: (channel: import("../../shared/types/remoteAccess").RemoteAccessChannelId, easyTierConfig?: { networkName: string; networkSecret: string; peers: string[]; bindIpv4: string }) =>
			ipcRenderer.invoke(ipcChannels.webRemoteAccessStart, channel, easyTierConfig) as Promise<{ ok: true; state: import("../../shared/types/remoteAccess").RemoteAccessState } | { ok: false; error: string }>,
		/** 停用外网访问渠道 */
		webRemoteAccessStop: (channel: import("../../shared/types/remoteAccess").RemoteAccessChannelId) => ipcRenderer.invoke(ipcChannels.webRemoteAccessStop, channel) as Promise<{ ok: true; state: import("../../shared/types/remoteAccess").RemoteAccessState } | { ok: false; error: string }>,
		/** 重新探测外网访问环境（二进制/登录态/serve 指向） */
		webRemoteAccessRefresh: () => ipcRenderer.invoke(ipcChannels.webRemoteAccessRefresh) as Promise<import("../../shared/types/remoteAccess").RemoteAccessState>,
		/** 外网访问状态变化推送；返回退订函数 */
		onWebRemoteAccessChanged: (callback: (state: import("../../shared/types/remoteAccess").RemoteAccessState) => void) => subscribe(ipcChannels.webRemoteAccessChanged, callback),
		testPiProxy: () => ipcRenderer.invoke(ipcChannels.settingsTestPiProxy) as Promise<PiProxyTestResult>,
		onApplyWindow: (callback: (settings: AppSettings) => void) => subscribe(ipcChannels.settingsApplyWindow, callback),
	},
	security: {
		getConfig: () => ipcRenderer.invoke(ipcChannels.securityGetConfig) as Promise<SecurityConfig>,
		updateConfig: (patch: Partial<SecurityConfig>) => ipcRenderer.invoke(ipcChannels.securityUpdateConfig, patch) as Promise<{ ok: true; config: SecurityConfig } | { ok: false; error: string }>,
		setSessionLevel: (sessionId: string, levelId: string | null) => ipcRenderer.invoke(ipcChannels.securitySetSessionLevel, sessionId, levelId) as Promise<{ ok: true; config: SecurityConfig } | { ok: false; error: string }>,
		/** 安全配置变更（任一端修改）：接收方重拉 getConfig 刷新菜单；返回退订函数。 */
		onConfigChanged: (callback: () => void) => subscribe(ipcChannels.securityConfigChanged, callback),
	},
};
