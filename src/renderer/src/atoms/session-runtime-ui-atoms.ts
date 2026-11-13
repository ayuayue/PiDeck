/**
 * 运行时 UI 请求状态（审批 / 提问 / 通知 / 编辑器注入 / widget）。
 *
 * 从 `session-atoms.ts` 原样搬家而来（拆分，行为零变化）：载荷白名单解析
 *（toAgentUiRequest）、事件归约（applySessionRuntimeUiEvent）、状态容器与
 * 应答占用/回滚两个写 atom。入口的 applySessionRuntimeEventAtom 调用这里的归约函数。
 * 入口 `session-atoms.ts` 用 `export *` 转出，所有既有 import 不变。
 */
import { atom } from "jotai";
import type { AgentUiBatchQuestion, AgentUiRequest, SessionRuntimeEvent } from "../../../shared/types";
import type { SessionRuntimeUiState } from "./session-atoms-types";

export const sessionRuntimeUiByIdAtom = atom<Record<string, SessionRuntimeUiState>>({});
function toAgentUiRequest(payload: Record<string, unknown>, agentId: string): AgentUiRequest | undefined {
	const requestId = typeof payload.requestId === "string" ? payload.requestId : "";
	if (!requestId) return undefined;
	const batchQuestions: AgentUiBatchQuestion[] | undefined = Array.isArray(payload.batchQuestions)
		? payload.batchQuestions.reduce<AgentUiBatchQuestion[]>((questions, question) => {
				if (!question || typeof question !== "object") return questions;
				const typed = question as Record<string, unknown>;
				if (
					typeof typed.id !== "string" ||
					typeof typed.question !== "string" ||
					// 与主进程/飞书 envelope 白名单同构：multi_select 也走批量信封，
					// 这里漏放行会导致选项组件整体不渲染（2026-09 回归）。
					!["select", "multi_select", "confirm", "input", "editor"].includes(String(typed.type))
				) {
					return questions;
				}
				const options = Array.isArray(typed.options)
					? typed.options.reduce<NonNullable<AgentUiBatchQuestion["options"]>>((items, option) => {
							if (typeof option === "string") {
								items.push(option);
								return items;
							}
							if (!option || typeof option !== "object") return items;
							const typedOption = option as Record<string, unknown>;
							if (typeof typedOption.label !== "string") return items;
							items.push({
								label: typedOption.label,
								...(typeof typedOption.value === "string" ? { value: typedOption.value } : {}),
								...(typeof typedOption.description === "string" ? { description: typedOption.description } : {}),
							});
							return items;
						}, [])
					: undefined;
				questions.push({
					id: typed.id,
					type: typed.type as AgentUiBatchQuestion["type"],
					question: typed.question,
					...(options?.length ? { options } : {}),
					...(typeof typed.allowOther === "boolean" ? { allowOther: typed.allowOther } : {}),
					...(typeof typed.placeholder === "string" ? { placeholder: typed.placeholder } : {}),
					...(typeof typed.prefill === "string" ? { prefill: typed.prefill } : {}),
				});
				return questions;
			}, [])
		: undefined;
	return {
		agentId,
		requestId,
		method: typeof payload.method === "string" ? payload.method : "",
		title: typeof payload.title === "string" ? payload.title : "",
		options: Array.isArray(payload.options) ? payload.options.filter((option): option is string => typeof option === "string") : undefined,
		placeholder: typeof payload.placeholder === "string" ? payload.placeholder : undefined,
		prefill: typeof payload.prefill === "string" ? payload.prefill : undefined,
		allowOther: payload.allowOther === true,
		completed: payload.completed === true,
		value: typeof payload.value === "string" || typeof payload.value === "boolean" ? payload.value : undefined,
		confirmed: typeof payload.confirmed === "boolean" ? payload.confirmed : undefined,
		cancelled: payload.cancelled === true,
		message: typeof payload.message === "string" ? payload.message : undefined,
		notifyType: payload.notifyType === "info" || payload.notifyType === "warning" || payload.notifyType === "error" ? payload.notifyType : undefined,
		text: typeof payload.text === "string" ? payload.text : undefined,
		widgetKey: typeof payload.widgetKey === "string" ? payload.widgetKey : undefined,
		widgetLines: Array.isArray(payload.widgetLines) ? payload.widgetLines.filter((line): line is string => typeof line === "string") : undefined,
		widgetPlacement: payload.widgetPlacement === "aboveEditor" || payload.widgetPlacement === "belowEditor" ? payload.widgetPlacement : undefined,
		batchQuestions: batchQuestions?.length ? batchQuestions : undefined,
		batchReview: payload.batchReview === true,
	};
}
export function applySessionRuntimeUiEvent(current: SessionRuntimeUiState | undefined, event: SessionRuntimeEvent, payload: Record<string, unknown>, bindingChanged: boolean): SessionRuntimeUiState | undefined {
	const base =
		!current || bindingChanged || current.agentId !== event.agentId || current.runtimeGeneration !== event.runtimeGeneration
			? {
					agentId: event.agentId,
					runtimeGeneration: event.runtimeGeneration,
					requests: {},
					widgets: {},
					revision: 0,
				}
			: current;
	if ((event.sourceChannel === "agents:state" || event.sourceChannel === "sessions:runtime") && payload.status === "closed") {
		return {
			agentId: event.agentId,
			runtimeGeneration: event.runtimeGeneration,
			requests: {},
			widgets: {},
			revision: base.revision + 1,
		};
	}
	if (event.sourceChannel !== "agents:ui-request") return bindingChanged ? base : current;
	const request = toAgentUiRequest(payload, event.agentId);
	if (!request) return base;
	const revision = base.revision + 1;

	if (request.completed) {
		const existing = base.requests[request.requestId];
		if (!existing) return { ...base, revision };
		return {
			...base,
			revision,
			requests: {
				...base.requests,
				[request.requestId]: {
					request: { ...existing.request, ...request },
					status: request.cancelled ? "cancelled" : "completed",
				},
			},
		};
	}
	if (request.method === "notify") {
		return request.message
			? {
					...base,
					revision,
					notification: {
						requestId: request.requestId,
						message: request.message,
						notifyType: request.notifyType,
						revision,
					},
				}
			: { ...base, revision };
	}
	if (request.method === "set_editor_text") {
		return {
			...base,
			revision,
			editorText: {
				requestId: request.requestId,
				text: request.text ?? "",
				revision,
			},
		};
	}
	if (request.method === "setWidget") {
		const widgetKey = request.widgetKey || request.requestId;
		const widgets = { ...base.widgets };
		if (request.widgetLines?.length) widgets[widgetKey] = request.widgetLines;
		else delete widgets[widgetKey];
		return { ...base, revision, widgets };
	}
	if (!["select", "confirm", "input", "editor", "batch_ask"].includes(request.method)) {
		return { ...base, revision };
	}
	return {
		...base,
		revision,
		requests: {
			...base.requests,
			[request.requestId]: { request, status: "pending" },
		},
	};
}
export const claimSessionRuntimeUiResponseAtom = atom(
	null,
	(
		get,
		set,
		input: {
			sessionId: string;
			requestId: string;
			agentId: string;
			runtimeGeneration: number;
			request?: AgentUiRequest;
		},
	) => {
		const current = get(sessionRuntimeUiByIdAtom)[input.sessionId];
		const request = current?.requests[input.requestId];
		if (!current || current.agentId !== input.agentId || current.runtimeGeneration !== input.runtimeGeneration || request?.status !== "pending" || (input.request !== undefined && request.request !== input.request)) {
			return false;
		}
		set(sessionRuntimeUiByIdAtom, {
			...get(sessionRuntimeUiByIdAtom),
			[input.sessionId]: {
				...current,
				requests: {
					...current.requests,
					[input.requestId]: { ...request, status: "responding" },
				},
			},
		});
		return true;
	},
);

export const rollbackSessionRuntimeUiResponseAtom = atom(
	null,
	(
		get,
		set,
		input: {
			sessionId: string;
			requestId: string;
			agentId: string;
			runtimeGeneration: number;
			request?: AgentUiRequest;
		},
	) => {
		const current = get(sessionRuntimeUiByIdAtom)[input.sessionId];
		const request = current?.requests[input.requestId];
		if (!current || current.agentId !== input.agentId || current.runtimeGeneration !== input.runtimeGeneration || request?.status !== "responding" || (input.request !== undefined && request.request !== input.request)) {
			return false;
		}
		set(sessionRuntimeUiByIdAtom, {
			...get(sessionRuntimeUiByIdAtom),
			[input.sessionId]: {
				...current,
				requests: {
					...current.requests,
					[input.requestId]: { ...request, status: "pending" },
				},
			},
		});
		return true;
	},
);
