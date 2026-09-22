import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ClipboardList } from "lucide-react";
import type { AgentUiBatchQuestion, AgentUiRequest, AgentUiResponse, SessionUiResponseInput } from "../../../../shared/types";
import type { SessionRuntimeUiState, SessionRuntimeViewState } from "../../atoms/session-atoms";
import { t } from "../../i18n";
import { buildAskResponse, formatAskTitle, isComposingKeyboardEvent, parseSecurityConfirmTitle, resolveActiveAskRequest, resolveBatchAskDirectEnter, resolveSingleAskDirectEnter, serializeBatchAnswers, shouldAutoAdvanceBatchAnswer, shouldSuppressAskClick, splitAskOption } from "../../utils/askUi";
import { SecurityConfirmCard } from "./SecurityConfirmCard";
import { Button } from "../ui-shadcn/button";
import { Input } from "../ui-shadcn/input";
import { Textarea } from "../ui-shadcn/textarea";
import { ApprovalCard } from "../ui-shadcn/approval-card";

/**
 * ask 选项选中态的 utility 表达（锚点类 `selected` 保留，供测试与 DOM 查询使用）。
 *
 * 为什么不再依赖 legacy 的 `.ask-inline-bar-option.selected`：选项是 shadcn
 * Button variant="outline"，其 `bg-background` / `dark:bg-input/30` /
 * `dark:border-input` 位于 utilities 层，按层序（legacy < utilities）稳压 legacy 声明——
 * 亮色下只剩边框变色，夜间模式下选中与未选中完全同色（用户反馈「夜间模式 ask
 * 选中样式不明显」的根因）。移到这里后用 utility 表达，twMerge 会丢掉冲突的 variant
 * 类，两种主题都生效；暗色取更高比例的 accent 混色，保证一档可辨的底色差。
 */
const ASK_OPTION_SELECTED_CLASS =
	"selected border-[var(--color-accent)] bg-[color:color-mix(in_srgb,var(--color-accent)_12%,var(--color-bg-panel))] hover:bg-[color:color-mix(in_srgb,var(--color-accent)_16%,var(--color-bg-panel))] dark:border-[var(--color-accent)] dark:bg-[color:color-mix(in_srgb,var(--color-accent)_22%,var(--color-bg-panel))] dark:hover:bg-[color:color-mix(in_srgb,var(--color-accent)_28%,var(--color-bg-panel))]";

/** 批量问答题目 tab 的选中态：同上，`active` 锚点类保留，底色/边框/文字色由 utility 承担。 */
const ASK_TAB_ACTIVE_CLASS =
	"active border-[var(--color-accent)] bg-[color:color-mix(in_srgb,var(--color-accent)_12%,var(--color-bg-panel))] text-[var(--color-accent)] hover:bg-[color:color-mix(in_srgb,var(--color-accent)_16%,var(--color-bg-panel))] dark:border-[var(--color-accent)] dark:bg-[color:color-mix(in_srgb,var(--color-accent)_22%,var(--color-bg-panel))] dark:hover:bg-[color:color-mix(in_srgb,var(--color-accent)_28%,var(--color-bg-panel))]";

/** 已作答（未必聚焦）的题目 tab：绿色边框提示「这题已答」，作为 Check 图标之外的第二线索。 */
const ASK_TAB_ANSWERED_CLASS = "answered border-[var(--color-success)]";

export type RuntimeUiBinding = {
	sessionId: string;
	agentId: string;
	runtimeGeneration: number;
};

type ResponseClaim = (input: SessionUiResponseInput & { request: AgentUiRequest }) => boolean;
type ResponseRollback = (input: SessionUiResponseInput & { request: AgentUiRequest }) => boolean;

export type SessionRuntimeUiResponder = {
	respond: (request: AgentUiRequest, response: AgentUiResponse) => Promise<boolean>;
};

export function createSessionRuntimeUiResponder(input: { binding: RuntimeUiBinding; readBinding: () => RuntimeUiBinding | undefined; claim: ResponseClaim; rollback: ResponseRollback; send: (input: SessionUiResponseInput) => Promise<void>; onError?: (error: unknown) => void }): SessionRuntimeUiResponder {
	return {
		respond: async (request, response) => {
			const start = input.readBinding();
			if (!start || !sameBinding(start, input.binding) || request.agentId !== start.agentId) return false;
			const envelope = { ...input.binding, requestId: request.requestId, response };
			if (!input.claim({ ...envelope, request })) return false;
			// Re-read immediately before IPC: a detach/rebind between render and click must win.
			const latest = input.readBinding();
			if (!latest || !sameBinding(latest, input.binding)) {
				input.rollback({ ...envelope, request });
				return false;
			}
			try {
				await input.send(envelope);
				return true;
			} catch (error) {
				input.rollback({ ...envelope, request });
				input.onError?.(error);
				return false;
			}
		},
	};
}

function sameBinding(left: RuntimeUiBinding, right: RuntimeUiBinding) {
	return left.sessionId === right.sessionId && left.agentId === right.agentId && left.runtimeGeneration === right.runtimeGeneration;
}

