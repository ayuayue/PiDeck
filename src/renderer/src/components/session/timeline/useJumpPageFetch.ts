/** One bounded file read includes the exact entry, replacing the old reader window.
 * Revision and the caller's live ownership guard reject stale responses; a rejected
 * response must never clear history and retry against a newer cache generation.
 */
import type { Dispatch, SetStateAction } from "react";
import type { SessionMessagePage } from "../../../../../shared/types";
import { JUMP_PAGE_TURN_SIZE } from "./historyPagePolicy";
import { planJumpPageRequest } from "./jumpWindowPolicy";
import type { TaggedTimelineJumpRequest } from "../../../hooks/session/timeline/useTimelineJumpNavigation";

/** File entry ids and projected message ids occupy distinct identity spaces. */
export function jumpEntryIdOf(id: string): string {
	const marker = "-history-";
	const at = id.indexOf(marker);
	return at >= 0 ? id.slice(at + marker.length) : id;
}
export interface JumpPageFetchPorts {
	sessionId: string | undefined;
	revision: number | undefined;
	isRequestCurrent: () => boolean;
	readRecordMessagePage: (sessionId: string, before?: number, pageSize?: number, options?: { beforeEntryId?: string; includeBeforeEntry?: boolean; afterEntryId?: string }) => Promise<SessionMessagePage>;
	prependHistoryPage: (input: { sessionId: string; expectedRevision: number; before?: number | null; page: SessionMessagePage; replace?: boolean }) => boolean;
	setPendingJump: Dispatch<SetStateAction<TaggedTimelineJumpRequest | undefined>>;
}
export function useJumpPageFetch(ports: JumpPageFetchPorts) {
	return (pendingJump: TaggedTimelineJumpRequest, currentOwnerKey: string, targetInLoadedData: boolean): boolean => {
		const { sessionId, revision, readRecordMessagePage, prependHistoryPage, setPendingJump, isRequestCurrent } = ports;
		if (!sessionId || pendingJump.value.pageFetched || targetInLoadedData || currentOwnerKey !== pendingJump.ownerKey) return false;
		const plan = planJumpPageRequest({ entryId: jumpEntryIdOf(pendingJump.value.messageId), pageFetched: false, expandAttempts: pendingJump.value.expandAttempts });
		if (plan.kind !== "fetch-page") return false;
		setPendingJump({ ownerKey: pendingJump.ownerKey, value: { ...pendingJump.value, pageFetched: true, nonce: pendingJump.value.nonce + 1 } });
		void readRecordMessagePage(sessionId, undefined, JUMP_PAGE_TURN_SIZE, { beforeEntryId: plan.beforeEntryId, includeBeforeEntry: true })
			.then((page) => {
				if (!isRequestCurrent()) return;
				prependHistoryPage({ sessionId, expectedRevision: revision ?? 0, before: undefined, page, replace: true });
			})
			// The pending-jump state has a bounded failure path; never start a retry loop here.
			.catch(() => {});
		return true;
	};
}
