/**
 * 输入预测 IPC handler（薄层：只做入参校验与适配，业务在 EnhancePromptService）。
 *
 * 与 enhance:run 的差别只有两处：systemPrompt / userText 由主进程填（渲染层无权传），
 * 且 purpose="suggest" 让 sidecar 不再追加「改写最后一条草稿」的约束。
 * 事件回发给发起方（event.sender），多窗口/多分屏各自只收自己发起的 run。
 *
 * 预测是后台功能（不弹 toast），所以每一步都写 scope=`suggest` 的应用日志：设置 → 日志
 * 里能区分「没触发 / 被拒绝 / 失败 / 模型返回空」，否则用户只能看到 ghost 没出现。
 * 日志只记模型标识、上下文条数、耗时与字数，不记用户内容。
 */

import type { IpcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { EnhanceEventPayload } from "../../shared/types/enhance";
import type { PromptSuggestionRunInput, PromptSuggestionRunResult } from "../../shared/types/promptSuggestion";
import type { EnhancePromptService } from "../pi/enhance/EnhancePromptService";
import { PROMPT_SUGGESTION_SYSTEM_PROMPT, PROMPT_SUGGESTION_USER_TEXT } from "../pi/enhance/promptSuggestion";
import { isModelId, parseContextMessages } from "./enhancePayloadValidation";

/** 应用日志（scope 固定 suggest）；不注入时全部丢弃，便于单测与降级装配。 */
export type PromptSuggestionLogger = {
	debug: (message: string) => void;
	info: (message: string) => void;
	warn: (message: string) => void;
};

const SILENT_LOGGER: PromptSuggestionLogger = { debug: () => undefined, info: () => undefined, warn: () => undefined };

function getErrorMessage(error: unknown): string {
	if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") return error.message;
	return String(error);
}

/** 输入预测必须有上下文：没有历史就没有预测依据，空数组按无效入参拒绝。 */
function parseSuggestionRunInput(value: unknown): PromptSuggestionRunInput {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid suggestion input: not an object");
	const record = value as Record<string, unknown>;
	if (!isModelId(record.provider)) throw new Error("Invalid suggestion input: provider");
	if (!isModelId(record.modelId)) throw new Error("Invalid suggestion input: modelId");
	const context = parseContextMessages(record.context, "suggestion");
	if (!context.length) throw new Error("Invalid suggestion input: context");
	return { provider: record.provider, modelId: record.modelId, context };
}

export function registerPromptSuggestionIpc(ipc: IpcMain, service: EnhancePromptService | null, logger: PromptSuggestionLogger = SILENT_LOGGER): void {
	const requireService = (): EnhancePromptService => {
		if (!service) throw new Error("Prompt suggestion service is not available");
		return service;
	};

	ipc.handle(ipcChannels.suggestRun, async (event, input: unknown): Promise<PromptSuggestionRunResult> => {
		let parsed: PromptSuggestionRunInput;
		try {
			parsed = parseSuggestionRunInput(input);
		} catch (error) {
			// 入参被拒也是「没预测」的来源（渲染层传了空上下文/坏模型），留痕后照旧抛给调用方。
			logger.warn(`输入预测请求被拒绝：${getErrorMessage(error)}`);
			throw error;
		}
		const startedAt = Date.now();
		const elapsed = () => Date.now() - startedAt;
		const modelLabel = `${parsed.provider}/${parsed.modelId}`;
		const sender = event.sender;
		// runId 先受理后知晓：回调经槽位读取，窗口销毁后静默丢弃。
		const state: { runId: string } = { runId: "" };
		const send = (payload: EnhanceEventPayload) => {
			if (!sender.isDestroyed()) sender.send(ipcChannels.suggestEvent, payload);
		};
		logger.debug(`输入预测发起：${modelLabel}，上下文 ${parsed.context.length} 条`);
		let result: Awaited<ReturnType<EnhancePromptService["enhance"]>>;
		try {
			result = await requireService().enhance(
				{ provider: parsed.provider, modelId: parsed.modelId, userText: PROMPT_SUGGESTION_USER_TEXT, context: parsed.context, systemPrompt: PROMPT_SUGGESTION_SYSTEM_PROMPT, purpose: "suggest" },
				{
					onDelta: (text) => send({ runId: state.runId, phase: "delta", text }),
					onDone: (text) => {
						send({ runId: state.runId, phase: "done", text });
						// 字数单独记：0 字 / 清洗后为空是「模型没给建议」，与请求失败不是一回事。
						logger.info(`输入预测完成：${text.length} 字${text.length ? "" : "（模型返回空内容）"}，${elapsed()}ms，${modelLabel}`);
					},
					onAborted: () => {
						send({ runId: state.runId, phase: "aborted" });
						logger.info(`输入预测中断：${elapsed()}ms，${modelLabel}（被新回合/新请求取代或用户取消）`);
					},
					onError: (errorKind, message) => {
						send({ runId: state.runId, phase: "error", errorKind, message });
						logger.warn(`输入预测失败（${errorKind}）：${message}，${elapsed()}ms，${modelLabel}`);
					},
				},
			);
		} catch (error) {
			logger.warn(`输入预测未受理：${getErrorMessage(error)}，${modelLabel}`);
			throw error;
		}
		if (result.ok) {
			state.runId = result.runId;
			send({ runId: state.runId, phase: "started" });
			logger.debug(`输入预测已受理：runId=${result.runId}，${modelLabel}`);
		} else {
			logger.warn(`输入预测未受理（${result.errorKind}）：${result.message}，${modelLabel}`);
		}
		return result;
	});

	ipc.handle(ipcChannels.suggestCancel, async () => {
		requireService().cancel();
		return { ok: true };
	});
}
