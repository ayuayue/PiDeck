import { useCallback, useRef, useState, type RefObject } from "react";
import { useSetAtom } from "jotai";
import { clearTimelineRevealAtom, requestTimelineRevealAtom } from "../../../atoms/timeline-reveal-atoms";
import type { TaggedTimelineJumpRequest } from "./useTimelineJumpNavigation";

/** 揭示提交后最多等约 1 秒；超过即交给已有 fallback，不无限转。 */
export const JUMP_DOM_WAIT_MAX_FRAMES = 60;

export function useTimelineJumpState(options: { ownerKeyRef: RefObject<string>; sessionId?: string }) {
	const [pendingJump, setPendingJump] = useState<TaggedTimelineJumpRequest | undefined>(undefined);
	const [jumpAnchorMessageId, setJumpAnchorMessageId] = useState<string | null>(null);
	const jumpNonceRef = useRef(0);
	const jumpDomWaitFrameRef = useRef<number | undefined>(undefined);
	const pendingJumpRef = useRef(pendingJump);
	pendingJumpRef.current = pendingJump;

	const cancelJumpDomWait = useCallback(() => {
		if (jumpDomWaitFrameRef.current === undefined) return;
		window.cancelAnimationFrame(jumpDomWaitFrameRef.current);
		jumpDomWaitFrameRef.current = undefined;
	}, []);
	const scheduleJumpDomWait = useCallback(
		(requestOwnerKey: string, messageId: string) => {
			if (jumpDomWaitFrameRef.current !== undefined) return;
			jumpDomWaitFrameRef.current = window.requestAnimationFrame(() => {
				jumpDomWaitFrameRef.current = undefined;
				if (options.ownerKeyRef.current !== requestOwnerKey) return;
				setPendingJump((current) => {
					if (!current || current.ownerKey !== requestOwnerKey || current.value.messageId !== messageId) return current;
					return {
						ownerKey: current.ownerKey,
						value: {
							...current.value,
							domWaitFrames: (current.value.domWaitFrames ?? 0) + 1,
							nonce: current.value.nonce + 1,
						},
					};
				});
			});
		},
		[options.ownerKeyRef],
	);

	const requestRevealWrite = useSetAtom(requestTimelineRevealAtom);
	const clearRevealWrite = useSetAtom(clearTimelineRevealAtom);
	const requestTimelineReveal = useCallback(
		(messageId: string) => {
			if (!options.sessionId || !messageId) return;
			requestRevealWrite({ sessionId: options.sessionId, messageId });
		},
		[options.sessionId, requestRevealWrite],
	);
	const clearTimelineReveal = useCallback(() => {
		if (!options.sessionId) return;
		clearRevealWrite(options.sessionId);
	}, [clearRevealWrite, options.sessionId]);
	return {
		pendingJump,
		setPendingJump,
		pendingJumpRef,
		jumpAnchorMessageId,
		setJumpAnchorMessageId,
		jumpNonceRef,
		cancelJumpDomWait,
		scheduleJumpDomWait,
		requestTimelineReveal,
		clearTimelineReveal,
	};
}
