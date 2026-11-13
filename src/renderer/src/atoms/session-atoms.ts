import { touchRecentSessionAtom, forgetRecentSessionAtom } from "./recent-session-atoms";
import { advanceSessionActivityAnchorAtom, forgetSessionActivityAnchorAtom } from "./sessionActivityAtoms";
import { sessionSendStateByIdAtom, setSessionSendStateAtom } from "./composer-atoms";
import { getSessionDisposalAtoms, removeRegisteredSessionFamilies } from "./session-family-registry";
import { atom } from "jotai";
import type { Getter, Setter } from "jotai";
import { selectAtom } from "jotai/utils";
import type { AgentRuntimeState, AgentStatus, ChatMessage, RemoteSessionExtensions, SessionRuntimeEvent, SessionRuntimeInfo } from "../../../shared/types";
import { mergeAgentRuntimeState } from "../utils/agentRuntimeState";
import { isSessionTurnRunning } from "../utils/sessionActivityClock";
import { shouldRefreshOutlineForRuntimeUpsert } from "./outlineRevision";
import { releaseSessionOutlineProjection } from "./outlineProjectionCache";
import { perfSpan } from "../utils/perfProbe";
import { historyHasCurrentAssistantText, resolveStreamingTextUpdate, shouldHoldLiveText, shouldReleaseHeldLiveText } from "../utils/liveTextHandoff";
import type { SessionRuntimeViewState, StreamingThinkingEntry } from "./session-atoms-types";
import { historyPrefixFromDiskPage, reconcileHistoryPrefix, stabilizeRuntimeMessageIds } from "./session-history-atoms";
import { cacheSessionMessagesAtom, sessionMessageCacheBySessionIdAtomFamily, trimSessionMessageCacheAtom } from "./session-message-cache-atoms";
import { applySessionRuntimeUiEvent, sessionRuntimeUiByIdAtom } from "./session-runtime-ui-atoms";
import { currentSessionIdAtom, discardedTransientSessionIdsAtom, sessionIdsByProjectAtom, sessionMessageLoadStateAtom, sessionMessageLruAtom, sessionMessagesCacheAtom, sessionRecordsAtom, sessionTabIdsAtom, stoppedSessionIdsAtom } from "./session-state-atoms";
import {
	disposeStreamingThinkingFamily,
	liveTextActiveBySessionAtom,
	liveTextStreamingBySessionAtom,
	liveThinkingIdBySessionAtom,
	liveThinkingIdBySessionIdAtomFamily,
	liveThinkingStreamingBySessionAtom,
	newTurnCollapseTickBySessionIdAtomFamily,
	processGroupOpenBySessionIdAtomFamily,
	runStepsVisibleMemoryBySessionIdAtomFamily,
	sendPinAnimatingByIdAtom,
	sendPinAnimatingBySessionIdAtomFamily,
	sessionScrollAnchorByIdAtom,
	streamingTextByIdAtom,
	streamingTextBySessionIdAtomFamily,
	streamingThinkingByIdAtom,
	streamingThinkingEntryByIdAtomFamily,
} from "./session-timeline-atoms";

/**
 * 会话 atoms 入口（2027-02 拆分）。
 *
 * 这里保留**运行时事件机**及其直接依赖：applySessionRuntimeEventAtom / bindSessionRuntimeAtom /
 * removeSessionStateAtom、运行时视图状态容器、live 通道的收口 helpers、乐观用户消息对账规则。
 * 其余按域搬到同级模块（都是**搬家**，atom / atomFamily 不重建——重建会造出两套状态）：
 *
 * - `session-atoms-types`：共享类型（纯类型，零运行时依赖）
 * - `session-cache-policy`：消息缓存裁剪策略（纯函数 + 常量）
 * - `session-state-atoms`：记录/目录/选中/消息缓存容器与目录写入动作
 * - `session-runtime-ui-atoms`：运行时 UI 请求状态机（审批/提问/通知/widget）
 * - `session-message-cache-atoms`：消息缓存写入路径（revision 守卫 / LRU / 字节预算）
 * - `session-history-atoms`：历史分页与前缀调和（disk 页 / runtime 窗口前缀）
 * - `session-timeline-atoms`：时间线运行期状态（改写遮罩 / 滚动锚点 / live 通道 / 折叠信号）
 *
 * `export *` 原样转出，所有既有 `@/atoms` / `./session-atoms` import 与调用方零改动。
 */
export * from "./session-atoms-types";
export * from "./session-cache-policy";
export * from "./session-history-atoms";
export * from "./session-message-cache-atoms";
export * from "./session-runtime-ui-atoms";
export * from "./session-state-atoms";
export * from "./session-timeline-atoms";

const REMOTE_EXTENSION_REASONS = ["REMOTE_PI_EXTENSIONS_UNSUPPORTED", "REMOTE_EXTENSIONS_UNAVAILABLE", "REMOTE_EXTENSIONS_DISABLED", "REMOTE_EXTENSIONS_NONE"] as const;

/**
 * `agents:state` 载荷里的注入面是 unknown（旧 main / 旧 payload / 半可信事件），只接受闭集形状。
 * 形状不对就当作没带这个字段（保留已知值），不报错也不净化成空数组——空数组是「确认什么都没注入」的强事实。
 */
export function readRemoteExtensions(value: unknown): RemoteSessionExtensions | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (!Array.isArray(record.applied) || record.applied.length > 64) return undefined;
	const applied: string[] = [];
	for (const entry of record.applied) {
		if (typeof entry !== "string" || entry.length === 0 || entry.length > 128) return undefined;
		applied.push(entry);
	}
	const reason = typeof record.reason === "string" ? REMOTE_EXTENSION_REASONS.find((known) => known === record.reason) : undefined;
	return { applied, ...(reason === undefined ? {} : { reason }), ...(typeof record.detail === "string" && record.detail.length <= 128 ? { detail: record.detail } : {}) };
}
export const sessionRuntimeByIdAtom = atom<Record<string, SessionRuntimeViewState>>({});
export const sidebarRuntimeAtom = selectAtom(sessionRuntimeByIdAtom, (full) => {
	const slim: Record<string, { agentId?: string; status: string }> = {};
	for (const [id, rt] of Object.entries(full)) {
		slim[id] = { agentId: rt.agentId, status: rt.status ?? "detached" };
	}
	return slim;
});

/**
 * 会话级缓存命中率快照历史（仅存数值，最多 50 条）：
 * 用于展示「当前会话平均缓存命中率」，弥补只显示最新一次 assistant 命中率的不足。
 */
export const sessionCacheStatsAtom = atom<Record<string, { cacheHitHistory: number[] }>>({});
export const SESSION_CACHE_STATS_LIMIT = 50;
export const currentSessionRuntimeAtom = atom((get) => {
	const sessionId = get(currentSessionIdAtom);
	return sessionId ? get(sessionRuntimeByIdAtom)[sessionId] : undefined;
});

