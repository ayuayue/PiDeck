import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/** Exercise the real overlay and batch callbacks with an in-memory draft atom. */
function createBatch(options = {}) {
	const questions = options.questions ?? [
		{ id: "first", type: "select", question: "First", options: ["A", "B"] },
		{ id: "second", type: "confirm", question: "Second" },
		{ id: "last", type: options.lastType ?? "input", question: "Last", options: ["A", "B"] },
	];
	const key = "session:agent:1:request";
	let draft = { key, batch: { answers: options.answers ?? {}, labels: {}, customAnswerIds: [], skippedIds: options.skippedIds ?? [], inputValues: options.inputValues ?? { last: options.text ?? "last answer" }, currentTab: options.currentTab ?? questions.length - 1, expanded: true } };
	const responses = [];
	const family = Object.assign((value) => value, { remove() {} });
	const stubs = {
		react: { useEffect() {}, useMemo: (read) => read(), useRef: (value) => ({ current: value }), useState: (value) => [value, () => {}] },
		jotai: {
			useAtom: () => [
				draft,
				(update) => {
					draft = typeof update === "function" ? update(draft) : update;
				},
			],
		},
		"motion/react": { useReducedMotion: () => true, AnimatePresence: "presence", motion: { div: "motion-div" } },
		"lucide-react": { Check: "check", ClipboardList: "clipboard" },
		"../../atoms/ask-draft-atoms": { askDraftBySessionRequestAtomFamily: family },
		"../../i18n": { t: (value) => value },
		"../motion/draw-check": { DrawCheck: "draw-check" },
		"./SecurityConfirmCard": { SecurityConfirmCard: "security-card" },
		...Object.fromEntries(
			[
				["button", "Button"],
				["input", "Input"],
				["textarea", "Textarea"],
				["approval-card", "ApprovalCard"],
				["prompt-tooltip", "PromptTooltip"],
			].map(([file, name]) => [`../ui-shadcn/${file}`, { [name]: file }]),
		),
	};
	const { SessionRuntimeUiOverlay } = loadTsCommonJs("src/renderer/src/components/overlays/SessionRuntimeUiOverlay.tsx", { stubs });
	const request = { agentId: "agent", requestId: "request", method: "batch_ask", title: "Batch", batchQuestions: questions, batchReview: options.review ?? false };
	const props = {
		sessionId: "session",
		runtime: { agentId: "agent", runtimeGeneration: 1, status: "running" },
		ui: { agentId: "agent", runtimeGeneration: 1, requests: { request: { status: "pending", request } } },
		responder: {
			async respond(_request, response) {
				responses.push(response);
				return true;
			},
		},
	};
	return {
		responses,
		get draft() {
			return draft.batch;
		},
		render() {
			const node = SessionRuntimeUiOverlay(props);
			return node.type(node.props);
		},
	};
}

/** Search rendered React elements without replacing the production event handlers. */
function findElement(node, predicate) {
	if (Array.isArray(node)) return node.map((child) => findElement(child, predicate)).find(Boolean);
	if (!node || typeof node !== "object") return undefined;
	if (predicate(node)) return node;
	return findElement(node.props?.children, predicate);
}

function question(batch) {
	const node = findElement(batch.render(), (element) => typeof element.props?.onAnswer === "function");
	assert.ok(node, "the batch must render its current question");
	return node.props;
}

for (const type of ["input", "select", "confirm"]) {
	test(`last ${type} answer cannot submit earlier unanswered questions`, () => {
		const batch = createBatch({ lastType: type });
		const current = question(batch);
		if (type === "input") current.onSubmitInput();
		else current.onAnswer(type === "confirm" ? false : "A");
		assert.equal(batch.responses.length, 0);
		assert.equal(batch.draft.currentTab, 0);
		assert.equal(batch.draft.answers.last, type === "input" ? "last answer" : type === "confirm" ? false : "A");
	});

	test(`first completion of last ${type} includes its new answer and accepts false`, () => {
		const batch = createBatch({ lastType: type, answers: { first: "A", second: false } });
		const current = question(batch);
		if (type === "input") current.onSubmitInput();
		else current.onAnswer(type === "confirm" ? false : "B");
		assert.equal(batch.responses.length, 1);
		const result = JSON.parse(batch.responses[0].value).answers;
		assert.equal(result[1].value, false);
		assert.equal(result[2].value, type === "input" ? "last answer" : type === "confirm" ? false : "B");
	});
}

test("incomplete submission selects the first missing answer and keeps earlier answers", () => {
	const batch = createBatch({ answers: { first: "B" } });
	question(batch).onSubmitInput();
	assert.equal(batch.responses.length, 0);
	assert.equal(batch.draft.currentTab, 1);
	assert.equal(batch.draft.answers.first, "B");
	assert.equal(batch.draft.answers.last, "last answer");
});

test("an empty multi-select remains unanswered", () => {
	const batch = createBatch({
		questions: [
			{ id: "first", type: "multi_select", question: "First", options: ["A"] },
			{ id: "last", type: "input", question: "Last" },
		],
		answers: { first: [] },
	});
	question(batch).onSubmitInput();
	assert.equal(batch.responses.length, 0);
	assert.equal(batch.draft.currentTab, 0);
});

test("single-question first submission is not blocked by the previous draft", () => {
	const batch = createBatch({ questions: [{ id: "last", type: "input", question: "Only" }] });
	question(batch).onSubmitInput();
	assert.equal(batch.responses.length, 1);
	assert.equal(JSON.parse(batch.responses[0].value).answers[0].value, "last answer");
});

