import type { AgentRuntimeState, SessionRecord } from "../../../../../shared/types";
import type { SessionLoadState, SessionScrollAnchor } from "../../../atoms";
import { TIMELINE_SCROLLED_TURN_LIMIT } from "../../../components/session/timeline/turnRenderWindow";
import { pickVisibleRootRow, type BrowsePin } from "../../timeline/browsePin";
import { ROOT_ROW_SELECTOR, type VisibleTimelineRow } from "../../timeline/useVisibleTimelineRows";

/**
 * 时间线控制器的纯策略（2026-12 从 useSessionTimelineController 提出）。
 *
 * 这层只回答「给定几何/状态该得出什么」：贴底判定、顶部补偿、浏览钉选择、首屏读盘
 * 跳过条件、surface 派生。没有 React、没有 atom、没有副作用，因此可以直接单测；
 * 带状态与副作用的编排仍留在主 hook。搬运时逐字复制，行为与拆分前一致。
 */

/** 滚动接近顶部自动加载历史的阈值（px，2026-11 轮次模型）：
 *  贴顶（≤8px）才触发翻页——「滑到底才翻」，避免在顶部附近任何滚动都连翻历史页。
 *  同时用作「顶部不补偿」阈值：视口顶部 prepend/展开新内容时保持原位可见，
 *  补偿会把新内容推出视口（点击「加载更多/显示更早」无反馈根因，2026-02 修复）。 */
export const HISTORY_AUTO_LOAD_THRESHOLD = 8;

// 用户主动向上滚超过此阈值后停止自动跟底。值设很小是为了让用户稍微滚一点就能挣脱自动滚动，
// 避免流式消息频繁触发 ResizeObserver/MutationObserver 把用户弹回底部造成"颤抖"。
export const BOTTOM_THRESHOLD = 16;

export function isTimelineAtBottom(scrollTop: number, scrollHeight: number, clientHeight: number): boolean {
	return scrollHeight - scrollTop - clientHeight < BOTTOM_THRESHOLD;
}

export function restoreTimelineAnchor(previousTop: number, heightDelta: number): number {
	return previousTop + heightDelta;
}
/**
 * 视口顶基准（相对 page）：IO 的 root 相交矩形以 padding box 为界（不含 border），
 * 快路径 origin 也加了 clientTop；全量回落与 pin 测量必须同基准，否则一旦
 * .message-timeline 加 border，两条路径会差一个 border 宽度（#401 终审 P2）。
 */
export function timelineViewportTop(timeline: HTMLElement): number {
	// clientTop 在真实 DOM 里一定是数字；替身/异常节点缺失时按 0 处理，避免 NaN 毒化整个锚点。
	const clientTop = Number.isFinite(timeline.clientTop) ? timeline.clientTop : 0;
	return timeline.getBoundingClientRect().top + clientTop;
}

