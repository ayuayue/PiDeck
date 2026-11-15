/**
 * 从 AppUtils 拆出的「消息分组类型」域：时间线条目形状的唯一定义处。
 * 只放类型，不放实现——实现分别落在 groupMessages / renderEquality / reconcileRuns。
 */

import type { ChatMessage } from "../../../../../shared/types";

/* ── 消息分组类型 ── */

export type ToolGroupItem = {
	kind: "tool-group";
	id: string;
	messages: ChatMessage[];
};

export type MessageItem = { kind: "message"; message: ChatMessage };

/**
 * 重试过程条目：一轮 run 内的自动重试状态消息（正在重试/成功/最终失败）。
 * 与工具/思考同层，作为 run 的过程步骤参与折叠，不再渲染成时间线独立大卡片
 * ——旧形态与工具时间线割裂且顺序错乱（卡片插在工具调用与后续回答之间）。
 */
export type RetryGroupItem = {
	kind: "retry-group";
	/** 与消息 id 一致，保证 Live upsert（同 id 原地改写）映射稳定 */
	id: string;
	message: ChatMessage;
};

/**
 * 错误诊断过程条目（用户反馈：429 等错误卡并入工具调用，像重试一样）。
 * agent 忙碌中的 error 诊断消息（请求失败/扩展错误）收进当前 run 的过程序列：
 * 与工具/思考/重试同层展示，可点开查看 debugDetails 里的具体错误。
 * run 尚未开始（首轮请求立即失败）时仍保持独立条目（见 groupToolMessages error 分支）。
 */
export type ErrorGroupItem = {
	kind: "error-group";
	/** 与消息 id 一致，保证 Live upsert（同 id 原地改写）映射稳定 */
	id: string;
	message: ChatMessage;
};

export type ThinkingGroupItem = {
	kind: "thinking-group";
	id: string;
	messages: ChatMessage[];
	text: string;
	startedAt: number;
	endedAt: number;
};

export type AgentRunItem = {
	kind: "agent-run";
	id: string;
	items: Array<MessageItem | ToolGroupItem | ThinkingGroupItem | RetryGroupItem | ErrorGroupItem | ExtensionEntryGroupItem>;
	startedAt: number;
	endedAt: number;
	/** 本轮内 ask_question 的用户等待总时长（ms）：由已完成的 ask 工具消息推导，
	 *  回复耗时（endedAt - startedAt）需扣除这部分，等待段不计入 agent 处理时间。 */
	askWaitMs: number;
	/** 本轮是否阻塞在提问上（最后一条 ask 工具仍在等待回答）：尾部耗时应冻结而非持续跳动。 */
	askPending: boolean;
	/** 阻塞中的提问弹起时刻（ask 工具 beganAt），用于把尾部耗时冻结在该时刻。 */
	askPendingAt?: number;
	/**
	 * 本轮内被时间线隐藏、但必须参与「修改的文件」汇总的工具消息。
	 *
	 * 目前唯一来源：DSH PTC 模式（preset 走 run_code 单工具）的文件类子调用。它们由
	 * dshEventProjector 投影成 meta.ptcNested=true 的隐藏消息——时间线只显示外层 run_code 卡，
	 * 但如果直接丢弃，轮末 chip 行就完全拿不到本轮改了哪些文件（2027-02 实测 PTC 会话恒为空）。
	 *
	 * 因此这些消息**不进 items**（不渲染），而是存在这里专供 collectRunFileChanges 聚合。
	 */
	hiddenFileMessages?: ChatMessage[];
};

/** 扩展输出条目组：同一 run 内连续到达的 appendEntry 投影卡合为一个过程组成员（用户决策 2026-10：不单独成块，折进过程组）。 */
export type ExtensionEntryGroupItem = {
	kind: "extension-entries";
	id: string;
	messages: ChatMessage[];
};

export type RenderMessage = MessageItem | ToolGroupItem | ThinkingGroupItem | RetryGroupItem | ErrorGroupItem | ExtensionEntryGroupItem | AgentRunItem;
