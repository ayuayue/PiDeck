import { useCallback, useEffect, useRef, useState } from "react";
import { AGENT_INVOKE_TEXT_MAX_CHARS, type AgentInvokeAction, type AgentModelRef, type AgentProfile, type AgentTranslateTarget } from "../../../../shared/types/agentProfile";
import type { EnhanceErrorKind } from "../../../../shared/types/enhance";
import { desktopApi } from "../../desktopApi";
import { getI18nLocale, t } from "../../i18n";
import { showNotice } from "../../utils/notice";
import { AGENT_TRANSLATE_TARGET_LABEL_KEYS, buildTranslateInstruction } from "../../utils/selectionToolPolicy";

/** 一次调用的运行阶段（与 hooks/useAgentInvoke 同一套语义，浮窗独立进程不复用该 hook）。 */
export type SelectionWindowInvokePhase = "idle" | "starting" | "streaming" | "done" | "error";

export type SelectionWindowInvokeState = {
	phase: SelectionWindowInvokePhase;
	/** 流式累积正文；done 后用主进程终态全文替换。 */
	text: string;
	errorKind: EnhanceErrorKind | null;
	/** error 阶段的用户可读文案（已按 errorKind 映射 i18n）。 */
	errorText: string;
};

export type SelectionWindowInvokeRequest = {
	agent: AgentProfile;
	text: string;
	action: AgentInvokeAction;
	targetLanguage: AgentTranslateTarget;
};

const IDLE_STATE: SelectionWindowInvokeState = { phase: "idle", text: "", errorKind: null, errorText: "" };

/**
 * 错误分类 → 用户可读文案。与 hooks/useAgentInvoke 用同一套词典；
 * 不直接 import 那个 hook 是因为它绑定主窗口的 Jotai 会话/增强模型原子，
 * 浮窗没有「当前会话」，模型解析规则不同（见 resolveWindowModel）。
 */
function invokeErrorText(kind: EnhanceErrorKind): string {
	switch (kind) {
		case "model-not-found":
			return t("enhance.error.modelNotFound");
		case "model-error":
			return t("enhance.error.modelError");
		case "timeout":
			return t("enhance.error.timeout");
		case "wsl":
			return t("enhance.error.wsl");
		case "no-pi-entry":
			return t("enhance.error.noPiEntry");
		case "helper-missing":
			return t("enhance.error.helperMissing");
		case "aborted":
			return t("enhance.stopped");
		case "sdk-unavailable":
		case "spawn-failed":
		case "protocol":
		case "busy":
		case "invalid-request":
		case "no-provider":
			return t("enhance.error.unavailable");
	}
}

/**
 * 浮窗的模型解析：智能体自带模型 > 主进程解析出的默认启动模型。
 *
 * 与主窗口调用面板的差异：浮窗没有「当前会话」，拿不到会话记录模型，
 * 因此第二级直接用 sessions.resolveLaunchDefaults（= 下一个新会话会用的模型，
 * 与引导页同一解析链），用户不用为划词单独配模型。
 */
async function resolveWindowModel(agent: AgentProfile): Promise<AgentModelRef | null> {
	const own = agent.model;
	if (own?.provider && own.modelId) return own;
	try {
		const defaults = await desktopApi.sessions.resolveLaunchDefaults({});
		const model = defaults.model;
		if (model?.provider && model.modelId) return { provider: model.provider, modelId: model.modelId };
	} catch {
		// 解析失败（pi 未安装/配置损坏）按「没有模型」处理：明确提示比静默等待更好。
	}
	return null;
}

/**
 * 浮窗的一次性调用状态机：run → agentProfiles.invoke → 按 runId 过滤的流式事件。
 *
 * 生命周期配对：
 * - 事件订阅在挂载时注册、卸载时退订；
 * - 卸载/新捕获/换智能体都作废进行中的 run（generation 递增 + cancelInvoke）；
 * - 「解析模型」是异步的，取消必须能打断它：generation 在 await 前后各校验一次，
 *   否则用户在 starting 阶段取消后，迟到的解析结果仍会发出请求。
 */
