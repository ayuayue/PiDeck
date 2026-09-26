import type { SessionRecord } from "../../../shared/types";

/**
 * 会话记录是否具备「可显示身份」——即会话列表/最近列表渲染它时不会是空标题行。
 *
 * 判据的唯一来源：`sessionRecordToSummary`（显示管线）对不满足该判据的记录返回
 * `undefined`。DSH / 生图会话没有 pi 会话文件（分别由 DSH host / ImageSessionStore
 * 持久化），也必须算可显示，否则它们会从所有列表里消失。
 *
 * 放在纯 util 里，让显示管线（atoms/session-selectors）与侧栏行的收集模型
 * （components/sidebar/activitySessionsModel）共用同一判据，避免两处各写一遍后漂移
 * ——过滤通过但渲染返回 null 会留下一行空标题。
 */
export function isDisplayableSessionRecord(session: Pick<SessionRecord, "filePath" | "backend">): boolean {
	return Boolean(session.filePath) || session.backend === "dsh" || session.backend === "imagegen";
}
