import { useAtomValue } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";
import { normalizeEnhanceModel, resolveEnhanceTargetModel } from "../../../shared/enhanceModelPreference";
import { AGENT_INVOKE_TEXT_MAX_CHARS, type AgentInvokeAction, type AgentModelRef, type AgentProfile, type AgentTranslateTarget } from "../../../shared/types/agentProfile";
import type { EnhanceErrorKind } from "../../../shared/types/enhance";
import { enhanceModelAtom } from "../atoms/composer-atoms";
import { currentSessionAtom } from "../atoms/session-atoms";
import { desktopApi } from "../desktopApi";
import { getI18nLocale, t } from "../i18n";
import { readWelcomeModelPreference } from "../utils/chatSessionBootstrap";
import { showNotice } from "../utils/notice";
import { AGENT_TRANSLATE_TARGET_LABEL_KEYS, buildTranslateInstruction } from "../utils/selectionToolPolicy";

/** 一次调用面板的运行阶段：starting = 已受理还没首个 delta；streaming = 正文在增长。 */
export type AgentInvokePhase = "idle" | "starting" | "streaming" | "done" | "error";

export type AgentInvokeViewState = {
	phase: AgentInvokePhase;
	/** 流式累积正文；done 后用主进程终态全文替换。 */
	text: string;
	/** 错误分类（phase="error" 时非空，供调用方决定标题/重试提示）。 */
	errorKind: EnhanceErrorKind | null;
	/** error 阶段的用户可读文案（已按 errorKind 映射 i18n）；其余阶段空串。 */
	errorText: string;
};

const IDLE_STATE: AgentInvokeViewState = { phase: "idle", text: "", errorKind: null, errorText: "" };

export type AgentInvokeRequest = {
	text: string;
	action: AgentInvokeAction;
	targetLanguage: AgentTranslateTarget;
};

/** 错误分类 → 用户可读文案（key 必须静态，动态模板串过不了类型检查；与 usePromptEnhance 同一套词典）。 */
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
		case "sdk-unavailable":
		case "spawn-failed":
		case "protocol":
		case "busy":
		case "invalid-request":
		case "no-provider":
			return t("enhance.error.unavailable");
		case "aborted":
			return t("enhance.stopped");
	}
}

/**
 * 智能体一次性调用的渲染域状态机（划词翻译 / 市场「使用」共用）。
 *
 * 链路：run() 解析目标模型 → agent-profiles:invoke → 按 runId 过滤的流式事件
 * （started/delta/done/aborted/error）→ 面板展示。语义与 usePromptEnhance 对齐：
 * - starting/streaming 都是显式阶段，任何时刻可 cancel（stop 按钮 / 换智能体自动作废）；
 * - aborted 一律静默回 idle（用户主动停或被新 run 取代，都不该报错打扰）；
 * - 卸载/作用域变化必须取消进行中的 run，并与事件订阅成对清理（生命周期配对）。
 *
 * 模型解析优先级（产品要求，与提示词增强同一套回退函数）：
 * 智能体自身模型 > 当前会话记录模型 > 设置固定增强模型 > 引导页点选偏好 > 调用方兜底模型。
 * fallbackModel 是 phase-2 新槽位（系统划词浮窗没有会话上下文，用它传主进程解析出的部署默认）；
 * 它必须排在最后，不能抢会话/设置的显式选择。
 */