export function useSelectionWindowInvoke() {
	const [state, setState] = useState<SelectionWindowInvokeState>(IDLE_STATE);
	const runIdRef = useRef("");
	const generationRef = useRef(0);
	const mountedRef = useRef(true);

	const cancelRemote = useCallback(() => {
		void desktopApi.agentProfiles.cancelInvoke().catch(() => undefined);
	}, []);

	const cancel = useCallback(() => {
		// 递增 generation：让仍在解析模型/等待受理的 run 在恢复执行时直接退出。
		generationRef.current += 1;
		if (runIdRef.current) {
			runIdRef.current = "";
			cancelRemote();
		}
		setState((current) => (current.phase === "starting" || current.phase === "streaming" ? { ...current, phase: "idle" } : current));
	}, [cancelRemote]);

	const reset = useCallback(() => {
		generationRef.current += 1;
		if (runIdRef.current) {
			runIdRef.current = "";
			cancelRemote();
		}
		setState(IDLE_STATE);
	}, [cancelRemote]);

	const run = useCallback(
		async (request: SelectionWindowInvokeRequest) => {
			const text = request.text.trim().slice(0, AGENT_INVOKE_TEXT_MAX_CHARS);
			if (!text) return;
			const generation = generationRef.current + 1;
			generationRef.current = generation;
			// 新 run 打断旧 run：浮窗同一时刻只展示一次调用的结果。
			if (runIdRef.current) {
				runIdRef.current = "";
				cancelRemote();
			}
			setState({ phase: "starting", text: "", errorKind: null, errorText: "" });
			const model = await resolveWindowModel(request.agent);
			if (!mountedRef.current || generationRef.current !== generation) return;
			if (!model) {
				setState(IDLE_STATE);
				showNotice(t("agentInvoke.noModel"), 4000);
				return;
			}
			const instruction = buildTranslateInstruction({
				action: request.action,
				targetLanguage: request.targetLanguage,
				targetLabel: t(AGENT_TRANSLATE_TARGET_LABEL_KEYS[request.targetLanguage]),
				locale: getI18nLocale().startsWith("zh") ? "zh" : "en",
			});
			const candidateRunId = `selection-window-${Math.random().toString(36).slice(2)}`;
			// 先占位：IPC 受理返回前用户再点运行/取消都能命中同一个 runId。
			runIdRef.current = candidateRunId;
			try {
				const result = await desktopApi.agentProfiles.invoke({
					agentId: request.agent.id,
					text,
					action: request.action,
					...(request.action === "translate" ? { targetLanguage: request.targetLanguage } : {}),
					...(instruction ? { instruction } : {}),
					model,
				});
				if (!mountedRef.current || generationRef.current !== generation || runIdRef.current !== candidateRunId) {
					if (result.ok) cancelRemote();
					return;
				}
				if (!result.ok) {
					runIdRef.current = "";
					setState({ phase: "error", text: "", errorKind: result.errorKind, errorText: invokeErrorText(result.errorKind) });
					return;
				}
				runIdRef.current = result.runId;
			} catch {
				if (!mountedRef.current || generationRef.current !== generation) return;
				runIdRef.current = "";
				setState({ phase: "error", text: "", errorKind: "spawn-failed", errorText: t("enhance.error.unavailable") });
			}
		},
		[cancelRemote],
	);

	// 事件订阅：只认自己的 runId（同一窗口内过滤，不依赖服务端单飞语义）。
	useEffect(() => {
		const unsubscribe = desktopApi.agentProfiles.onInvokeEvent((event) => {
			if (!runIdRef.current || event.runId !== runIdRef.current) return;
			switch (event.phase) {
				case "started":
					break;
				case "delta":
					setState((current) => ({ phase: "streaming", text: current.text + event.text, errorKind: null, errorText: "" }));
					break;
				case "done":
					runIdRef.current = "";
					setState({ phase: "done", text: event.text, errorKind: null, errorText: "" });
					break;
				case "aborted":
					runIdRef.current = "";
					setState((current) => ({ ...current, phase: "idle", errorKind: null, errorText: "" }));
					break;
				case "error":
					runIdRef.current = "";
					setState({ phase: "error", text: "", errorKind: event.errorKind, errorText: invokeErrorText(event.errorKind) });
					break;
			}
		});
		return unsubscribe;
	}, []);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			generationRef.current += 1;
			if (runIdRef.current) {
				runIdRef.current = "";
				cancelRemote();
			}
		};
	}, [cancelRemote]);

	return { state, run, cancel, reset };
}
