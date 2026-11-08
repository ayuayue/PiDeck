import type { AgentUiBatchQuestion } from "../../../shared/types";
import type { AskBatchDraft, BatchAnswerValue } from "./askUi";

/** Preserve the card's answer semantics: false is valid, an empty multi-select is not. */
export function isBatchAnswered(value: BatchAnswerValue): boolean {
	return value !== undefined && value !== null && (!Array.isArray(value) || value.length > 0);
}

/** A question is settled once it is answered or the user explicitly skipped it. */
export function isBatchSettled(questionId: string, answers: Record<string, BatchAnswerValue>, skippedIds: ReadonlyArray<string> | undefined): boolean {
	return isBatchAnswered(answers[questionId]) || Boolean(skippedIds?.includes(questionId));
}

/**
 * Inspect the submitted snapshot, including an answer not yet committed to the draft atom.
 * Explicitly skipped questions count as settled, so the user can leave a question blank on
 * purpose without the whole card being blocked; an untouched question still blocks (#448).
 */
export function inspectBatchAnswers(questions: AgentUiBatchQuestion[], answers: Record<string, BatchAnswerValue>, skippedIds?: ReadonlyArray<string>): { complete: boolean; firstUnanswered: number } {
	const firstUnanswered = questions.findIndex((question) => !isBatchSettled(question.id, answers, skippedIds));
	return { complete: questions.length > 0 && firstUnanswered === -1, firstUnanswered };
}

/**
 * A prefill is the model's proposal, not the user's answer: text still identical to it does
 * not count as answered until the user edits it, confirms it with the field's own submit
 * button, or presses "use prefill". Otherwise an untouched suggestion would be returned as if
 * the user had chosen it, indistinguishable from a real answer (#448).
 */
export function isUntouchedPrefill(question: AgentUiBatchQuestion, raw: string): boolean {
	return typeof question.prefill === "string" && question.prefill.length > 0 && raw === question.prefill;
}

/**
 * Fold text that is visible in a field but was never confirmed with its own submit button
 * into the answers: input/editor text the user typed or edited and the custom text of a
 * select. Without this, typing an answer and then pressing Next/Submit or a tab silently
 * dropped it. An untouched prefill is left out (see isUntouchedPrefill).
 * Committed answers and skipped questions win over pending text.
 */
export function withPendingTextAnswers(questions: ReadonlyArray<AgentUiBatchQuestion>, draft: AskBatchDraft): AskBatchDraft {
	const skipped = draft.skippedIds ?? [];
	let answers = draft.answers;
	let labels = draft.labels;
	let customAnswerIds = draft.customAnswerIds;
	for (const question of questions) {
		if (isBatchAnswered(answers[question.id]) || skipped.includes(question.id)) continue;
		if (question.type !== "input" && question.type !== "editor" && question.type !== "select") continue;
		const raw = draft.inputValues[question.id] ?? "";
		if (!raw.trim() || isUntouchedPrefill(question, raw)) continue;
		// editor keeps its line breaks and indentation; single-line fields are trimmed like their submit buttons do.
		const value = question.type === "editor" ? raw : raw.trim();
		answers = { ...answers, [question.id]: value };
		labels = { ...labels, [question.id]: value };
		if (question.type === "select" && !customAnswerIds.includes(question.id)) customAnswerIds = [...customAnswerIds, question.id];
	}
	if (answers === draft.answers) return draft;
	return { ...draft, answers, labels, customAnswerIds };
}