export const currentSessionRuntimeUiAtom = atom((get) => {
	const sessionId = get(currentSessionIdAtom);
	return sessionId ? get(sessionRuntimeUiByIdAtom)[sessionId] : undefined;
});

export const replaceSessionRuntimesAtom = atom(null, (get, set, runtimes: SessionRuntimeInfo[]) => {
	const current = get(sessionRuntimeByIdAtom);
	const next = { ...current };
	for (const runtime of runtimes) {
		const existing = current[runtime.sessionId];
		if (existing && existing.runtimeGeneration > runtime.runtimeGeneration) continue;
		const bindingChanged = existing?.agentId !== runtime.agentId || existing.runtimeGeneration !== runtime.runtimeGeneration;
		// 启动/恢复的快照可能先于状态事件到达；以实际绑定补记，重复刷新不改顺序。
		if (bindingChanged && runtime.agentId && !runtime.noSession && (runtime.status === "starting" || runtime.status === "running" || runtime.status === "idle")) {
			set(touchRecentSessionAtom, { sessionId: runtime.sessionId, projectId: runtime.projectId });
		}
		next[runtime.sessionId] = {
			...(bindingChanged ? {} : existing),
			agentId: runtime.agentId,
			runtimeGeneration: runtime.runtimeGeneration,
			status: runtime.status,
			state: bindingChanged ? undefined : existing?.state,
			updatedAt: Date.now(),
			projectId: runtime.projectId,
			cwd: runtime.cwd,
			sessionPath: runtime.sessionPath,
			createdAt: runtime.createdAt,
			compactionCount: runtime.compactionCount,
			noSession: runtime.noSession,
			// 与 `agents:state` 那条路径同源：远端 trust 现状在 runtime 快照里也要带，
			// 否则「渲染层重载 + runtime 空闲」时提示要等下一次状态推送才出现。
			remoteTrustUnhandled: runtime.remoteTrustUnhandled === true ? true : undefined,
			// 注入面与 trust 标记同源：runtime 快照重载后 UI 不能凭空恢复能力门。
			remoteExtensions: runtime.remoteExtensions,
			// listRuntimes 快照可能落后于事件流（或旧主进程未带此字段）：不冲掉已知身份。
			deckSessionId: runtime.deckSessionId ?? existing?.deckSessionId,
		};
	}
	set(sessionRuntimeByIdAtom, next);
});

/** 运行时重新绑定后清掉「已停止」标记：缓存条目恢复打开 Tab 保护（否则活会话会被误淘汰）。 */
function clearStoppedSessionFlag(get: Getter, set: Setter, sessionId: string): void {
	const stopped = get(stoppedSessionIdsAtom);
	if (!stopped.has(sessionId)) return;
	const next = new Set(stopped);
	next.delete(sessionId);
	set(stoppedSessionIdsAtom, next);
}

/** 清除某会话的 live 思考通道（换绑 / 卸载 / detach）。 */
function clearSessionLiveThinking(get: Getter, set: Setter, sessionId: string) {
	const liveId = get(liveThinkingIdBySessionAtom)[sessionId];
	const idsToDispose: string[] = [];
	if (liveId) {
		idsToDispose.push(liveId);
		set(streamingThinkingByIdAtom, (prevMap) => {
			if (!(liveId in prevMap)) return prevMap;
			const nextMap = { ...prevMap };
			delete nextMap[liveId];
			return nextMap;
		});
	} else {
		// 兜底：按 sessionId 扫一遍，防止 liveId 映射丢失后残留段。
		const map = get(streamingThinkingByIdAtom);
		const leftoverIds = Object.entries(map)
			.filter(([, entry]) => entry.sessionId === sessionId)
			.map(([id]) => id);
		if (leftoverIds.length > 0) {
			idsToDispose.push(...leftoverIds);
			set(streamingThinkingByIdAtom, (prevMap) => {
				const nextMap = { ...prevMap };
				for (const id of leftoverIds) delete nextMap[id];
				return nextMap;
			});
		}
	}
	set(liveThinkingIdBySessionAtom, (prevMap) => {
		if (!(sessionId in prevMap)) return prevMap;
		const nextMap = { ...prevMap };
		delete nextMap[sessionId];
		return nextMap;
	});
	for (const id of idsToDispose) disposeStreamingThinkingFamily(id);
}

/**
 * History 已写入同段 thinking 后才卸 live 身份。
 * done 与 agents:message 跨通道可能乱序；若 done 先清，会在 message.thinking 仍空时
 * 拆掉 ThinkingStep，等 History 到达再 remount → 整段糊屏。
 */
/** History 已写入本轮助手正文（或用户已发下一问）后，卸掉 done 暂留的 live 槽。 */
function tryReleaseHeldLiveTextAfterHistory(get: Getter, set: Setter, sessionId: string) {
	const live = get(streamingTextByIdAtom)[sessionId];
	if (!live?.held) return;
	const messages = get(sessionMessagesCacheAtom)[sessionId]?.messages ?? [];
	if (!shouldReleaseHeldLiveText(messages)) return;
	set(streamingTextByIdAtom, (prevMap) => {
		if (!(sessionId in prevMap)) return prevMap;
		const nextMap = { ...prevMap };
		delete nextMap[sessionId];
		return nextMap;
	});
}

/**
 * agent 关闭 / 换绑 / 终态：主进程 stop 路径直接清 live 通道、不会补发 done。
 * 这里收口渲染层残留：history 已接管就丢掉槽（避免同段正文重复挂载）；还没接管就转
 * held（保留已生成内容，等 messages 到达由 tryReleaseHeldLiveTextAfterHistory 释放）。
 */
function settleSessionLiveText(get: Getter, set: Setter, sessionId: string) {
	const map = get(streamingTextByIdAtom);
	const live = map[sessionId];
	if (!live) return;
	// 只认「本轮助手正文已落盘」：历史末尾是当前用户消息（回合还没落盘）不能算接管，
	// 否则停止/崩溃时会把已生成的部分回答直接抹掉。
	const historyReady = historyHasCurrentAssistantText(get(sessionMessagesCacheAtom)[sessionId]?.messages ?? []);
	if (historyReady || !live.content) {
		const nextMap = { ...map };
		delete nextMap[sessionId];
		set(streamingTextByIdAtom, nextMap);
		return;
	}
	if (!live.streaming && live.held) return;
	set(streamingTextByIdAtom, { ...map, [sessionId]: { content: live.content, streaming: false, held: true } });
}

