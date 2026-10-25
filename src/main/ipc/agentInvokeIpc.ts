/**
 * 智能体一次性调用的 IPC handler（薄层：只做入参校验与事件适配，业务在
 * AgentInvokeService）。
 *
 * 渲染层来的数据一律不可信：agentId / 正文 / 附加指令都设硬上限；模型标识沿用
 * enhanceIpc 的规则——只挡空白、控制字符与超长，真实目录里的 `builtin:`、
 * `https://`、`a/b`、带空格的中文键都必须放行（曾因校验过严把用户点增强全拒掉）。
 * 事件只回发给发起方（event.sender），多窗口时各自只收自己发起的 run。
 */

import type { IpcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import { AGENT_INVOKE_INSTRUCTION_MAX_CHARS, AGENT_INVOKE_TEXT_MAX_CHARS, AGENT_TRANSLATE_TARGETS, type AgentInvokeAction, type AgentInvokeEventPayload, type AgentInvokeInput, type AgentInvokeResult, type AgentModelRef, type AgentTranslateTarget } from "../../shared/types/agentProfile";
import type { AgentInvokeService } from "../agents/AgentInvokeService";

/** agentId 由主进程生成（store 里是 uuid / 内置稳定 id），只挡空值与误传的超长值。 */
const MAX_AGENT_ID_LENGTH = 200;
/** 模型标识上限与 enhanceIpc 同档：真实目录键是百字符级，200 足够且挡住误传。 */
const MAX_MODEL_ID_LENGTH = 200;
const MODEL_ID_CONTROL_CHARACTERS = /[\p{Cc}\u2028\u2029]/u;

/** 动作与目标语言白名单直接取共享常量：IPC 校验与渲染层枚举不允许各写一份。 */
const AGENT_INVOKE_ACTIONS: readonly AgentInvokeAction[] = ["translate", "chat"];
const AGENT_INVOKE_ACTION_SET: ReadonlySet<string> = new Set(AGENT_INVOKE_ACTIONS);
const AGENT_TRANSLATE_TARGET_SET: ReadonlySet<string> = new Set(AGENT_TRANSLATE_TARGETS);

function nonEmptyString(value: unknown, maxLength: number): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

/** 只拒绝空名称、控制字符与超长值；其余交给 pi 的模型目录匹配。 */
function isModelId(value: unknown): value is string {
	return nonEmptyString(value, MAX_MODEL_ID_LENGTH) && !MODEL_ID_CONTROL_CHARACTERS.test(value);
}

function isAgentInvokeAction(value: unknown): value is AgentInvokeAction {
	return typeof value === "string" && AGENT_INVOKE_ACTION_SET.has(value);
}

function isTranslateTarget(value: unknown): value is AgentTranslateTarget {
	return typeof value === "string" && AGENT_TRANSLATE_TARGET_SET.has(value);
}

/** 模型引用：渲染层已解析好 provider/modelId（解析链在主进程之外），这里只校验形态。 */
function parseModel(value: unknown): AgentModelRef {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid agent invoke input: model");
	const record = value as Record<string, unknown>;
	if (!isModelId(record.provider)) throw new Error("Invalid agent invoke input: model.provider");
	if (!isModelId(record.modelId)) throw new Error("Invalid agent invoke input: model.modelId");
	return { provider: record.provider, modelId: record.modelId };
}

/**
 * 严格解析一次性调用入参（导出供单测直接锁定边界）。
 * 返回白名单字段的新对象：渲染层多带的字段一律丢弃，不进入服务层。
 */
export function parseAgentInvokeInput(value: unknown): AgentInvokeInput {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid agent invoke input: not an object");
	const record = value as Record<string, unknown>;
	if (!nonEmptyString(record.agentId, MAX_AGENT_ID_LENGTH)) throw new Error("Invalid agent invoke input: agentId");
	// 诊断只带字段名不带值：正文是用户内容，不进主进程日志。
	if (!nonEmptyString(record.text, AGENT_INVOKE_TEXT_MAX_CHARS)) throw new Error("Invalid agent invoke input: text");
	if (record.instruction !== undefined && (typeof record.instruction !== "string" || record.instruction.length > AGENT_INVOKE_INSTRUCTION_MAX_CHARS)) throw new Error("Invalid agent invoke input: instruction");
	if (record.action !== undefined && !isAgentInvokeAction(record.action)) throw new Error("Invalid agent invoke input: action");
	if (record.targetLanguage !== undefined && !isTranslateTarget(record.targetLanguage)) throw new Error("Invalid agent invoke input: targetLanguage");
	const model = parseModel(record.model);
	return {
		agentId: record.agentId,
		text: record.text,
		model,
		...(record.instruction !== undefined ? { instruction: record.instruction } : {}),
		...(record.action !== undefined ? { action: record.action } : {}),
		...(record.targetLanguage !== undefined ? { targetLanguage: record.targetLanguage } : {}),
	};
}

export function registerAgentInvokeIpc(ipc: IpcMain, service: AgentInvokeService | null): void {
	ipc.handle(ipcChannels.agentProfilesInvoke, async (event, input: unknown): Promise<AgentInvokeResult> => {
		// 入参校验放在服务判空之前：非法入参永远先被拦，不因装配状态改变返回值形状。
		const parsed = parseAgentInvokeInput(input);
		// 装配失败（服务未创建）时返回结构化错误，而不是抛裸异常跨 IPC：
		// 渲染层按 AgentInvokeResult 处理即可（errorKind 走同一套 i18n 文案）。
		if (!service) return { ok: false, errorKind: "sdk-unavailable", message: "agent-invoke-unavailable" };
		const sender = event.sender;
		// 事件只回发给发起方；窗口销毁后静默丢弃（run 的终态对 UI 已无意义）。
		// runId 先受理后知晓，回调经槽位读取，避免闭包直接引用受理结果。
		const state: { runId: string } = { runId: "" };
		const send = (payload: AgentInvokeEventPayload) => {
			if (!sender.isDestroyed()) sender.send(ipcChannels.agentProfilesInvokeEvent, payload);
		};
		const result = await service.invoke(parsed, {
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

	ipc.handle(ipcChannels.agentProfilesInvokeCancel, async () => {
		// 没有进行中的调用时 cancel 是纯 no-op：返回受理形状，不制造错误。
		service?.cancel();
		return { ok: true };
	});
}
