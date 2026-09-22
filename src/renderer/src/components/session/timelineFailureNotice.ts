import type { ChatMessage } from "../../../../shared/types";
import { t, translateI18nDescriptor } from "../../i18n";
import { stripAnsi } from "./TimelineFormat";

/**
 * 失败/重试提示：主进程以 role=error / role=system 消息携带这些 i18nKey（见 AgentManager）。
 * 失败类与自动重试状态类都保留时间线诊断卡片（留痕可排查），同时弹 toast（即时提醒）；
 * 重试卡走专属标题/图标，见 RETRY_STATUS_KEYS。
 * 例外：重试成功卡是瞬态卡，不进时间线（见 RETRY_SUCCEEDED_KEY / isTransientRetryCard）。
 * pi 启动失败、runtimeError，以及扩展执行错误（带 debugDetails）本就保留诊断卡片。
 */
export const FLOATING_FAILURE_KEYS = new Set([
	"diagnostic.requestFailed",
	"diagnostic.requestFailedAfterRetries",
	"diagnostic.requestFailedUnknown",
	"diagnostic.requestFailedUnknownAfterRetries",
	"diagnostic.agentStopped",
	"diagnostic.promptRejected",
	"diagnostic.promptDeliveryUnknown",
	"diagnostic.commandFailed",
	"diagnostic.commandDeliveryUnknown",
	"diagnostic.commandCancelled",
	"diagnostic.processReconnectFailed",
	"diagnostic.historyLoadFailed",
	"diagnostic.retryScheduled",
	"diagnostic.retryScheduledAfterDelay",
	"diagnostic.retrySucceeded",
	"diagnostic.retryFailed",
]);

export const EXTENSION_ERROR_I18N_KEY = "diagnostic.extensionError";

/**
 * 自动重试状态卡（已调度 / 等待延迟后重试 / 重试成功 / 重试失败）：
 * 渲染层据此把「系统状态」换成「自动重试」标题，并在进行中时给旋转图标。
 * 这些 key 必须照常渲染时间线卡片——此前只弹 toast，用户事后完全看不出重试发生过
 * （toast 会自己消失、也不进历史），现在 toast 负责即时提醒、卡片负责留痕。
 * 唯一例外是「重试成功」：pi 按「一次 LLM 调用」计数，同一轮 run 内多次 5xx 会各发一次
 * auto_retry_end(success)，成功卡留在时间线上就堆成一排（见 isTransientRetryCard）。
 */
export const RETRY_SUCCEEDED_KEY = "diagnostic.retrySucceeded";
export const RETRY_STATUS_KEYS = new Set(["diagnostic.retryScheduled", "diagnostic.retryScheduledAfterDelay", RETRY_SUCCEEDED_KEY, "diagnostic.retryFailed"]);

/** toast 里附带的 debugDetails 上限，避免整段堆栈撑爆通知。 */
const MAX_TOAST_DETAIL_CHARS = 280;

export type FailureNoticeKind = "info" | "error";

export type FailureNoticeContent = {
	title: string;
	body: string;
	kind: FailureNoticeKind;
	duration: number;
	id?: string;
};

function messageI18nKey(message: ChatMessage): string {
	const key = message.meta?.i18nKey;
	return typeof key === "string" ? key : "";
}

/** 判断消息是否为「失败/重试类」提示（toast 层用：全部失败/重试都弹 toast）。 */
export function isFloatingFailureMessage(message: ChatMessage): boolean {
	return FLOATING_FAILURE_KEYS.has(messageI18nKey(message));
}

/** 判断消息是否为自动重试状态卡（标题走「自动重试」，等待重试时图标旋转）。 */
export function isRetryStatusMessage(message: ChatMessage): boolean {
	return RETRY_STATUS_KEYS.has(messageI18nKey(message));
}

/**
 * 重试成功卡是瞬态卡：不进时间线。
 *
 * 为什么：pi 的自动重试按「一次 LLM 调用」计数——同一轮 run 里连续多次 5xx 会各发一次
 * auto_retry_end(success)，主进程每个周期各留一张卡；成功卡不退场就会堆成一排
 * 「自动重试成功，共重试 N 次」（用户反馈：连续重试挂一排很难看）。重试成功由 toast
 * 即时报告，紧接着就是正常回答，时间线不需要这张卡。
 * 进行中的重试卡与失败卡仍照常渲染：进行中要告诉用户「当前不是最终失败」，
 * 失败要留痕可排查。
 *
 * 只作用于时间线渲染：toast 扫描用完整消息列表（reduceFailureNoticePass），
 * 成功 toast 与签名去重都不受影响。
 */
export function isTransientRetryCard(message: ChatMessage): boolean {
	return messageI18nKey(message) === RETRY_SUCCEEDED_KEY;
}

/** 扩展执行错误：时间线保留诊断卡，同时对新发生的错误弹一次带详情的 toast。 */
export function isExtensionErrorMessage(message: ChatMessage): boolean {
	return messageI18nKey(message) === EXTENSION_ERROR_I18N_KEY;
}

/** 需要弹 toast 的诊断（浮动失败 + 扩展错误）。 */
export function isFailureNoticeMessage(message: ChatMessage): boolean {
	return isFloatingFailureMessage(message) || isExtensionErrorMessage(message);
}

