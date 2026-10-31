import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { atom, useAtomValue, useSetAtom } from "jotai";
import { desktopApi } from "../desktopApi";
import type { SessionFactsCoverage, SessionProcessEvent } from "../../../shared/types/trajectory";
import type { SessionRecord } from "../../../shared/types";
import { isModelTraceLogData } from "../../../shared/types/rpcLog";
import { prependSessionHistoryPageAtom, prependSessionMessagePageAtom, sessionMessageCacheBySessionIdAtomFamily, sessionRecordByIdAtomFamily, sessionRuntimeBySessionIdAtomFamily, type SessionMessageCacheEntry, type SessionRuntimeViewState } from "../atoms";
import { sessionHistoryUnavailableState } from "../utils/sessionHistoryAvailability";
import { isLiveRuntimeStatus } from "../utils/sessionCommands";
import { isSessionTurnRunning } from "../utils/sessionActivityClock";
import type { TrajectoryModelTraceSummary } from "../components/session/trajectory/buildTrajectory";

/** 与时间线 runtime 翻页对齐：一次补 3 轮，复用同一份消息缓存。 */
const RUNTIME_HISTORY_TURN_PAGE_SIZE = 3;

const EMPTY_CACHE_ATOM = atom<SessionMessageCacheEntry | undefined>(undefined);
const EMPTY_RECORD_ATOM = atom<SessionRecord | undefined>(undefined);
const EMPTY_RUNTIME_ATOM = atom<SessionRuntimeViewState | undefined>(undefined);

/**
 * 轨迹事实预热缓存（模块级，按会话 id，LRU 限量）。
 *
 * 为什么要有：面板挂载后才发 IPC，抽屉打开的第一帧必然只有消息、没有过程轨
 * （用户看到的就是「过程又空着」）。会话聚焦时先读一次存进来，抽屉一打开就能直接画。
 * 只存成功结果（暂时读不到 / 读取失败不入缓存），命中后仍由面板自己的 effect 刷新。
 */
const PROCESS_FACTS_CACHE_LIMIT = 8;
const processFactsCache = new Map<string, { events: SessionProcessEvent[]; coverage: SessionFactsCoverage }>();
const processFactsInflight = new Set<string>();

function rememberProcessFacts(sessionId: string, events: SessionProcessEvent[], coverage: SessionFactsCoverage): void {
	processFactsCache.delete(sessionId);
	processFactsCache.set(sessionId, { events, coverage });
	for (const key of processFactsCache.keys()) {
		if (processFactsCache.size <= PROCESS_FACTS_CACHE_LIMIT) break;
		processFactsCache.delete(key);
	}
}

/** 预热一次会话事实：已有缓存或已在路上直接返回（不重复发 IPC）。 */
export function prefetchSessionProcessFacts(sessionId: string | undefined): void {
	if (!sessionId || processFactsCache.has(sessionId) || processFactsInflight.has(sessionId)) return;
	processFactsInflight.add(sessionId);
	void desktopApi.sessions
		.readProcessEvents(sessionId)
		.then((result) => {
			// 兼容旧形状（数组）与「后端暂时不可用」：两者都不是事实，不入缓存。
			if (Array.isArray(result) || result.coverage.reason === "unavailable") return;
			rememberProcessFacts(sessionId, result.events, result.coverage);
		})
		.catch(() => {
			// 预热失败不影响面板：打开抽屉时会自己再读并重试。
		})
		.finally(() => {
			processFactsInflight.delete(sessionId);
		});
}

/** 会话视图挂载即预热轨迹事实，让「轨迹」抽屉点开就有过程轨。 */
export function useSessionProcessFactsPrefetch(sessionId: string | undefined): void {
	useEffect(() => {
		prefetchSessionProcessFacts(sessionId);
	}, [sessionId]);
}

/**
 * 轨迹抽屉的数据源：只订本会话 cache family，把 runtime 历史前缀与窗口段拼成一条账本。
 * 翻页写回同一 atom，时间线与抽屉共享已加载历史，不另开 IPC 通道。
 */
