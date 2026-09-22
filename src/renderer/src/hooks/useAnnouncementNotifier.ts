/**
 * 公告通知调度 hook（全局唯一挂载点：App.tsx，与 useAgentLoadNotice 同层）。
 *
 * 设计要点：
 * - 轮询驱动而非事件驱动：公告是低频广播（快照最迟 2h 才可能变化），3s 轮询的
 *   空转成本（2 次 atom 读 + 3 次 DOM 查询）可忽略，却能把「忙碌判定」做成持续
 *   状态检查，避免为 composer 焦点/Agent 事件/弹窗开关各建一条订阅链。
 * - 不打扰原则：composer 输入聚焦、Agent 运行中、模态打开、窗口不活跃四类状态
 *   都不弹；待提醒内容不丢弃（侧栏红点仍在），空闲后下一轮自动补弹。
 *   判定策略在 utils/announcementNotifyPolicy.ts（纯函数，tests 可单测）。
 * - 每条公告只弹一次，且**跨重启/崩溃重载都成立**：去重状态持久化在主进程
 *   （notifiedIds），不用组件内存（ref 在每次启动和 renderer 崩溃自动 reload 后都会重置，
 *   未读公告会跟着重放——这正是历史 bug「同一条公告一直弹」）。
 * - 一轮只弹最新 1 条（ANNOUNCEMENT_TOAST_BURST_LIMIT）：多条未读不排队刷屏；
 *   被压制的旧条目也一并记为已提醒，否则下一轮会把次新当最新再弹，等于没压住。
 * - 用户点开公告中心 = 已知悉：顺手把这些旧公告写回主进程「已提醒」，之后不再为它们弹 toast
 *   （新公告照常提醒）。
 */
import { useEffect, useRef } from "react";
import { getDefaultStore, useAtomValue } from "jotai";
import { announcementCenterOpenAtom, announcementNotificationEnabledAtom, announcementStateAtom, unreadAnnouncementsAtom } from "../atoms/announcement-atoms";
import { currentSessionRuntimeAtom } from "../atoms/session-atoms";
import { desktopApi } from "../desktopApi";
import { t } from "../i18n";
import { showNotice } from "../utils/notice";
import { isBusyForAnnouncement, levelToNoticeKind, nextTickDelayMs, pickAnnouncementBatch, ANNOUNCEMENT_POLL_VISIBLE_MS } from "../utils/announcementNotifyPolicy";
import type { AnnouncementBusyContext } from "../utils/announcementNotifyPolicy";

/** 单条 toast 展示时长（ms）：showNotice 的 info 默认 1.5s 太短，公告需要可读时长。 */
const ANNOUNCEMENT_TOAST_DURATION_MS = 6000;

/**
 * 当前聚焦会话的 Agent 是否运行中。与 App.isAgentCurrentlyBusy 同口径
 * （status running / isStreaming / isExecutingTool），读取走默认 jotai store，
 * 不经过 React 订阅——轮询 tick 里按需取最新值即可。
 */
function isCurrentAgentBusy(): boolean {
	const runtime = getDefaultStore().get(currentSessionRuntimeAtom);
	return runtime?.status === "running" || Boolean(runtime?.state?.isStreaming) || Boolean(runtime?.state?.isExecutingTool);
}

/**
 * 采集当前「是否可打扰」上下文。非纯函数（读 DOM / jotai store），
 * 判定逻辑全部在纯策略函数 isBusyForAnnouncement 内，本函数只做采集。
 */
function readAnnouncementBusyContext(): AnnouncementBusyContext {
	return {
		// 焦点在 composer 富文本输入框内（closest 覆盖输入框内的子节点）：正在打字/选词
		composerFocused: document.activeElement?.closest(".rich-input") != null,
		agentBusy: isCurrentAgentBusy(),
		// 任意 Radix 模态对话框打开（portal 渲染在 body 下）：toast 会压在弹窗上层
		modalOpen: document.querySelector('[role="dialog"]') != null,
		// 窗口失焦/最小化/托盘隐藏：用户不在看 PiDeck，不着急弹（hasFocus 在个别老内核可能缺失，防御一下）
		windowInactive: typeof document.hasFocus === "function" ? !document.hasFocus() : false,
	};
}

