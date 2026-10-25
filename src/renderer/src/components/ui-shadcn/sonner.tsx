import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Toaster as SonnerToaster } from "sonner";
import { Inbox } from "lucide-react";
import { t } from "../../i18n";
import { getActiveNoticeOverflow, subscribeActiveNoticeCount, VISIBLE_TOAST_COUNT } from "../../utils/noticeCountStore";
import { setToasterReady } from "../../utils/notice";
// 弹窗本体单文件：它 import MarkdownStream，与 notice-toast 同文件会形成循环 import
import { NoticeDetailsDialog } from "./notice-details-dialog";
import { setNoticeDetailsOpener, type NoticeDetailsPayload } from "./notice-toast";
import { openNoticeHistoryDialog } from "./notice-history-dialog";

/**
 * 全局 Toaster（#115）：sonner 官方组件，只承担堆叠/定位/时长/主题跟随，
 * 单条 toast 的具体外观由 notice.ts 经 toast.custom 渲染的自定义卡片（NoticeToastCard）承担。
 * 主题跟随应用 dataset.theme（应用主题独立于系统主题，不能用 sonner 的 "system" 模式）。
 *
 * portal 到 body：sonner 自身不 portal，而 #root 带 position:relative + z-index:1
 * （层叠上下文），Radix Dialog/Sheet 却 portal 到 body——toast 留在 #root 内会被
 * 弹窗整体盖住（曾现：设置弹窗内 toast 显示到下层图层）。挂到 body 后 z-index
 * 999999999 与弹窗（--z-dialog: 950）同级比较，永远置顶。
 */

function subscribeTheme(callback: () => void) {
	const observer = new MutationObserver(callback);
	observer.observe(document.documentElement, {
		attributes: true,
		attributeFilter: ["data-theme"],
	});
	return () => observer.disconnect();
}

