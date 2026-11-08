/**
 * 关联会话（子对话）的共享契约。
 *
 * 一个 pi 会话的 agent 经随包扩展 `pi-deck-linked-sessions.ts` 开出完整的子会话；
 * 关联关系是 PiDeck 自己的本地数据（<userData>/linked-sessions.json），不写会话文件、不改 pi 协议。
 * 边界与禁止项见 docs/host-boundaries.md 例外九。
 *
 * 扩展是自包含 .ts（只能 import type），帧字段漂移没有编译期兜底：
 * `tests/linkedSessionsExtension.test.mjs` 按本文件核对扩展发出的字段名。
 */

/** 谁要的这个子会话：用户要求立即开 / 用户点名但先问一句 / agent 自己发现的后续工作。 */
export const LINKED_SESSION_INITIATIONS = ["user_asked", "offer", "own_initiative"] as const;
export type LinkedSessionInitiation = (typeof LINKED_SESSION_INITIATIONS)[number];

export const LINKED_SESSION_TITLE_MAX_CHARS = 80;
export const LINKED_SESSION_PROMPT_MAX_CHARS = 20_000;
/** 回报给父会话的子会话最终回复截取长度（与 Claude Code 桌面版的 400 字一致）。 */
export const LINKED_SESSION_REPORT_MAX_CHARS = 400;
/** 父会话被回报自动续跑的连续轮数上限；用户在父会话发消息即清零。 */
export const LINKED_SESSION_MAX_AUTO_CONTINUE = 6;
/** offer 卡片等用户回答的上限；超时按「未决定」返回给 agent。 */
export const LINKED_SESSION_OFFER_TIMEOUT_MS = 10 * 60_000;
/** own_initiative 提议卡片的有效期。 */
export const LINKED_SESSION_PROPOSAL_TTL_MS = 7 * 24 * 60 * 60_000;

/** 子会话的展示状态：由运行时事件推导，不是 pi 的状态枚举。 */
export type LinkedSessionState = "starting" | "running" | "idle" | "failed" | "stopped";

export type LinkedSessionLink = {
	childSessionId: string;
	parentSessionId: string;
	projectId: string;
	title: string;
	createdAt: number;
	state: LinkedSessionState;
	/** 最近一轮结束时最终回复的前 LINKED_SESSION_REPORT_MAX_CHARS 字。 */
	lastReport?: string;
	lastReportAt?: number;
	/** 已结束的回合数（含用户直接在子会话里发起的回合）。 */
	turnCount: number;
	archived: boolean;
};

export type LinkedSessionProposalStatus = "pending" | "started" | "here" | "dismissed" | "expired";

export type LinkedSessionProposal = {
	id: string;
	parentSessionId: string;
	projectId: string;
	title: string;
	prompt: string;
	initiation: Exclude<LinkedSessionInitiation, "user_asked">;
	/** 发起提议的 pi 工具调用 id：时间线卡片据此找到自己的提议。 */
	toolCallId?: string;
	status: LinkedSessionProposalStatus;
	createdAt: number;
	childSessionId?: string;
};

export type LinkedSessionsSnapshot = {
	links: LinkedSessionLink[];
	proposals: LinkedSessionProposal[];
};

/** 卡片按钮：开新会话 / 在当前会话里做 / 不要了。 */
export type LinkedSessionProposalAnswer = "new" | "here" | "dismiss";

export type AnswerLinkedSessionProposalInput = { proposalId: string; answer: LinkedSessionProposalAnswer };
export type AnswerLinkedSessionProposalResult = { ok: true; childSessionId?: string } | { ok: false; error: string };

/* ------------------------------------------------------------------ */
/* 扩展 → 端点 线格式                                                  */
/* ------------------------------------------------------------------ */

export type LinkedSessionsStartRequest = {
	op: "start";
	toolCallId?: string;
	title?: string;
	prompt?: string;
	initiation?: LinkedSessionInitiation;
	/** 启动先前 own_initiative 登记的提议（用户在对话里说「开第二个」时）。 */
	proposalId?: string;
};

export type LinkedSessionsSendRequest = {
	op: "send";
	sessionId: string;
	message: string;
};

export type LinkedSessionsListRequest = {
	op: "list";
};

export type LinkedSessionsRequest = LinkedSessionsStartRequest | LinkedSessionsSendRequest | LinkedSessionsListRequest;

export type LinkedSessionsResponse = { ok: true; data: unknown } | { ok: false; error: string };