/**
 * 公告通知调度。开关读 announcementNotificationEnabledAtom 镜像（App.tsx 从
 * settings 同步）；开关在**每个 tick 内重新读取**，所以运行中关掉通知会立刻停止后续弹出
 * （只在挂载时读一次的话，已启动的轮询会继续弹，关开关看似无效）。
 * 关闭后完全不弹 toast，入口按钮与红点由 AnnouncementCenter 按同一开关隐藏。
 */
export function useAnnouncementNotifier(): void {
	// 本运行周期已弹过 toast 的公告 id：只是**即时去重**（避免同一 tick 内重复提交 IPC），
	// 权威记录在主进程 notifiedIds（持久化，跨重启生效）。不用它当唯一判据。
	const sessionShownIdsRef = useRef<Set<string>>(new Set());
	const centerOpen = useAtomValue(announcementCenterOpenAtom);

	// 用户主动打开公告中心 = 待提醒内容已全部可见：全部标记为本周期已展示，
	// 关闭弹窗后不再为这些旧公告弹 toast（之后新公告照常提醒）。
	// 同时写回主进程「已提醒」——用户已经主动看过了，之后更没有理由再弹。
	useEffect(() => {
		if (!centerOpen) return;
		const unread = getDefaultStore().get(unreadAnnouncementsAtom);
		if (unread.length === 0) return;
		for (const item of unread) sessionShownIdsRef.current.add(item.id);
		void desktopApi.announcements.markNotified(unread.map((item) => item.id)).catch(() => undefined);
	}, [centerOpen]);

	useEffect(() => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const tick = () => {
			// 先排下一轮再处理本轮：任何提前 return 的分支都不会打断轮询节奏
			timer = setTimeout(tick, nextTickDelayMs(readAnnouncementBusyContext()));
			// 开关每轮重读（见 hook 注释）：关闭后立即停止弹出，无需重挂载
			if (!getDefaultStore().get(announcementNotificationEnabledAtom)) return;
			// 待提醒 = 未读 ∩ 历史已提醒（主进程持久化）∩ 本周期已弹
			const alreadyNotified = new Set([...(getDefaultStore().get(announcementStateAtom)?.notifiedIds ?? []), ...sessionShownIdsRef.current]);
			const pending = getDefaultStore()
				.get(unreadAnnouncementsAtom)
				.filter((item) => !alreadyNotified.has(item.id));
			if (pending.length === 0) return;
			// 不打扰判定：忙碌时本轮跳过，待提醒集合不丢（红点仍在），空闲后自动补弹
			if (isBusyForAnnouncement(readAnnouncementBusyContext())) return;
			// 一轮只弹最新 1 条；被判为「本轮不弹」的旧条目同样记为已提醒——
			// 否则它们会顺位成下一轮的「最新」，攒 N 条就弹 N 轮（见 pickAnnouncementBatch 注释）。
			// pending 保持快照顺序（发布时间倒序），所以 shown[0] 就是最新那条。
			const { shown, suppressed } = pickAnnouncementBatch(pending);
			const consumed = [...shown, ...suppressed];
			for (const item of consumed) sessionShownIdsRef.current.add(item.id);
			// 先落盘再弹：即使用户弹完立刻崩溃/退出，也不会因为「还没记上」而重播
			void desktopApi.announcements.markNotified(consumed.map((item) => item.id)).catch(() => undefined);
			const item = shown[0];
			if (!item) return;
			// 正文原样传给 showNotice：toast 卡片仍是纯文本（截断预览），但超长时点「查看详情」
			// 的弹窗会经 MarkdownStream 渲染 markdown —— 公告本就是 md 正文，纯文本展示会满屏 `**`。
			// 「查看」按钮打开公告中心（atom 驱动，见 announcement-atoms）。
			showNotice(item.body, ANNOUNCEMENT_TOAST_DURATION_MS, levelToNoticeKind(item.level), item.title, {
				action: {
					label: t("announcements.toast.view"),
					onClick: () => getDefaultStore().set(announcementCenterOpenAtom, true),
				},
			});
		};
		timer = setTimeout(tick, ANNOUNCEMENT_POLL_VISIBLE_MS);
		return () => {
			if (timer !== undefined) clearTimeout(timer);
		};
	}, []);
}