/** 无条件清掉本会话的 live 正文槽（最后一栏卸载 / 换绑新 agent 时用）。 */
function clearSessionLiveText(get: Getter, set: Setter, sessionId: string) {
	const map = get(streamingTextByIdAtom);
	if (!(sessionId in map)) return;
	const nextMap = { ...map };
	delete nextMap[sessionId];
	set(streamingTextByIdAtom, nextMap);
}

/** 聊天栏卸载时清掉本会话的 live 正文（后台流不再下发；切回由可见性补帧覆盖）。 */
export const clearSessionLiveTextAtom = atom(null, (get, set, sessionId: string) => {
	clearSessionLiveText(get, set, sessionId);
});

function tryReleaseLiveThinkingAfterHistory(get: Getter, set: Setter, sessionId: string) {
	const liveId = get(liveThinkingIdBySessionAtom)[sessionId];
	if (!liveId?.startsWith("msg-thinking-")) return;
	const messageId = liveId.slice("msg-thinking-".length);
	if (!messageId) return;
	const messages = get(sessionMessagesCacheAtom)[sessionId]?.messages ?? [];
	const ready = messages.some((message) => message.id === messageId && Boolean(message.thinking?.trim()));
	if (!ready) return;
	set(streamingThinkingByIdAtom, (prevMap) => {
		if (!(liveId in prevMap)) return prevMap;
		const nextMap = { ...prevMap };
		delete nextMap[liveId];
		return nextMap;
	});
	set(liveThinkingIdBySessionAtom, (prevMap) => {
		if (prevMap[sessionId] !== liveId) return prevMap;
		const nextMap = { ...prevMap };
		delete nextMap[sessionId];
		return nextMap;
	});
	// 数据条目与 family 实例成对释放（uuid 段 id 不复用，不 remove 会永久堆在 Map 里）。
	disposeStreamingThinkingFamily(liveId);
}

