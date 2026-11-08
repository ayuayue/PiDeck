/**
 * pi-deck-linked-sessions —— 关联会话（子对话）工具。
 *
 * 让 agent 开出一个**完整的** PiDeck 会话来做一件独立的事：用户能在侧栏点开它、直接对话、停掉；
 * 它每轮结束，宿主把它最终回复的开头回报给本会话。对标 Claude Code 桌面版的子对话管理。
 * 与 pi-subagents 的区别：子代理是本轮里的一次性帮手（结果回到本轮）；关联会话是独立任务，活得比本轮久。
 *
 * **协议**（宿主侧唯一来源 `src/shared/types/linkedSessions.ts` 的 `LinkedSessionsRequest`；
 * 处理见 `src/main/linkedSessions/LinkedSessionServer.ts` / `LinkedSessionService.ts`）：
 * POST `<PIDECK_LINKED_SESSIONS_URL>`，头带 `x-pideck-linked-token`，体为 `{op:"start"|"send"|"list", ...}`，
 * 回 `{ok:true,data}` 或 `{ok:false,error}`。
 *
 * **硬约束**：
 * 1. env 缺失（纯终端跑 pi / 宿主端点未就绪 / 远端会话）→ 不注册任何工具（fail-safe）。
 * 2. 调用方身份由宿主按 token 解析，本扩展不上报「我是谁」。
 * 3. offer 会挂起到用户在卡片上点按钮（宿主侧最长 10 分钟），所以 start 的超时比它长；
 *    pi 中止本轮时随 signal 一起放弃。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

/** start 的本地超时：宿主 offer 等待上限 10 分钟 + 建会话与首条 prompt 激活的余量。 */
export const START_TIMEOUT_MS = 12 * 60_000;
const DEFAULT_TIMEOUT_MS = 60_000;

const StartParams = Type.Object({
	title: Type.Optional(Type.String({ description: "子会话标题，几个字说清这件事（≤80 字）" })),
	prompt: Type.Optional(
		Type.String({
			description: "交给子会话的完整简报：要动的文件/范围、做到什么算完、怎么验证、不能碰什么。子会话看不到本会话的上下文，必须自足。",
		}),
	),
	initiation: Type.Optional(
		StringEnum(["user_asked", "offer", "own_initiative"], {
			description:
				"user_asked=用户明确让你另开会话/并行/后台做，立即开；offer=用户点名了这件事但没说要另开，先出卡片问「新会话 / 在此做」并等回答；own_initiative=你自己发现的、用户没要求的后续工作，只登记一张提议卡片，用户点了才开。",
		}),
	),
	proposal_id: Type.Optional(Type.String({ description: "启动之前 own_initiative 登记的提议（用户说「开第二个」时）。给了它就不用再给 title/prompt。" })),
});

const SendParams = Type.Object({
	session_id: Type.String({ description: "目标会话 id：本会话开出的子会话，或开出本会话的父会话" }),
	message: Type.String({ description: "要发的消息；对方忙时排在它当前这一轮之后" }),
});

const ListParams = Type.Object({});

type EndpointResult = { ok: true; data: unknown } | { ok: false; error: string };

function textResult(value: unknown, isError = false) {
	return {
		content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
		details: { response: value },
		...(isError ? { isError: true } : {}),
	};
}

export default function piDeckLinkedSessions(pi: ExtensionAPI): void {
	const url = process.env.PIDECK_LINKED_SESSIONS_URL?.trim();
	const token = process.env.PIDECK_LINKED_SESSIONS_TOKEN?.trim();
	if (!url || !token) return;

	async function call(frame: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<EndpointResult> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		const onAbort = () => controller.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const response = await fetch(url as string, {
				method: "POST",
				headers: { "content-type": "application/json", "x-pideck-linked-token": token as string },
				body: JSON.stringify(frame),
				signal: controller.signal,
			});
			const body = (await response.json()) as EndpointResult;
			return body && typeof body === "object" && "ok" in body ? body : { ok: false, error: "invalid-response" };
		} catch (error) {
			if (signal?.aborted) return { ok: false, error: "aborted" };
			return { ok: false, error: controller.signal.aborted ? "timeout" : `pideck-unreachable: ${error instanceof Error ? error.message : String(error)}` };
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}
	}

	const asToolResult = (result: EndpointResult) => (result.ok ? textResult(result.data) : textResult(`失败：${result.error}`, true));

	pi.registerTool({
		name: "start_session",
		label: "Start Session",
		description: [
			"在当前项目里开一个独立的 PiDeck 会话来做一件自成一体的事：用户能在侧栏点开它、直接和它对话、停掉它；它每结束一轮，宿主会把它最终回复的开头回报到本会话。",
			"适合：活得比本轮久、有自己产出（一个分支、一处独立改动、一份报告）、用户可能想单独查看或接管的任务。",
			"不适合：一个问题、读几个文件、几步就能做完的事，或本任务的一部分（搜索、并行改同一处、测试/复核）——这些在本会话里做或用子代理。",
		].join(" "),
		promptSnippet: "Start a separate, user-visible PiDeck session for a self-contained task",
		promptGuidelines: [
			"start_session 的 initiation 决定谁拍板：用户明确说另开/并行/后台做 → user_asked；用户点名了这件事但没说怎么做 → offer（会挂起等用户点「新会话 / 在此做」）；你自己发现、用户没要求的后续工作 → own_initiative（只出卡片，每轮最多 3 张，别重复提）。",
			"简报必须自足：子会话看不到本会话。写清范围、完成标准、验证方式和禁止项，用你自己的话综合，不写「根据上面的发现」。",
			"两个会话不要同时改同一批文件。",
			"子会话的回报是它的自述，不是证据；告诉用户完成之前先核对它的结果（文件、diff、命令输出）。不要编造或预测子会话的结果，也不要轮询它。",
			"给已存在的子会话追加要求用 send_to_session，不要再开一个新的。",
		],
		parameters: StartParams,
		async execute(toolCallId, params, signal) {
			const record = params as Record<string, unknown>;
			const frame: Record<string, unknown> = { op: "start", toolCallId };
			if (typeof record.title === "string") frame.title = record.title;
			if (typeof record.prompt === "string") frame.prompt = record.prompt;
			if (typeof record.initiation === "string") frame.initiation = record.initiation;
			if (typeof record.proposal_id === "string") frame.proposalId = record.proposal_id;
			return asToolResult(await call(frame, START_TIMEOUT_MS, signal));
		},
	});

	pi.registerTool({
		name: "send_to_session",
		label: "Send To Session",
		description: "给与本会话直接关联的会话（本会话开出的子会话，或开出本会话的父会话）发一条消息。对方忙时排在它当前这一轮之后；不等对方回复。",
		promptSnippet: "Send a follow-up message to a linked parent or child session",
		parameters: SendParams,
		async execute(_toolCallId, params, signal) {
			const record = params as Record<string, unknown>;
			return asToolResult(await call({ op: "send", sessionId: record.session_id, message: record.message }, DEFAULT_TIMEOUT_MS, signal));
		},
	});

	pi.registerTool({
		name: "list_linked_sessions",
		label: "List Linked Sessions",
		description: "列出本会话开出的子会话（状态、已结束轮数、最近一次回报）、本会话的父会话，以及还没被用户处理的提议卡片。",
		promptSnippet: "List child sessions this session started and their latest reports",
		parameters: ListParams,
		async execute(_toolCallId, _params, signal) {
			return asToolResult(await call({ op: "list" }, DEFAULT_TIMEOUT_MS, signal));
		},
	});
}
