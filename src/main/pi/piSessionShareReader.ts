import type { MainProcessTranslationKey } from "../../shared/i18n/mainProcessCopy";
import { AgentMessageProjector } from "./AgentMessageProjector";
import { SessionHistoryReader } from "./SessionHistoryReader";

/** 复用活动分支/上下文编辑/分页语义，只换为导出投影；不启动 pi，也不使用 UI 工具摘要。 */
export function createPiSessionShareReader(translate: (key: MainProcessTranslationKey, params?: Record<string, string | number>) => string): SessionHistoryReader {
	const projector = new AgentMessageProjector({ translate, isAskAborted: () => false, purpose: "share" });
	return new SessionHistoryReader({
		toHostPath: (path) => path,
		convertMessages: (agentId, messages, ids) => projector.convert(agentId, messages, ids),
		trimMessages: (messages) => messages,
		translate,
	});
}
