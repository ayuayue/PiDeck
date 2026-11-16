import type { RefObject } from "react";
import type { ChatMessage } from "../../../../../shared/types";
import type { MessageScrollerScrollApi } from "../../../components/agents/message-scroller";

/**
 * 时间线控制器对外契约（2026-12 从 useSessionTimelineController 提出）。
 *
 * 只有类型、没有实现：会话面板（SessionMessageTimeline / SessionView / OwnedSessionMessageTimeline
 * 等）按这份形状接线，宿主 hook 与按域拆出的子 hook 共同填满它。搬出来是为了让
 * 「面板能用什么」与「hook 怎么实现」分开读，实现文件不再被 100 行类型挡在前面。
 */
export type SessionTimelineController = {
	timelineRef: RefObject<HTMLElement | null>;
	messages: ChatMessage[];
	visibleMessages: ChatMessage[];
	totalMessageCount: number;
	hasMoreMessages: boolean;
	/** 下一次「加载更多」触发 disk 轮次分页（渲染窗口已耗尽且窗口前还有历史） */
	nextLoadIsHistory: boolean;
	isLoadingMoreMessages: boolean;
	/** 上一次「加载更多」失败原因（原始 IPC 文案）；null = 无错误。时间线在按钮下方出失败行并允许直接重试。 */
	loadMoreError: string | null;
	/** 补页后保持当前视口（新历史只出现在上方）。所有入口统一，不再有「新页直接出现」的跳动。 */
	loadMoreMessages: (source?: "scroll" | "button" | "backfill") => void;
	/** 标记一次程序化滚动（turn 窗口展开补偿等组件内补偿用），抑制历史意图消费。
	 *  durationMs > 0 时按时间窗口抑制（连续 smooth scroll 会派发多个 scroll 事件）。 */
	markProgrammaticScroll: (durationMs?: number) => void;
	/**
	 * 顶部插入（扩窗/翻页）后钉住当前视口：走引擎 restoreAt（定位 + 解锁 + ignoreScrollToTop）。
	 * 引擎未挂上时回退原生 scrollTop。
	 */
	pinViewportAfterPrepend: (nextTop: number) => void;
	/**
	 * 浏览态：按钉住的那一轮相对视口顶的漂移补 scrollTop。
	 * 扩窗 / 翻页 / Markdown 后排版共用；跟随时无操作。人手滚动不会走这条。
	 */
	pinBrowseRow: () => void;
	jumpToMessage: (messageId: string) => void;
	scrollToBottom: () => void;
	/** Receives wheel input from the sibling outline rail without bypassing timeline scroll ownership. */
	scrollTimelineBy: (deltaY: number) => void;
	/** 最新轮自动收起后，不再自动调整滚动位置——历史滚动只发生在「发送那一刻」，
	 *   保持这个 API 只是为兼容旧调用处；实现为空操作。 */
	scrollFinalAnswerToUpperMiddle: (runId: string) => void;
	/** 滚动回调（MessageScroller viewport 接线）：维护会话切换的滚动锚点。 */
	handleTimelineScroll: () => void;
	autoScroll: boolean;
	showScrollToBottom: boolean;
	/** 由 MessageScroller 汇报用户是否仍在实时尾部，避免两套滚动监听互相抢占。 */
	setAutoScrollFromScroller: (following: boolean) => void;
	/**
	 * 引擎上报的用户滚动意图（wheel/触摸/滚动条真实输入）：
	 * 近顶部自动扩窗/预取只消费该意图，布局 resize/clamp 不算用户上滑。
	 * source 区分真实输入与 scroll 派生：只有真实输入才终止在途定位动画。
	 */
	setUserScrollIntent: (intent: "up" | "down", source?: "scroll" | "input") => void;
	/** 新 run 开始（busy 边沿）：旧实现用来取消完结定位动画；现已删除该动画，
	 *  保留同签名避免外部调用处崩溃。 */
	cancelSettledRepositionForNewRun: () => void;
	/**
	 * 挂到 MessageScroller 的 stick-to-bottom 引擎 API（回底弹簧）。
	 * 未挂上时 scrollToBottom 退化为原生 scrollTo。
	 */
	scrollerScrollApiRef: RefObject<MessageScrollerScrollApi | null>;
	/** 上滚查看历史时的渲染窗口轮数（贴底时渲染层用 TIMELINE_MOUNTED_TURN_LIMIT，忽略此值）。
	 *  2026-08 黑屏治理：历史不再全量放开挂载，窗口随「显示更早」逐步扩大。 */
	scrolledWindowTurns: number;
	/** 扩大上滚渲染窗口（每次最多 +3 轮）；数据翻页与本地 DOM 扩展使用同一 cohort。 */
	expandWindow: () => void;
	/**
	 * 上滚渲染窗口是否仍可扩展（由渲染层同步 turnWindowActive：已加载数据未被全部挂载）。
	 * 滚动监听读它决定「先扩窗口」还是「翻数据页」（方案 C 渐进扩展，2026-12）。
	 */
	windowExpandableRef: RefObject<boolean>;
	/**
	 * 磁盘消息尚未就绪（含挂载首帧 loadStatus 未写入）。
	 * SessionView 用它在历史会话加载期仍挂底部 composer，避免 1 面板 Group 吃到 2 值布局缓存。
	 */
	isSurfaceLoading: boolean;
	/**
	/**
	 * 需要「整表真实渲染」的时机（三处，同一套机制）：
	 * 1. 恢复锚点 / 挂起跳转在途 —— 这两条路径按 [data-message-id] 查 DOM；
	 * 2. 顶部插入（扩窗 / 数据翻页）在途 —— 插入会把视口里的行推走、被虚拟化卸载，
	 *    之后 pinBrowseRow 拿不到 currentTop，补不了位移（用户看到内容跳一下）；
	 * 3. 多选导出（渲染层自己的 state，不在这里）。
	 * 虚拟区外的行不在 DOM 里，上述场景必须整表挂载。
	 */
	navBlockingVirtualization: boolean;
	/** 当前钉住行的 messageId（浏览态）；无钉行时为 null。读 ref，不触发渲染。 */
	readPinnedMessageId: () => string | null;
	/** 跳转在途：贴底跟随的窗口压缩要让位，否则流式期间目标轮挂不上。 */
	jumpPending: boolean;
	/** 顶部插入收尾：渲染层做完 pin 补偿后调用，解除整表渲染。 */
	endPrependSolid: () => void;
	/** 本栏粘住的空会话：预热写 filePath/dshSessionId 后仍不闪历史骨架。 */
	knownEmpty: boolean;
	/**
	 * 强制从磁盘重载本会话时间线（编辑/删除/重发改 JSONL 后）。
	 * 绕过「已加载 + 有缓存就跳过」和 runtime 缓存守卫。
	 */
	reloadFromDisk: () => Promise<void>;
	/**
	 * DSH host 被手动停止时的恢复入口：先显式启动 host（唯一能解开手动停止标记的
	 * 路径），再重载本会话历史。返回是否启动成功；false 时调用方给用户提示。
	 */
	startDshHostAndReload: () => Promise<boolean>;
};
