export type VoiceTranscriptionTarget = {
	sessionId: string;
	draft: string;
	from: number;
	to: number;
};

export type VoiceTranscriptionInsertionResult =
	| { ok: true; value: string; caret: number }
	| { ok: false; reason: "stale" };

/**
 * Maps the captured selection through a later edit only when that edit is
 * wholly before or after the target. Ambiguous overlap is rejected so an
 * asynchronous transcription can never overwrite newer user input.
 */
export function resolveVoiceTranscriptionInsertion(input: {
	target: VoiceTranscriptionTarget;
	currentSessionId: string;
	currentDraft: string;
	text: string;
}): VoiceTranscriptionInsertionResult {
	const { target, currentSessionId, currentDraft, text } = input;
	if (
		target.sessionId !== currentSessionId ||
		target.from < 0 ||
		target.to < target.from ||
		target.to > target.draft.length
	) {
		return { ok: false, reason: "stale" };
	}

	let from = target.from;
	let to = target.to;
	if (currentDraft !== target.draft) {
		const prefix = commonPrefixLength(target.draft, currentDraft);
		const suffix = commonSuffixLength(target.draft, currentDraft, prefix);
		const oldChangedEnd = target.draft.length - suffix;
		const selectionIsCaret = from === to;
		const safelyBefore = selectionIsCaret ? oldChangedEnd < from : oldChangedEnd <= from;
		const safelyAfter = selectionIsCaret ? prefix > to : prefix >= to;
		if (safelyBefore) {
			const delta = currentDraft.length - target.draft.length;
			from += delta;
			to += delta;
		} else if (!safelyAfter) {
			return { ok: false, reason: "stale" };
		}
	}

	const value = currentDraft.slice(0, from) + text + currentDraft.slice(to);
	return { ok: true, value, caret: from + text.length };
}

function commonPrefixLength(left: string, right: string): number {
	const limit = Math.min(left.length, right.length);
	let index = 0;
	while (index < limit && left[index] === right[index]) index += 1;
	return index;
}

function commonSuffixLength(left: string, right: string, prefix: number): number {
	const limit = Math.min(left.length, right.length) - prefix;
	let length = 0;
	while (
		length < limit &&
		left[left.length - 1 - length] === right[right.length - 1 - length]
	) {
		length += 1;
	}
	return length;
}