export type SessionRuntimeUiOverlayProps = {
	sessionId: string;
	runtime?: SessionRuntimeViewState;
	ui?: SessionRuntimeUiState;
	responder: SessionRuntimeUiResponder;
	/** 展开阻塞式 Ask 后通知时间线 owner 重新定位，避免新高度落在视口下方。 */
	onExpandedChange?: (expanded: boolean) => void;
};

type BatchAnswer = string | boolean | string[] | undefined;

/** 批量答案 label：布尔转是/否，数组 join「、」，其余原样 */
function batchAnswerLabel(value: BatchAnswer): string {
	if (typeof value === "boolean") return value ? t("common.true") : t("common.false");
	if (Array.isArray(value)) return value.join("、");
	return value ?? "";
}

/** 是否已作答：multi_select 空数组视为未作答 */
function isBatchAnswered(value: BatchAnswer): boolean {
	return value !== undefined && (!Array.isArray(value) || value.length > 0);
}

/** Ask 展开后由时间线 owner 重新定位到底部，确保新展开的内容不会落在视口下方。 */
function notifyAskExpanded(onExpandedChange: ((expanded: boolean) => void) | undefined, expanded: boolean) {
	onExpandedChange?.(expanded);
}
function BatchAskInlineBar(props: { request: AgentUiRequest; responding: boolean; onCancel: () => void; onSubmit: (answers: string) => void; onExpandedChange?: (expanded: boolean) => void }) {
	const questions = props.request.batchQuestions ?? [];
	const total = questions.length;
	const [answers, setAnswers] = useState<Record<string, BatchAnswer>>({});
	const [answerLabels, setAnswerLabels] = useState<Record<string, string>>({});
	const [customAnswerIds, setCustomAnswerIds] = useState<Set<string>>(new Set());
	const [inputValues, setInputValues] = useState<Record<string, string>>({});
	const [currentTab, setCurrentTab] = useState(0);
	const [expanded, setExpanded] = useState(true);
	const requestKey = props.request.requestId;

	useEffect(() => {
		setAnswers({});
		setAnswerLabels({});
		setCustomAnswerIds(new Set());
		setInputValues(Object.fromEntries(questions.filter((question) => question.prefill).map((question) => [question.id, question.prefill ?? ""])));
		setCurrentTab(0);
		setExpanded(true);
	}, [requestKey]);

	const answeredCount = questions.filter((question) => isBatchAnswered(answers[question.id])).length;
	const allAnswered = total > 0 && answeredCount === total;
	const reviewTab = props.request.batchReview === true && currentTab === total;
	const currentQuestion = reviewTab ? undefined : questions[currentTab];
	const finalStep = currentTab === total - 1;

	/**
	 * 写入答案并返回**新的三份 state**。
	 *
	 * 自动前进（尤其末题直接提交）必须在同一个事件里拿到刚写入的答案：
	 * setAnswers/setAnswerLabels/setCustomAnswerIds 是异步提交的，再读 state 会漏掉本题。
	 */
	function commitAnswer(questionId: string, value: BatchAnswer, label = batchAnswerLabel(value), wasCustom = false) {
		const nextAnswers = { ...answers, [questionId]: value };
		const nextLabels = { ...answerLabels, [questionId]: label };
		const nextCustom = new Set(customAnswerIds);
		if (wasCustom) nextCustom.add(questionId);
		else nextCustom.delete(questionId);
		setAnswers(nextAnswers);
		setAnswerLabels(nextLabels);
		setCustomAnswerIds(nextCustom);
		return { answers: nextAnswers, labels: nextLabels, custom: nextCustom };
	}

	/** 自定义输入（select 的「其他」）与纯输入题的提交：写入答案并按策略自动前进。 */
	function submitText(question: AgentUiBatchQuestion): boolean {
		const value = inputValues[question.id]?.trim();
		if (!value) return false;
		return answerAndAdvance(question, value, value, question.type === "select");
	}

	function submitAnswers(overrides?: { answers?: Record<string, BatchAnswer>; labels?: Record<string, string>; custom?: Set<string> }) {
		// 自动前进到末题时会带上「本次刚写入」的答案（overrides），不能读 state：
		// 同一事件里 setAnswers 还没提交，直接 submitAnswers() 会把本题答案丢掉。
		const effectiveAnswers = overrides?.answers ?? answers;
		const effectiveLabels = overrides?.labels ?? answerLabels;
		const effectiveCustom = overrides?.custom ?? customAnswerIds;
		props.onSubmit(
			serializeBatchAnswers(
				questions,
				effectiveAnswers,
				Object.fromEntries(
					questions.map((question) => [
						question.id,
						{
							label: effectiveLabels[question.id],
							wasCustom: effectiveCustom.has(question.id),
						},
					]),
				),
			),
		);
	}

	/** 答题并推进（返回值：本函数是否已把卡片推进到下一站，供焦点修复判断）。 */
	function answerAndAdvance(question: AgentUiBatchQuestion, value: BatchAnswer, label?: string, wasCustom?: boolean): boolean {
		const committed = commitAnswer(question.id, value, label, wasCustom);
		if (!shouldAutoAdvanceBatchAnswer({ type: question.type, total })) return false;
		if (!finalStep) {
			setCurrentTab(currentTab + 1);
		} else if (props.request.batchReview) {
			setCurrentTab(total);
		} else {
			// 末题且无需审阅：带上刚写入的答案直接提交全部
			submitAnswers(committed);
		}
		return true;
	}

	if (total === 0) return null;

	return (
		<ApprovalCard
			open={expanded}
			onOpenChange={(next) => {
				setExpanded(next);
				notifyAskExpanded(props.onExpandedChange, next);
			}}
			title={formatAskTitle(props.request.title || t("ask.batchTitle", { count: total }))}
			status={t("ask.batchProgress", { done: answeredCount, total })}
			statusTone={allAnswered ? "success" : "active"}
			onCancel={props.onCancel}
			cancelDisabled={props.responding}
			cancelLabel={t("common.close")}
			className="ask-inline-bar ask-inline-bar--active w-full"
		>
			<div className="mb-2 flex min-w-0 items-center gap-2" aria-label={t("ask.batchProgress", { done: answeredCount, total })}>
				<div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={answeredCount}>
					<div className="h-full rounded-full bg-[var(--color-success)] transition-[width] duration-200" style={{ width: `${total > 0 ? (answeredCount / total) * 100 : 0}%` }} />
				</div>
				<span className="shrink-0 text-micro font-medium text-text-secondary">{t("ask.batchProgress", { done: answeredCount, total })}</span>
			</div>

			{/* 题目索引：单行不换行（2026-12 用户反馈：换行后标签条占掉好几行，太占位置）。
			    标签只做「序号 + 短标题」，宽度封顶后横向滚动；条高固定一行，不再抢正文高度。 */}
			<div className="mb-1 flex min-w-0 items-center gap-1 overflow-x-auto border-b border-border-subtle pb-1" role="tablist">
				{questions.map((question, index) => {
					const answered = isBatchAnswered(answers[question.id]);
					const active = index === currentTab;
					return (
						<Button
							key={question.id}
							variant="ghost"
							role="tab"
							aria-selected={active}
							className={`ask-batch-tab inline-flex h-[24px] flex-none items-center gap-1 rounded-md border border-border-subtle bg-transparent px-1.5 font-sans text-micro whitespace-nowrap text-text-secondary transition-colors hover:border-border-strong hover:text-text-primary focus-visible:outline-[var(--focus-ring)] focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-55${answered ? ` ${ASK_TAB_ANSWERED_CLASS}` : ""}${active ? ` ${ASK_TAB_ACTIVE_CLASS}` : ""}`}
							disabled={props.responding}
							onClick={() => setCurrentTab(index)}
						>
							<span className="min-w-[14px] text-center font-mono font-semibold">{index + 1}</span>
							{/* 单行截断：tab 只做摘要，完整问题在下方详情区展示；
							    多行会突破胶囊固定高度溢出到下方内容（min-w-0 让 truncate 在 flex 里生效） */}
							<span className="max-w-[14ch] min-w-0 truncate text-left" title={question.question}>
								{question.question}
							</span>
							{answered ? <Check size={11} className="shrink-0 text-[var(--color-success)]" aria-hidden="true" /> : null}
						</Button>
					);
				})}
				{props.request.batchReview ? (
					<Button
						variant="ghost"
						role="tab"
						aria-selected={reviewTab}
						className={`ask-batch-tab ask-batch-tab--review border-[var(--color-warning)] text-[var(--color-warning)] inline-flex h-[24px] flex-none items-center gap-1 rounded-md px-1.5 font-sans text-micro whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-55${reviewTab ? " active" : ""}`}
						disabled={props.responding}
						onClick={() => setCurrentTab(total)}
					>
						<ClipboardList size={12} aria-hidden="true" />
						<span className="ask-batch-tab-label">{t("ask.batchReviewTab")}</span>
					</Button>
				) : null}
			</div>

			<div>
				{reviewTab ? (
					<div className="flex flex-col gap-1.5">
						<div className="inline-flex items-center gap-1 text-control font-semibold text-text-primary">
							<ClipboardList size={16} aria-hidden="true" />
							<span>{t("ask.batchReviewTitle")}</span>
						</div>
						<div className="text-caption text-text-tertiary">{t("ask.batchReviewHint")}</div>
						<div className="flex flex-col gap-1 rounded-sm bg-bg-muted p-2">
							{questions.map((question, index) => {
								const value = answers[question.id];
								const answered = isBatchAnswered(value);
								return (
									<div key={question.id} className="grid grid-cols-[20px_minmax(0,1fr)_minmax(0,30ch)] items-start gap-2 text-caption leading-[1.6] text-text-primary">
										<span className="font-mono font-semibold">{index + 1}</span>
										<span className="min-w-0 [overflow-wrap:anywhere]">{question.question}</span>
										<span className={`min-w-0 text-right font-mono font-medium [overflow-wrap:anywhere]${answered ? " answered" : " unanswered"}`}>{answered ? (answerLabels[question.id] ?? batchAnswerLabel(value)) : "-"}</span>
									</div>
								);
							})}
						</div>
						{!allAnswered ? <div className="rounded-sm bg-[color:color-mix(in_srgb,var(--color-warning)_10%,transparent)] p-2 text-caption text-[var(--color-warning)]">{t("ask.batchIncomplete")}</div> : null}
						<Button className="w-full" variant="default" disabled={!allAnswered || props.responding} onClick={() => submitAnswers()}>
							{t("ask.batchSubmitAll")}
						</Button>
					</div>
				) : currentQuestion ? (
					<BatchQuestion
						question={currentQuestion}
						questionIndex={currentTab}
						total={total}
						answer={answers[currentQuestion.id]}
						inputValue={inputValues[currentQuestion.id] ?? ""}
						responding={props.responding}
						onAnswer={(value, label, wasCustom) => answerAndAdvance(currentQuestion, value, label, wasCustom)}
						onInputChange={(value) => setInputValues((current) => ({ ...current, [currentQuestion.id]: value }))}
						onSubmitInput={() => submitText(currentQuestion)}
						onPrevious={currentTab > 0 ? () => setCurrentTab(currentTab - 1) : undefined}
						onNext={() => {
							if (!finalStep) {
								setCurrentTab(currentTab + 1);
							} else if (props.request.batchReview) {
								setCurrentTab(total);
							} else {
								submitAnswers();
							}
						}}
						nextDisabled={finalStep && !props.request.batchReview && !allAnswered}
						finalLabel={finalStep && !props.request.batchReview ? t("ask.batchSubmitAll") : undefined}
					/>
				) : null}
			</div>
		</ApprovalCard>
	);
}

