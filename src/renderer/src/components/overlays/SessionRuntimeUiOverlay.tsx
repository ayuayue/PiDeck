import { useEffect, useMemo, useState } from "react";
import { Check, ClipboardList } from "lucide-react";
import type {
	AgentUiBatchQuestion,
	AgentUiRequest,
	AgentUiResponse,
	SessionUiResponseInput,
} from "../../../../shared/types";
import type { SessionRuntimeUiState, SessionRuntimeViewState } from "../../atoms/session-atoms";
import { t } from "../../i18n";
import {
	buildAskResponse,
	formatAskTitle,
	hasTextSelection,
	parseSecurityConfirmTitle,
	pickActiveAskRequest,
	serializeBatchAnswers,
	splitAskOption,
} from "../../utils/askUi";
import { SecurityConfirmCard } from "./SecurityConfirmCard";
import { Button } from "../ui-shadcn/button";
import { Input } from "../ui-shadcn/input";
import { Textarea } from "../ui-shadcn/textarea";
import { ApprovalCard } from "../ui-shadcn/approval-card";

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

export function createSessionRuntimeUiResponder(input: {
	binding: RuntimeUiBinding;
	readBinding: () => RuntimeUiBinding | undefined;
	claim: ResponseClaim;
	rollback: ResponseRollback;
	send: (input: SessionUiResponseInput) => Promise<void>;
	onError?: (error: unknown) => void;
}): SessionRuntimeUiResponder {
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
function notifyAskExpanded(
	onExpandedChange: ((expanded: boolean) => void) | undefined,
	expanded: boolean,
) {
	onExpandedChange?.(expanded);
}
function BatchAskInlineBar(props: {
	request: AgentUiRequest;
	responding: boolean;
	onCancel: () => void;
	onSubmit: (answers: string) => void;
	onExpandedChange?: (expanded: boolean) => void;
}) {
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
		setInputValues(
			Object.fromEntries(
				questions
					.filter((question) => question.prefill)
					.map((question) => [question.id, question.prefill ?? ""]),
			),
		);
		setCurrentTab(0);
		setExpanded(true);
	}, [requestKey]);

	const answeredCount = questions.filter((question) => isBatchAnswered(answers[question.id])).length;
	const allAnswered = total > 0 && answeredCount === total;
	const reviewTab = props.request.batchReview === true && currentTab === total;
	const currentQuestion = reviewTab ? undefined : questions[currentTab];
	const finalStep = currentTab === total - 1;

	function setAnswer(questionId: string, value: BatchAnswer, label = batchAnswerLabel(value), wasCustom = false) {
		setAnswers((current) => ({ ...current, [questionId]: value }));
		setAnswerLabels((current) => ({ ...current, [questionId]: label }));
		setCustomAnswerIds((current) => {
			const next = new Set(current);
			if (wasCustom) next.add(questionId);
			else next.delete(questionId);
			return next;
		});
	}

	function submitText(question: AgentUiBatchQuestion) {
		const value = inputValues[question.id]?.trim();
		if (value) setAnswer(question.id, value, value, question.type === "select");
	}

	function submitAnswers() {
		props.onSubmit(serializeBatchAnswers(
			questions,
			answers,
			Object.fromEntries(questions.map((question) => [
				question.id,
				{
					label: answerLabels[question.id],
					wasCustom: customAnswerIds.has(question.id),
				},
			])),
		));
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
			description={t("ask.batchProgress", { done: answeredCount, total })}
			onCancel={props.onCancel}
			cancelDisabled={props.responding}
			cancelLabel={t("common.close")}
			className="ask-inline-bar ask-inline-bar--active w-full"
		>
			<div className="mb-1 flex min-w-0 gap-1 overflow-x-auto border-b border-border-subtle pb-1" role="tablist">
				{questions.map((question, index) => {
					const answered = isBatchAnswered(answers[question.id]);
					const active = index === currentTab;
					return (
						<Button
							key={question.id}
							variant="ghost"
							role="tab"
							aria-selected={active}
							className={`ask-batch-tab inline-flex h-[26px] flex-none items-center gap-1 rounded-md border border-border-subtle bg-transparent px-2 font-sans text-micro whitespace-nowrap text-text-secondary transition-colors hover:border-border-strong hover:text-text-primary focus-visible:outline-[var(--focus-ring)] focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-55${active ? " active" : ""}${answered ? " answered" : ""}`}
							disabled={props.responding}
							onClick={() => setCurrentTab(index)}
						>
							<span className="min-w-[14px] text-center font-mono font-semibold">{index + 1}</span>
							{/* 单行截断：tab 只做摘要，完整问题在下方详情区展示；
							    多行会突破胶囊固定高度溢出到下方内容（min-w-0 让 truncate 在 flex 里生效） */}
							<span className="max-w-[28ch] min-w-0 truncate text-left" title={question.question}>{question.question}</span>
							{answered ? <Check size={11} className="shrink-0 text-[var(--color-success)]" aria-hidden="true" /> : null}
						</Button>
					);
				})}
				{props.request.batchReview ? (
					<Button
						variant="ghost"
						role="tab"
						aria-selected={reviewTab}
						className={`ask-batch-tab ask-batch-tab--review border-[var(--color-warning)] text-[var(--color-warning)] inline-flex h-[26px] flex-none items-center gap-1 rounded-md px-2 font-sans text-micro whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-55${reviewTab ? " active" : ""}`}
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
										<span className={`min-w-0 text-right font-mono font-medium [overflow-wrap:anywhere]${answered ? " answered" : " unanswered"}`}>
											{answered ? answerLabels[question.id] ?? batchAnswerLabel(value) : "-"}
										</span>
									</div>
								);
							})}
						</div>
						{!allAnswered ? (
							<div className="rounded-sm bg-[color:color-mix(in_srgb,var(--color-warning)_10%,transparent)] p-2 text-caption text-[var(--color-warning)]">{t("ask.batchIncomplete")}</div>
						) : null}
						<Button
														variant="default"
							disabled={!allAnswered || props.responding}
							onClick={submitAnswers}
						>
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
						onAnswer={(value, label, wasCustom) => setAnswer(currentQuestion.id, value, label, wasCustom)}
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
	onAnswer: (value: BatchAnswer, label?: string, wasCustom?: boolean) => void;
	onInputChange: (value: string) => void;
	onSubmitInput: () => void;
	onPrevious?: () => void;
	onNext: () => void;
	nextDisabled: boolean;
	finalLabel?: string;
}) {
	const { question } = props;
	const selectOptions = question.type === "select" || question.type === "multi_select" ? question.options ?? [] : [];
	const hasOptionDescriptions = selectOptions.some((option) => typeof option !== "string" && Boolean(option.description));
	const hasLongOptionText = selectOptions.some((option) => {
		const label = typeof option === "string" ? option : option.label;
		const description = typeof option === "string" ? "" : option.description ?? "";
		return label.length > 28 || description.length > 56;
	});
	const expandedOptionLayout = hasOptionDescriptions || hasLongOptionText || selectOptions.length > 6;
	return (
		<div className="flex flex-col gap-1.5">
			<div className="font-mono text-micro font-semibold text-text-tertiary">
				{t("common.details")} {props.questionIndex + 1}/{props.total}
			</div>
			<div className="mb-1 text-control font-medium leading-5 break-words text-text-primary">{question.question}</div>
			<div className="ask-batch-question-body">
				{question.type === "confirm" ? (
					<div className="flex gap-2">
						<Button
							className={`ask-inline-bar-option ask-inline-bar-option-yes flex-none items-center justify-center gap-1 whitespace-nowrap${props.answer === true ? " selected" : ""}`}
							variant="outline"
							disabled={props.responding}
							onClick={() => {
								// 划选复制的 mouseup 落在按钮上会冒充 click；有选区时不记答案。
								if (hasTextSelection()) return;
								props.onAnswer(true, t("common.true"));
							}}
						>
							{/* 选中态对勾：部分主题色 accent 对比度低，光靠变色难分辨已选项 */}
							{props.answer === true ? <Check size={14} className="shrink-0 text-[var(--color-success)]" aria-hidden="true" /> : null}
							{t("common.true")}
						</Button>
						<Button
							className={`ask-inline-bar-option ask-inline-bar-option-no flex-none items-center justify-center gap-1 whitespace-nowrap${props.answer === false ? " selected" : ""}`}
							variant="outline"
							disabled={props.responding}
							onClick={() => {
								if (hasTextSelection()) return;
								props.onAnswer(false, t("common.false"));
							}}
						>
							{props.answer === false ? <Check size={14} className="shrink-0 text-[var(--color-success)]" aria-hidden="true" /> : null}
							{t("common.false")}
						</Button>
					</div>
				) : question.type === "select" && question.options?.length ? (
					<>
						{/* 长文案/多选项使用宽卡片并自然增高；外层时间线是唯一滚动容器，避免嵌套滚动。 */}
						<div className={`grid min-w-0 gap-1.5 ${expandedOptionLayout ? "grid-cols-2 max-[720px]:grid-cols-1" : "grid-cols-4 max-[720px]:grid-cols-2 max-[480px]:grid-cols-1"}`}>
							{question.options.map((option, index) => {
								const rawLabel = typeof option === "string" ? option : option.label;
								const parsed = typeof option === "string"
									? splitAskOption(option)
									: { label: rawLabel, description: option.description };
								const label = parsed.label;
								const value = typeof option === "string" ? option : option.value ?? rawLabel;
								const description = parsed.description;
								return (
									<Button
										key={`${question.id}:${index}`}
										className={`ask-inline-bar-option h-auto min-h-[30px] w-full min-w-0 max-w-none flex-col items-start justify-center gap-0.5 px-2 py-1 text-left break-words whitespace-normal${expandedOptionLayout ? " min-h-[72px] py-2" : ""}${props.answer === value ? " selected" : ""}`}
										variant="outline"
										disabled={props.responding}
										onClick={() => {
										if (hasTextSelection()) return;
										props.onAnswer(value, label);
									}}
									>
										{/* 选中态对勾标记：主题色 accent 对比度低时只靠边框/背景变色难分辨已选项 */}
										<span className="flex min-w-0 max-w-full items-center gap-1">
											{props.answer === value ? <Check size={14} className="shrink-0 text-[var(--color-success)]" aria-hidden="true" /> : null}
											<span className="min-w-0 max-w-full break-words whitespace-normal text-caption font-medium leading-5 text-text-primary" title={label}>{label}</span>
										</span>
										{description ? <span className="min-w-0 max-w-full break-words whitespace-normal text-micro font-normal leading-5 text-text-tertiary" title={description}>{description}</span> : null}
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
											props.onSubmitInput();
										}
									}}
								/>
								<Button
																		variant="default"
									disabled={props.responding || !props.inputValue.trim()}
									onClick={props.onSubmitInput}
								>
									{t("ask.submit")}
								</Button>
							</div>
						) : null}
					</>
				) : question.type === "multi_select" && question.options?.length ? (
					<>
						{/* 多选：checkbox 语义（选中打勾，再点取消），选完走底部的下一题/提交全部 */}
						<div className={`grid min-w-0 gap-1.5 ${expandedOptionLayout ? "grid-cols-2 max-[720px]:grid-cols-1" : "grid-cols-4 max-[720px]:grid-cols-2 max-[480px]:grid-cols-1"}`}>
							{question.options.map((option, index) => {
								const rawLabel = typeof option === "string" ? option : option.label;
								const parsed = typeof option === "string"
									? splitAskOption(option)
									: { label: rawLabel, description: option.description };
								const label = parsed.label;
								const value = typeof option === "string" ? option : option.value ?? rawLabel;
								const description = parsed.description;
								const selectedValues = Array.isArray(props.answer) ? props.answer : [];
								const selected = selectedValues.includes(value);
								return (
									<Button
										key={`${question.id}:${index}`}
										className={`ask-inline-bar-option h-auto min-h-[30px] w-full min-w-0 max-w-none flex-col items-start justify-center gap-0.5 px-2 py-1 text-left break-words whitespace-normal${expandedOptionLayout ? " min-h-[72px] py-2" : ""}${selected ? " selected" : ""}`}
										variant="outline"
										disabled={props.responding}
										onClick={() => {
											if (hasTextSelection()) return;
											// 切换选中项：multi_select 答案始终是数组
											const next = selected
												? selectedValues.filter((v) => v !== value)
												: [...selectedValues, value];
											props.onAnswer(next, next.join("、"));
										}}
									>
										{/* 选中态对勾标记：主题色 accent 对比度低时只靠边框/背景变色难分辨已选项 */}
										<span className="flex min-w-0 max-w-full items-center gap-1">
											{selected ? <Check size={14} className="shrink-0 text-[var(--color-success)]" aria-hidden="true" /> : null}
											<span className="min-w-0 max-w-full break-words whitespace-normal text-caption font-medium leading-5 text-text-primary" title={label}>{label}</span>
										</span>
										{description ? <span className="min-w-0 max-w-full break-words whitespace-normal text-micro font-normal leading-5 text-text-tertiary" title={description}>{description}</span> : null}
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
								if (event.key === "Enter") {
									event.preventDefault();
									props.onSubmitInput();
								}
							}}
						/>
						<Button
														variant="default"
							disabled={props.responding || !props.inputValue.trim()}
							onClick={props.onSubmitInput}
						>
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
				<Button
					className="h-7 px-2 text-caption"
					variant="ghost"
					disabled={props.responding || props.nextDisabled}
					onClick={props.onNext}
				>
					{props.questionIndex < props.total - 1
						? t("ask.batchNext")
						: props.finalLabel ?? t("ask.batchGoReview")}
				</Button>
			</div>
		</div>
	);
}

export function SessionRuntimeUiOverlay({ sessionId, runtime, ui, responder, onExpandedChange }: SessionRuntimeUiOverlayProps) {
	const active = Boolean(
		runtime &&
		ui &&
		runtime.status !== "detached" &&
		runtime.status !== "closed" &&
		runtime.agentId === ui.agentId &&
		runtime.runtimeGeneration === ui.runtimeGeneration,
	);
	const request = useMemo(
		() => active && ui ? pickActiveAskRequest(ui.requests) : undefined,
		[active, ui],
	);
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

	if (!active || !request || !requestState) return null;
	const responding = busy || requestState.status === "responding";
	const answer = async (method: string, response: AgentUiResponse) => {
		if (responding) return;
		setBusy(true);
		const accepted = await responder.respond(request, response);
		if (!accepted) setBusy(false);
	};
	const cancel = () => void answer(request.method, buildAskResponse(request.method, undefined, { cancelled: true }));
	const submitValue = (value: string | boolean | undefined, confirmed?: boolean) => {
		// 划选复制的 mouseup 落在选项/提交按钮上会冒充 click，误答提问。
		// Enter 键也走这里：input/textarea 选区不进 window.getSelection，键盘提交不受影响。
		if (hasTextSelection()) return;
		void answer(request.method, buildAskResponse(request.method, value, { confirmed }));
	};

	if (request.method === "batch_ask") {
		return (
			<BatchAskInlineBar
				request={request}
				responding={responding}
				onCancel={cancel}
				onSubmit={(answers) => submitValue(answers)}
				onExpandedChange={onExpandedChange}
			/>
		);
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
			<div>
				{request.method === "select" && request.options?.length ? (
					<div className="grid min-w-0 grid-cols-2 gap-1.5 max-[480px]:grid-cols-1">
						{request.options.map((option) => {
							const parsed = splitAskOption(option);
							return (
								<Button
									key={`${request.requestId}:${option}`}
									// 单行选项（2026-12 用户反馈：上下两行文本对不齐）：标签+说明同行，
									// 固定高度 + 说明 truncate（title 兔底全文），等宽等高实现光学对齐。
									className={`ask-inline-bar-option h-[30px] w-full min-w-0 max-w-none items-center justify-start gap-2 px-2 py-0 text-left${selectedOption === option ? " selected" : ""}`}
									variant="outline"
									disabled={responding}
									onClick={() => {
										if (hasTextSelection()) return;
										setSelectedOption(option);
									}}
									title={parsed.description || parsed.label}
								>
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
										if (event.key === "Enter" && value.trim()) submitValue(value.trim());
									}}
								/>
								<Button
																		variant="default"
									disabled={responding || !value.trim()}
									onClick={() => submitValue(value.trim())}
								>
									{t("ask.submit")}
								</Button>
							</div>
						) : null}
					</div>
				) : null}
				{selectedOption ? (
					<div className="mt-1 flex w-full min-w-0 items-center gap-1.5">
						<span className="min-w-0 flex-1 truncate text-caption text-text-secondary">
							{t("ask.selectedPrefix")}{splitAskOption(selectedOption).label}
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
								if (event.key === "Enter" && value.trim()) submitValue(value.trim());
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
