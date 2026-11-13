import type { createStore } from "jotai";
import { sessionMessagesCacheAtom } from "../../atoms";
import { setSessionAttachmentsAtom, setSessionDraftAtom } from "../../atoms/composer-atoms";
import { hydrateImageContents } from "../../../../shared/imageContentSrc";
import { t } from "../../i18n";
import type { ImageContent, SessionRecord } from "../../../../shared/types";
import { useSessionHistoryMutations, type SessionHistoryMutationsDeps } from "../useSessionHistoryMutations";

/**
 * pi 历史消息改写（编辑/删除/重发/分支）的 App 级接线。
 *
 * 策略与写盘都在 useSessionHistoryMutations 里，这里只负责把「会话身份 → 项目/文件/后端形态」
 * 的判定函数接进去：远端 SSH 会话有远端会话文件、生图 draft 没有 pi JSONL、DSH 维持 catalog
 * legacy、fork 锚点是否最后一条 user 消息决定替换还是分支。这些判定必须与主进程写入口径一致，
 * 所以集中在这一处装配，不散在 UI 里。
 */
export type AppHistoryMutationsDeps = Pick<
	SessionHistoryMutationsDeps,
	"currentSessionId" | "getRuntimeTargetForSession" | "getRuntimeTargetForAgent" | "isSessionRuntimeLive" | "showConfirm" | "clearConfirm" | "showToast" | "translateAgentErrorMessage" | "submitPromptSnapshot" | "openReplacedRuntimeSession" | "setPromptForAgent" | "isAgentCurrentlyBusy"
> & {
	/** 与 App 的 currentSessionIdRef 同一份：改写成功后立刻改指向，避免同帧读到旧 id */
	currentSessionIdRef: { current: string | undefined };
	store: ReturnType<typeof createStore>;
	getSessionRecord: (sessionId: string) => SessionRecord | undefined;
	activeProjectId: string | undefined;
	setSessionDraft: (input: { sessionId: string; value: string | ((current: string) => string) }) => void;
	setSessionAttachments: (input: { sessionId: string; value: ImageContent[] | ((current: ImageContent[]) => ImageContent[]) }) => void;
};

export function useAppHistoryMutations(deps: AppHistoryMutationsDeps): ReturnType<typeof useSessionHistoryMutations> {
	const {
		currentSessionId,
		getRuntimeTargetForSession,
		getRuntimeTargetForAgent,
		isSessionRuntimeLive,
		showConfirm,
		clearConfirm,
		showToast,
		translateAgentErrorMessage,
		submitPromptSnapshot,
		openReplacedRuntimeSession,
		setPromptForAgent,
		isAgentCurrentlyBusy,
		currentSessionIdRef,
		store,
		getSessionRecord,
		activeProjectId,
		setSessionDraft,
		setSessionAttachments,
	} = deps;

	return useSessionHistoryMutations({
		currentSessionId,
		getRuntimeTargetForSession,
		getRuntimeTargetForAgent,
		isSessionRuntimeLive,
		showConfirm,
		clearConfirm,
		showToast,
		translateAgentErrorMessage,
		submitPromptSnapshot,
		openReplacedRuntimeSession,
		setPromptForAgent,
		setCurrentSessionIdRef: (sessionId) => {
			currentSessionIdRef.current = sessionId;
		},
		isAgentCurrentlyBusy,
		resolveProjectId: (sessionId) => getSessionRecord(sessionId)?.projectId ?? activeProjectId,
		hasPersistedSessionFile: (sessionId) => {
			const record = getSessionRecord(sessionId);
			if (!record || record.noSession) return false;
			// 远端（ssh）会话没有本机 filePath，但它在远端有真实的会话文件——编辑 / 删除 / 准备重发改写的
			// 就是它（P4.5c 的远端写面）。判据必须认 locator 里的远端身份，否则远端会话在这里被判成
			// 「无持久化文件」，那三条链路在 UI 上永远走不到（表现为"匿名会话不支持编辑"）。
			if (record.locator?.kind === "ssh") return Boolean(record.locator.remoteSessionId || record.locator.remotePath);
			return Boolean(record.filePath);
		},
		// 生图 draft：会话消息里存在生图占位/结果即判定为生图模式（无 pi runtime、无 pi JSONL）。
		isImageGenSession: (sessionId) => (store.get(sessionMessagesCacheAtom)?.[sessionId]?.messages ?? []).some((message) => message.meta?.imageGen !== undefined),
		// fork 化重发/编辑只服务本机 pi 后端：DSH 维持 legacy 路径（策略层返回 catalog）
		isDshSession: (sessionId) => getSessionRecord(sessionId)?.backend === "dsh",
		// 远端 SSH 会话同样维持 catalog：改写主机上的会话文件由 RemoteSessionHistoryWriter 负责
		// （含外部改动冲突检测）；pi fork 只接受 user 条目，而编辑目标是 assistant 回复。
		isRemoteSession: (sessionId) => getSessionRecord(sessionId)?.locator?.kind === "ssh",
		// fork 锚点是否为最后一条用户消息：尾部 → 替换语义（旧会话隐藏）；非尾部 → 分支模式（旧会话保留可见）。
		// 缓存缺失时按非尾部处理（false），宁可两会话并存也不隐藏可能还有独属内容的旧会话。
		isLastUserMessage: (sessionId, message) => {
			const cached = store.get(sessionMessagesCacheAtom)?.[sessionId]?.messages;
			if (!cached) return false;
			const index = cached.findIndex((candidate) => candidate.id === message.id);
			if (index < 0) return false;
			return !cached.slice(index + 1).some((candidate) => candidate.role === "user");
		},
		// 生图重发：把失败的提示词（+参考图）放回输入框供一键重试。参考图直接整体替换附件栏
		//（重发目标就是这轮消息自身，不需要前插保留——那是失败后保留用户新粘贴图的场景）。
		restoreImageGenTurn: (sessionId, text, images) => {
			setSessionDraft({ sessionId, value: text });
			if (!images?.length) return;
			// 历史消息里的参考图是落盘引用（ref），附件栏与后续请求体要的是 base64：
			// 异步回填，取不到字节的条目丢掉（不阻断提示词回填）。
			void hydrateImageContents(images, (ref) => window.piDesktop.imagegen.readImageBlob(ref))
				.then((hydrated) => {
					if (hydrated.length > 0) {
						setSessionAttachments({ sessionId, value: hydrated });
						return;
					}
					if (images.length > 0) showToast(t("imagegen.referenceUnavailable"));
				})
				.catch(() => showToast(t("imagegen.referenceUnavailable")));
		},
	});
}
