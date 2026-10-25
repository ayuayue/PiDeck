/**
 * 智能体「一次性调用」的宿主侧服务（划词翻译 / 市场面板试跑）。
 *
 * 通道复用提示词增强侧车 `resources/pi-enhance-host.mjs` 的「一次性单条补全」
 * （见 AGENTS.md 例外四）：不新开第二条模型通道，也不让渲染层碰 pi SDK。区别只在
 * 角色设定——提示词增强用内置改写模板，智能体调用用主进程按 agentId 解析出的
 * systemPrompt（渲染层只能传 agentId，见 shared/types/agentProfile.ts）。
 *
 * 职责划分：
 * - 本服务只做业务校验、角色设定解析、用户消息拼装与用量记账；
 * - 侧车进程生命周期 / boot 与 run 超时 / 取消结算全部在 EnhancePromptService
 *   （它是清理路径的唯一归属地），这里经注入的 AgentCompletionRunner 访问，
 *   单测不需要 spawn 任何进程。
 */

import { AGENT_INVOKE_INSTRUCTION_MAX_CHARS, AGENT_INVOKE_TEXT_MAX_CHARS, type AgentInvokeInput, type AgentInvokeResult, type AgentProfile } from "../../shared/types/agentProfile";
import type { EnhanceErrorKind } from "../../shared/types/enhance";
import type { EnhanceAcceptResult, EnhanceRunCallbacks } from "../pi/enhance/EnhancePromptService";

/**
 * 受理失败时的 message 用稳定机器标记：errorKind 决定渲染层文案，message 只进
 * 日志/详情。这三个是渲染层可能按值判断的契约，不要改成自由文案。
 */
const INVALID_TEXT_MESSAGE = "invalid-text";
const INVALID_INSTRUCTION_MESSAGE = "invalid-instruction";
const AGENT_NOT_FOUND_MESSAGE = "agent-not-found";
const AGENT_EMPTY_PROMPT_MESSAGE = "agent-system-prompt-empty";

/** 一次调用的回调集：与 EnhanceRunCallbacks 同形，由 IPC 层转成 agentProfiles:invoke-event。 */
export type AgentInvokeCallbacks = {
	onDelta: (text: string) => void;
	onDone: (text: string) => void;
	onAborted: () => void;
	onError: (errorKind: EnhanceErrorKind, message: string) => void;
};

/** 补全通道入参：模型与文本都已由主进程解析/校验完毕，侧车不再查设置。 */
export type AgentCompletionInput = {
	provider: string;
	modelId: string;
	userText: string;
	/**
	 * 主进程-only 的角色设定；缺省时侧车回落内置增强模板（提示词增强路径）。
	 * 渲染层拿不到这个字段（AgentInvokeInput 里没有），只能传 agentId。
	 */
	systemPrompt?: string;
};

/**
 * 补全通道抽象：生产装配直接传 EnhancePromptService 实例（结构完全兼容，无需适配器），
 * 单测传假实现——服务层因此不依赖子进程、定时器与 Electron。
 */
export type AgentCompletionRunner = {
	enhance: (input: AgentCompletionInput, callbacks: EnhanceRunCallbacks) => Promise<EnhanceAcceptResult>;
	cancel: () => void;
};

/**
 * 智能体目录的最小读接口（真实实现是主进程 AgentProfileStore）。
 * 只暴露本服务用到的两个动作：按 id 取角色设定、记一次成功调用。
 */
export type AgentProfileLookup = {
	/** 按 id 精确查找；不存在返回 undefined（不能返回 null，调用方按 undefined 判定）。 */
	get: (agentId: string) => AgentProfile | undefined;
	/** 记一次成功受理：usageCount+1 / lastUsedAt；未知 id 应静默返回，不抛错。 */
	recordUsage: (agentId: string) => Promise<void>;
};

/** 只取本服务需要的主进程日志面（装配层注入 AppLogger 适配）。 */
export type AgentInvokeLogger = {
	warn: (message: string) => void;
	error: (message: string) => void;
};