export const applySessionRuntimeEventAtom = atom(null, (get, set, event: SessionRuntimeEvent) => {
	const currentRuntime = get(sessionRuntimeByIdAtom)[event.sessionId] ?? {
		runtimeGeneration: 0,
		status: "detached" as const,
		updatedAt: 0,
	};
	if (event.kind === "detach") {
		if (event.runtimeGeneration < currentRuntime.runtimeGeneration || (currentRuntime.agentId && currentRuntime.agentId !== event.agentId)) {
			return;
		}
		// Anonymous records only exist while their --no-session runtime exists.
		// Remove every renderer cache at detach so a future catalog refresh cannot
		// leave a closed anonymous row selectable in the sidebar.
		if (get(sessionRecordsAtom)[event.sessionId]?.noSession) {
			set(discardedTransientSessionIdsAtom, new Set(get(discardedTransientSessionIdsAtom)).add(event.sessionId));
			set(removeSessionStateAtom, event.sessionId);
			return;
		}
		const nextUiById = { ...get(sessionRuntimeUiByIdAtom) };
		delete nextUiById[event.sessionId];
		set(sessionRuntimeUiByIdAtom, nextUiById);
		clearSessionLiveThinking(get, set, event.sessionId);
		settleSessionLiveText(get, set, event.sessionId);
		set(sessionRuntimeByIdAtom, {
			...get(sessionRuntimeByIdAtom),
			[event.sessionId]: {
				runtimeGeneration: event.runtimeGeneration,
				status: "detached",
				updatedAt: Date.now(),
			},
		});
		// 进程已经结束，渲染层只剩这份消息副本：降级为可淘汰并立刻裁剪一次
		//（#519：此前只有「删除会话」才释放，任务做完关掉 Agent 的缓存会一直驻留）。
		if (!get(stoppedSessionIdsAtom).has(event.sessionId)) {
			const stopped = new Set(get(stoppedSessionIdsAtom));
			stopped.add(event.sessionId);
			set(stoppedSessionIdsAtom, stopped);
		}
		set(trimSessionMessageCacheAtom);
		return;
	}
	if (event.runtimeGeneration < currentRuntime.runtimeGeneration) return;
	if (event.runtimeGeneration === currentRuntime.runtimeGeneration && currentRuntime.agentId && currentRuntime.agentId !== event.agentId) {
		return;
	}
	const bindingChanged = event.runtimeGeneration > currentRuntime.runtimeGeneration || currentRuntime.agentId !== event.agentId;
	// 运行时重新绑定（懒启动 / 重启）：该会话不再是「只剩磁盘副本」，恢复打开 Tab 保护。
	clearStoppedSessionFlag(get, set, event.sessionId);

	// 2026-08 治理：agents:event 是 pi 原始事件流（每 token 100+/s），桌面 UI
	// 无任何消费者（web SSE 走主进程内部订阅）。此前它落入下方兜底路径无条件
	// 写 sessionRuntimeByIdAtom，导致 timeline 等订阅者 100/s 全量重渲染——
	// 主进程侧已停止转发，这里双保险拦截（防其他生产者误发）。
	if (event.sourceChannel === "agents:event") return;

	let nextRuntime: SessionRuntimeViewState = {
		...(bindingChanged
			? {
					runtimeGeneration: event.runtimeGeneration,
					status: "detached" as const,
					updatedAt: 0,
					// 新绑定不能继承旧 agent 的运行时状态：清掉残留 state，
					// 否则底栏 state?.modelName 优先于 record 显示旧模型（模型切换后显示旧）。
					// 真实值由后续 agents:runtime-state 事件（含 applyPreferences 后的主动推送）填充。
					// 但**会话级事实必须留**：`remoteTrustUnhandled` 只随 `agents:state` 的 tab 快照下发，
					// `agents:runtime-state` 载荷里没有它——在这里丢掉就再没人补，远端会话的
					// trust 提示会永久消失（2026-10 真机 UI 验收实测：输入首键→绑定变化→提示从不出现）。
					remoteTrustUnhandled: currentRuntime?.remoteTrustUnhandled,
					remoteExtensions: currentRuntime?.remoteExtensions,
					state: undefined,
				}
			: currentRuntime),
		agentId: event.agentId,
		runtimeGeneration: event.runtimeGeneration,
		updatedAt: Date.now(),
	};
	if (bindingChanged) {
		clearSessionLiveThinking(get, set, event.sessionId);
		// 换绑（restart/重建）后旧 live 正文属于上一代 agent：必须整槽丢弃。
		// 新回合的首次增量是「delta 追加」语义，留着旧槽会把两轮正文拼在一起。
		clearSessionLiveText(get, set, event.sessionId);
	}
	const payload = event.payload && typeof event.payload === "object" ? (event.payload as Record<string, unknown>) : undefined;

	if ((event.sourceChannel === "agents:state" || event.sourceChannel === "sessions:runtime") && payload) {
		const status = payload.status;
		// 只在实际运行状态边沿更新最近列表；不让流式token或历史扫描不断写存储。
		if (status !== currentRuntime.status && (status === "starting" || status === "running" || (currentRuntime.status === "running" && status === "idle"))) {
			const record = get(sessionRecordsAtom)[event.sessionId];
			if (record && !record.noSession) set(touchRecentSessionAtom, { sessionId: record.id, projectId: record.projectId });
		}
		if (status === "starting" || status === "idle" || status === "running" || status === "error" || status === "closed") {
			nextRuntime = {
				...nextRuntime,
				status,
				// 终态（error/closed）会话不再需要运行时状态（goal/todos/model 上下文等），
				// 清空以释放渲染进程内存；但上下文超限是一个可操作的恢复态：
				// 即使会话进入 error，圆环仍必须保留这个最小标记，才能提供「压缩后重试」入口。
				state: status === "error" || status === "closed" ? (nextRuntime.state?.contextOverflow ? { contextOverflow: true } : undefined) : nextRuntime.state,
				projectId: typeof payload.projectId === "string" ? payload.projectId : nextRuntime.projectId,
				cwd: typeof payload.cwd === "string" ? payload.cwd : nextRuntime.cwd,
				title: typeof payload.title === "string" ? payload.title : nextRuntime.title,
				piSessionId: typeof payload.sessionId === "string" ? payload.sessionId : nextRuntime.piSessionId,
				sessionPath: typeof payload.sessionPath === "string" ? payload.sessionPath : nextRuntime.sessionPath,
				deckSessionId: typeof payload.deckSessionId === "string" ? payload.deckSessionId : nextRuntime.deckSessionId,
				createdAt: typeof payload.createdAt === "number" ? payload.createdAt : nextRuntime.createdAt,
				compactionCount: typeof payload.compactionCount === "number" ? payload.compactionCount : nextRuntime.compactionCount,
				noSession: payload.noSession === true || nextRuntime.noSession,
				// backend 只在运行时事件里透传（dsh=DSH host 会话；acp=ACP CLI 会话，tab 侧栏徽章与配对依赖它），
				// 其余一律回落本地状态，防止旧事件把已知后端冲掉。
				backend: payload.backend === "dsh" || payload.backend === "acp" ? payload.backend : (nextRuntime.backend ?? "pi"),
				// 远端 trust 标记只在远端会话上出现；旧 main 的载荷没有这个字段（undefined）。
				// 同一绑定内 sticky（会话身份含 hostId，不会本地↔远端跳变），避免 refresh 抖动。
				remoteTrustUnhandled: payload.remoteTrustUnhandled === true || nextRuntime.remoteTrustUnhandled,
				// 注入面跟本次绑定走（每次 spawn/reattach 都可能变）；旧载荷缺字段时保留已知值，不凭空清空。
				remoteExtensions: readRemoteExtensions(payload.remoteExtensions) ?? nextRuntime.remoteExtensions,
			};
			// 终态不会再有任何后继事件：live 正文在这里收口，避免 stop/崩溃后残留「正在流式」。
			if (status === "error" || status === "closed") settleSessionLiveText(get, set, event.sessionId);
		}
		// ACP 首回合：sessions:prompt IPC 要等整个回合结束才返回，而 sendState 的 activating→sending
		// 转换原本只有「发送前 runtime 已存在」和 IPC 结算两处——首条消息会全程卡在 activating
		//（时间线显示启动中、composer 禁用；CLI 回合挂死时表现为永久启动中）。
		// runtime 绑定事件把会话推进到 starting/idle/running 即证明激活完成，立即推进发送态为
		// sending；后续进度由 runtime 状态事件表达，最终结算仍由 useSessionSend 的 IPC 结果负责。
		// requestId 必须保留：结算路径 isCurrentRequest() 靠它识别本次发送。
		const pendingSend = get(sessionSendStateByIdAtom)[event.sessionId];
		if (pendingSend?.status === "activating" && (status === "starting" || status === "idle" || status === "running")) {
			set(setSessionSendStateAtom, { sessionId: event.sessionId, state: { status: "sending", requestId: pendingSend.requestId } });
		}
	} else if (event.sourceChannel === "agents:runtime-state" && payload?.state) {
		// 终态之后主进程仍可能有迟到的 runtime-state 事件回填旧 state；
		// 此时跳过 merge，避免刚被清空的 state 又被旧事件重新填回（占用内存）。
		// isSessionRuntimeBusy 已按 status 早退、不读 state，跳过不改变任何 UI 判断。
		const terminal = nextRuntime.status === "error" || nextRuntime.status === "closed";
		if (!terminal) {
			nextRuntime = {
				...nextRuntime,
				state: mergeAgentRuntimeState(nextRuntime.state, payload.state as AgentRuntimeState),
			};
			// 缓存命中率快照入列：供「会话平均命中率」展示。
			// 只记有效百分比，避免把 undefined/瞬时抖动计入平均；
			// 连续相同的快照值跳过（流式期间 get_state 轮询会重复返回同一统计）。
			const hitPercent = (payload.state as AgentRuntimeState).cacheHitPercent;
			if (typeof hitPercent === "number" && Number.isFinite(hitPercent)) {
				const currentStats = get(sessionCacheStatsAtom)[event.sessionId] ?? { cacheHitHistory: [] };
				const history = currentStats.cacheHitHistory;
				if (history[history.length - 1] === hitPercent) {
					// 值未变化：不写 atom，避免 SessionHeader 无谓重渲染
				} else {
					const nextHistory = [...history, hitPercent].slice(-SESSION_CACHE_STATS_LIMIT);
					set(sessionCacheStatsAtom, {
						...get(sessionCacheStatsAtom),
						[event.sessionId]: { cacheHitHistory: nextHistory },
					});
				}
			}
		}
	} else if (event.sourceChannel === "agents:thinking" && payload) {
		// Live 思考：只更新 streamingThinkingByIdAtom / liveThinkingIdBySessionAtom。
		// 绑定未变时不写 sessionRuntimeByIdAtom，避免每帧戳醒 timeline。
		const id = typeof payload.id === "string" ? payload.id : "";
		const fullText = typeof payload.text === "string" ? payload.text : typeof payload.thinking === "string" ? payload.thinking : "";
		const delta = typeof payload.delta === "string" ? payload.delta : "";
		const done = payload.done === true;
		const startedAt = typeof payload.startedAt === "number" ? payload.startedAt : Date.now();
		const endedAt = typeof payload.endedAt === "number" ? payload.endedAt : 0;
		if (id) {
			if (done) {
				// 只标终态，保留 id/文本；等 History 同段 thinking 可见后再卸身份（防跨通道乱序 remount）。
				const prev = get(streamingThinkingByIdAtom)[id];
				// 终态事件携带全量 text（见 finishThinkingChannel）；缺省时用本地累积
				const text = fullText || (delta && prev ? prev.text + delta : "") || prev?.text || "";
				const nextEntry: StreamingThinkingEntry = {
					sessionId: event.sessionId,
					text,
					startedAt: prev?.startedAt ?? startedAt,
					endedAt: endedAt > 0 ? endedAt : prev?.endedAt && prev.endedAt > 0 ? prev.endedAt : Date.now(),
					streaming: false,
				};
				if (!prev || prev.text !== nextEntry.text || prev.startedAt !== nextEntry.startedAt || prev.endedAt !== nextEntry.endedAt || prev.streaming !== false || prev.sessionId !== event.sessionId) {
					set(streamingThinkingByIdAtom, {
						...get(streamingThinkingByIdAtom),
						[id]: nextEntry,
					});
				}
				if (get(liveThinkingIdBySessionAtom)[event.sessionId] !== id) {
					set(liveThinkingIdBySessionAtom, {
						...get(liveThinkingIdBySessionAtom),
						[event.sessionId]: id,
					});
				}
				tryReleaseLiveThinkingAfterHistory(get, set, event.sessionId);
			} else {
				const streaming = endedAt <= 0;
				const prev = get(streamingThinkingByIdAtom)[id];
				// 增量协议（2026-08 治理）：delta 追加到本地累积；text 全量替换
				const text = delta ? (prev?.text ?? "") + delta : fullText;
				if (!prev || prev.text !== text || prev.startedAt !== startedAt || prev.endedAt !== endedAt || prev.streaming !== streaming || prev.sessionId !== event.sessionId) {
					set(streamingThinkingByIdAtom, {
						...get(streamingThinkingByIdAtom),
						[id]: {
							sessionId: event.sessionId,
							text,
							startedAt,
							endedAt,
							streaming,
						},
					});
				}
				if (get(liveThinkingIdBySessionAtom)[event.sessionId] !== id) {
					set(liveThinkingIdBySessionAtom, {
						...get(liveThinkingIdBySessionAtom),
						[event.sessionId]: id,
					});
				}
			}
		}
		if (bindingChanged) {
			set(sessionRuntimeByIdAtom, {
				...get(sessionRuntimeByIdAtom),
				[event.sessionId]: nextRuntime,
			});
		}
		return;
	} else if (event.sourceChannel === "agents:text-stream" && payload) {
		// Live 正文：只更新 streamingTextByIdAtom。
		// 绑定未变时不写 sessionRuntimeByIdAtom，避免每帧戳醒 timeline/composer 订阅者。
		const prev = get(streamingTextByIdAtom)[event.sessionId];
		// 增量协议（2026-08 治理）：主进程正常 append 只推 delta，渲染层追加到
		// 本地累积；text 全量快照（非 append 重置 / 2.5s 自愈）整体替换。
		const incoming = typeof payload.delta === "string" ? (prev?.content ?? "") + payload.delta : typeof payload.text === "string" ? payload.text : (prev?.content ?? "");
		const done = payload.done === true;
		const reset = payload.reset === true;
		const text = resolveStreamingTextUpdate(prev?.content ?? "", incoming, done, reset);
		const historyReady = shouldReleaseHeldLiveText(get(sessionMessagesCacheAtom)[event.sessionId]?.messages ?? []);
		const hold = shouldHoldLiveText({
			done,
			reset,
			liveText: text,
			historyHasAssistantText: historyReady,
		});
		const streaming = !done && text.length > 0;
		// done 才到、本地没有 live 槽（会话一直在后台，或聊天栏刚卸载）：历史消息会接管正文，
		// 不要为一个不可见会话新建 held 槽——几百个后台流式会话会让这个 map 无谓膨胀。
		if ((!done || prev) && (!prev || prev.content !== text || prev.streaming !== streaming || prev.held !== hold)) {
			set(streamingTextByIdAtom, {
				...get(streamingTextByIdAtom),
				[event.sessionId]: { content: text, streaming, held: hold || undefined },
			});
		}
		if (done && !hold) {
			set(streamingTextByIdAtom, (prevMap) => {
				if (!(event.sessionId in prevMap)) return prevMap;
				const nextMap = { ...prevMap };
				delete nextMap[event.sessionId];
				return nextMap;
			});
		}
		if (bindingChanged) {
			set(sessionRuntimeByIdAtom, {
				...get(sessionRuntimeByIdAtom),
				[event.sessionId]: nextRuntime,
			});
		}
		return;
	} else if ((event.sourceChannel === "agents:message" || event.sourceChannel === "sessions:messages") && payload) {
		// Phase 4 分段计时（探针关闭时是空函数）：把一次投递拆成「原子合并」与「React 提交」。
		const stopMessageSpan = perfSpan("atoms:agents-message");
		// 迟到快照守卫（2026-11）：stop 后主进程先发 detach（agentId 清除），节流 50ms 的
		// 最终 messages flush 可能晚于编辑/删除后的 force disk 重载到达，覆盖刚写回的缓存。
		// 同代际 + 绑定已消失 + terminal 才拦；新代际事件不受影响（detach 清 agentId 后
		// bindingChanged 会被重算成 true，不能拿它判定）。
		if (event.runtimeGeneration === currentRuntime.runtimeGeneration && !currentRuntime.agentId && (currentRuntime.status === "detached" || currentRuntime.status === "closed")) {
			return;
		}
		const messages = payload.messages;
		// 增量 flush 协议（2026-08 渲染卡顿优化）：主进程节流 flush 只发尾部增量
		// （upsertFrom + totalLength），终态 immediate flush 永远全量。
		// 激活显示窗口（2026-08 激活分页）：全量快照只含窗口段 [windowStart..]，
		// 窗口前历史由 disk 轮次分页 prepend（history 字段）；下标运算一律换算窗口偏移。
		const upsertFrom = typeof payload.upsertFrom === "number" ? payload.upsertFrom : undefined;
		const totalLength = typeof payload.totalLength === "number" ? payload.totalLength : undefined;
		const payloadWindowStart = typeof payload.windowStart === "number" ? payload.windowStart : undefined;
		const payloadWindowStartFilePos = typeof payload.windowStartFilePos === "number" ? payload.windowStartFilePos : undefined;
		const fileVersion = typeof payload.fileVersion === "string" ? payload.fileVersion : undefined;
		if (Array.isArray(messages)) {
			const current = get(sessionMessagesCacheAtom)[event.sessionId];
			if (upsertFrom !== undefined && totalLength !== undefined) {
				// 增量合并：upsertFrom 为 runtime 数组绝对下标；本地数组 = [系统卡片(c), 窗口段]，
				// 窗口段首条对应 runtime 下标 W（windowStart），因此本地下标 = upsertFrom − W + c。
				// c（卡片数）由上一次全量 flush 推导并缓存（cardCount，见全量分支）；偏移无效
				// （缓存缺失/磁盘来源/漏事件）则丢弃，等终态窗口化全量校准——中间态滞后至多
				// 为本轮回答内的显示延迟，终态到达后完全纠正。
				const W = current?.windowStart ?? 0;
				const cardCount = current?.cardCount ?? 0;
				const offset = upsertFrom - W + cardCount;
				if (current?.source === "runtime" && offset >= 0 && current.messages.length >= offset) {
					const incoming = stabilizeRuntimeMessageIds(current, messages as ChatMessage[]);
					const merged = [...current.messages.slice(0, offset), ...incoming];
					const outlineChanged = shouldRefreshOutlineForRuntimeUpsert(current.messages, current.outlineLastUserIndex, offset, incoming);
					// 长度校验：合并后本地长度 = 卡片 + (totalLength − W)；不满足说明增量已失序
					// （漏事件/trim 未校准），丢弃等待全量
					if (merged.length === totalLength - W + cardCount) {
						// 宿主快照不含「尚未写进会话日志的乐观用户消息」（模型解析失败等），
						// 增量替换会把气泡挤掉——按公共前缀接回原位（见 pendingUserMessage）。
						set(cacheSessionMessagesAtom, {
							sessionId: event.sessionId,
							messages: carryPendingUserMessages(current.messages, merged),
							source: "runtime",
							windowStart: W,
							outlineChanged,
							history: current.history,
							cardCount,
						});
					}
				}
			} else {
				// 窗口化全量 / 传统全量：替换运行时窗口段；
				// disk 前缀经版本守卫（压缩改写即失效）+ 接缝去重（窗口右移与前缀重叠）后保留
				// id 稳定化（见 stabilizeRuntimeMessageIds）：磁盘页时代的显示 id 保持不变，
				// 避免投影切换导致 TurnRow remount / 布局跳动打断输入
				const segment = stabilizeRuntimeMessageIds(current, messages as ChatMessage[]);
				// 卡片数推导：全量载荷 = [卡片(c), 窗口段]，本地长度 = c + (totalLength − W)
				const W = payloadWindowStart ?? 0;
				const cardCount = Math.max(0, segment.length - (totalLength ?? segment.length) + W);
				// trim 窗口右移的滑出轮：主进程把旧窗口头部（不再被新窗口覆盖的轮次）
				// 随全量 flush 下发，并入历史前缀，避免「锚点轮从视口消失且翻不回来」
				const slideOut = Array.isArray(payload.slideOut) ? stabilizeRuntimeMessageIds(current, payload.slideOut as ChatMessage[]) : undefined;
				// disk → runtime 交接：窗口段替换 messages 之前，先把磁盘页转成历史前缀
				// （见 historyPrefixFromDiskPage 注释）。已是 runtime 前缀的照旧走 reconcile。
				set(cacheSessionMessagesAtom, {
					sessionId: event.sessionId,
					// 全量替换同样可能丢掉尚未被宿主记录的乐观用户消息（DSH 模型解析失败
					// 会让回合直接 error 收口，用户消息从未进日志）——接回原位，避免「消息被吞」。
					messages: carryPendingUserMessages(current?.messages ?? [], segment),
					source: "runtime",
					windowStart: payloadWindowStart,
					cardCount,
					history: reconcileHistoryPrefix(current?.history ?? historyPrefixFromDiskPage(current), segment, fileVersion, slideOut),
					...(typeof payloadWindowStartFilePos === "number" ? { windowStartFilePos: payloadWindowStartFilePos } : {}),
				});
			}
			stopMessageSpan();
			// message 到达后若已含同段 thinking，安全卸 live（覆盖 done 先到的情况）。
			tryReleaseLiveThinkingAfterHistory(get, set, event.sessionId);
			tryReleaseHeldLiveTextAfterHistory(get, set, event.sessionId);
		}
	}

	// 侧栏计时点：只认「本轮开始（用户输入落地）/ 本轮结束（turn 结束）」两个边沿。
	// 流式 token、工具调用、标题回写、catalog 刷新都不推进——否则计时器会被无限重置
	// （文件 mtime 版就是这样，永远显示「刚刚」）。规则见 utils/sessionActivityClock.ts。
	set(advanceSessionActivityAnchorAtom, {
		sessionId: event.sessionId,
		// 换绑（新 agent 接管旧会话）时上一代的运行态不代表本轮，按「未知=空闲」处理：
		// 新绑定若已在跑，会在下一跳改成 true 并推进计时点。
		previousRunning: bindingChanged ? false : isSessionTurnRunning(currentRuntime.state, currentRuntime.status),
		running: isSessionTurnRunning(nextRuntime.state, nextRuntime.status),
	});
	const terminalEnvelope = !bindingChanged && currentRuntime.status === "closed";
	const previousUi = get(sessionRuntimeUiByIdAtom)[event.sessionId];
	const nextUi = payload && !(terminalEnvelope && event.sourceChannel === "agents:ui-request") ? applySessionRuntimeUiEvent(previousUi, event, payload, bindingChanged) : undefined;
	// 与下方 runtimeUnchanged 同款治理（2027-02 性能审计）：applySessionRuntimeUiEvent 对
	// 非 ui-request 事件（50ms 节流的 sessions:messages flush、agents:runtime-state 轮询）
	// 返回原引用。旧代码只判 truthy 就整表 spread 写回——值没变也换 Record 身份，
	// sessionRuntimeUiByIdAtom 的整表订阅者（侧栏五棵树）在流式期间每秒被全量重渲染
	// 数十次。引用相等即跳写；真实 UI 变化必然返回新对象（revision 递增路径）。
	if (nextUi && nextUi !== previousUi) {
		set(sessionRuntimeUiByIdAtom, {
			...get(sessionRuntimeUiByIdAtom),
			[event.sessionId]: nextUi,
		});
	}
	// 2026-08 治理：无实质变化的推送跳过 atom 写入（emitStreamingStatePatch 在
	// 流式期间每 50ms 一推且状态相同）。sessionRuntimeByIdAtom 的订阅者含整个
	// timeline，新对象写入 = 100/s 级全量重渲染（O(消息数) + 分配压力），
	// 是渲染进程 CPU 满载与 V8 committed 只涨不缩的根源。updatedAt 不参与比较
	// （始终变化），跳过更新时也不刷新它——真正的状态变化必然伴随上述字段变化。
	const runtimeUnchanged =
		!bindingChanged &&
		currentRuntime.agentId === nextRuntime.agentId &&
		currentRuntime.runtimeGeneration === nextRuntime.runtimeGeneration &&
		currentRuntime.status === nextRuntime.status &&
		currentRuntime.state === nextRuntime.state &&
		currentRuntime.projectId === nextRuntime.projectId &&
		currentRuntime.cwd === nextRuntime.cwd &&
		currentRuntime.title === nextRuntime.title &&
		currentRuntime.piSessionId === nextRuntime.piSessionId &&
		currentRuntime.sessionPath === nextRuntime.sessionPath &&
		currentRuntime.createdAt === nextRuntime.createdAt &&
		currentRuntime.compactionCount === nextRuntime.compactionCount &&
		currentRuntime.noSession === nextRuntime.noSession &&
		currentRuntime.backend === nextRuntime.backend &&
		currentRuntime.deckSessionId === nextRuntime.deckSessionId &&
		// 远端 trust 标记参与「无变化」判定：它在同一绑定内首次出现时若被跳过写入，
		// 本会话就永远看不到那条提示（本机会话两个值都是 undefined，不影响原行为）。
		currentRuntime.remoteTrustUnhandled === nextRuntime.remoteTrustUnhandled &&
		// 注入面同样参与：能力门晚到一步就会被旧值盖掉（只在 spawn/reattach 后出现）。
		JSON.stringify(currentRuntime.remoteExtensions ?? null) === JSON.stringify(nextRuntime.remoteExtensions ?? null);
	if (!runtimeUnchanged) {
		set(sessionRuntimeByIdAtom, {
			...get(sessionRuntimeByIdAtom),
			[event.sessionId]: nextRuntime,
		});
	}
});
export const bindSessionRuntimeAtom = atom(
	null,
	(
		get,
		set,
		input: {
			sessionId: string;
			agentId: string;
			runtimeGeneration?: number;
			status?: AgentStatus;
		},
	) => {
		const current = get(sessionRuntimeByIdAtom)[input.sessionId];
		const currentGeneration = current?.runtimeGeneration ?? 0;
		if (input.runtimeGeneration !== undefined && input.runtimeGeneration < currentGeneration) {
			return;
		}
		const bindingChanged = Boolean(current?.agentId && current.agentId !== input.agentId);
		// 发送路径的绑定同样代表运行时已恢复（此前可能因闲置释放被标记为已停止）。
		clearStoppedSessionFlag(get, set, input.sessionId);
		const record = get(sessionRecordsAtom)[input.sessionId];
		if (record && !record.noSession && (input.status === "running" || current?.agentId !== input.agentId)) {
			set(touchRecentSessionAtom, { sessionId: record.id, projectId: record.projectId });
		}
		if (bindingChanged) {
			const ui = { ...get(sessionRuntimeUiByIdAtom) };
			delete ui[input.sessionId];
			set(sessionRuntimeUiByIdAtom, ui);
		}
		set(sessionRuntimeByIdAtom, {
			...get(sessionRuntimeByIdAtom),
			[input.sessionId]: {
				// 这里只是绑定刷新（send 路径），除 agent 绑定字段外的会话级元数据（projectId/cwd/
				// createdAt/远端 trust 等，都不属于某次绑定）必须原样保留：漏掉它们会让
				// projectId/cwd/createdAt 坍塌成 undefined，`agentInventorySourceAtom` 的非空守卫
				// 随即把这条会话从活动区剔除，而上面的 touch 已把它顶到「最近会话」首位，
				// 侧栏就出现「掉进最近再闪回活动」的跨区跳变（#492）。首次绑定（无 current）时
				// 从 catalog 记录回填同一批字段，避免新会话首条消息同样不落活动区。
				...(current ?? {}),
				agentId: input.agentId,
				runtimeGeneration: input.runtimeGeneration ?? currentGeneration,
				status: input.status ?? (bindingChanged ? "idle" : current?.status) ?? "idle",
				state: bindingChanged ? undefined : current?.state,
				projectId: current?.projectId ?? record?.projectId,
				cwd: current?.cwd ?? (record?.projectPath || undefined),
				title: current?.title ?? record?.title,
				sessionPath: current?.sessionPath ?? record?.filePath,
				createdAt: current?.createdAt ?? record?.createdAt,
				deckSessionId: current?.deckSessionId ?? record?.id,
				backend: current?.backend ?? record?.backend,
				updatedAt: Date.now(),
			},
		});
		if (bindingChanged) {
			clearSessionLiveThinking(get, set, input.sessionId);
		}
	},
);

