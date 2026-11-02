/**
 * 记忆学习循环的纯逻辑：阈值、转录、解析、每会话进度。
 *
 * 设计取舍（对照 pi-hermes-memory 的 background-review）：
 * - **不常驻监听消息流**。宿主只需要一条「回合结算」信号（composite gateway 的
 *   onAgentSettled），真正的消息从记忆索引里取——三种后端（pi/DSH/ACP）归一后
 *   都是同一张 messages 表，学习循环不必为每种后端各写一份读取逻辑。
 * - **不静默花钱**。默认关闭；开启后每会话每新增 N 轮用户回合才调用一次模型，
 *   单次最多落 3 条，超出直接丢弃（预算交给 addMemory 的既有闸门）。
 * - **进度落盘而不是内存**。重启后不该从头再学一遍（重复调用模型＝重复计费），
 *   已学到的轮次记在 `<root>/learn-state.json`。
 *
 * 本文件只用传入的 root 与时钟，不碰 electron，便于单测。
 */

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 每会话新增多少轮用户回合才触发一次学习。12 轮够长：小改动不值得提炼。 */
export const AUTO_LEARN_MIN_NEW_TURNS = 12;
/** 单次学习最多落盘条数：宁少不滥，避免一次会话把记忆塞满。 */
export const AUTO_LEARN_MAX_ENTRIES = 3;
/** 喂给模型的转录上限（字符）：超出取**尾部**，结尾才是刚发生的事。 */
export const AUTO_LEARN_TRANSCRIPT_CHARS = 6000;
/** 从索引里取多少条消息来拼转录。 */
export const AUTO_LEARN_MESSAGE_LIMIT = 40;
/** 单条记忆的长度上限，与工具层 assertWritable 的宽松上限对齐。 */
const MAX_ENTRY_CHARS = 2000;

export const LEARN_STATE_FILENAME = "learn-state.json";

/** 可写入的目标：device 与 standing 不参与学习（前者是账号作用域，后者要用户显式同意）。 */
const LEARNABLE_TARGETS = ["memory", "user", "project", "failure"] as const;
type LearnableTarget = (typeof LEARNABLE_TARGETS)[number];

const LEARNABLE_CATEGORIES = ["failure", "correction", "insight", "preference", "convention", "tool-quirk"] as const;

export type LearnedEntry = { target: LearnableTarget; content: string; category?: string };

export type LearnedEntryRejection = "not-json" | "not-array" | "target-invalid" | "content-invalid" | "content-too-long" | "category-invalid" | "cap-exceeded";

export type ParseLearnedResult = { entries: LearnedEntry[]; rejected: { reason: LearnedEntryRejection; index: number }[] };

export const AUTO_LEARN_SYSTEM_PROMPT = `你是记忆提炼器。输入是一段 AI 编程助手与用户的会话转录，你的任务是找出**值得跨会话长期记住**的东西，输出 JSON 数组，不要任何解释文字。

只记这四类：
1. 用户的稳定偏好或工作方式（例如「用户要求中文回复」「提交前不加 -A」）
2. 项目约定或架构事实（例如「这个仓库用 npm，不用 pnpm」「IPC 通道要在三处同步」）
3. 用户明确纠正过的事，或踩过的坑及其原因（例如「不要用 -X theirs 合并」）
4. 可复用的做法或判定方法（例如「用 X 命令判断 Y」）

不要记：一次性的任务进度、临时 TODO、已经完成的工作清单、会话里的偶然数字、助手自己的过程独白。
一条记忆必须能脱离这次会话独立成立；不能独立成立的就不要记。

输出格式（严格 JSON 数组，最多 3 条；没有值得记的就输出 []）：
[{"target":"memory|user|project|failure","content":"一句话记忆","category":"failure|correction|insight|preference|convention|tool-quirk"}]
- target=user 只放「用户是谁/怎么做事」；target=memory 放通用经验；target=project 放这个项目的约定；target=failure 放踩过的坑（此时 category 必填，其余 target 可省略 category）。
- content 用陈述句，写清触发条件与结论，不要写「用户说他……」这类转述。`;

/** 每会话进度：learnedTurns 是上次学习时的用户回合数。 */
export type LearnState = { version: 1; sessions: Record<string, { learnedTurns: number; learnedAt: string }> };

const EMPTY_STATE: LearnState = { version: 1, sessions: {} };

export function readLearnState(root: string): LearnState {
	const file = join(root, LEARN_STATE_FILENAME);
	if (!existsSync(file)) return { ...EMPTY_STATE, sessions: {} };
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (!parsed || typeof parsed !== "object") return { ...EMPTY_STATE, sessions: {} };
		const sessions: LearnState["sessions"] = {};
		const raw = (parsed as { sessions?: unknown }).sessions;
		if (raw && typeof raw === "object") {
			for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
				const learnedTurns = Number((value as { learnedTurns?: unknown })?.learnedTurns);
				if (!Number.isFinite(learnedTurns) || learnedTurns < 0) continue;
				const learnedAt = typeof (value as { learnedAt?: unknown })?.learnedAt === "string" ? (value as { learnedAt: string }).learnedAt : "";
				sessions[id] = { learnedTurns: Math.floor(learnedTurns), learnedAt };
			}
		}
		return { version: 1, sessions };
	} catch {
		// 坏文件当没学过：重新学一次（多花一次模型调用）比永久卡住便宜。
		return { ...EMPTY_STATE, sessions: {} };
	}
}

