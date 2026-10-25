import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "jotai";
import { sessionMessageCacheBySessionIdAtomFamily } from "../atoms/session-atoms";
import { desktopApi } from "../desktopApi";
import { collectPromptEnhanceContext } from "../utils/promptEnhanceContext";
import { isPromptSuggestionAcceptKey, normalizePromptSuggestion, shouldShowPromptSuggestion } from "../utils/promptSuggestion";
import { logFromRenderer } from "../utils/rendererLog";

/**
 * 输入预测的渲染域 hook：拥有「回合结束 → 一次预测 → 空输入框 ghost 文案 → Tab 采纳」状态机。
 *
 * 与 usePromptEnhance 的分工：增强是用户显式点击 + 有面板/进度/toast；预测是**后台**
 * 功能，全程安静——失败、超时、模型不可用都不打扰用户（按钮都没点过，弹 toast 只会吵）。
 * 因此这里只有 `text` 与 `visible` 两个对外状态，其余全是内部簿记。
 *
 * 触发条件（缺一不可）：开关开、有可用目标模型、回合刚从 running 落回 idle、
 * 且缓存里最后一条是 assistant 正文。上下文取的是「回合结束后」的消息快照：
 * 直接读 atom 而不是闭包里的数组，避免流式收尾那一帧还差最后一段正文。
 */

/** 回合结束后稍等一拍再取快照：agent_end 到消息缓存落地之间可能还差一次写入。 */
const PREDICT_DELAY_MS = 300;

/**
 * 没预测/没结果的原因只记应用日志（scope=suggest，设置 → 日志可见），不弹 toast。
 * 关键：区分「没触发」与「模型没给东西」——前者是本地判定，后者带字数为 0 的完成记录。
 */
function logSuggestion(level: "debug" | "info" | "warn", message: string, detail?: unknown): void {
	logFromRenderer(level, "suggest", message, detail);
}

export type PromptSuggestionView = { text: string; visible: boolean };

