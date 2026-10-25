import { useSessionTimelineController } from "../../hooks/useSessionTimelineController";
import { SessionMessageTimeline, type SessionMessageTimelineProps } from "./SessionMessageTimeline";

/**
 * Standalone timeline owner for surfaces that do not already own session scroll state.
 * Main session panes inject their controller directly into SessionMessageTimeline instead.
 */
export type OwnedSessionMessageTimelineProps = Omit<SessionMessageTimelineProps, "controller">;

export function OwnedSessionMessageTimeline({ sessionId, ...timelineProps }: OwnedSessionMessageTimelineProps) {
	const controller = useSessionTimelineController({ sessionId });

	return <SessionMessageTimeline {...timelineProps} sessionId={sessionId} controller={controller} />;
}
