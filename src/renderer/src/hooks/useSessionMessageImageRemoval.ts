import { useCallback, useRef } from "react";
import type { ChatMessage, SessionMessageImageTarget } from "../../../shared/types";
import { desktopApi } from "../desktopApi";
import { t } from "../i18n";
import { messageEntryId, requireSessionCommand } from "../utils/sessionCommands";
import { visionImageHash } from "../utils/visionImageHash";
import type { SessionHistoryMutationsDeps } from "./useSessionHistoryMutations";

/** 单图移除确认：由所属 pane 传 sessionId，异步阶段不再读取全局焦点。 */
export function useSessionMessageImageRemoval(args: { deps: SessionHistoryMutationsDeps; runFileMutation: (sessionId: string, work: () => Promise<void>) => Promise<void>; onFailure: (prefix: string, error: unknown) => void }) {
	const argsRef = useRef(args);
	argsRef.current = args;
	return useCallback((sessionId: string, message: ChatMessage, index: number) => {
		const { deps, runFileMutation, onFailure } = argsRef.current;
		const image = message.images?.[index];
		if (message.role !== "user" || !Number.isSafeInteger(index) || index < 0 || !image?.data) return;
		if (!deps.hasPersistedSessionFile(sessionId)) {
			deps.showToast(t("message.removeImageUnsupported"), 4000);
			return;
		}
		// 确认框打开时即固定身份/数量/字节快照；随后切换会话或消息重新投影不改变目标。
		const messageId = message.id;
		const entryId = messageEntryId(message);
		const data = image.data;
		const expectedImageCount = message.images?.length ?? 0;
		const live = deps.isSessionRuntimeLive(sessionId);
		deps.showConfirm({
			title: t("message.removeImage"),
			message: t(live ? "message.removeImageStopBody" : "message.removeImageBody"),
			danger: true,
			confirmLabel: t("message.removeImage"),
			onConfirm: async () => {
				deps.clearConfirm();
				try {
					const imageTarget: SessionMessageImageTarget = { index, expectedImageCount, expectedHash: await visionImageHash(data, 64) };
					await runFileMutation(sessionId, async () => {
						requireSessionCommand(await desktopApi.sessions.removeCatalogMessageImage(sessionId, messageId, imageTarget, entryId));
					});
				} catch (error) {
					onFailure(t("message.removeImageFailed"), error);
				}
			},
		});
	}, []);
}