test("whitespace-only input does not complete the question", () => {
	const batch = createBatch({ answers: { first: "A", second: false }, text: "   " });
	assert.equal(question(batch).onSubmitInput(), false);
	assert.equal(batch.responses.length, 0);
});

test("review mode still waits for its explicit submit action", () => {
	const batch = createBatch({ review: true, answers: { first: "A", second: false } });
	question(batch).onSubmitInput();
	assert.equal(batch.responses.length, 0);
	assert.equal(batch.draft.currentTab, 3);
	const submit = findElement(batch.render(), (node) => node.type === "button" && node.props.children === "ask.batchSubmitAll");
	assert.ok(submit);
	assert.equal(submit.props.disabled, false);
	submit.props.onClick();
	assert.equal(batch.responses.length, 1);
	assert.equal(JSON.parse(batch.responses[0].value).answers[2].value, "last answer");
});

test("an incomplete review cannot submit all answers", () => {
	const batch = createBatch({ review: true });
	question(batch).onSubmitInput();
	const submit = findElement(batch.render(), (node) => node.type === "button" && node.props.children === "ask.batchSubmitAll");
	assert.ok(submit);
	assert.equal(submit.props.disabled, true);
	// Also exercise the shared handler directly, independent of the button's disabled state.
	submit.props.onClick();
	assert.equal(batch.responses.length, 0);
	assert.equal(batch.draft.currentTab, 0);
});

test("empty batches do not render a submit path", () => {
	const batch = createBatch({ questions: [] });
	assert.equal(batch.render(), null);
	assert.equal(batch.responses.length, 0);
});

function card(batch) {
	const node = findElement(batch.render(), (element) => element.type === "approval-card");
	assert.ok(node, "the batch must render inside its approval card");
	return node.props;
}

function submitted(batch) {
	assert.equal(batch.responses.length, 1);
	assert.equal(batch.responses[0].cancelled, undefined);
	return JSON.parse(batch.responses[0].value);
}

test("skipping a middle question advances and marks it settled without an answer", () => {
	const batch = createBatch({ currentTab: 1, answers: { first: "A" } });
	question(batch).onSkip();
	assert.equal(batch.responses.length, 0);
	assert.equal(batch.draft.currentTab, 2);
	assert.deepEqual([...batch.draft.skippedIds], ["second"]);
	assert.equal(batch.draft.answers.second, undefined);
});

test("skipping the last question submits once every question is answered or skipped", () => {
	const batch = createBatch({ answers: { first: "A" }, skippedIds: ["second"], inputValues: {} });
	question(batch).onSkip();
	const result = submitted(batch);
	assert.equal(result.cancelled, undefined);
	assert.deepEqual(
		result.answers.map((answer) => [answer.id, answer.value, answer.skipped === true]),
		[
			["first", "A", false],
			["second", null, true],
			["last", null, true],
		],
	);
});

test("an untouched question still blocks submission even when others are skipped", () => {
	const batch = createBatch({ skippedIds: ["second"], inputValues: {} });
	question(batch).onSkip();
	assert.equal(batch.responses.length, 0);
	assert.equal(batch.draft.currentTab, 0);
});

test("answering a skipped question takes it out of the skipped set", () => {
	const batch = createBatch({ currentTab: 0, skippedIds: ["first"] });
	question(batch).onAnswer("B");
	assert.equal(batch.draft.answers.first, "B");
	assert.deepEqual([...batch.draft.skippedIds], []);
});

test("typed text that was never confirmed is kept when the final submit is pressed", () => {
	const batch = createBatch({ answers: { first: "A", second: true }, text: "typed but not submitted" });
	const current = question(batch);
	assert.equal(current.nextDisabled, false, "visible text counts as an answer");
	current.onNext();
	assert.equal(submitted(batch).answers[2].value, "typed but not submitted");
});

test("an accepted editor prefill counts as the answer", () => {
	const batch = createBatch({
		questions: [
			{ id: "first", type: "select", question: "First", options: ["A"] },
			{ id: "goal", type: "editor", question: "Goal", prefill: "keep this" },
		],
		answers: { first: "A" },
		inputValues: { goal: "keep this\n  indented" },
	});
	question(batch).onNext();
	assert.equal(submitted(batch).answers[1].value, "keep this\n  indented");
});

test("custom select text that was never confirmed is submitted as a custom answer", () => {
	const batch = createBatch({ lastType: "select", answers: { first: "A", second: false }, text: "my own option" });
	question(batch).onNext();
	const last = submitted(batch).answers[2];
	assert.equal(last.value, "my own option");
	assert.equal(last.wasCustom, true);
});

test("closing a partly answered card returns the answers instead of cancelling", () => {
	const batch = createBatch({ answers: { first: "B" }, inputValues: {} });
	card(batch).onCancel();
	const result = submitted(batch);
	assert.equal(result.cancelled, true, "the envelope tells the extension the card was closed early");
	assert.equal(result.answers[0].value, "B");
	assert.equal(result.answers[1].value, null);
});

test("closing a card with nothing answered is still a plain cancel", () => {
	const batch = createBatch({ skippedIds: ["first"], inputValues: {} });
	card(batch).onCancel();
	assert.equal(batch.responses.length, 1);
	assert.equal(batch.responses[0].cancelled, true);
	assert.equal(batch.responses[0].value, undefined);
});