export const removeSessionStateAtom = atom(null, (get, set, sessionId: string) => {
	set(forgetRecentSessionAtom, sessionId);
	set(forgetSessionActivityAnchorAtom, sessionId);
	const records = { ...get(sessionRecordsAtom) };
	const session = records[sessionId];
	delete records[sessionId];
	set(sessionRecordsAtom, records);
	if (session) {
		set(sessionIdsByProjectAtom, {
			...get(sessionIdsByProjectAtom),
			[session.projectId]: (get(sessionIdsByProjectAtom)[session.projectId] ?? []).filter((id) => id !== sessionId),
		});
	}
	const runtime = { ...get(sessionRuntimeByIdAtom) };
	delete runtime[sessionId];
	set(sessionRuntimeByIdAtom, runtime);
	const runtimeUi = { ...get(sessionRuntimeUiByIdAtom) };
	delete runtimeUi[sessionId];
	set(sessionRuntimeUiByIdAtom, runtimeUi);
	const cacheStats = { ...get(sessionCacheStatsAtom) };
	delete cacheStats[sessionId];
	set(sessionCacheStatsAtom, cacheStats);
	if (get(stoppedSessionIdsAtom).has(sessionId)) {
		const stopped = new Set(get(stoppedSessionIdsAtom));
		stopped.delete(sessionId);
		set(stoppedSessionIdsAtom, stopped);
	}
	const cache = { ...get(sessionMessagesCacheAtom) };
	releaseSessionOutlineProjection(sessionId);
	delete cache[sessionId];
	set(sessionMessagesCacheAtom, cache);
	clearSessionLiveThinking(get, set, sessionId);
	liveTextStreamingBySessionAtom.remove(sessionId);
	liveTextActiveBySessionAtom.remove(sessionId);
	liveThinkingStreamingBySessionAtom.remove(sessionId);
	// atomFamily 无自动 GC：会话删除时必须同步 remove 各 family 实例，否则长期泄漏（2026-10）。
	// 2027-02：除本文件内的 family 外，composer 六件套 / 命令表 / outline / runtime UI /
	// 侧栏状态等跨模块 family 通过登记表统一释放（原先 15 个 family 完全没有释放路径）。
	removeRegisteredSessionFamilies(sessionId);
	// 数据不在 atomFamily 里的模块（如 DSH 提问回显）经登记表提供清理写 atom
	for (const disposalAtom of getSessionDisposalAtoms()) {
		set(disposalAtom as Parameters<typeof set>[0], sessionId);
	}
	liveThinkingIdBySessionIdAtomFamily.remove(sessionId);
	newTurnCollapseTickBySessionIdAtomFamily.remove(sessionId);
	sendPinAnimatingBySessionIdAtomFamily.remove(sessionId);
	runStepsVisibleMemoryBySessionIdAtomFamily.remove(sessionId);
	processGroupOpenBySessionIdAtomFamily.remove(sessionId);
	streamingTextBySessionIdAtomFamily.remove(sessionId);
	sessionMessageCacheBySessionIdAtomFamily.remove(sessionId);
	set(streamingTextByIdAtom, (prevMap) => {
		if (!(sessionId in prevMap)) return prevMap;
		const nextMap = { ...prevMap };
		delete nextMap[sessionId];
		return nextMap;
	});
	set(sendPinAnimatingByIdAtom, (prevMap) => {
		if (!(sessionId in prevMap)) return prevMap;
		const nextMap = { ...prevMap };
		delete nextMap[sessionId];
		return nextMap;
	});
	set(sessionScrollAnchorByIdAtom, (prevMap) => {
		if (!(sessionId in prevMap)) return prevMap;
		const nextMap = { ...prevMap };
		delete nextMap[sessionId];
		return nextMap;
	});
	set(
		sessionMessageLruAtom,
		get(sessionMessageLruAtom).filter((id) => id !== sessionId),
	);
	const loadState = { ...get(sessionMessageLoadStateAtom) };
	delete loadState[sessionId];
	set(sessionMessageLoadStateAtom, loadState);
	if (get(currentSessionIdAtom) === sessionId) set(currentSessionIdAtom, undefined);
});