export function useAgentInvoke(input: { agent: AgentProfile | null; scopeKey: string; fallbackModel?: AgentModelRef | null }) {
	const currentSession = useAtomValue(currentSessionAtom);
	const enhanceModel = useAtomValue(enhanceModelAtom);
	const [state, setState] = useState<AgentInvokeViewState>(IDLE_STATE);
	const runIdRef = useRef("");
	const mountedRef = useRef(true);
	/** 上一次真正发起的请求：restart() 重新生成时复用（含已裁剪的文本/动作/目标语言）。 */
	const lastRequestRef = useRef<AgentInvokeRequest | null>(null);

	const reset = useCallback(() => {
		if (runIdRef.current) {
			runIdRef.current = "";
			void desktopApi.agentProfiles.cancelInvoke().catch(() => undefined);
		}
		setState(IDLE_STATE);
	}, []);

	/** 主动停止：保留已收到的部分结果（用户要的是「别再生成」，不是丢掉已有输出）。 */
	const cancel = useCallback(() => {
		if (!runIdRef.current) return;
		runIdRef.current = "";
		void desktopApi.agentProfiles.cancelInvoke().catch(() => undefined);
		setState((current) => ({ ...current, phase: "idle" }));
	}, []);

	const captureModel = useCallback(() => {
		const agent = input.agent;
		if (!agent) return null;
		// resolveEnhanceTargetModel 只做「逐级取第一个双字段有效的候选」，槽位名沿用其文档语义；
		// 这里把「设置固定增强模型」放进 welcome 槽，实现上面的产品优先级（不复制可用性校验）。
		const preferred = resolveEnhanceTargetModel({
			configured: agent.model,
			recordModel: currentSession?.model,
			welcomeModel: enhanceModel ?? undefined,
			fallback: readWelcomeModelPreference()?.model,
		});
		// 调用方兜底排在最后：normalizeEnhanceModel 与主进程共用同一套「双字段非空」校验，
		// 半截数据（只有 provider 或 modelId）自然落空，不会被当成可用模型发出坏请求。
		return preferred ?? normalizeEnhanceModel(input.fallbackModel ?? null);
	}, [currentSession?.model, enhanceModel, input.agent, input.fallbackModel]);

	const run = useCallback(
		(request: AgentInvokeRequest) => {
			if (runIdRef.current) return; // 运行中再触发：UI 已是 stop 态，正常路径到不了；防连点双跑
			const agent = input.agent;
			if (!agent) {
				showNotice(t("agentInvoke.selectAgent"), 4000);
				return;
			}
			const text = request.text.trim().slice(0, AGENT_INVOKE_TEXT_MAX_CHARS);
			if (!text) return;
			const model = captureModel();
			if (!model) {
				// 发不出请求就绝不发：没有模型的静默等待比明确提示更糟。
				showNotice(t("agentInvoke.noModel"), 4000);
				return;
			}
			const locale = getI18nLocale().startsWith("zh") ? "zh" : "en";
			const instruction = buildTranslateInstruction({
				action: request.action,
				targetLanguage: request.targetLanguage,
				targetLabel: t(AGENT_TRANSLATE_TARGET_LABEL_KEYS[request.targetLanguage]),
				locale,
			});
			lastRequestRef.current = { text, action: request.action, targetLanguage: request.targetLanguage };
			const candidateRunId = `pending-${Math.random().toString(36).slice(2)}`;
			// 先占位：IPC 受理返回前用户再点直接忽略，也挡住连点双跑。
			runIdRef.current = candidateRunId;
			setState({ phase: "starting", text: "", errorKind: null, errorText: "" });
			void desktopApi.agentProfiles
				.invoke({
					agentId: agent.id,
					text,
					action: request.action,
					...(request.action === "translate" ? { targetLanguage: request.targetLanguage } : {}),
					...(instruction ? { instruction } : {}),
					model,
				})
				.then((result) => {
					if (!mountedRef.current || runIdRef.current !== candidateRunId) {
						// 等待受理期间已取消/切智能体/卸载：受理成功后立刻作废这次 run，避免后台空跑。
						// 只有当前没有新 run（runIdRef 为空）时才补发 cancel：cancelInvoke 不带 runId，
						// 若此刻已有新 run 在受理/流式，这一发会取消掉新 run（换语言/动作自动重跑的竞态）。
						if (result.ok && !runIdRef.current) void desktopApi.agentProfiles.cancelInvoke().catch(() => undefined);
						return;
					}
					if (!result.ok) {
						runIdRef.current = "";
						setState({ phase: "error", text: "", errorKind: result.errorKind, errorText: invokeErrorText(result.errorKind) });
						return;
					}
					runIdRef.current = result.runId;
				})
				.catch(() => {
					if (!mountedRef.current || runIdRef.current !== candidateRunId) return;
					runIdRef.current = "";
					setState({ phase: "error", text: "", errorKind: "spawn-failed", errorText: t("enhance.error.unavailable") });
				});
		},
		[captureModel, input.agent],
	);

	/**
	 * 重新生成：按上一次请求重跑（结果区 retry 按钮）。
	 * reset() 同步清空 runId 并作废旧 run，紧接着 run() 才能通过「运行中不重入」的守卫；
	 * 先发 cancelInvoke 再发 invoke，主进程按 IPC 到达顺序处理，不会误杀新 run。
	 */
	const restart = useCallback(() => {
		const request = lastRequestRef.current;
		if (!request) return;
		reset();
		run(request);
	}, [reset, run]);

	// 事件订阅：按当前 runId 过滤（同一渲染进程只有本 hook 实例会命中自己的 run）。
	useEffect(() => {
		const unsubscribe = desktopApi.agentProfiles.onInvokeEvent((event) => {
			if (!runIdRef.current || event.runId !== runIdRef.current) return;
			switch (event.phase) {
				case "started":
					// 保持 starting：面板在首个 delta 前显示「正在连接模型…」。
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

	// 卸载：作废进行中的 run 并标记已卸载（受理回调不再 setState）；StrictMode 二次挂载时重置标记。
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			if (runIdRef.current) {
				runIdRef.current = "";
				void desktopApi.agentProfiles.cancelInvoke().catch(() => undefined);
			}
		};
	}, []);

	// 换智能体 = 另一次调用：清空结果并作废进行中的 run，旧智能体的流式输出绝不串到新面板。
	const scopeKeyRef = useRef(input.scopeKey);
	useEffect(() => {
		if (scopeKeyRef.current === input.scopeKey) return;
		scopeKeyRef.current = input.scopeKey;
		reset();
	}, [input.scopeKey, reset]);

	return { state, run, cancel, reset, restart };
}