export type AgentInvokeServiceDeps = {
	profiles: AgentProfileLookup;
	completion: AgentCompletionRunner;
	/** 缺省静默；用量记账失败只告警，不影响调用结果。 */
	logger?: AgentInvokeLogger;
};

/** 从原生 Error、跨 realm 错误或未知抛出值中提取可读详情（与 EnhancePromptService 同口径）。 */
function getErrorMessage(error: unknown): string {
	if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") return error.message;
	return String(error);
}

function invalidRequest(message: string): AgentInvokeResult {
	return { ok: false, errorKind: "invalid-request", message };
}

/**
 * 智能体一次性调用服务。
 *
 * 生命周期：一次调用 = 一个侧车 run，同一时刻只有一个（新调用打断旧调用由
 * EnhancePromptService 保证）；`cancel()` 转发给侧车，渲染层停止按钮/关闭浮层共用。
 * 回调纪律：受理成功返回 runId 后，终态经 onDone/onAborted/onError 恰好送达一次；
 * 受理失败只返回结构化错误，不回调（与 enhance:run 同一语义）。
 */
export class AgentInvokeService {
	private readonly profiles: AgentProfileLookup;
	private readonly completion: AgentCompletionRunner;
	private readonly logger?: AgentInvokeLogger;

	constructor(deps: AgentInvokeServiceDeps) {
		this.profiles = deps.profiles;
		this.completion = deps.completion;
		this.logger = deps.logger;
	}

	/** 发起一次调用；校验不过/智能体不存在/通道起不来都返回结构化错误。 */
	async invoke(input: AgentInvokeInput, callbacks: AgentInvokeCallbacks): Promise<AgentInvokeResult> {
		// 选中文本两端空白不含语义，裁掉后再拼装：否则 instruction 前会出现大片空行。
		const text = input.text.trim();
		// 长度按原始串判：两侧空白也会随消息发给模型，先裁后判会让超长输入偷偷通过。
		if (!text || input.text.length > AGENT_INVOKE_TEXT_MAX_CHARS) return invalidRequest(INVALID_TEXT_MESSAGE);
		const instruction = (input.instruction ?? "").trim();
		if (instruction.length > AGENT_INVOKE_INSTRUCTION_MAX_CHARS) return invalidRequest(INVALID_INSTRUCTION_MESSAGE);

		const agent = this.profiles.get(input.agentId);
		if (!agent) return invalidRequest(AGENT_NOT_FOUND_MESSAGE);
		const systemPrompt = agent.systemPrompt.trim();
		// 空角色设定不能回落侧车内置的「提示词改写」模板：那会把翻译请求当成草稿重写，
		// 结果与用户预期完全错位。直接拒绝，让渲染层提示重新编辑该智能体。
		if (!systemPrompt) return invalidRequest(AGENT_EMPTY_PROMPT_MESSAGE);

		const result = await this.completion.enhance({ provider: input.model.provider, modelId: input.model.modelId, userText: instruction ? `${text}\n\n${instruction}` : text, systemPrompt }, callbacks);
		// 受理失败时侧车没有跑任何东西，也不能记用量。
		if (!result.ok) return { ok: false, errorKind: result.errorKind, message: result.message };
		this.recordUsage(agent.id);
		return { ok: true, runId: result.runId };
	}

	/** 取消当前调用（渲染层停止按钮 / 关闭浮层）。没有进行中的 run 时静默。 */
	cancel(): void {
		this.completion.cancel();
	}

	/**
	 * 用量记账是「尽力而为」：失败只告警，绝不把已受理的调用改成错误——模型已经在
	 * 跑了，UI 已进入流式状态，回退成 error 会让用户以为调用没发生。
	 * Promise.resolve().then 包一层：同步抛错的实现也走同一条告警路径。
	 */
	private recordUsage(agentId: string): void {
		void Promise.resolve()
			.then(() => this.profiles.recordUsage(agentId))
			.catch((error: unknown) => {
				this.logger?.warn(`智能体用量记账失败（${agentId}）：${getErrorMessage(error)}`);
			});
	}
}