/** 原子写：先写临时文件再改名，中途崩溃不会留半截 JSON。 */
export function writeLearnState(root: string, state: LearnState): void {
	const file = join(root, LEARN_STATE_FILENAME);
	const temporary = `${file}.${process.pid}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
		renameSync(temporary, file);
	} catch {
		rmSync(temporary, { force: true });
		throw new Error("learn-state-write-failed");
	}
}

export function markLearned(state: LearnState, sessionId: string, turns: number, at: string): LearnState {
	return { version: 1, sessions: { ...state.sessions, [sessionId]: { learnedTurns: turns, learnedAt: at } } };
}

/** 该会话是否值得学一次。 */
export function shouldLearn(state: LearnState, sessionId: string, turns: number, minimum = AUTO_LEARN_MIN_NEW_TURNS): boolean {
	const learned = state.sessions[sessionId]?.learnedTurns ?? 0;
	return turns - learned >= minimum;
}

/** 只数用户回合：助手的长篇输出不代表新需求。 */
export function countUserTurns(messages: readonly { role: string }[]): number {
	let count = 0;
	for (const message of messages) if (message.role === "user") count += 1;
	return count;
}

/**
 * 拼模型输入：按角色打标签，跳过空内容。
 *
 * 超长时保留**尾部**：这次会话最近发生的事才有提炼价值，开头往往是任务背景。
 */
export function buildTranscript(messages: readonly { role: string; content: string }[], maxChars = AUTO_LEARN_TRANSCRIPT_CHARS): string {
	const lines: string[] = [];
	for (const message of messages) {
		const text = message.content.trim();
		if (!text) continue;
		const label = message.role === "user" ? "用户" : message.role === "assistant" ? "助手" : message.role;
		lines.push(`${label}：${text}`);
	}
	const joined = lines.join("\n\n");
	return joined.length <= maxChars ? joined : `…（前文省略）\n${joined.slice(joined.length - maxChars)}`;
}

/**
 * 解析模型输出。
 *
 * 真实模型经常包一层 ```json 围栏或加一句「好的，这是结果」。这里不追求宽容到
 * 「猜出意图」——只用「第一个 [ 到最后一个 ]」截取候选，解析失败就当作没学到，
 * 绝不让模型输出直接决定写什么（每条还要再过工具层的扫描与预算闸门）。
 */
export function parseLearnedEntries(text: string, maxEntries = AUTO_LEARN_MAX_ENTRIES): ParseLearnedResult {
	const rejected: ParseLearnedResult["rejected"] = [];
	const start = text.indexOf("[");
	const end = text.lastIndexOf("]");
	if (start < 0 || end <= start) {
		rejected.push({ reason: "not-json", index: 0 });
		return { entries: [], rejected };
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text.slice(start, end + 1));
	} catch {
		rejected.push({ reason: "not-json", index: 0 });
		return { entries: [], rejected };
	}
	if (!Array.isArray(raw)) {
		rejected.push({ reason: "not-array", index: 0 });
		return { entries: [], rejected };
	}
	const entries: LearnedEntry[] = [];
	for (const [index, item] of raw.entries()) {
		if (entries.length >= maxEntries) {
			rejected.push({ reason: "cap-exceeded", index });
			continue;
		}
		const target = typeof (item as { target?: unknown })?.target === "string" ? (item as { target: string }).target.trim() : "";
		if (!(LEARNABLE_TARGETS as readonly string[]).includes(target)) {
			rejected.push({ reason: "target-invalid", index });
			continue;
		}
		const content = typeof (item as { content?: unknown })?.content === "string" ? (item as { content: string }).content.trim() : "";
		if (!content) {
			rejected.push({ reason: "content-invalid", index });
			continue;
		}
		if (content.length > MAX_ENTRY_CHARS) {
			rejected.push({ reason: "content-too-long", index });
			continue;
		}
		const rawCategory = typeof (item as { category?: unknown })?.category === "string" ? (item as { category: string }).category.trim() : "";
		if (rawCategory && !(LEARNABLE_CATEGORIES as readonly string[]).includes(rawCategory)) {
			rejected.push({ reason: "category-invalid", index });
			continue;
		}
		const entry: LearnedEntry = { target: target as LearnableTarget, content };
		// failure 条目没有分类会退化成 insight（工具层的默认值），学习循环显式补齐。
		if (rawCategory) entry.category = rawCategory;
		entries.push(entry);
	}
	return { entries, rejected };
}