function getThemeSnapshot(): "light" | "dark" {
	return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

/** 收纳条无新增时的自动淡出时长：它只是「刚刚刷屏」的余温提示，不该常驻抢视线。 */
const OVERFLOW_PILL_AUTO_DISMISS_MS = 5000;

/**
 * 收纳条（Notification Stack 薄层）：活跃 toast 超过 sonner 可见堆叠数时，
 * 被压在堆叠里的旧 toast 用户看不见也滚不到；此条显示「还有 N 条未展示」并提供通知历史面板入口。
 * 刻意不贴 toast 列（top-right）：sonner 的 OMISSION_HEIGHT 会把堆叠底部
 * 之下约 26px 划给「点击展开」热区，贴上去会和展开手势打架。
 * 数据源是 notice.ts 单点维护的活跃 id 集合，不查 sonner 内部状态。
 * 呈现是「一次性提示」：点击（已进历史面板，没必要再留）或 5s 无新增即淡出，
 * 只有新 toast 把溢出推得比上次更高时才重新出现。
 */
function NoticeOverflowPill() {
	const overflow = useSyncExternalStore(subscribeActiveNoticeCount, getActiveNoticeOverflow, getActiveNoticeOverflow);
	// 「已阅水位」= 上一次淡出/点击时的溢出数；差值才是需要提醒的新内容
	const [acknowledged, setAcknowledged] = useState(0);
	const pending = overflow - acknowledged;
	useEffect(() => {
		// 全部 toast 已消失：水位归零，下一波溢出重新提醒
		if (overflow <= 0) {
			setAcknowledged(0);
			return;
		}
		if (pending <= 0) return;
		const timer = window.setTimeout(() => setAcknowledged(overflow), OVERFLOW_PILL_AUTO_DISMISS_MS);
		return () => window.clearTimeout(timer);
	}, [overflow, pending]);
	if (pending <= 0) return null;
	return (
		<button
			type="button"
			onClick={() => {
				// 点开历史即视为已阅：面板里能看到全部条目，留个常驻提示只是噪音
				setAcknowledged(overflow);
				openNoticeHistoryDialog();
			}}
			title={t("notice.stackOverflowTitle")}
			style={{ zIndex: 999999998, WebkitAppRegion: "no-drag" } as React.CSSProperties}
			className="fixed bottom-4 right-4 inline-flex h-8 items-center gap-1.5 rounded-full border border-border-subtle bg-bg-panel px-3 text-xs font-medium text-text-secondary shadow-md transition-colors hover:text-text-primary"
		>
			<Inbox className="size-3.5 shrink-0" />
			{t("notice.stackOverflow", { count: String(pending) })}
		</button>
	);
}

export function Toaster() {
	const theme = useSyncExternalStore(subscribeTheme, getThemeSnapshot);
	// sonner 2.x 无 toast 时不渲染 DOM，notice.ts 无法靠 DOM 探测挂载态，
	// 挂载/卸载时显式回报，未挂载窗口期 showNotice 才走 DOM 兜底。
	useEffect(() => {
		setToasterReady(true);
		return () => setToasterReady(false);
	}, []);
	// 长文本「查看详情」弹窗宿主：挂在 Toaster 层（常驻），不随单条 toast 卸载；
	// 卡片点「查看详情」会先 dismiss toast，弹窗必须独立存活。
	const [details, setDetails] = useState<NoticeDetailsPayload | null>(null);
	useEffect(() => {
		setNoticeDetailsOpener(setDetails);
		return () => setNoticeDetailsOpener(null);
	}, []);
	// 禁掉 sonner 的拖动取消手势：桌面端用鼠标拖选 toast 文本复制时，
	// 快速拖动会被判定为 swipe（velocity > 0.11 / 位移超阈值即取消），
	// 表现为“想复制却把 toast 拖没了”，且 setPointerCapture 会干扰选区。
	// 在 document 捕获阶段拦掉 toast 非按钮区的 pointerdown，sonner 的
	// onPointerDown 收不到事件就不会进入 swipe 状态；关闭/操作/取消按钮
	// 走 click 事件不受影响，文本选区默认行为也保留（不 preventDefault）。
	useEffect(() => {
		const blockToastSwipe = (event: PointerEvent) => {
			const target = event.target;
			if (!(target instanceof Element)) return;
			// 按钮（复制/关闭/操作等）放行，保持点击可用；仅拦非按钮区的拖选手势
			if (target.closest("button")) return;
			if (target.closest("[data-sonner-toast]")) {
				event.stopImmediatePropagation();
			}
		};
		document.addEventListener("pointerdown", blockToastSwipe, true);
		return () => document.removeEventListener("pointerdown", blockToastSwipe, true);
	}, []);
	return createPortal(
		<>
			<SonnerToaster
				theme={theme}
				position="top-right"
				// 固定最大宽度避免超长会话标题把 toast 撑成横条；卡片内部的
				// min-w-0 + break-words 负责换行，超过可读高度再显示详情入口。
				// 420px 为桌面端右上角通知的可读上限，小窗口由 viewport 自动收缩。
				style={{ "--width": "min(420px, calc(100vw - 32px))" } as React.CSSProperties}
				gap={10}
				visibleToasts={VISIBLE_TOAST_COUNT}
				offset={{
					// 让开自定义标题栏拖拽区（--window-drag-height：frameless 下 32px，否则 0px）。
					// 首个 toast 若贴顶，左上角关闭按钮会落在 -webkit-app-region: drag 层里，
					// 点击被拖拽命中测试吞掉，表现为“点叉没反应”。
					top: "calc(var(--window-drag-height, 0px) + 12px)",
					right: "16px",
				}}
			/>
			<NoticeOverflowPill />
			<NoticeDetailsDialog
				payload={details}
				onOpenChange={(open) => {
					if (!open) setDetails(null);
				}}
			/>
		</>,
		document.body,
	);
}