function BatchQuestion(props: {
	question: AgentUiBatchQuestion;
	questionIndex: number;
	total: number;
	answer: BatchAnswer;
	inputValue: string;
	responding: boolean;
	onAnswer: (value: BatchAnswer, label?: string, wasCustom?: boolean) => boolean;
	onInputChange: (value: string) => void;
	onSubmitInput: () => boolean;
	onPrevious?: () => void;
	onNext: () => void;
	nextDisabled: boolean;
	finalLabel?: string;
}) {
	const { question } = props;
	// 被点的选项按钮会随换题卸载，焦点掉回 body：把焦点收回卡片容器（tabIndex={-1}），
	// 键盘用户不必从页面开头重新 Tab。只在本次点击真的推进了才收，不抢鼠标用户的焦点。
	const containerRef = useRef<HTMLDivElement | null>(null);
	const refocusAfterAdvanceRef = useRef(false);
	useEffect(() => {
		if (!refocusAfterAdvanceRef.current) return;
		refocusAfterAdvanceRef.current = false;
		containerRef.current?.focus();
	}, [props.questionIndex]);
	const answer = (value: BatchAnswer, label?: string, wasCustom?: boolean) => {
		if (!props.onAnswer(value, label, wasCustom)) return;
		refocusAfterAdvanceRef.current = true;
	};
	// 自定义输入/纯输入题提交后同样可能自动前进，输入框随换题卸载，焦点要一起收回。
	const submitInput = () => {
		if (!props.onSubmitInput()) return;
		refocusAfterAdvanceRef.current = true;
	};
	return (
		<div
			ref={containerRef}
			tabIndex={-1}
			className="flex flex-col gap-1.5 outline-none"
			onKeyDown={(event) => {
				// 批量卡直接回车（策略见 askUi.resolveBatchAskDirectEnter）：
				// 选项按钮上已作答回车 = 提交并推进；卡片空白处同理；未作答回车交原生 click 完成选中。
				if (event.key !== "Enter" || isComposingKeyboardEvent(event)) return;
				const target = event.target as HTMLElement;
				const action = resolveBatchAskDirectEnter({
					fromField: target.tagName === "INPUT" || target.tagName === "TEXTAREA",
					fromButton: target.tagName === "BUTTON",
					fromOptionButton: target.classList.contains("ask-inline-bar-option"),
					answered: isBatchAnswered(props.answer),
					nextDisabled: props.nextDisabled,
				});
				if (action.kind === "advance") {
					event.preventDefault();
					props.onNext();
				}
			}}
		>
			<div className="mb-1.5 text-control font-medium leading-[1.5] break-words text-text-primary">{question.question}</div>
			<div className="ask-batch-question-body">
				{question.type === "confirm" ? (
					<div className="flex gap-2">
						<Button
							className={`ask-inline-bar-option ask-inline-bar-option-yes flex-none items-center justify-center gap-1 whitespace-nowrap${props.answer === true ? ` ${ASK_OPTION_SELECTED_CLASS}` : ""}`}
							variant="outline"
							disabled={props.responding}
							onClick={() => {
								// 划选 mouseup 落在按钮上会冒充 click；按压感知守卫只吞本次按压新拖出的选区，
								// 旧选区残留不再误吞（划选复制/双击选词后选项仍可正常点击）。
								if (shouldSuppressAskClick()) return;
								answer(true, t("common.true"));
							}}
						>
							{/* 选中态对勾：部分主题色 accent 对比度低，光靠变色难分辨已选项 */}
							{props.answer === true ? <Check size={14} className="shrink-0 text-[var(--color-success)]" aria-hidden="true" /> : null}
							{t("common.true")}
						</Button>
						<Button
							className={`ask-inline-bar-option ask-inline-bar-option-no flex-none items-center justify-center gap-1 whitespace-nowrap${props.answer === false ? ` ${ASK_OPTION_SELECTED_CLASS}` : ""}`}
							variant="outline"
							disabled={props.responding}
							onClick={() => {
								if (shouldSuppressAskClick()) return;
								answer(false, t("common.false"));
							}}
						>
							{props.answer === false ? <Check size={14} className="shrink-0 text-[var(--color-success)]" aria-hidden="true" /> : null}
							{t("common.false")}
						</Button>
					</div>
				) : question.type === "select" && question.options?.length ? (
					<>
						{/* 选项一律整行横条（2026-12 用户反馈）：栅格 2/4 列在长文案下会被压成窄条，
						    横条让标签与说明各自有整行宽度，长文案也能完整换行；外层时间线是唯一滚动容器。 */}
						<div className="flex min-w-0 flex-col gap-2">
							{question.options.map((option, index) => {
								const rawLabel = typeof option === "string" ? option : option.label;
								const parsed = typeof option === "string" ? splitAskOption(option) : { label: rawLabel, description: option.description };
								const label = parsed.label;
								const value = typeof option === "string" ? option : (option.value ?? rawLabel);
								const description = parsed.description;
								return (
									<Button
										key={`${question.id}:${index}`}
										className={`ask-inline-bar-option h-auto min-h-[32px] w-full min-w-0 max-w-none items-center justify-start gap-1.5 px-2.5 py-1.5 text-left break-words whitespace-normal${props.answer === value ? ` ${ASK_OPTION_SELECTED_CLASS}` : ""}`}
										variant="outline"
										disabled={props.responding}
										onClick={() => {
											if (shouldSuppressAskClick()) return;
											answer(value, label);
										}}
									>
										{/* 选中态对勾标记：主题色 accent 对比度低时只靠边框/背景变色难分辨已选项 */}
										{props.answer === value ? <Check size={14} className="shrink-0 text-[var(--color-success)]" aria-hidden="true" /> : null}
										{/* 说明与标签同一行、同字号、空格分隔，只靠颜色区分（2026-12 用户反馈：
										    说明别用小字、也别放第二行——小屏还好，大屏上又小又局限）。 */}
										<span className="min-w-0 flex-1 whitespace-normal break-words text-caption leading-[1.45]">
											<span className="text-text-primary">{label}</span>
											{description ? <span className="text-text-tertiary">{` ${description}`}</span> : null}
										</span>
									</Button>
								);
							})}
						</div>
						{question.allowOther !== false ? (
							<div className="mt-1 flex w-full min-w-0 items-center gap-1.5">
								<Input
									className="h-8 min-w-0 flex-1 rounded-sm border border-border-subtle bg-bg-panel px-2 text-caption text-text-primary outline-none transition-[border-color,box-shadow] duration-150 focus:border-[var(--color-accent)] focus:shadow-[var(--focus-ring)]"
									value={props.inputValue}
									placeholder={question.placeholder || t("ask.customPlaceholder")}
									disabled={props.responding}
									onChange={(event) => props.onInputChange(event.target.value)}
									onKeyDown={(event) => {
										if (event.key === "Enter") {
											event.preventDefault();
											submitInput();
										}
									}}
								/>
								<Button variant="default" disabled={props.responding || !props.inputValue.trim()} onClick={submitInput}>
									{t("ask.submit")}
								</Button>
							</div>
						) : null}
					</>
				) : question.type === "multi_select" && question.options?.length ? (
					<>
						{/* 多选：checkbox 语义（选中打勾，再点取消），选完走底部的下一题/提交全部。
						    与单选一致用整行横条，保证勾选态与文案在长选项下都可读。 */}
						<div className="flex min-w-0 flex-col gap-2">
							{question.options.map((option, index) => {
								const rawLabel = typeof option === "string" ? option : option.label;
								const parsed = typeof option === "string" ? splitAskOption(option) : { label: rawLabel, description: option.description };
								const label = parsed.label;
								const value = typeof option === "string" ? option : (option.value ?? rawLabel);
								const description = parsed.description;
								const selectedValues = Array.isArray(props.answer) ? props.answer : [];
								const selected = selectedValues.includes(value);
								return (
									<Button
										key={`${question.id}:${index}`}
										className={`ask-inline-bar-option h-auto min-h-[32px] w-full min-w-0 max-w-none items-center justify-start gap-1.5 px-2.5 py-1.5 text-left break-words whitespace-normal${selected ? ` ${ASK_OPTION_SELECTED_CLASS}` : ""}`}
										variant="outline"
										disabled={props.responding}
										onClick={() => {
											if (shouldSuppressAskClick()) return;
											// 切换选中项：multi_select 答案始终是数组
											const next = selected ? selectedValues.filter((v) => v !== value) : [...selectedValues, value];
											props.onAnswer(next, next.join("、"));
										}}
									>
										{/* 选中态对勾标记：主题色 accent 对比度低时只靠边框/背景变色难分辨已选项 */}
										{selected ? <Check size={14} className="shrink-0 text-[var(--color-success)]" aria-hidden="true" /> : null}
										<span className="min-w-0 flex-1 whitespace-normal break-words text-caption leading-[1.45]">
											<span className="text-text-primary">{label}</span>
											{description ? <span className="text-text-tertiary">{` ${description}`}</span> : null}
										</span>
									</Button>
								);
							})}
						</div>
						<div className="mt-1 text-micro text-text-tertiary">{t("ask.multiSelectHint")}</div>
					</>
				) : question.type === "editor" ? (
					<Textarea
						className="h-auto min-h-[60px] w-full flex-1 resize-y rounded-sm border border-border-subtle bg-bg-panel p-2 text-caption leading-[1.5] text-text-primary outline-none transition-[border-color,box-shadow] duration-150 focus:border-[var(--color-accent)] focus:shadow-[var(--focus-ring)]"
						value={props.inputValue}
						placeholder={question.placeholder || t("ask.editorPlaceholder")}
						disabled={props.responding}
						onChange={(event) => {
							props.onInputChange(event.target.value);
							props.onAnswer(event.target.value || undefined, event.target.value);
						}}
						onKeyDown={(event) => {
							// 多行编辑器：回车保留换行，Ctrl/Cmd+Enter 提交并进入下一题（末题 = 提交全部）
							if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.shiftKey && !isComposingKeyboardEvent(event) && !props.nextDisabled) {
								event.preventDefault();
								props.onNext();
							}
						}}
					/>
				) : (
					<div className="flex w-full items-center gap-2">
						<Input
							className="h-9 flex-1 rounded-sm border border-border-subtle bg-bg-panel px-2.5 text-control text-text-primary outline-none transition-[border-color,box-shadow] duration-150 focus:border-[var(--color-accent)] focus:shadow-[var(--focus-ring)]"
							value={props.inputValue}
							placeholder={question.placeholder || t("ask.inputPlaceholder")}
							disabled={props.responding}
							onChange={(event) => props.onInputChange(event.target.value)}
							onKeyDown={(event) => {
								// IME 合成中的回车只用于选字/提交候选，不能当作提交键
								if (event.key === "Enter" && !isComposingKeyboardEvent(event)) {
									event.preventDefault();
									submitInput();
								}
							}}
						/>
						{/* 纯输入题的按钮与输入框并排；不能使用 w-full，否则 Button 的 shrink-0 会把输入框压成窄条。 */}
						<Button className="shrink-0" variant="default" disabled={props.responding || !props.inputValue.trim()} onClick={submitInput}>
							{t("ask.submit")}
						</Button>
					</div>
				)}
			</div>
			<div className="mt-1 flex min-h-7 items-center gap-2">
				{props.onPrevious ? (
					<Button className="h-7 px-2 text-caption" variant="ghost" disabled={props.responding} onClick={props.onPrevious}>
						{t("ask.batchPrev")}
					</Button>
				) : null}
				<span className="flex-1" />
				<Button className="h-7 px-2 text-caption" variant="ghost" disabled={props.responding || props.nextDisabled} onClick={props.onNext}>
					{props.questionIndex < props.total - 1 ? t("ask.batchNext") : (props.finalLabel ?? t("ask.batchGoReview"))}
				</Button>
			</div>
		</div>
	);
}

