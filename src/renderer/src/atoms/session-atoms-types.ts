/**
 * 会话 atoms 的共享类型（纯类型模块，零运行时依赖）。
 *
 * 从 `session-atoms.ts` 原样搬家而来（拆分，行为零变化）：运行时视图状态、消息缓存
 * 条目、live 思考段、加载态、运行时 UI 状态。各域模块用 `import type` 引用，
 * 编译后不产生 require，不会给测试的手写 vm 加载器添依赖。
 * 入口 `session-atoms.ts` 用 `export *` 转出，所有既有 import 不变。
 */
import type { AgentBackend, AgentRuntimeState, AgentStatus, AgentUiRequest, ChatMessage, RemoteSessionExtensions, SessionHistoryUnavailableReason, SessionMessagePage } from "../../../shared/types";

export type SessionRuntimeViewState = {
	agentId?: string;
	runtimeGeneration: number;
	status: AgentStatus | "detached";
	state?: AgentRuntimeState;
	updatedAt: number;
	projectId?: string;
	cwd?: string;
	title?: string;
	piSessionId?: string;
	sessionPath?: string;
	/** PiDeck 会话身份（agents:state / sessions:runtime 事件与 listRuntimes 透传）：侧栏 ACP「agent↔会话」配对用，缺它会把同一会话画成两行。 */
	deckSessionId?: string;
	createdAt?: number;
	compactionCount?: number;
	noSession?: boolean;
	/**
	 * 远端会话标记（agents:state 载荷透传自 `AgentTab.remoteTrustUnhandled`）：这条会话的远端项目
	 * trust 由 PiDeck 的决策表管理（P4.4b）。它只决定**是否**显示 trust 提示；四种展示态由决策表合成
	 * （见 `remote-trust-atoms.ts` 的 `sessionRemoteTrustStateAtomFamily`），不以 pi 事件为准。
	 * undefined/false = 本地/WSL/DSH/生图会话，或旧 main 的载荷没带这个字段；
	 * 消费端（RemoteSessionTrustNotice）按「无标记 = 不显示提示」处理，不报错。
	 */
	remoteTrustUnhandled?: boolean;
	/**
	 * 远端会话实际注入的内置扩展（`AgentTab.remoteExtensions` 透传）。能力门（计划/目标/安全等级）
	 * 只认它的 `applied`；空数组 + reason = 本轮降级，UI 必须禁用入口而不是让用户选了没反应。
	 */
	remoteExtensions?: RemoteSessionExtensions;
	/** 运行时后端（pi/dsh）：agents:state 事件透传，侧栏徽章/配对用。 */
	backend?: AgentBackend;
};

/** Live 思考段（按稳定 id 索引，与 History msg-thinking-* 同一身份）。 */
export type StreamingThinkingEntry = {
	sessionId: string;
	text: string;
	startedAt: number;
	endedAt: number;
	streaming: boolean;
};

export type SessionLoadState = {
	status: "idle" | "loading" | "ready" | "error";
	error?: string;
	/**
	 * 结构化不可用原因（与 status:"error" 配合）：区分「读盘真的失败」与
	 * 「历史暂时读不了但用户可恢复」。当前只有 DSH host 被手动停止一种。
	 */
	reason?: SessionHistoryUnavailableReason;
};

export type SessionMessageCacheEntry = {
	messages: ChatMessage[];
	revision: number;
	// "remote" = 这条历史来自远端会话文件（ssh locator）经主进程有界窗口读回：
	// 游标语义与本地**不同**（远端是字节偏移，本地是活动分支消息下标），因此不能走本地那套数值算术。
	source: "disk" | "runtime" | "remote";
	updatedAt: number;
	/**
	 * 条目驻留字节估算（estimateSessionCacheEntryBytes，写入时随条目重建刷新）。
	 * 供已关闭 Tab 条目的字节预算淘汰用；本版本前写入的条目缺省，读取方需补算。
	 */
	bytes?: number;
	/** Changes only when the user-message outline can change. */
	outlineRevision?: number;
	/** Last user-message index in messages (not the separate history prefix). */
	outlineLastUserIndex?: number;
	/**
	 * Present only for paged historical reads; runtime owns an authoritative full snapshot.
	 * indexVersion/nextBeforeEntryId 也要留住：disk → runtime 交接时，磁盘页会整体转成
	 * history 前缀，版本用来判断它是否与当前会话文件同代，游标用来继续向更早翻页。
	 */
	page?: Pick<SessionMessagePage, "total" | "nextBefore" | "nextBeforeEntryId" | "indexVersion">;
	/** 激活显示窗口起点（runtime 数组下标空间，2026-08 激活分页）；>0 表示窗口前还有历史。 */
	windowStart?: number;
	/**
	 * 窗口段头部的系统摘要卡片数（全量 flush 时推导：本地长度 − (totalLength − windowStart)）。
	 * 增量合并时 upsertFrom 是 runtime 绝对下标，须 +cardCount 才等于本地下标（卡片占据本地头部）。
	 */
	cardCount?: number;
	/** 窗口首条消息的文件消息下标（2026-11）：窗口缺 entryId 时作为首次补历史的数值游标 */
	windowStartFilePos?: number;
	/**
	 * disk 历史前缀（仅 runtime 窗口会话）：prepend-only 轮次页，
	 * 与运行时窗口段的接缝按 meta.entryId 去重；fileVersion 变化（压缩改写）即整段失效。
	 */
	history?: {
		messages: ChatMessage[];
		nextBefore: number | null;
		/** 下一页续页锚点（页最旧条目的 entryId，2026-11 缓存优先路径用） */
		nextBeforeEntryId?: string | null;
		version?: string;
	};
};

export type SessionRuntimeUiRequestState = {
	request: AgentUiRequest;
	status: "pending" | "responding" | "completed" | "cancelled";
};

export type SessionRuntimeUiState = {
	agentId: string;
	runtimeGeneration: number;
	requests: Record<string, SessionRuntimeUiRequestState>;
	widgets: Record<string, string[]>;
	notification?: {
		requestId: string;
		message: string;
		notifyType?: "info" | "warning" | "error";
		revision: number;
	};
	editorText?: {
		requestId: string;
		text: string;
		revision: number;
	};
	revision: number;
};
