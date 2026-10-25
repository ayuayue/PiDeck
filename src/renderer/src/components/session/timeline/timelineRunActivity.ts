/**
 * Timeline runtime phases separate a busy session from an active model turn.
 *
 * Pi can compact context after `agent_end`: the runtime must remain busy so
 * callers cannot submit conflicting work, while the preceding assistant turn
 * is already complete and must render its final answer outside the fold.
 */
export type TimelineRunActivity = {
	isCompacting: boolean;
	isRuntimeBusy: boolean;
	isTurnRunning: boolean;
};

export function deriveTimelineRunActivity(input: {
	isRuntimeBusy: boolean;
	isCompacting?: boolean;
	/** Explicit pi agent_end boundary; undefined preserves legacy/backend fallback. */
	isTurnActive?: boolean;
}): TimelineRunActivity {
	const isCompacting = input.isCompacting === true;
	return {
		isCompacting,
		// Manual compaction may start while the tab has not yet moved to running.
		isRuntimeBusy: input.isRuntimeBusy || isCompacting,
		// Compaction is runtime work after the response turn. An explicit agent_end
		// boundary also keeps the reply complete during post-compaction idle checks.
		isTurnRunning: input.isRuntimeBusy && !isCompacting && input.isTurnActive !== false,
	};
}