export function SessionRuntimeUiOverlay({ sessionId, runtime, ui, responder, onExpandedChange }: SessionRuntimeUiOverlayProps) {
	// 同代判定与「当前 ask 请求」统一走 askUi.resolveActiveAskRequest：
	// SessionRuntimeInjector 的底栏占位需要同一份判据（见该函数注释）。
	const request = useMemo(() => resolveActiveAskRequest(runtime, ui), [runtime, ui]);
	const requestState = request ? ui?.requests[request.requestId] : undefined;
	const requestKey = request ? `${sessionId}:${request.agentId}:${ui?.runtimeGeneration}:${request.requestId}` : "";
	const [value, setValue] = useState("");
	const [busy, setBusy] = useState(false);
	const [expanded, setExpanded] = useState(true);
	// 单问题 select 集中提交：选项点击只改选中态，确认后才提交（2026-08 用户反馈：即点即提交易误触）
	const [selectedOption, setSelectedOption] = useState("");

	useEffect(() => {
		setValue(request?.prefill ?? (typeof request?.value === "string" ? request.value : ""));
		setSelectedOption("");
		setBusy(false);
		setExpanded(true);
	}, [requestKey, request?.prefill, request?.value]);

	if (!request || !requestState) return null;
	const responding = busy || requestState.status === "responding";
	const answer = async (method: string, response: AgentUiResponse) => {
		if (responding) return;
		setBusy(true);
		const accepted = await responder.respond(request, response);
		if (!accepted) setBusy(false);
	};
	const cancel = () => void answer(request.method, buildAskResponse(request.method, undefined, { cancelled: true }));
	const submitValue = (value: string | boolean | undefined, confirmed?: boolean) => {
		// 划选 mouseup 落在选项/提交按钮上会冒充 click，误答提问；按压感知守卫只吞
		// 本次按压新拖出的选区，旧选区残留不再误吞（根因见 askUi.ts）。
		// Enter 键也走这里：input/textarea 选区不进 window.getSelection，键盘提交不受影响。
		if (shouldSuppressAskClick()) return;
		void answer(request.method, buildAskResponse(request.method, value, { confirmed }));
	};

	if (request.method === "batch_ask") {
		return <BatchAskInlineBar request={request} responding={responding} onCancel={cancel} onSubmit={(answers) => submitValue(answers)} onExpandedChange={onExpandedChange} />;
	}

	// 安全确认（pi-deck-security-gate 的「ask」动作）：用专用卡片展开工具/等级/详情，
	// 而不是把命令/路径压进普通 Ask 卡的两行摘要，让用户看清「审批什么」。
	const securityConfirm = request.method === "select" ? parseSecurityConfirmTitle(request.title) : null;
	if (securityConfirm) {
		return (
			<SecurityConfirmCard
				request={request}
				responding={responding}
				open={expanded}
				onOpenChange={(next) => {
					setExpanded(next);
					notifyAskExpanded(onExpandedChange, next);
				}}
				onRespond={(value) => submitValue(value)}
				onCancel={cancel}
			/>
		);
	}

	return (
		<ApprovalCard
			open={expanded}
			onOpenChange={(next) => {
				setExpanded(next);
				notifyAskExpanded(onExpandedChange, next);
			}}
			title={t("ask.toolName")}
			// plan 卡默认显示两行摘要：提问行 + 引导去上方待办看详情；步骤仍折叠，眼睛展开全文。
			descriptionPreviewLines={2}
			description={formatAskTitle(request.title || t("ask.defaultTitle"))}
			onCancel={cancel}
			cancelDisabled={responding}
			cancelLabel={t("common.close")}
			className="ask-inline-bar ask-inline-bar--active w-full"
		>
			{/* 单卡「直接回车」策略（见 askUi.resolveSingleAskDirectEnter）：输入框内的回车
			    由字段自身处理（editor 保留换行），这里接管焦点在字段之外的直接回车；
			    IME 合成中的回车只用于选字，绝不能触发提交 */}
			<div
				onKeyDown={(event) => {
					if (event.key !== "Enter" || responding || isComposingKeyboardEvent(event)) return;
					if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
					const action = resolveSingleAskDirectEnter({
						method: request.method,
						fromField: event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement,
						fromButton: event.target instanceof HTMLButtonElement,
						fromOptionButton: event.target instanceof HTMLElement && event.target.classList.contains("ask-inline-bar-option"),
						selectedOption,
						text: value,
					});
					if (action.kind === "none") return;
					// preventDefault 同时抑制按钮原生 click（回车激活按钮），避免双重提交
					event.preventDefault();
					if (action.kind === "submit-option") submitValue(action.option);
					else if (action.kind === "submit-confirm") submitValue(true, true);
					else if (action.kind === "submit-text") submitValue(action.text);
				}}
			>
				{request.method === "select" && request.options?.length ? (
					// 单卡选项同样整行横条：横条比双列栅格更耐长文案，也与批量卡的选项语言一致。
					<div className="flex min-w-0 flex-col gap-2">
						{request.options.map((option) => {
							const parsed = splitAskOption(option);
							return (
								<Button
									key={`${request.requestId}:${option}`}
									// 单行选项（2026-12 用户反馈：上下两行文本对不齐）：标签+说明同行，
									// 固定高度 + 说明 truncate（title 兔底全文），等宽等高实现光学对齐。
									className={`ask-inline-bar-option h-[32px] w-full min-w-0 max-w-none items-center justify-start gap-2 px-2.5 py-0 text-left${selectedOption === option ? ` ${ASK_OPTION_SELECTED_CLASS}` : ""}`}
									variant="outline"
									disabled={responding}
									onClick={() => {
										if (shouldSuppressAskClick()) return;
										setSelectedOption(option);
									}}
									title={parsed.description || parsed.label}
								>
									{/* 选中态对勾：夜间模式下 accent 混色底 + 边框仍可能不够醒目，
									    与批量卡一致再补一个非颜色线索（success 色，不跟随主题 accent）。 */}
									{selectedOption === option ? <Check size={14} className="shrink-0 text-[var(--color-success)]" aria-hidden="true" /> : null}
									{/* 标签不缩不截：短标签（如「开始执行」）保证两枚按钮说明文案起点对齐；
									    超长标签兜底 max-w 截断，避免挤压说明列。 */}
									<span className="max-w-[45%] shrink-0 truncate text-caption font-medium leading-none text-text-primary">{parsed.label}</span>
									{parsed.description ? <span className="min-w-0 flex-1 truncate text-micro leading-none text-text-tertiary">{parsed.description}</span> : null}
								</Button>
							);
						})}
						{request.allowOther ? (
							<div className="mt-1 flex w-full min-w-0 items-center gap-1.5">
								<Input
									className="h-8 min-w-0 flex-1 rounded-sm border border-border-subtle bg-bg-panel px-2 text-caption text-text-primary outline-none transition-[border-color,box-shadow] duration-150 focus:border-[var(--color-accent)] focus:shadow-[var(--focus-ring)]"
									value={value}
									placeholder={t("ask.customPlaceholder")}
									disabled={responding}
									onChange={(event) => setValue(event.target.value)}
									onKeyDown={(event) => {
										// IME 合成中的回车只用于选字/提交候选，不能当作提交键
										if (event.key === "Enter" && !isComposingKeyboardEvent(event) && value.trim()) {
											submitValue(value.trim());
										}
									}}
								/>
								<Button variant="default" disabled={responding || !value.trim()} onClick={() => submitValue(value.trim())}>
									{t("ask.submit")}
								</Button>
							</div>
						) : null}
					</div>
				) : null}
				{selectedOption ? (
					<div className="mt-1 flex w-full min-w-0 items-center gap-1.5">
						<span className="min-w-0 flex-1 truncate text-caption text-text-secondary">
							{t("ask.selectedPrefix")}
							{splitAskOption(selectedOption).label}
						</span>
						<Button variant="default" disabled={responding} onClick={() => submitValue(selectedOption)}>
							{t("ask.submit")}
						</Button>
					</div>
				) : null}
				{request.method === "confirm" ? (
					<div className="flex gap-2">
						<Button className="ask-inline-bar-option ask-inline-bar-option-yes" variant="outline" disabled={responding} onClick={() => submitValue(true, true)}>
							{t("common.confirm")}
						</Button>
						<Button className="ask-inline-bar-option ask-inline-bar-option-no" variant="outline" disabled={responding} onClick={() => submitValue(false, false)}>
							{t("common.cancel")}
						</Button>
					</div>
				) : null}
				{request.method === "input" ? (
					<div className="flex w-full items-center gap-2">
						<Input
							className="h-9 flex-1 rounded-sm border border-border-subtle bg-bg-panel px-2.5 text-control text-text-primary outline-none transition-[border-color,box-shadow] duration-150 focus:border-[var(--color-accent)] focus:shadow-[var(--focus-ring)]"
							autoFocus
							value={value}
							placeholder={request.placeholder || t("ask.inputPlaceholder")}
							disabled={responding}
							onChange={(event) => setValue(event.target.value)}
							onKeyDown={(event) => {
								// IME 合成中的回车只用于选字/提交候选，不能当作提交键
								if (event.key === "Enter" && !isComposingKeyboardEvent(event) && value.trim()) {
									submitValue(value.trim());
								}
							}}
						/>
						<Button className="ask-inline-bar-submit-btn" variant="default" disabled={responding || !value.trim()} onClick={() => submitValue(value.trim())}>
							{t("ask.submit")}
						</Button>
					</div>
				) : null}
				{request.method === "editor" ? (
					<div className="flex w-full items-center gap-2">
						<Textarea
							className="h-auto min-h-[60px] w-full flex-1 resize-y rounded-sm border border-border-subtle bg-bg-panel p-2 text-caption leading-[1.5] text-text-primary outline-none transition-[border-color,box-shadow] duration-150 focus:border-[var(--color-accent)] focus:shadow-[var(--focus-ring)]"
							autoFocus
							value={value}
							placeholder={request.placeholder || t("ask.editorPlaceholder")}
							disabled={responding}
							onChange={(event) => setValue(event.target.value)}
							onKeyDown={(event) => {
								// 多行编辑器：回车保留换行，Ctrl/Cmd+Enter 提交（与主流编辑器快捷键一致）
								if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.shiftKey && !isComposingKeyboardEvent(event) && value.trim()) {
									event.preventDefault();
									submitValue(value);
								}
							}}
						/>
						<Button className="ask-inline-bar-submit-btn" variant="default" disabled={responding || !value.trim()} onClick={() => submitValue(value)}>
							{t("ask.submit")}
						</Button>
					</div>
				) : null}
			</div>
		</ApprovalCard>
	);
}
