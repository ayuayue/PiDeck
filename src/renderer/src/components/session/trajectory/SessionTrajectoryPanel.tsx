import { useCallback } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { Activity } from "lucide-react";
import { currentSessionIdAtom, sessionRecordsAtom, sessionTabIdsAtom } from "../../../atoms";
import { useSessionTrajectorySource } from "../../../hooks/useSessionTrajectorySource";
import { t } from "../../../i18n";
import { openPermanentSessionTab } from "../../../utils/sessionTabs";
import { deriveBranchFamily } from "../branchFamily";
import { SessionTrajectoryView } from "./SessionTrajectoryView";

/**
 * 右侧抽屉「轨迹」面板：跟随当前聚焦会话，不进中栏会话区。
 * 无会话时给空态，避免抽屉 tab 只能在有会话时出现。
 */
export function SessionTrajectoryPanel() {
	const sessionId = useAtomValue(currentSessionIdAtom);
	const records = useAtomValue(sessionRecordsAtom);
	const setCurrentSessionId = useSetAtom(currentSessionIdAtom);
	const setSessionTabIds = useSetAtom(sessionTabIdsAtom);
	const source = useSessionTrajectorySource(sessionId);

	// 来源会话（fork/子代理的父会话）：与 SessionBranchBar 同源的派生，仅同项目
	// 可跳转（跨项目选中需要切 activeProject，抽屉层没有该通道，退化为纯展示）。
	const record = sessionId ? records[sessionId] : undefined;
	const family = sessionId ? deriveBranchFamily(records, sessionId) : undefined;
	const parent = family?.parent;
	const sourceSession = parent && record && parent.projectId === record.projectId ? { sessionId: parent.id, title: parent.title || parent.filePath || parent.id } : undefined;
	const openSourceSession = useCallback(() => {
		if (!sourceSession) return;
		// pinned/preview 状态属 workspace chrome hook，抽屉层不可达：追加语义只
		// 需要「不在则尾插」（pinned 传空仍保持现有相对顺序），预览标记交由既有逻辑。
		setSessionTabIds((current) => openPermanentSessionTab(current, [], null, sourceSession.sessionId).tabs);
		setCurrentSessionId(sourceSession.sessionId);
	}, [sourceSession, setSessionTabIds, setCurrentSessionId]);

	if (!sessionId) {
		return (
			<div className="flex h-full min-h-0 flex-col items-center justify-center gap-2 px-4 text-center" data-session-view="trajectory">
				<Activity size={16} className="text-muted-foreground" aria-hidden="true" />
				<p className="text-caption text-muted-foreground">{t("session.trajectory.noSession")}</p>
			</div>
		);
	}

	// 覆盖范围提示：预算/祖先/窗口缺失时说明「没读到」，不能伪装成「没有事实」。
	const coverage = source.processCoverage;
	const coverageNotice = !coverage ? undefined : !coverage.readComplete && coverage.reason === "budget" ? t("session.trajectory.coverageBudget") : !coverage.chainComplete ? t("session.trajectory.coverageAncestor") : !coverage.fromStart ? t("session.trajectory.coverageWindow") : undefined;

	return (
		<div className="flex h-full min-h-0 flex-col" data-session-view="trajectory">
			{coverageNotice ? <p className="shrink-0 border-b border-border/60 px-3 py-1.5 text-caption text-muted-foreground">{coverageNotice}</p> : null}
			<div className="min-h-0 flex-1">
				<SessionTrajectoryView
					sessionId={sessionId}
					messages={source.messages}
					processEvents={source.processEvents}
					coverage={source.processCoverage}
					modelTraces={source.modelTraces}
					sourceSession={sourceSession}
					onOpenSourceSession={sourceSession ? openSourceSession : undefined}
					isDsh={source.isDshSession}
					hasMoreMessages={source.hasMoreMessages}
					isLoadingMoreMessages={source.isLoadingMoreMessages}
					onLoadMore={source.loadMore}
					variant="drawer"
				/>
			</div>
		</div>
	);
}