export function useSessionTrajectorySource(sessionId: string | undefined) {
	const cachedEntry = useAtomValue(sessionId ? sessionMessageCacheBySessionIdAtomFamily(sessionId) : EMPTY_CACHE_ATOM);
	// dsh 会话的过程事件由运行时会话按 mux/重放收集，历史会话从 host history 事件流
	// 推导；两者的系统提示词快照都走同一条 processEvents 链路（不再单独读
	// request/header 的「最后一份」文本——那条路径只能看到最新提示，看不到初始与变化）。
	const record = useAtomValue(sessionId ? sessionRecordByIdAtomFamily(sessionId) : EMPTY_RECORD_ATOM);
	const isDshSession = record?.backend === "dsh";
	const runtime = useAtomValue(sessionId ? sessionRuntimeBySessionIdAtomFamily(sessionId) : EMPTY_RUNTIME_ATOM);
	const prependMessagePage = useSetAtom(prependSessionMessagePageAtom);
	const prependHistoryPage = useSetAtom(prependSessionHistoryPageAtom);
	const [isLoadingMore, setIsLoadingMore] = useState(false);
	// 初值取预热缓存：抽屉第一次渲染就带过程轨，不在挂载后的往返里空一帧。
	const [processEvents, setProcessEvents] = useState<SessionProcessEvent[]>(() => (sessionId ? (processFactsCache.get(sessionId)?.events ?? []) : []));
	// 事实覆盖范围：预算/祖先/窗口缺失时账本要能说明「没读到」而不是「没有」。
	const [processCoverage, setProcessCoverage] = useState<SessionFactsCoverage | undefined>(() => (sessionId ? processFactsCache.get(sessionId)?.coverage : undefined));
	const [modelTraces, setModelTraces] = useState<TrajectoryModelTraceSummary[]>([]);
	const loadSequenceRef = useRef(0);
	const processSequenceRef = useRef(0);
	const traceSequenceRef = useRef(0);
	const processVersionRef = useRef<string | undefined>(undefined);
	// 同会话上一次成功的事实：一次瞬时「读不到」不能把已显示的过程轨清空。
	const lastGoodProcessEventsRef = useRef<{ sessionId: string; events: SessionProcessEvent[] } | undefined>(undefined);
	/** 已用预热缓存铺底过的会话：同一会话的后续重跑不再铺底，避免把新事实回退成旧缓存。 */
	const seededSessionRef = useRef<string | undefined>(undefined);

	// 事实刷新的触发条件：只认「回合边界 / 压缩状态 / 运行代次」这类语义事件。
	// 为什么不再挂 cachedEntry.revision/updatedAt：它们随 token flush（~20 次/秒）变化，
	// 会把轨迹事实读变成高频重拉；事实一次回合只变几次，事件驱动 + 5 秒兜底足够。
	const turnRunning = isSessionTurnRunning(runtime?.state, runtime?.status);
	const compacting = runtime?.state?.isCompacting === true;
	const factsTriggerKey = [sessionId ?? "", runtime?.agentId ?? "", runtime?.runtimeGeneration ?? 0, turnRunning ? 1 : 0, compacting ? 1 : 0].join("|");

	useEffect(() => {
		if (!sessionId) {
			setProcessEvents([]);
			setProcessCoverage(undefined);
			processVersionRef.current = undefined;
			lastGoodProcessEventsRef.current = undefined;
			return;
		}
		// 切会话：先用预热缓存同步铺底，再发真实请求刷新。
		if (seededSessionRef.current !== sessionId) {
			seededSessionRef.current = sessionId;
			const cached = processFactsCache.get(sessionId);
			setProcessEvents(cached?.events ?? []);
			setProcessCoverage(cached?.coverage);
			lastGoodProcessEventsRef.current = cached ? { sessionId, events: cached.events } : undefined;
			processVersionRef.current = undefined;
		}
		let disposed = false;
		let inflight = false;
		let pending = false;
		// 后端「暂时不可用」（DSH host 未就绪、读取失败）不是「没有事实」：
		// 面板开着时按 5 秒重试，最多 12 次（≈1 分钟），失败就停，不无限轮询。
		let retries = 0;
		let retryTimer: ReturnType<typeof setTimeout> | undefined;
		// 作用域绑定：切会话/换代后旧响应一律作废（不等下一次请求才作废）。
		const scope = ++processSequenceRef.current;

		const run = () => {
			if (disposed) return;
			if (inflight) {
				// 在途只留一个待刷新标记，不建无界队列。
				pending = true;
				return;
			}
			inflight = true;
			void desktopApi.sessions
				.readProcessEvents(sessionId)
				.then((result) => {
					if (disposed || processSequenceRef.current !== scope) return;
					// 兼容旧形状（数组）：主进程/预加载任一未更新时不能把事件变成 undefined。
					const events = Array.isArray(result) ? result : (result?.events ?? []);
					const version = Array.isArray(result) ? "" : (result?.version ?? "");
					// 「后端暂时不可用」不是「没有事实」：保留同会话上一次成功的事实（不把已显示的过程轨
					// 清空到下一次成功为止），否则一次瞬时失败就把「过程」轨静默抹掉。
					const unavailable = !Array.isArray(result) && result?.coverage.reason === "unavailable";
					if (unavailable && lastGoodProcessEventsRef.current?.sessionId === sessionId) {
						setProcessEvents(lastGoodProcessEventsRef.current.events);
					} else {
						setProcessEvents((previous) => (processVersionRef.current === version ? previous : events));
						if (!unavailable) lastGoodProcessEventsRef.current = { sessionId, events };
					}
					processVersionRef.current = version;
					setProcessCoverage(Array.isArray(result) ? undefined : result?.coverage);
					// 成功结果进预热缓存：下次打开抽屉（会话再次聚焦）第一帧就有过程轨。
					if (!Array.isArray(result) && !unavailable && result.coverage) rememberProcessFacts(sessionId, events, result.coverage);
					// 后端未就绪：稍后自动重试，避免「DSH host 还在启动，轨迹永远空白」。
					if (!Array.isArray(result) && result?.coverage.reason === "unavailable" && retries < 12) {
						retries += 1;
						retryTimer = setTimeout(run, 5000);
					} else if (!Array.isArray(result) && result?.coverage.reason !== "unavailable") {
						retries = 0;
					}
				})
				.catch(() => {
					// 失败保留上一次成功数据，不清空后冒充「没有事实」。
				})
				.finally(() => {
					inflight = false;
					if (pending && !disposed) {
						pending = false;
						run();
					}
				});
		};

		run();
		// 兜底只在会话活动时跑（轨迹面板挂载即「可见」，静态历史不轮询）。
		const timer = turnRunning || compacting ? setInterval(run, 5000) : undefined;
		return () => {
			disposed = true;
			if (timer) clearInterval(timer);
			if (retryTimer) clearTimeout(retryTimer);
			processSequenceRef.current += 1;
		};
	}, [factsTriggerKey, sessionId, turnRunning, compacting]);

	// 模型请求快照（model-trace）：pi 会话的账本补充数据源（拉取 effect 在 messages
	// 之后声明，重拉触发器之一是 messages.length）。DSH 请求体不走 pi 桥，无 trace。
	// 活运行时传 target（主进程校验后按 agent 过滤）；历史/已停止会话不传 target 会拿到
	// 全部 agent 的日志，再按会话最后已知 agentId 客户端过滤（重启前的旧 agent 世代快照
	// 暂无法归属，接受缺失——快照保留 30 天，近期会话不受影响）。
	const runtimeAgentId = runtime?.agentId;
	const lastKnownAgentId = runtimeAgentId;

	const messages = useMemo(() => {
		if (!cachedEntry) return [];
		if (cachedEntry.source === "runtime" && cachedEntry.history) {
			return [...cachedEntry.history.messages, ...cachedEntry.messages];
		}
		return cachedEntry.messages;
	}, [cachedEntry]);

	useEffect(() => {
		if (!sessionId || isDshSession) {
			setModelTraces([]);
			return;
		}
		const sequence = ++traceSequenceRef.current;
		const live = isLiveRuntimeStatus(runtime?.status);
		const options = live && runtimeAgentId ? { target: { sessionId, agentId: runtimeAgentId, runtimeGeneration: runtime?.runtimeGeneration ?? 0 }, days: 30, limit: 10000 } : { days: 30, limit: 10000 };
		void desktopApi.rpcLogs
			.get(options)
			.then((entries) => {
				if (traceSequenceRef.current !== sequence) return;
				const summaries: TrajectoryModelTraceSummary[] = [];
				for (const entry of entries) {
					if (entry.direction !== "model" || !isModelTraceLogData(entry.data) || entry.data.kind !== "request") continue;
					if (!lastKnownAgentId || entry.agentId !== lastKnownAgentId) continue;
					summaries.push({
						traceId: entry.data.traceId,
						agentId: entry.agentId,
						time: entry.time,
						model: entry.data.model,
						provider: entry.data.provider,
						messageCount: entry.data.messageCount,
						toolCount: entry.data.toolCount,
						payloadBytes: entry.data.payloadBytes,
						truncated: entry.data.truncated,
					});
				}
				summaries.sort((left, right) => left.time - right.time);
				setModelTraces(summaries);
			})
			.catch(() => {
				if (traceSequenceRef.current === sequence) setModelTraces([]);
			});
		// 与事实同口径：回合边界/代次变化才重拉，不跟 token 或消息条数刷新。
	}, [factsTriggerKey, sessionId, isDshSession, runtime?.status, runtimeAgentId, runtime?.runtimeGeneration, lastKnownAgentId]);

	const diskPage = cachedEntry?.source === "disk" ? cachedEntry.page : undefined;
	const runtimeHistory = cachedEntry?.source === "runtime" ? cachedEntry.history : undefined;
	// slideOut 重建前缀时 nextBefore 可能为 null；nextBeforeEntryId 仍是有效续页锚点。
	// 兜底分支（runtimeHistory 缺失）不能只看 windowStart：主进程内存窗口只驻留最近若干轮，
	// windowStart 常为 0，而真正还有更早历史时只有 windowStartFilePos 是正数。判据与
	// useSessionTimelineController 的 historyHasMore 保持一致，否则轨迹面板与主时间线的
	// 「加载更多对话」会出现与否打架。
	const windowHasEarlier = typeof cachedEntry?.windowStartFilePos === "number" ? cachedEntry.windowStartFilePos > 0 : (cachedEntry?.windowStart ?? 0) > 0;
	const hasMore = diskPage ? diskPage.nextBefore !== null : Boolean(cachedEntry?.source === "runtime" && (runtimeHistory ? runtimeHistory.nextBefore !== null || Boolean(runtimeHistory.nextBeforeEntryId) : windowHasEarlier));

	const loadMore = useCallback(() => {
		if (!sessionId || !cachedEntry || isLoadingMore) return;
		const sequence = ++loadSequenceRef.current;
		const expectedRevision = cachedEntry.revision;

		if (diskPage) {
			const before = diskPage.nextBefore;
			if (before === null) return;
			setIsLoadingMore(true);
			void desktopApi.sessions
				.readRecordMessagePage(sessionId, before, 100)
				.then((page) => {
					if (loadSequenceRef.current !== sequence) return;
					// DSH host 被手动停止时返回「暂时读不了」的空页：不能当前缀写进缓存，
					// 否则 total 归零、游标被清空，「加载更多」消失且无法重试。保持现状即可，
					// 恢复路径由时间线的「启动 host」专态给出。
					if (sessionHistoryUnavailableState(page)) return;
					prependMessagePage({ sessionId, before, expectedRevision, page });
				})
				.finally(() => {
					if (loadSequenceRef.current === sequence) setIsLoadingMore(false);
				});
			return;
		}

		if (cachedEntry.source !== "runtime") return;
		const before = runtimeHistory?.nextBefore;
		const anchorMessage = !runtimeHistory ? cachedEntry.messages.find((message) => typeof message.meta?.entryId === "string") : undefined;
		const anchorEntryId = typeof anchorMessage?.meta?.entryId === "string" ? anchorMessage.meta.entryId : undefined;
		const anchorFilePos = !runtimeHistory && !anchorEntryId ? (typeof cachedEntry.windowStartFilePos === "number" ? cachedEntry.windowStartFilePos : undefined) : undefined;
		if (!runtimeHistory && !anchorEntryId && anchorFilePos === undefined) return;

		setIsLoadingMore(true);
		void desktopApi.sessions
			.readRecordMessagePage(sessionId, before ?? (anchorFilePos !== undefined ? anchorFilePos : undefined), RUNTIME_HISTORY_TURN_PAGE_SIZE, {
				beforeEntryId: anchorEntryId ?? runtimeHistory?.nextBeforeEntryId ?? undefined,
			})
			.then((page) => {
				if (loadSequenceRef.current !== sequence) return;
				// 与 disk 翻页同源：host 被停时的空页不是新历史（否则同样的游标/total 损坏）。
				if (sessionHistoryUnavailableState(page)) return;
				prependHistoryPage({ sessionId, expectedRevision, before, page });
			})
			.finally(() => {
				if (loadSequenceRef.current === sequence) setIsLoadingMore(false);
			});
	}, [cachedEntry, diskPage, isLoadingMore, prependHistoryPage, prependMessagePage, runtimeHistory, sessionId]);

	return {
		messages,
		processEvents,
		processCoverage,
		modelTraces,
		isDshSession,
		hasMoreMessages: hasMore,
		isLoadingMoreMessages: hasMore ? isLoadingMore : false,
		loadMore,
	};
}
