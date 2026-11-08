/**
 * 关联会话 IPC：只做边界适配（入参校验 / 日志），业务在 LinkedSessionService。
 * 渲染层只读快照、在提议卡片上作答、归档子会话；建会话与转发消息都由主进程按关系表裁决。
 */
import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { AnswerLinkedSessionProposalResult, LinkedSessionProposalAnswer, LinkedSessionsSnapshot } from "../../shared/types/linkedSessions";
import type { LinkedSessionService } from "../linkedSessions/LinkedSessionService";
import type { LinkedSessionStore } from "../linkedSessions/LinkedSessionStore";
import type { AppLogger } from "../logging/AppLogger";

export type LinkedSessionsIpcDeps = {
	store: LinkedSessionStore;
	service: LinkedSessionService;
	appLogger: AppLogger;
};

const ANSWERS: readonly LinkedSessionProposalAnswer[] = ["new", "here", "dismiss"];

function parseId(value: unknown): string {
	const id = typeof value === "string" ? value.trim() : "";
	if (!id || id.length > 500) throw new Error("invalid-linked-session-id");
	return id;
}

export function registerLinkedSessionsIpc(deps: LinkedSessionsIpcDeps): () => void {
	const { store, service, appLogger } = deps;

	ipcMain.handle(ipcChannels.linkedSessionsSnapshot, async (): Promise<LinkedSessionsSnapshot> => store.snapshot());

	ipcMain.handle(ipcChannels.linkedSessionsAnswer, async (_event, input: unknown): Promise<AnswerLinkedSessionProposalResult> => {
		const record = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
		const proposalId = parseId(record.proposalId);
		const answer = ANSWERS.find((candidate) => candidate === record.answer);
		if (!answer) throw new Error("invalid-linked-session-answer");
		const result = await service.answerProposal({ proposalId, answer });
		void appLogger.info("linked-sessions", "Proposal answered", { proposalId, answer, ok: result.ok });
		return result;
	});

	ipcMain.handle(ipcChannels.linkedSessionsArchive, async (_event, childSessionId: unknown, archived: unknown): Promise<boolean> => {
		return service.archive(parseId(childSessionId), archived !== false);
	});

	return () => {
		ipcMain.removeHandler(ipcChannels.linkedSessionsSnapshot);
		ipcMain.removeHandler(ipcChannels.linkedSessionsAnswer);
		ipcMain.removeHandler(ipcChannels.linkedSessionsArchive);
	};
}