/**
 * 待消费的消息跳转（跨会话正文搜索点击后）：侧栏搜索结果点击时写入
 * {sessionId, messageId}，目标会话 pane 聚焦挂载 jumpToMessageRef 后消费并清空。
 * 生命周期短暂（点击→pane 挂载），切走即由消费方/写入方覆盖。
 */
export const pendingMessageJumpAtom = atom<{ sessionId: string; messageId: string } | null>(null);

/**
 * 发送期「乐观用户消息」接管规则（纯函数，可单测）。
 *
 * 背景（2026-10 用户反馈「DSH 会话失败后发送的消息被吞了」）：
 * 渲染层发出提示词时会先往缓存塞一条乐观用户气泡（id = requestId），等宿主把它写进
 * 会话日志后再由运行时快照替换成正式消息。DSH 的模型解析发生在回合的 prepareRequest
 * 阶段（@deepseek-ai/dsh-agent-loop：step() 先 prepareRequest，再 append user/message），
 * 早于把用户消息写进日志——模型配置错误（pi-ai provider … has no configured model）
 * 时回合直接以 error 收口，用户消息从未落盘：随后的快照里没有它，乐观气泡被整段替换，
 * 界面上只剩一条错误诊断，用户刚发出的内容凭空消失。
 *
 * 规则：快照到达时，把「带 pending 标记、且快照里没有等价用户消息」的气泡接回原位；
 * 一旦快照出现同文本用户消息 = 宿主已记录（或用户重发成功），标记气泡让位给正式消息。
 * 标记只由发送路径写入，宿主投影永远不带它，因此不会把正式消息误判成乐观气泡。
 *
 * 放在本模块而不是 utils：session-atoms 是本仓库被最多手写 vm 加载器编译的模块，
 * 新增相对 import 会让这些加载器整片 MODULE_NOT_FOUND（见 AGENTS「禁止手写 vm 加载器」）。
 */

