import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type { ChatMessage } from "../../../shared/types";
import type { SessionProcessEvent } from "../../../shared/types/trajectory";
import { getAppLogger } from "../../logging/sharedLogger";
import { assembleDshHistoryEntries, countDshUserMessages, DSH_HISTORY_DEFAULT_TURN_PAGE_SIZE, normalizeDshTurnPageSize, planDshHistoryRounds, trimToOldestTurnStart } from "../dshHistoryPagePlan";
import { projectDshEvent } from "../dshEventProjector";
import { collectDshProcessEvents } from "../dshProcessEvents";
import { projectDshSubagentTranscriptPage, type DshSubagentTranscriptPage } from "../dshSubagentTranscript";
import type { DshEnvelope, DshHistoryEntry, DshHistoryPage, DshRemoteClient } from "../dshRemoteClient";
import type { DshHost } from "../DshHost";
import type { DshAgentRuntime } from "./dshAgentRuntime";

/**
 * 历史读取的宿主出口：会话 map、host 冷读游标、客户端获取与图片回填留在
 * DshAgentManager，这里只经窄接口走既有路径（分页入口 historyPage 由宿主持有，
 * 它是 session/page 的唯一出口）。
 */
export type DshHistoryReadHost = {
	readonly runtimes: ReadonlyMap<string, DshAgentRuntime>;
	readonly dshHost: DshHost;
	getRuntime(agentId: string): DshAgentRuntime;
	requireClient(): DshRemoteClient;
	ensureClient(): Promise<DshRemoteClient>;
	historyPage(sessionId: string, options?: { beforeSeq?: number; maxMessages?: number }): Promise<DshEnvelope<DshHistoryPage>>;
	hydrateDshImageRefs(client: DshRemoteClient, sessionId: SessionId, messages: ChatMessage[], attempted?: Set<string>): Promise<ChatMessage[]>;
};

/**
 * 轨迹过程事件（G-context）：modelChange/permission/plan/goal/compaction 记录
 * （pi 会话文件过程事件的 DSH 等价物）。
 * - 运行时会话：mux 事件流 + attach/backfill 重放收集的缓存；
 * - 历史（未激活）会话：从 host history 尾部按事件流推导（与 dsh-web 历史页同数据源），
 *   失败/无 host 时返回空数组（不阻断轨迹展示）。
 */
export async function readDshProcessEvents(host: DshHistoryReadHost, agentId: string | undefined, dshSessionId: string | undefined): Promise<{ events: SessionProcessEvent[]; fromStart: boolean; unavailable?: boolean }> {
	if (agentId) {
		const runtime = host.runtimes.get(agentId);
		if (runtime) {
			return { events: [...runtime.processEvents].sort((left, right) => left.timestamp - right.timestamp), fromStart: true };
		}
	}
	if (!dshSessionId) return { events: [], fromStart: true, unavailable: true };
	try {
		const client = await host.ensureClient();
		const page = await host.historyPage(dshSessionId, { maxMessages: 1000 });
		// host 明确返回失败（未就绪/错误）不是「没有事实」：标 unavailable 让前端可重试。
		if (!page.result.ok) return { events: [], fromStart: true, unavailable: true };
		// 历史冷读只有 host 的尾部页：还有更早的页时窗口未覆盖会话开头，
		// 首个可见提示词只能是窗口快照（不能标成 initial，见计划 §3.4）。
		const fromStart = page.result.value.hasMore !== true;
		const events = (page.result.value.events ?? [])
			.map((entry) => entry.event)
			.filter((event): event is NonNullable<typeof event> => Boolean(event))
			.sort((left: { seq?: number }, right: { seq?: number }) => (left.seq ?? 0) - (right.seq ?? 0));
		return { events: collectDshProcessEvents([], events, { fromStart }).sort((left, right) => left.timestamp - right.timestamp), fromStart };
	} catch {
		return { events: [], fromStart: true, unavailable: true };
	}
}