function messageRetryKey(message: ChatMessage): string {
	const key = messageI18nKey(message);
	return key.startsWith("diagnostic.retry") ? key : "";
}

/**
 * 自动重试是同一条系统消息的 upsert：id 不变、attempt 变。
 * 用 id+key+count 当签名，同一次尝试不重复弹，下一次尝试仍可更新 toast。
 */
export function failureRetrySignature(message: ChatMessage): string | undefined {
	const key = messageRetryKey(message);
	if (!key) return undefined;
	const meta = message.meta as Record<string, unknown> | undefined;
	const params = meta?.i18nParams;
	const count = typeof params === "object" && params ? String((params as Record<string, unknown>).count ?? meta?.attempt ?? "") : String(meta?.attempt ?? "");
	return `${message.id}:${key}:${count}`;
}

export type FailureNoticePassState = {
	/** 当前 pass 绑定的会话；切换后必须重采基线，否则会拿着上一会话的 id 去判新消息。 */
	sessionId: string | undefined;
	/** null = 尚未建立基线（加载中 / 刚切会话）。 */
	baselineIds: string[] | null;
};

export type FailureNoticePassInput = {
	sessionId: string;
	isLoading: boolean;
	messages: readonly ChatMessage[];
	state: FailureNoticePassState;
	/** 失败/扩展错误已弹过的消息 id（跨栏、跨会话切换保留）。 */
	toastedIds: Set<string>;
	/** 重试签名已弹过的集合；不能放组件 ref，切会话清掉就会把同一条「自动重试」再播一遍。 */
	toastedRetrySignatures: Set<string>;
};

/**
 * 失败/重试 toast 的一次扫描：只对「当前会话加载完成后新出现」的诊断弹。
 * 切走再切回同一会话时，已弹过的失败 id / 重试签名必须仍被挡住——这是用户看到 toast 重放的根因。
 */
export function reduceFailureNoticePass(input: FailureNoticePassInput): {
	state: FailureNoticePassState;
	toasts: ChatMessage[];
} {
	const sessionChanged = input.state.sessionId !== input.sessionId;
	if (input.isLoading) {
		return {
			state: { sessionId: input.sessionId, baselineIds: null },
			toasts: [],
		};
	}
	const floating = input.messages.filter(isFailureNoticeMessage);
	// 切会话或首次加载完成：把当前已有诊断记成基线，历史回放 / attach 重连不打扰。
	// 同时把已在场的重试签名写入全局集合，避免切回后 lastRetry 被清掉而重放。
	const baselineIds = sessionChanged ? null : input.state.baselineIds;
	if (baselineIds === null) {
		for (const message of floating) {
			const retrySignature = failureRetrySignature(message);
			if (retrySignature) input.toastedRetrySignatures.add(retrySignature);
			else input.toastedIds.add(message.id);
		}
		return {
			state: {
				sessionId: input.sessionId,
				baselineIds: floating.map((message) => message.id),
			},
			toasts: [],
		};
	}
	const toasts: ChatMessage[] = [];
	for (const message of floating) {
		const retrySignature = failureRetrySignature(message);
		if (retrySignature) {
			if (input.toastedRetrySignatures.has(retrySignature)) continue;
			input.toastedRetrySignatures.add(retrySignature);
			toasts.push(message);
			continue;
		}
		if (baselineIds.includes(message.id)) continue;
		if (input.toastedIds.has(message.id)) continue;
		input.toastedIds.add(message.id);
		toasts.push(message);
	}
	return {
		state: { sessionId: input.sessionId, baselineIds },
		toasts,
	};
}

function readDebugDetails(meta: ChatMessage["meta"]): string {
	const raw = typeof meta?.debugDetails === "string" ? meta.debugDetails.trim() : "";
	return raw;
}

function clipDetail(text: string): string {
	if (text.length <= MAX_TOAST_DETAIL_CHARS) return text;
	return `${text.slice(0, MAX_TOAST_DETAIL_CHARS)}…`;
}

/**
 * 组装失败/重试/扩展错误 toast。
 * 扩展错误不用「会话失败」当标题，并把 pi 原文（debugDetails）放进正文。
 */
export function composeFailureNotice(message: ChatMessage): FailureNoticeContent {
	const meta = message.meta;
	const key = messageI18nKey(message);
	const isRetry = key.startsWith("diagnostic.retry");
	const summary = stripAnsi(translateI18nDescriptor(meta, message.text) || message.text).trim();
	const details = stripAnsi(readDebugDetails(meta));
	const isExtensionError = key === EXTENSION_ERROR_I18N_KEY;

	let body = summary;
	if (isExtensionError) {
		// 标题已说明是扩展错误；正文优先给可排查的原文，没有原文再回退概括句。
		body = details ? clipDetail(details) : summary;
	} else if (!isRetry && details && details !== summary && !summary.includes(details)) {
		body = `${summary}\n${clipDetail(details)}`;
	}

	return {
		// toast 与时间线重试卡共用同一标题 key，避免两处文案各自漂移。
		title: t(isRetry ? "diagnostic.retryTitle" : isExtensionError ? "diagnostic.extensionErrorToastTitle" : "diagnostic.failureToastTitle"),
		body,
		kind: isRetry ? "info" : "error",
		duration: isRetry ? 2200 : 6000,
		id: isRetry ? `session-retry:${message.agentId}` : undefined,
	};
}