/** ChatMessage.meta 键：待宿主确认的乐观用户消息。 */
export const PENDING_USER_MESSAGE_META = "pendingUserMessage";

function normalizeText(text: string | undefined): string {
	return (text ?? "").replace(/\s+/gu, " ").trim();
}

/** 是否为本模块管理的乐观用户消息（必须是 user + 标记 + 可对账的 requestId）。 */
export function isPendingUserMessage(message: ChatMessage): boolean {
	if (message.role !== "user") return false;
	if (message.meta?.[PENDING_USER_MESSAGE_META] !== true) return false;
	return typeof message.meta?.requestId === "string" && message.meta.requestId.length > 0;
}

/**
 * 用宿主快照替换窗口段时，把尚未被宿主记录的用户消息接回原位。
 *
 * - 快照里已有同 id 或同文本用户消息 → 视为已确认，不再保留（避免重复气泡）；
 * - 否则插在「旧消息与新快照的公共前缀」之后——错误卡/回答通常正是那段新内容，
 *   用户消息因此仍排在它前面，顺序与用户实际发送时一致。
 */
export function carryPendingUserMessages(previous: readonly ChatMessage[], next: readonly ChatMessage[]): ChatMessage[] {
	const pendingAt = previous.flatMap((message, index) => (isPendingUserMessage(message) ? [{ message, index }] : []));
	if (pendingAt.length === 0) return [...next];
	const nextIds = new Set(next.map((message) => message.id));
	const confirmedTexts = new Set(next.filter((message) => message.role === "user").map((message) => normalizeText(message.text)));
	// 锚点：旧序列里排在这条气泡之后的第一个普通消息（快照里的错误卡/回答）。
	// 后续快照虽然又追加了新内容，气泡仍然插在同一个锚点之前，位置不会随刷新漂移。
	const insertions: Array<{ index: number; message: ChatMessage }> = [];
	for (const { message, index } of pendingAt) {
		if (nextIds.has(message.id) || confirmedTexts.has(normalizeText(message.text))) continue;
		const anchor = previous.slice(index + 1).find((candidate) => !isPendingUserMessage(candidate) && nextIds.has(candidate.id));
		const anchorIndex = anchor ? next.findIndex((candidate) => candidate.id === anchor.id) : -1;
		insertions.push({ index: anchorIndex >= 0 ? anchorIndex : commonPrefixLength(previous, next), message });
	}
	if (insertions.length === 0) return [...next];
	insertions.sort((left, right) => left.index - right.index);
	const result: ChatMessage[] = [];
	let cursor = 0;
	for (const insertion of insertions) {
		const at = Math.max(insertion.index, cursor);
		result.push(...next.slice(cursor, at), insertion.message);
		cursor = at;
	}
	result.push(...next.slice(cursor));
	return result;
}

/** 旧序列（去掉乐观气泡）与新快照的公共前缀长度：兜底插入点。 */
function commonPrefixLength(previous: readonly ChatMessage[], next: readonly ChatMessage[]): number {
	const base = previous.filter((message) => !isPendingUserMessage(message));
	let prefix = 0;
	while (prefix < base.length && prefix < next.length && base[prefix].id === next[prefix].id) prefix += 1;
	return prefix;
}

/** 投递被拒/从未送达：撤掉该次请求的乐观气泡（文字已由 restoreRejectedPrompt 回填草稿）。 */
export function removePendingUserMessages(messages: readonly ChatMessage[], requestId: string): ChatMessage[] {
	return messages.filter((message) => !(message.id === requestId && isPendingUserMessage(message)));
}
