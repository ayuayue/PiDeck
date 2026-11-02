/**
 * 学习循环的编排层：索引 → 取最近消息 → 模型提炼 → 逐条落盘。
 *
 * 所有外部能力都以端口注入（root/sources/complete/logger/now），本文件不碰 electron、
 * 不读 settings、不 spawn 进程——装配在 src/main/index.ts。这样单测可以用假模型
 * 覆盖「阈值、解析、落盘、去重、失败」全部路径，不需要网络与凭据。
 *
 * 与 pi-hermes-memory 的 background-review 的关键差异：
 * - 触发信号来自宿主的「回合结算」，不是监听每条消息（三后端统一）；
 * - 记忆条目走工具层同一个 addMemory（扫描/去重/预算一处生效，学习不会绕过闸门）；
 * - 任何失败都只记日志并停止：学习是可选增益，不能影响会话。
 */

import type { AgentMemorySource } from "./agentMemoryMounts";
import { addMemory, MemoryToolError } from "../../../resources/agent-memory/tools.mjs";
import { indexSources } from "../../../resources/agent-memory/sessions.mjs";
import { sessionMessages } from "../../../resources/agent-memory/db.mjs";
import { AUTO_LEARN_MESSAGE_LIMIT, AUTO_LEARN_SYSTEM_PROMPT, buildTranscript, countUserTurns, parseLearnedEntries, readLearnState, shouldLearn, markLearned, writeLearnState, type LearnState } from "./autoLearn";

/** 会话来源沿用挂载描述里的定义：服务器与学习循环必须索引同一组目录。 */
export type { AgentMemorySource } from "./agentMemoryMounts";

export type LearnerLogger = {
	info(channel: string, message: string, meta?: Record<string, unknown>): void;
	warn(channel: string, message: string, meta?: Record<string, unknown>): void;
};

export type LearnerDeps = {
	/** 记忆根目录（userData/memory）。 */
	root: string;
	/** 会话索引来源（pi sessions 根 + ACP 归档根）。 */
	sources: readonly AgentMemorySource[];
	/** 一次性补全：返回模型原文。失败应 reject。 */
	complete: (input: { systemPrompt: string; text: string }) => Promise<string>;
	logger?: LearnerLogger;
	now?: () => Date;
	/** 便于单测替换写入口；默认就是工具层 addMemory。 */
	addEntry?: (input: { target: string; content: string; category?: string; projectId: string }) => { duplicate?: boolean };
};

export type LearnerOutcome = {
	ran: boolean;
	/** 未跑的原因：便于日志与测试断言。 */
	skipped?: "no-session" | "below-threshold" | "index-unavailable" | "empty-transcript" | "already-running";
	userTurns?: number;
	added?: number;
	duplicate?: number;
	rejected?: string[];
	/** 模型调用或解析失败的错误码（不抛出）。 */
	error?: string;
};

/** 同一时刻只跑一趟：学习是后台增益，不需要并发，也不该和用户操作抢模型通道。 */
let inFlight: Promise<LearnerOutcome> | null = null;

export async function runLearnerPass(deps: LearnerDeps, input: { sessionId?: string; projectId?: string }): Promise<LearnerOutcome> {
	if (inFlight) return { ran: false, skipped: "already-running" };
	const pass = runPass(deps, input);
	inFlight = pass;
	try {
		return await pass;
	} finally {
		inFlight = null;
	}
}

async function runPass(deps: LearnerDeps, input: { sessionId?: string; projectId?: string }): Promise<LearnerOutcome> {
	const sessionId = input.sessionId;
	if (!sessionId) return { ran: false, skipped: "no-session" };
	const projectId = input.projectId ?? "";
	const now = deps.now?.() ?? new Date();
	const root = deps.root;

	// 索引是懒的：增量索引成本按「文件大小/mtime 未变就跳过」计，通常只有当前会话变脏。
	try {
		indexSources(root, deps.sources);
	} catch (error) {
		deps.logger?.warn("agent-memory", "learn: index failed", { error: describe(error) });
	}

	const snapshot = sessionMessages(root, sessionId, { limit: AUTO_LEARN_MESSAGE_LIMIT });
	if (!snapshot.ok) return { ran: false, skipped: "index-unavailable" };

	const state: LearnState = readLearnState(root);
	const userTurns = snapshot.userTurns;
	if (!shouldLearn(state, sessionId, userTurns)) return { ran: false, skipped: "below-threshold", userTurns };

	const transcript = buildTranscript(snapshot.messages);
	if (!transcript) return { ran: false, skipped: "empty-transcript", userTurns };

	let output: string;
	try {
		output = await deps.complete({ systemPrompt: AUTO_LEARN_SYSTEM_PROMPT, text: transcript });
	} catch (error) {
		// 模型不可用/超时/被取消：不动进度，下次满足阈值时再试。
		return { ran: false, error: describe(error), userTurns };
	}

	const parsed = parseLearnedEntries(output);
	const rejected = parsed.rejected.map((entry) => `${entry.reason}@${entry.index}`);
	let added = 0;
	let duplicate = 0;
	for (const entry of parsed.entries) {
		// target=project 需要真实项目 id：没有项目上下文时退化成全局经验，
		// 而不是当失败丢弃——模型无从得知当前是哪个项目。
		const target = entry.target === "project" && !projectId ? "memory" : entry.target;
		try {
			const outcome = deps.addEntry ? deps.addEntry({ target, content: entry.content, category: entry.category, projectId }) : addMemory(root, { target, content: entry.content, category: entry.category, projectId });
			if (outcome?.duplicate) duplicate += 1;
			else added += 1;
		} catch (error) {
			// 工具层闸门（扫描命中注入/密钥、预算裁剪、目标非法）在这里统一拒收。
			rejected.push(error instanceof MemoryToolError ? error.message : describe(error));
		}
	}

	// 只有真的调用过模型才推水位：模型失败时不该把这一段会话标记成「已学」。
	try {
		writeLearnState(root, markLearned(readLearnState(root), sessionId, userTurns, now.toISOString()));
	} catch (error) {
		deps.logger?.warn("agent-memory", "learn: state write failed", { error: describe(error) });
	}
	deps.logger?.info("agent-memory", "learn pass done", { sessionId, userTurns, added, duplicate, rejected: rejected.length });
	return { ran: true, userTurns, added, duplicate, rejected };
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