/**
 * 历史分页（D04）：DSH 会话没有 pi 会话文件，历史浏览走 host 的 session.history
 * （事件流翻页，beforeSeq 为排除边界：返回 seq < beforeSeq 的事件，与本页最旧事件
 * seq 相同即可不重复）。投影复用 dshEventProjector（过滤注入上下文）。
 * 返回形状对齐渲染层 disk 分页协议（sessionsCatalogReadMessagePage）。
 *
 * options 二选一（换算口径见 dshHistoryPagePlan）：
 *  - turnCount：渲染层契约的「轮数」（首屏 9 / 加载更多 3）。host 的 session/page
 *    以消息事件数计数（MESSAGE_TYPES，默认 50），旧实现把它当 maxMessages 直接透传，
 *    于是「加载更多」一次只前进 3 条消息（稀疏会话里不到半轮），用户必须连点很多次；
 *    这里按 24 条/轮换算预算并支持多轮补取，直到凑够轮数或到会话开头；
 *  - maxMessages：显式消息窗口（Web/mobile 首屏、工具结果回读），原样透传一轮。
 */
export async function readDshHistoryPage(host: DshHistoryReadHost, dshSessionId: string, beforeSeq: number | undefined, options: { turnCount?: number; maxMessages?: number } = {}): Promise<{ messages: ChatMessage[]; total: number; nextBefore: number | null }> {
	// 历史浏览是 DSH host 的第一个入口：点击历史 DSH 会话时 runtime 尚未激活
	// （懒启动），必须 ensureStarted 拉起 host，否则 requireClient 直接抛
	// "DSH host is not started"，时间线加载失败显示为空会话。
	const client = await host.ensureClient();
	// 轮分页（渲染层契约）与显式消息窗口二选一：前者按「一轮 ≈ 24 条消息」换算成 host 的
	// maxMessages 预算，必要时多轮补取；后者（Web/mobile 首屏、工具结果回读）原样送一轮。
	const pagingByTurns = options.maxMessages === undefined;
	const turnCount = pagingByTurns ? normalizeDshTurnPageSize(options.turnCount ?? DSH_HISTORY_DEFAULT_TURN_PAGE_SIZE) : 0;
	const rounds = pagingByTurns ? planDshHistoryRounds(turnCount) : [Math.max(1, Math.floor(options.maxMessages ?? DSH_HISTORY_DEFAULT_TURN_PAGE_SIZE))];
	const batches: DshHistoryEntry[][] = [];
	let cursor = beforeSeq;
	let hasMore = false;
	let pageError: { code: string; message: string } | undefined;
	for (const [round, maxMessages] of rounds.entries()) {
		const page = await host.historyPage(String(dshSessionId), { beforeSeq: cursor, maxMessages });
		if (!page.result.ok) {
			// 历史读取失败不再静默返回空：0.1.5 升级后「会话内容为空」的根因（throughSeq
			// 送 MAX 被 host 拒）就是被这个分支吞掉的；这里把真实原因记主进程日志（首轮
			// 还会抛给渲染层转 error 态），避免「看着像空会话」。
			pageError = page.result.error;
			getAppLogger()?.warn("dsh-agent", "dsh history page failed", {
				sessionId: String(dshSessionId),
				code: pageError.code,
				message: pageError.message,
				round,
				rounds: rounds.length,
			});
			break;
		}
		const batch = (page.result.value.events ?? []).map((entry) => ({ event: entry.event, view: entry.view })).filter((item): item is DshHistoryEntry => Boolean(item.event));
		hasMore = page.result.value.hasMore === true;
		if (batch.length === 0) break;
		batches.push(batch);
		// 下一轮从本批最旧事件继续往更早处取（beforeSeq 是排除边界，不会重复取到同一批）
		const oldest = batch.reduce<number | undefined>((min, item) => {
			const seq = item.event.seq;
			return typeof seq === "number" && Number.isFinite(seq) && (min === undefined || seq < min) ? seq : min;
		}, undefined);
		if (oldest === undefined || !hasMore) break;
		cursor = oldest;
		if (batches.length >= rounds.length) break;
		// 已凑够渲染层要的轮数就收手：正常会话（每轮 2~9 条消息）一轮即满足，
		// 只有超长轮（实测单轮最多 157 条消息）才会走满补取轮数。
		if (countDshUserMessages(assembleDshHistoryEntries(batches, beforeSeq).entries) >= turnCount) break;
	}
	// 首轮失败保持「明确报错」语义（渲染层转 error 态）；补取轮失败时保留已取到的部分页
	// （日志已记），下一次点击仍从同一游标续取，比整页报错重来体验更好。
	if (pageError && batches.length === 0) {
		throw new Error(`DSH session history unavailable (${pageError.code}): ${pageError.message}`);
	}
	const assembled = assembleDshHistoryEntries(batches, beforeSeq);
	if (assembled.droppedByContract > 0) {
		// host 违反了排除边界契约（回了 seq ≥ beforeSeq 的事件）：丢弃并留痕，
		// 否则渲染层拿到的游标会在原地打转（再点一次拿到同一页）。
		getAppLogger()?.warn("dsh-agent", "dsh history page returned out-of-range events", {
			sessionId: String(dshSessionId),
			beforeSeq,
			dropped: assembled.droppedByContract,
		});
	}
	// 轮分页把页首裁到本页最旧的 turn/start：不完整的那一轮下次点击会重新取到（游标已指向
	// 裁剪后的起点），观感与 pi 的轮对齐分页一致；显式消息窗口（Web/工具结果）保持原样。
	const entries = pagingByTurns ? trimToOldestTurnStart(assembled.entries, hasMore) : assembled.entries;
	const agentId = `dsh:${dshSessionId}`;
	let projection = projectDshEvent(undefined, undefined, agentId);
	for (const { event, view } of entries) {
		projection = projectDshEvent(projection, event, agentId, view);
	}
	const oldestSeq = entries.length > 0 ? entries[0].event.seq : undefined;
	// 游标语义：下一页传本页最旧事件 seq（DSH history 的 beforeSeq 是排除边界，
	// 返回 seq < beforeSeq 的事件，与渲染层 prepend 协议「nextBefore 原样回传」对齐）。
	const nextBefore = hasMore && typeof oldestSeq === "number" ? oldestSeq : null;
	const messages = await host.hydrateDshImageRefs(client, dshSessionId as SessionId, projection.messages);
	return {
		messages,
		// 渲染层不消费 total（仅透传）；-1 表示未知（DSH 无总条数概念）。
		total: -1,
		nextBefore,
	};
}

