/**
 * 提示词增强 IPC handler（薄层：只做入参校验与适配，业务在 EnhancePromptService）。
 *
 * 渲染层来的数据一律不可信：草稿文本/模型标识都设硬上限，事件回发给发起方
 * （event.sender），多窗口时各自只收自己发起的 run。
 */

import type { IpcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { EnhanceEventPayload } from "../../shared/types/enhance";
import type { EnhancePromptService } from "../pi/enhance/EnhancePromptService";

/** 模型/供应商 id 是目录中的原始键：中文、空格、冒号、URL 均合法，
 * 不在 IPC 层复制 pi 的命名文法，也不 trim 后改掉实际查找键。 */
const MAX_MODEL_ID_LENGTH = 160;
const MODEL_ID_CONTROL_CHARACTERS = /[\p{Cc}\u2028\u2029]/u;

/** 草稿上限：输入框粘贴的长文本也会被增强，64KB 覆盖合理用途并挡住误传。 */
const MAX_DRAFT_LENGTH = 64 * 1024;

function nonEmptyString(value: unknown, maxLength: number): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

/** 只拒绝空名称、控制字符与超长值；其余交给 pi 的模型目录匹配。 */
function isModelId(value: unknown): value is string {
	return nonEmptyString(value, MAX_MODEL_ID_LENGTH) && !MODEL_ID_CONTROL_CHARACTERS.test(value);
}

function parseEnhanceRunInput(value: unknown): { provider: string; modelId: string; userText: string } {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid enhance input: not an object");
	const record = value as Record<string, unknown>;
	// 诊断只带字段名不带值：草稿是用户内容，不进主进程日志。
	if (!isModelId(record.provider)) throw new Error("Invalid enhance input: provider");
	if (!isModelId(record.modelId)) throw new Error("Invalid enhance input: modelId");
	if (!nonEmptyString(record.userText, MAX_DRAFT_LENGTH)) throw new Error("Invalid enhance input: userText");
	return { provider: record.provider, modelId: record.modelId, userText: record.userText };
}

export function registerEnhanceIpc(ipc: IpcMain, service: EnhancePromptService | null): void {
	/** 装配失败（服务未创建）时抛结构化错误，而不是让渲染层拿到 undefined。 */
	const requireService = (): EnhancePromptService => {
		if (!service) throw new Error("Enhance service is not available");
		return service;
	};

	ipc.handle(ipcChannels.enhanceRun, async (event, input: unknown) => {
		const parsed = parseEnhanceRunInput(input);
		const sender = event.sender;
		// 事件只回发给发起方；窗口销毁后静默丢弃（run 的终态对 UI 已无意义）。
		// runId 先受理后知晓，回调经槽位读取，避免闭包直接引用受理结果。
		const state: { runId: string } = { runId: "" };
		const send = (payload: EnhanceEventPayload) => {
			if (!sender.isDestroyed()) sender.send(ipcChannels.enhanceEvent, payload);
		};
		const result = await requireService().enhance(parsed, {
			onDelta: (text) => send({ runId: state.runId, phase: "delta", text }),
			onDone: (text) => send({ runId: state.runId, phase: "done", text }),
			onAborted: () => send({ runId: state.runId, phase: "aborted" }),
			onError: (errorKind, message) => send({ runId: state.runId, phase: "error", errorKind, message }),
		});
		if (result.ok) {
			state.runId = result.runId;
			send({ runId: state.runId, phase: "started" });
		}
		return result;
	});

	ipc.handle(ipcChannels.enhanceCancel, async () => {
		requireService().cancel();
		return { ok: true };
	});
}
