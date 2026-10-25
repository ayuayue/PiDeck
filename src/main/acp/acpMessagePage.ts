import type { ChatMessage, SessionMessagePage } from "../../shared/types/session";
import { findTurnPageStart, SessionHistoryReader } from "../pi/SessionHistoryReader";

/** ACP 重放缓存复用现有轮次分页规则；不把 agent 的历史误当作 pi/生图文件读取。 */
export function acpMessagePage(messages: readonly ChatMessage[], before?: number, turnCount?: number): SessionMessagePage {
	const end = typeof before === "number" && Number.isFinite(before) ? Math.min(messages.length, Math.max(0, Math.floor(before))) : messages.length;
	const turns = typeof turnCount === "number" && Number.isFinite(turnCount) ? Math.min(SessionHistoryReader.maxTurnPageSize(), Math.max(1, Math.floor(turnCount))) : SessionHistoryReader.DEFAULT_TURN_PAGE_SIZE;
	const entries = messages.slice(0, end).map((message) => ({ role: message.role, byteLength: 0 }));
	const start = findTurnPageStart(entries, end, turns);
	return { messages: messages.slice(start, end), total: messages.length, nextBefore: start > 0 ? start : null };
}