export function usePromptSuggestion(input: {
	/** 会话身份：切会话即清空并取消进行中的预测。 */
	scopeKey: string;
	enabled: boolean;
	target: { provider: string; modelId: string } | null;
	/** 本轮是否在跑：true 时清掉旧建议，落回 false 时发起新预测。 */
	turnRunning: boolean;
	/** 草稿是否为空：非空时隐藏（不取消也不清空，删空后还能再看到）。 */
	draftEmpty: boolean;
	/** 采纳：交给 controller 整体回填（与增强共用同一套 focus/caret 语义）。 */
	applyText: (text: string) => void;
}): { text: string; visible: boolean; accept: () => void; dismiss: () => void; acceptKey: (event: { key: string; shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }) => boolean } {
	const store = useStore();
	const [text, setText] = useState("");

	const runIdRef = useRef("");
	const scopeKeyRef = useRef(input.scopeKey);
	const prevRunningRef = useRef(input.turnRunning);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const applyRef = useRef(input.applyText);
	const targetRef = useRef(input.target);
	const enabledRef = useRef(input.enabled);
	applyRef.current = input.applyText;
	targetRef.current = input.target;
	enabledRef.current = input.enabled;

	const clearTimer = useCallback(() => {
		if (timerRef.current) {
			clearTimeout(timerRef.current);
			timerRef.current = null;
		}
	}, []);

	/** 无条件丢弃进行中的预测（受理前的候选 id 也要清，迟到的受理结果据此自弃）。 */
	const cancel = useCallback(() => {
		if (!runIdRef.current) return;
		runIdRef.current = "";
		void desktopApi.suggestion.cancel().catch(() => undefined);
	}, []);

	const dismiss = useCallback(() => {
		clearTimer();
		cancel();
		setText("");
	}, [cancel, clearTimer]);

	/** 取本轮结束时的快照并发起预测；完成前只看开关与目标是否还有效。 */
	const start = useCallback(() => {
		if (!enabledRef.current) return;
		const target = targetRef.current;
		// 回合结束后目标模型才失效（切会话/改设置）：留一行原因，否则只是 ghost 不出现。
		if (!target) {
			logSuggestion("debug", "未预测：开关已开但没有可用目标模型（会话模型与固定模型都解析不到）");
			return;
		}
		const messages = store.get(sessionMessageCacheBySessionIdAtomFamily(scopeKeyRef.current))?.messages ?? [];
		const last = messages.at(-1);
		// 只有「答完」才预测：错误/中断/最后一条还是用户消息时不猜，省一次无意义调用。
		if (!last || last.role !== "assistant" || !last.text.trim()) {
			logSuggestion("debug", `未预测：最后一条不是 assistant 正文（role=${last?.role ?? "none"}，本轮可能出错/被中断）`);
			return;
		}
		const context = collectPromptEnhanceContext(messages);
		if (!context.length) {
			logSuggestion("debug", "未预测：上下文为空");
			return;
		}
		const candidate = `pending-${Math.random().toString(36).slice(2)}`;
		runIdRef.current = candidate;
		void desktopApi.suggestion
			.run({ provider: target.provider, modelId: target.modelId, context })
			.then((result) => {
				// 等受理期间：用户已开始输入/切会话/关开关，候选 id 已被清掉 → 立即撤回。
				if (runIdRef.current !== candidate) {
					logSuggestion("debug", "输入预测已撤回：受理前用户已开始输入/切会话/关开关");
					if (result.ok) void desktopApi.suggestion.cancel().catch(() => undefined);
					return;
				}
				if (!result.ok) {
					runIdRef.current = "";
					// 主进程已记 「未受理」原因，这里不重复刷屏。
					return;
				}
				runIdRef.current = result.runId;
			})
			.catch(() => {
				// 后台功能：IPC 失败不打扰用户，静默回到无建议状态（下一轮结束会再试）。
				if (runIdRef.current === candidate) runIdRef.current = "";
			});
	}, [store]);

	// 事件订阅：只认自己的 runId；只有 done 会产出文案（delta 不逐字渲染，避免 ghost 抖动）。
	useEffect(() => {
		const unsubscribe = desktopApi.suggestion.onEvent((event) => {
			if (!runIdRef.current || event.runId !== runIdRef.current) return;
			if (event.phase === "done") {
				const next = normalizePromptSuggestion(event.text);
				runIdRef.current = "";
				if (!next) logSuggestion("info", `输入预测无可用结果：模型返回 ${event.text.length} 字，清洗后为空`);
				setText(next);
				return;
			}
			if (event.phase === "aborted" || event.phase === "error") runIdRef.current = "";
		});
		return unsubscribe;
	}, []);

	// 回合边沿：开始 → 清旧建议并取消；结束 → 延迟一拍取快照预测。
	useEffect(() => {
		const wasRunning = prevRunningRef.current;
		prevRunningRef.current = input.turnRunning;
		if (input.turnRunning) {
			clearTimer();
			cancel();
			setText("");
			return;
		}
		if (!wasRunning) return;
		clearTimer();
		// 目标为空时下面的失效 effect 会清掉定时器，start() 根本跑不到；「没预测」的原因只能在这里记。
		// 开关关着是用户的显式选择，不记日志（否则每轮都刷一条无意义记录）。
		if (!enabledRef.current) return;
		if (!targetRef.current) {
			logSuggestion("debug", "未预测：开关已开但没有可用目标模型（会话模型与固定模型都解析不到）");
			return;
		}
		timerRef.current = setTimeout(() => {
			timerRef.current = null;
			start();
		}, PREDICT_DELAY_MS);
	}, [input.turnRunning, cancel, clearTimer, start]);

	// 开关/目标模型失效：立即作废（关开关不保留「最后一屏」ghost）。
	useEffect(() => {
		if (!input.enabled || !input.target) {
			clearTimer();
			cancel();
			setText("");
		}
	}, [input.enabled, input.target, cancel, clearTimer]);

	// 切会话：旧建议与在跑的预测都属于旧会话。
	useEffect(() => {
		if (scopeKeyRef.current === input.scopeKey) return;
		scopeKeyRef.current = input.scopeKey;
		clearTimer();
		cancel();
		setText("");
	}, [input.scopeKey, cancel, clearTimer]);

	// 卸载：与订阅/定时器配对清理。
	useEffect(() => {
		return () => {
			if (timerRef.current) clearTimeout(timerRef.current);
			if (runIdRef.current) void desktopApi.suggestion.cancel().catch(() => undefined);
		};
	}, []);

	const visible = shouldShowPromptSuggestion({ text, draftEmpty: input.draftEmpty, turnRunning: input.turnRunning, requestEnabled: input.enabled && !!input.target });

	const accept = useCallback(() => {
		if (!text) return;
		// 采纳即消费：ghost 消失，内容进入草稿（与增强回填同一条路径）。
		setText("");
		applyRef.current(text);
	}, [text]);

	const acceptKey = useCallback(
		(event: { key: string; shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }) =>
			// 判定逻辑在纯函数里（单测覆盖），这里只把「当前是否有可采纳建议」递进去。
			isPromptSuggestionAcceptKey(event, { hasSuggestion: visible }),
		[visible],
	);

	return { text, visible, accept, dismiss, acceptKey };
}
