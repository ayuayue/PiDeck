/**
 * preload sessionGroups 域：会话关系面：会话分组与关联会话。
 *
 * 组装口 `src/preload/index.ts` 只做 spread；方法体 / 参数名 / 通道引用与拆分前逐字一致。
 */
import { ipcRenderer } from "electron";
import { ipcChannels } from "../../shared/ipc";
import { subscribe } from "./ipcHelpers";
import type { AnswerLinkedSessionProposalInput, AnswerLinkedSessionProposalResult, LinkedSessionsSnapshot } from "../../shared/types/linkedSessions";
import type { SessionGroup } from "../../shared/types/sessionGroups";

export const sessionGroupsApi = {

	// ── 会话分组（userData/session-groups.json）：侧栏只读消费，写入方是插件页 ──
	sessionGroups: {
		list: () => ipcRenderer.invoke(ipcChannels.sessionGroupsList) as Promise<SessionGroup[]>,
		save: (input: unknown) => ipcRenderer.invoke(ipcChannels.sessionGroupsSave, input) as Promise<SessionGroup[]>,
		delete: (groupId: string) => ipcRenderer.invoke(ipcChannels.sessionGroupsDelete, groupId) as Promise<boolean>,
		reorder: (groupIds: string[]) => ipcRenderer.invoke(ipcChannels.sessionGroupsReorder, groupIds) as Promise<SessionGroup[]>,
		onChanged: (callback: () => void) => subscribe(ipcChannels.sessionGroupsChanged, callback),
	},
	linkedSessions: {
		snapshot: () => ipcRenderer.invoke(ipcChannels.linkedSessionsSnapshot) as Promise<LinkedSessionsSnapshot>,
		answer: (input: AnswerLinkedSessionProposalInput) => ipcRenderer.invoke(ipcChannels.linkedSessionsAnswer, input) as Promise<AnswerLinkedSessionProposalResult>,
		archive: (childSessionId: string, archived = true) => ipcRenderer.invoke(ipcChannels.linkedSessionsArchive, childSessionId, archived) as Promise<boolean>,
		onChanged: (callback: () => void) => subscribe(ipcChannels.linkedSessionsChanged, callback),
	},
};
