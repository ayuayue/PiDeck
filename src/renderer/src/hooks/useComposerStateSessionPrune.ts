import { useEffect } from "react";
import type { createStore } from "jotai";
import { sessionRecordsAtom, sessionRuntimeByIdAtom } from "../atoms";
import { removeSessionComposerStateAtom, sessionDraftByIdAtom, sessionQuotesByIdAtom, sessionSendStateByIdAtom, sessionAttachmentsByIdAtom, sessionPasteFilesByIdAtom, sessionComposerModeByIdAtom, modelPendingByIdAtom } from "../atoms/composer-atoms";
import { GUIDE_BOOTSTRAP_SESSION_ID } from "../utils/chatSessionBootstrap";

/**
 * composer 域 per-session 状态的外部删除清理（所有权模式，与 useQueuedPrompt 同构）。
 *
 * 背景：deleteDraftSession 等内部路径会显式调 removeSessionComposerStateAtom，但会话
 * 也可能被外部删除（用户删文件、catalog 刷新、归档清理）——那条路径只会让
 * sessionRecordsAtom/sessionRuntimeByIdAtom 里的记录消失，composer 状态（草稿、引用
 * 全文仓、发送态、附件、粘贴文件、模式、模型待定）会无限驻留内存。
 *
 * 语义（对齐 useQueuedPrompt 的 pruneRemovedSessions）：
 * - owned = 这些原子里实际持有状态的会话；只有 owned 且 records 与 runtime 双双
 *   消失才清理。目录源/项目切换只过滤 records 而 runtime 绑定仍在时，状态休眠保留。
 * - 新晋升的会话 id 在 catalog 刷新窗口内还没有 record，但 dispatch 会同步写
 *   runtime（starting），因此不会被误清（与队列 hook 同一保证口径）。
 * - 引导页虚拟会话永不在 catalog，显式豁免——它的草稿是用户在引导页的真实输入。
 *
 * 分工：排队消息原子与队列抑制投影仍由 useQueuedPrompt 自清理（各自领域各自拥有）。
 */
export function useComposerStateSessionPrune(store: ReturnType<typeof createStore>) {
	useEffect(() => {
		if (!store) return;

		const prune = () => {
			const records = store.get(sessionRecordsAtom);
			const runtimes = store.get(sessionRuntimeByIdAtom);
			const owned = new Set<string>([
				...Object.keys(store.get(sessionDraftByIdAtom)),
				...Object.keys(store.get(sessionQuotesByIdAtom)),
				...Object.keys(store.get(sessionSendStateByIdAtom)),
				...Object.keys(store.get(sessionAttachmentsByIdAtom)),
				...Object.keys(store.get(sessionPasteFilesByIdAtom)),
				...Object.keys(store.get(sessionComposerModeByIdAtom)),
				...Object.keys(store.get(modelPendingByIdAtom)),
			]);
			for (const sessionId of owned) {
				if (records[sessionId] || runtimes[sessionId]) continue;
				if (sessionId === GUIDE_BOOTSTRAP_SESSION_ID) continue;
				store.set(removeSessionComposerStateAtom, sessionId);
			}
		};

		prune();
		const unsubscribeRecords = store.sub(sessionRecordsAtom, prune);
		const unsubscribeRuntime = store.sub(sessionRuntimeByIdAtom, prune);
		return () => {
			unsubscribeRecords();
			unsubscribeRuntime();
		};
	}, [store]);
}
