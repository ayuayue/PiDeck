import { useCallback, useEffect, useRef, useState } from "react";
import type { EnhanceErrorKind } from "../../../shared/types/enhance";
import { desktopApi } from "../desktopApi";
import { t } from "../i18n";
import { showNotice } from "../utils/notice";

/**
 * 提示词增强的渲染域 hook：拥有「点击增强 → 流式预览 → 回填/失败」的完整状态机。
 *
 * 链路：点击 → captureRequest() 快照（当前模型 + 当前草稿）→ enhance:run →
 * 事件按 runId 过滤后累积为预览（starting = 已受理还没首个 delta）→ done 时
 * applyText 回填输入框。UI 必须让用户随时知道发生了什么：
 * - starting/streaming 都是显式状态（底栏胶囊 + 输入框上方预览面板）；
 * - 任何时刻可 cancel（stop 按钮 / 切换会话自动作废）；
 * - 失败用 toast 说明原因，按钮回到 idle，不会留下「点了没反应」的死态。
 *
 * 并发语义与主进程一致（新 run 打断旧 run）：start 在非 idle 时直接忽略——
 * UI 在运行中会变成 stop 按钮，正常路径到不了这里；aborted 一律静默回 idle
 * （要么用户主动停，要么被新 run 取代，都不该报错打扰）。
 */

/** 面板可见的运行阶段：starting = 模型还没吐首字；streaming = 预览在增长。 */
export type PromptEnhancePhase = "idle" | "starting" | "streaming";

export type PromptEnhanceView = {
	phase: PromptEnhancePhase;
	/** 流式累积的增强预览（starting 阶段为空串）。 */
	preview: string;
	/** 本次增强捕获的原稿快照（预览面板对照展示；idle 恒为空串）。 */
	original: string;
	/** 已收到的增强正文字符数（进度反馈，比转圈更有「在动」感）。 */
	chars: number;
};

/** 一次增强请求的快照：模型 + 草稿在同一时刻取定，运行中改设置不影响本次。 */
export type PromptEnhanceRequest = { provider: string; modelId: string; draft: string };

/** 错误分类 → 用户可读文案（i18n key 必须静态，动态模板串过不了类型检查）。 */
function enhanceErrorText(kind: EnhanceErrorKind): string {
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

export function usePromptEnhance(input: {
	/** 会话身份：切会话即作废进行中的 run（不把旧结果回填到新会话）。 */
	scopeKey: string;
	/** 发起点快照：模型解析失败（无可用模型）或草稿为空时返回 null，由 hook 报可读错误。 */
	captureRequest: () => PromptEnhanceRequest | null;
	/** 终态回填：run 存续期间 scopeKey 不变（切会话已取消），总是指向发起会话。 */
	applyText: (text: string) => void;
}) {
	const [phase, setPhase] = useState<PromptEnhancePhase>("idle");
	const [preview, setPreview] = useState("");
	const [original, setOriginal] = useState("");
	const [chars, setChars] = useState(0);

	const runIdRef = useRef("");
	const scopeKeyRef = useRef(input.scopeKey);
	const captureRef = useRef(input.captureRequest);
	const applyRef = useRef(input.applyText);
	captureRef.current = input.captureRequest;
	applyRef.current = input.applyText;

	const resetToIdle = useCallback(() => {
		runIdRef.current = "";
		setPhase("idle");
		setPreview("");
		setOriginal("");
		setChars(0);
	}, []);

	const start = useCallback(() => {
		if (runIdRef.current) return;
		const request = captureRef.current();
		if (!request) {
			showNotice(t("enhance.noModel"), 4000);
			return;
		}
		if (!request.draft.trim()) {
			showNotice(t("enhance.emptyDraft"), 4000);
			return;
		}
		const candidateRunId = `pending-${Math.random().toString(36).slice(2)}`;
		// 先占位：受理返回前用户再点直接忽略，也挡住连点双跑。
		runIdRef.current = candidateRunId;
		setPreview("");
		setOriginal(request.draft);
		setChars(0);
		setPhase("starting");
		void desktopApi.enhance
			.run({ provider: request.provider, modelId: request.modelId, userText: request.draft })
			.then((result) => {
				// 等待受理期间用户可能已取消/切换会话：候选 id 已被清掉就不再受理。
				if (runIdRef.current !== candidateRunId) {
					if (result.ok) void desktopApi.enhance.cancel();
					return;
				}
				if (!result.ok) {
					resetToIdle();
					showNotice(`${t("enhance.failed")}：${result.message || enhanceErrorText(result.errorKind)}`, 6000);
					return;
				}
				runIdRef.current = result.runId;
			})
			.catch(() => {
				// 受理请求本身失败（IPC 异常/服务缺失）：不能静默回 idle——那正是
				// 「点了没反应」的体验；必须给出可读提示。
				if (runIdRef.current === candidateRunId) {
					resetToIdle();
					showNotice(t("enhance.failed"), 6000);
				}
			});
	}, [resetToIdle]);

	const cancel = useCallback(() => {
		if (!runIdRef.current) return;
		// 立即回 idle（UI 抢先反馈）；主进程稍后送达的 aborted 事件因 runId 已清空被忽略。
		runIdRef.current = "";
		void desktopApi.enhance.cancel().catch(() => undefined);
		setPhase("idle");
		setPreview("");
		setOriginal("");
		setChars(0);
	}, []);

	// 事件订阅：按 runId 过滤；分屏/多输入框实例共用一个渲染进程，
	// 只有发起 run 的实例会命中自己的 runId。回调经 ref 读当前值，无 stale 问题。
	useEffect(() => {
		const unsubscribe = desktopApi.enhance.onEvent((event) => {
			if (!runIdRef.current || event.runId !== runIdRef.current) return;
			switch (event.phase) {
				case "delta": {
					setPhase("streaming");
					setPreview((current) => current + event.text);
					setChars((current) => current + event.text.length);
					break;
				}
				case "done": {
					const text = event.text;
					resetToIdle();
					applyRef.current(text);
					showNotice(t("enhance.applied"), 3000);
					break;
				}
				case "aborted":
					resetToIdle();
					break;
				case "error":
					resetToIdle();
					showNotice(`${t("enhance.failed")}：${event.message || enhanceErrorText(event.errorKind)}`, 6000);
					break;
			}
		});
		return unsubscribe;
	}, []);

	// 切换会话：进行中的 run 直接作废（等同用户点了 stop），旧结果绝不跨会话回填。
	useEffect(() => {
		if (scopeKeyRef.current !== input.scopeKey) {
			scopeKeyRef.current = input.scopeKey;
			cancel();
		}
	}, [input.scopeKey, cancel]);

	// 卸载：停掉还挂着的 run，避免面板关闭后请求无人认领（清理路径与订阅配对）。
	useEffect(() => {
		return () => {
			if (runIdRef.current) void desktopApi.enhance.cancel().catch(() => undefined);
		};
	}, []);

	return {
		view: { phase, preview, original, chars } satisfies PromptEnhanceView,
		start,
		cancel,
	};
}
