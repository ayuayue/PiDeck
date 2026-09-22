import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { atom, useAtomValue, useSetAtom } from "jotai";
import { desktopApi } from "../desktopApi";
import type { SessionProcessEvent } from "../../../shared/types/trajectory";
import type { SessionRecord } from "../../../shared/types";
import { prependSessionHistoryPageAtom, prependSessionMessagePageAtom, sessionMessageCacheBySessionIdAtomFamily, sessionRecordByIdAtomFamily, type SessionMessageCacheEntry } from "../atoms";
import { sessionHistoryUnavailableState } from "../utils/sessionHistoryAvailability";

/** 与时间线 runtime 翻页对齐：一次补 3 轮，复用同一份消息缓存。 */
const RUNTIME_HISTORY_TURN_PAGE_SIZE = 3;

const EMPTY_CACHE_ATOM = atom<SessionMessageCacheEntry | undefined>(undefined);
const EMPTY_RECORD_ATOM = atom<SessionRecord | undefined>(undefined);

/**
 * 轨迹抽屉的数据源：只订本会话 cache family，把 runtime 历史前缀与窗口段拼成一条账本。
 * 翻页写回同一 atom，时间线与抽屉共享已加载历史，不另开 IPC 通道。
 */
export function useSessionTrajectorySource(sessionId: string | undefined) {
	const cachedEntry = useAtomValue(sessionId ? sessionMessageCacheBySessionIdAtomFamily(sessionId) : EMPTY_CACHE_ATOM);
	// dsh 会话的系统提示在 DSH harness 内部组装（persona + sections），文本从
	// request/header 事件读取（readDshSystemPrompt）；pi 的 pi-system 模板只对 pi
	// 会话是「参考系统提示」。按 backend 区分来源，否则 dsh 会话的轨迹会错误显示
	// pi 的系统提示（2026-08 用户反馈）。
	const record = useAtomValue(sessionId ? sessionRecordByIdAtomFamily(sessionId) : EMPTY_RECORD_ATOM);
	const isDshSession = record?.backend === "dsh";
	const prependMessagePage = useSetAtom(prependSessionMessagePageAtom);
	const prependHistoryPage = useSetAtom(prependSessionHistoryPageAtom);
	const [isLoadingMore, setIsLoadingMore] = useState(false);
	const [processEvents, setProcessEvents] = useState<SessionProcessEvent[]>([]);
	const [systemPrompt, setSystemPrompt] = useState<string | undefined>(undefined);
	const loadSequenceRef = useRef(0);
	const processSequenceRef = useRef(0);

	useEffect(() => {
		if (!sessionId) {
			setProcessEvents([]);
			return;
		}
		const sequence = ++processSequenceRef.current;
		void desktopApi.sessions
			.readProcessEvents(sessionId)
			.then((events) => {
				if (processSequenceRef.current !== sequence) return;
				setProcessEvents(events);
			})
			.catch(() => {
				if (processSequenceRef.current === sequence) setProcessEvents([]);
			});
	}, [sessionId, cachedEntry?.revision, cachedEntry?.updatedAt]);

	// 系统提示参考：pi 会话加载本地 pi-system 模板（Pi 不落盘，仅作参考记录）；
	// dsh 会话从 host 的 request/header 事件读当轮真实系统提示（harness 按
	// persona + sections 在请求时组装，dsh-web 轨迹同源），未装配/无数据时不展示。
	useEffect(() => {
		if (!sessionId) {
			setSystemPrompt(undefined);
			return;
		}
		let cancelled = false;
		if (isDshSession) {
			void desktopApi.sessions
				.readDshSystemPrompt(sessionId)
				.then((prompt) => {
					if (cancelled) return;
					setSystemPrompt(prompt);
				})
				.catch(() => {
					if (!cancelled) setSystemPrompt(undefined);
				});
		} else {
			void desktopApi.prompts
				.list()
				.then((result) => {
					if (cancelled) return;
					const prompt = result.templates.find((item) => item.name === "pi-system");
					setSystemPrompt(prompt?.content);
				})
				.catch(() => {
					if (!cancelled) setSystemPrompt(undefined);
				});
		}
		return () => {
			cancelled = true;
		};
	}, [sessionId, isDshSession]);

	const messages = useMemo(() => {
		if (!cachedEntry) return [];
		if (cachedEntry.source === "runtime" && cachedEntry.history) {
			return [...cachedEntry.history.messages, ...cachedEntry.messages];
		}
		return cachedEntry.messages;
	}, [cachedEntry]);

	const diskPage = cachedEntry?.source === "disk" ? cachedEntry.page : undefined;
	const runtimeHistory = cachedEntry?.source === "runtime" ? cachedEntry.history : undefined;
	// slideOut 重建前缀时 nextBefore 可能为 null；nextBeforeEntryId 仍是有效续页锚点。
	const hasMore = diskPage ? diskPage.nextBefore !== null : Boolean(cachedEntry?.source === "runtime" && (runtimeHistory ? runtimeHistory.nextBefore !== null || Boolean(runtimeHistory.nextBeforeEntryId) : (cachedEntry.windowStart ?? 0) > 0));

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
		systemPrompt,
		isDshSession,
		hasMoreMessages: hasMore,
		isLoadingMoreMessages: hasMore ? isLoadingMore : false,
		loadMore,
	};
}