/** 子代理历史（G6）：只读 transcript（不激活 Agent），投影成 ChatMessage。 */
export async function readDshSubagentHistory(host: DshHistoryReadHost, agentId: string, childSessionId: string, beforeSeq?: number, maxMessages = 100): Promise<DshSubagentTranscriptPage> {
	const runtime = host.getRuntime(agentId);
	const client = host.requireClient();
	// 新目录保留 continuable 模式；页地址必须与真实 descriptor 一致，不能硬编码 one-shot。
	const listed = await client.subagentsList({ parentSessionId: runtime.sessionId });
	if (!listed.result.ok) throw new Error(`dsh subagent catalog unavailable: ${listed.result.error.message}`);
	const entry = listed.result.value.entries.find((item) => item.id === childSessionId && item.kind === "child");
	if (!entry) throw new Error("dsh subagent is not a readable direct child");
	const address = {
		parentSessionId: runtime.sessionId,
		childSessionId,
		mode: entry.mode,
	};
	let throughSeq: number;
	try {
		// 子代理页同样受 throughSeq ≤ cursor 约束；cursor 用冷读 observation（不激活）。
		throughSeq = await host.dshHost.readSessionCursor(String(childSessionId));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		getAppLogger()?.warn("dsh-agent", "subagent history cursor unavailable", { childSessionId, error: message });
		return { messages: [], hasMore: false };
	}
	const page = await client.subagentsHistory({
		...address,
		throughSeq,
		...(typeof beforeSeq === "number" ? { beforeSeq } : {}),
		maxMessages,
	});
	if (!page.result.ok) {
		return { messages: [], hasMore: false };
	}
	const childAgentId = `dsh:${childSessionId}`;
	return projectDshSubagentTranscriptPage(page.result.value.events ?? [], childAgentId, page.result.value.hasMore === true);
}