/** 钉行相对视口顶的偏移；行未挂载时返回 null。 */
export function measureBrowsePinViewportTop(timeline: HTMLElement | null, messageId: string): number | null {
	if (!timeline || !messageId) return null;
	const el = timeline.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`) as HTMLElement | null;
	if (!el) return null;
	return el.getBoundingClientRect().top - timelineViewportTop(timeline);
}

/**
 * 视口里第一条底部仍在视口内的轮根节点（user-turn / turn-row）；不要求整行都在视口里。
 * 浏览钉行用：即使物理上仍接近底部（短 3 轮窗口）也要能钉住，所以不走 isTimelineAtBottom。
 */
export function findBrowsePin(timeline: HTMLElement | null, visibleRows?: readonly VisibleTimelineRow[]): BrowsePin | null {
	if (!timeline) return null;
	// 快路径：可见行已按 top 升序，取第一条还没被视口顶切掉的行即可。
	// 命中轮根才走快路径；可见集合里没有轮根（长回答内部、只有子元素）时必须回落到
	// 下面的全量遍历 —— 原实现会继续找「视口下方最近的轮根」，直接 return null 会丢 pin
	// 导致插页后位置漂移（2026-10-23 评审实测回归）。
	if (visibleRows && visibleRows.length > 0) {
		// 与原逻辑一致：findBrowsePin 只认轮根，不做卡类降级（降级是 computeCurrentAnchor 的两级策略）
		const row = pickVisibleRootRow(visibleRows);
		if (row) return { messageId: row.id, expectedViewportTop: row.top };
	}
	const viewportTop = timelineViewportTop(timeline);
	const rows = timeline.querySelectorAll<HTMLElement>(ROOT_ROW_SELECTOR);
	for (const row of rows) {
		const rect = row.getBoundingClientRect();
		if (rect.bottom < viewportTop + 1) continue;
		const messageId = row.dataset.messageId ?? "";
		if (!messageId) continue;
		return {
			messageId,
			expectedViewportTop: rect.top - viewportTop,
		};
	}
	return null;
}

/**
 * Session switching reuses the same controller instance in the solo pane. The
 * restored anchor therefore has to initialize both follow mode and the DOM
 * window before MessageScroller commits its layout effects.
 */
export function resolveSessionTimelineRestoreState(anchor: SessionScrollAnchor | undefined): {
	autoScroll: boolean;
	showScrollToBottom: boolean;
	scrolledWindowTurns: number;
} {
	return {
		autoScroll: anchor === undefined,
		showScrollToBottom: anchor !== undefined,
		scrolledWindowTurns: Math.max(TIMELINE_SCROLLED_TURN_LIMIT, anchor?.windowTurns ?? TIMELINE_SCROLLED_TURN_LIMIT),
	};
}

/** 顶部补偿决策（数据 prepend / turn 窗口扩大共用，2026-02 修复）：
 *  视口在顶部（≤阈值）时不补偿，保持原位让新加载/展开的内容直接出现在视口顶部——
 *  容器 overflow-anchor:none，插入内容不会自动调整滚动位置，补偿反而把新内容推出视口，
 *  表现为「点击加载更多/显示更早无反馈」。视口中部时按高度差补偿以保持视口内容不动。
 *  返回补偿后的 scrollTop；null = 不补偿（保持原位）。 */
export function resolveTimelineTopCompensation(previousTop: number, heightDelta: number, threshold = HISTORY_AUTO_LOAD_THRESHOLD): number | null {
	if (previousTop <= threshold) return null;
	return restoreTimelineAnchor(previousTop, heightDelta);
}

export function matchesTimelineOwner(taggedOwnerKey: string, currentOwnerKey: string): boolean {
	return taggedOwnerKey === currentOwnerKey;
}

export function isSessionRuntimeBusy(status: string | undefined, state: AgentRuntimeState | undefined, backend?: string): boolean {
	// ACP：status 只会随 tab 快照更新，可能比回合结算晚一拍；isTurnActive 已显式落回 false
	// （此时输入预测 ghost 已经出现）却仍报 running 时，按空闲处理。否则 Tab 采纳预测后的
	// 发送会被误判成「忙碌」排进 followUp 队列，输入框上方凭空多出一条队列行。
	if (backend === "acp" && state?.isTurnActive === false) return false;
	// idle/error/closed 是停止的权威边沿；旧 runtime-state 可能稍后到达，
	// 不能让滞后的 isStreaming/isExecutingTool 把页面继续显示为运行中。
	if (status === "idle" || status === "error" || status === "closed" || status === "detached") return false;
	return Boolean(status === "running" || state?.isStreaming || state?.isExecutingTool);
}

/** 用户主动发送才算「正在启动」。输入预热也会把 runtime 打成 starting，但不能锁输入框。 */
export function isUserFacingSessionStart(sendStatus: string | undefined): boolean {
	return sendStatus === "activating";
}

/** catalog 已确认无磁盘历史：空草稿、从未落文件的 pi 会话、尚无 host id 的新 DSH。
 * 预热会写 filePath / dshSessionId，但草稿在真正开聊前仍算空——见控制器 sticky。 */
export function isKnownEmptySessionRecord(record: Pick<SessionRecord, "status" | "filePath" | "messageCount" | "backend" | "dshSessionId" | "locator"> | undefined): boolean {
	if (!record) return false;
	if (record.status === "draft") return true;
	if ((record.messageCount ?? 0) > 0) return false;
	if (record.filePath) return false;
	// SSH 的 messageCount=0 是未读取摘要，不是磁盘无历史；归档恢复的新记录没有内存缓存。
	// 只要已有远端文件身份就必须读页。草稿仍由上面的 draft 分支保留空态。
	if (record.locator?.kind === "ssh" && (record.locator.remoteSessionId || record.locator.remotePath)) return false;
	if (record.backend === "dsh" && record.dshSessionId) return false;
	// imagegen 会话历史独立存 ImageSessionStore，不体现在 filePath/messageCount：
	// 已 promote 为 active 的生图会话不能判为空，否则重启后打开会跳过历史加载显示空引导页。
	// 新建生图草稿仍为 draft，已在上面 return true，不受影响。
	// videogen 同理（VideoSessionStore 独立存储，任务占位也不在 filePath/messageCount 里）。
	if (record.backend === "imagegen" || record.backend === "videogen") return false;
	return true;
}

export function deriveSessionSurfaceRuntime(
	messageCount: number,
	messageLoadStatus: string | undefined,
	sendStatus: string | undefined,
	runtimeStatus: string | undefined,
	runtimeState: AgentRuntimeState | undefined,
	hasCachedEntry?: boolean,
	/**
	 * catalog 已确认是空草稿（draft / 无会话文件且 messageCount=0）。
	 * 不能把 undefined/loading 钉成骨架：否则新建会话先挂底部输入栏再卸掉改居中起始页
	 * （输入框上跳），切回空会话还闪「正在加载历史」。有 filePath 的历史仍走下方规则。
	 */
	knownEmpty?: boolean,
) {
	const activating = isUserFacingSessionStart(sendStatus);
	const status = activating ? "starting" : runtimeStatus;
	return {
		status,
		isLoading:
			!knownEmpty &&
			messageCount === 0 &&
			(messageLoadStatus === "loading" ||
				// 挂载首帧 loadState 尚未写入（passive effect 在 paint 后才置 loading），
				// undefined 一律视为加载中——否则有历史的会话会被误判为「空会话」，
				// 闪出 SessionStartSurface 起始页（打开/切回大会话闪屏根因）。
				messageLoadStatus === undefined ||
				// ready 但缓存条目不存在（从未写入或被 LRU 淘汰）＝ disk 读取结果尚未到达
				// （cacheMessages 对 disk 读取无论空/非空都会创建条目）：必须钉在骨架屏。
				// 缓存条目已存在（即使 messages 为空）说明 disk 已返回——空会话显示起始页
				// 是合法终态，不会进入加载死循环。读取失败（error）不在此列。
				// 预热/发送 activating 不能再钉骨架：空会话应留在起始页，避免「输入一半整页闪骨架」。
				(messageLoadStatus === "ready" && !hasCachedEntry)),
		isStarting: activating,
		isBusy: activating || sendStatus === "sending" || isSessionRuntimeBusy(status, runtimeState),
	};
}

export function canLoadSessionTimelineMore(isStarting: boolean, messageCount: number): boolean {
	// 只在初始加载（无消息）时隐藏按钮；runtime 创建期间已有消息则不隐藏
	return !(isStarting && messageCount === 0);
}

/**
 * 挂载时是否可跳过初始磁盘历史读取。
 *
 * 背景（2026-10-08 fork/copy 现场）：主进程把坏路径读盘失败当「空历史」返回，
 * runtime 下发 0 条的全量 flush，渲染层写入 source="runtime"、messages=[] 的缓存
 * 条目。旧逻辑把这条**空 runtime 投影**当「已加载」跳过磁盘读取，loadState 永远停在
 * undefined，deriveSessionSurfaceRuntime 把 undefined 钉成 loading → 骨架屏永驻。
 *
 * 契约：跳过条件必须是「已拿到真实内容」——
 *   - knownEmpty（草稿/无文件无消息）→ 跳过，起始页是合法终态；
 *   - 条目非空（runtime/disk 来源都算真实内容）→ 跳过；
 *   - 条目为空但来源是 disk → 跳过（磁盘已应答，空即空会话终态）；
 *   - 条目为空且来源是 runtime → 不跳过：这是唯一能区分「会话本来就空」与
 *     「读盘还没应答/失败」的状态，必须读盘让磁盘给出 ready（起始页）或
 *     error（错误卡片 + 重试），否则失败被伪装成空历史且骨架永驻。
 */
export function shouldSkipInitialDiskLoad(cachedEntry: { source: "disk" | "runtime" | "remote"; messages: readonly unknown[]; history?: { messages: readonly unknown[] } } | undefined, knownEmpty: boolean): boolean {
	if (knownEmpty) return true;
	if (!cachedEntry) return false;
	if (cachedEntry.messages.length > 0 || (cachedEntry.source === "runtime" && Boolean(cachedEntry.history?.messages.length))) return true;
	// 空条目只有磁盘亲自返回的才算终态；runtime 空投影必须读盘核实。
	return cachedEntry.source === "disk";
}

/**
 * 挂载 effect 是否跳过初始磁盘读取（在 shouldSkipInitialDiskLoad 之上叠加「本次挂载已经
 * 发起或拿到读盘结论」的去重条件）。
 *
 * 为什么需要去重：runtime 节流 flush 每次都重建缓存条目对象（cacheSessionMessagesAtom
 * 整体重建 entry），effect 依赖 cachedEntry 会随之重跑；不去重就会对同一会话反复读盘。
 *
 * 但「会话挂载过一次」不等于「已经读过盘」，两者必须分开：
 *   - loadState 仍是 undefined（本次挂载从未发起/拿到读盘结论）→ 不得跳过。缓存里的空
 *     runtime 投影不是终态：重启换代把旧窗口替换成空数组后，只有读盘能把它推到
 *     ready（历史/空会话）或 error（错误卡片），否则骨架屏永驻（Issue #350）。
 *   - loadState 已 settled 且缓存条目被 8-LRU 整体淘汰（undefined）→ 不得跳过，重读自愈
 *     （2026-12 回归修复）；条目仍在时以已有磁盘结论为准，不因 runtime 重写条目重读。
 *   - loadState 已是终态错误（读盘失败 / 文件缺失 / DSH 专态）→ 不得自动重读：错误态没有
 *     缓存条目，跳过条件会退化成「effect 每次重跑都读盘」，而 effect 依赖 loadStateStatus，
 *     形成 loading↔error 的读盘死循环（2026-11 现场：Windows 模式点开 WSL 路径会话，
 *     48 次/秒 IPC，页面一直闪）。错误由 UI 呈现并支持手动重试，自动恢复只靠重新挂载。
 */
export function shouldSkipInitialDiskRead(input: { previouslyLoaded: boolean; cachedEntry: { source: "disk" | "runtime" | "remote"; messages: readonly unknown[]; history?: { messages: readonly unknown[] } } | undefined; knownEmpty: boolean; loadStateStatus: SessionLoadState["status"] | undefined }): boolean {
	if (shouldSkipInitialDiskLoad(input.cachedEntry, input.knownEmpty)) return true;
	// 首次挂载到本会话：是否读盘完全由缓存权威性决定（与旧行为一致）。
	if (!input.previouslyLoaded) return false;
	// 读盘已给出终态错误：等用户手动重试，不能让 effect 自己再发一次（死循环，见函数注释）。
	if (input.loadStateStatus === "error") return true;
	// 从未读盘：空 runtime 投影必须核实（Issue #350 的核心）。
	if (input.loadStateStatus === undefined) return false;
	// 读盘在途：等结果，不重复发起（缓存条目可能已被 runtime flush 重建）。
	if (input.loadStateStatus === "loading") return true;
	// 已 settled：条目消失（LRU 淘汰）→ 重读自愈；条目仍在 → 以磁盘结论为准。
	return input.cachedEntry !== undefined;
}

export function isLatestTimelineRunBusy(isAgentBusy: boolean, index: number, runCount: number): boolean {
	return isAgentBusy && index === runCount - 1;
}
