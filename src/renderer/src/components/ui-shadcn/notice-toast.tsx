import { ArrowRight, Bell, Check, CircleAlert, Copy, Info, MessageCircleQuestion, TriangleAlert, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { t } from "../../i18n";
import { writeClipboard } from "../../utils/clipboard";
import type { NoticeActions } from "../../utils/notice";

/**
 * 全局 toast 的自定义卡片（替代 sonner 内置 title/description/action 布局）。
 *
 * 背景：sonner 内置结构把 [图标][正文][cancel][action][关闭] 全塞在一条 flex 行里，
 * 长文案 + 双按钮时会挤成一团，且 action/cancel 按钮用的是 sonner 默认黑底小按钮，
 * 与应用 token 完全脱节。这里改为一张自绘卡片：图标 + 标题/正文 + 复制/关闭 + 按钮行，
 * 视觉与弹窗/抽屉同一套 token，类型语义只体现在图标色（沿用 surfaces.css 约定）。
 */

/** 状态图标与颜色（卡片与详情弹窗共用，后者见 ./notice-details-dialog）：中性卡片 + 彩色图标。
 *
 * `question` 是 Ask（等待回答）专用档：语义是「等你操作」而非「出错」，因此不能用
 * warning 的黄三角（用户会误读成失败/异常），改用问号气泡图标 + 身份色（--color-tool，
 * 与会话内 ask 工具卡同色）；文案也自带「等待你的回答」。
 */
export const KIND_ICON = {
	neutral: { Icon: Bell, className: "text-text-tertiary" },
	info: { Icon: Info, className: "text-info" },
	warning: { Icon: TriangleAlert, className: "text-warning" },
	error: { Icon: CircleAlert, className: "text-danger" },
	// 与会话内 ask 工具卡同色（--color-tool，默认=info 蓝，可由皮肤覆盖）；
	// 注意 Tailwind 的 --color-accent 是「面」色，此处不能写 text-accent
	question: { Icon: MessageCircleQuestion, className: "text-[var(--color-tool)]" },
} as const;

export type NoticeToastKind = keyof typeof KIND_ICON;

// ── 长文本「查看详情」弹窗 ──────────────────────────────────────────
// toast 卡片对超长标题/正文做截断（max-height + overflow-hidden），截断时提供
// 「查看详情」入口。详情弹窗不能挂在 toast 卡片内部：点详情会先 dismiss toast
// （toast z-index 远高于 dialog，卡片留在原地会浮在遮罩上方），卡片卸载会连带
// 卸载弹窗。因此弹窗状态提升到 Toaster 常驻层，卡片只通过 opener 回调触发。
// 弹窗本体在 ./notice-details-dialog（分文件的原因见该文件头注释：避免与 markdown 链成环）。

/** 详情弹窗载荷：完整标题与正文（未截断）。 */
export type NoticeDetailsPayload = {
	title: string;
	description?: string;
	kind: NoticeToastKind;
};

let noticeDetailsOpener: ((payload: NoticeDetailsPayload) => void) | null = null;

/** Toaster 挂载时注册弹窗宿主；卸载时注销，避免持有失效 setState。 */
export function setNoticeDetailsOpener(opener: ((payload: NoticeDetailsPayload) => void) | null) {
	noticeDetailsOpener = opener;
}

/** 打开长文本详情弹窗（由 NoticeToastCard 的「查看详情」按钮调用）。 */
export function openNoticeDetails(payload: NoticeDetailsPayload) {
	noticeDetailsOpener?.(payload);
}

export function NoticeToastCard({ toastId, kind, title, description, actions }: { toastId: string | number; kind: NoticeToastKind; title: string; description?: string; actions?: NoticeActions }) {
	const [copied, setCopied] = useState(false);
	const copiedTimer = useRef<number | null>(null);
	const { Icon, className: iconColor } = KIND_ICON[kind];

	// 长文本截断：标题最多 3 行（leading-5 → 60px）、正文最多 4 行（leading-4 → 64px）。
	// 用 scrollHeight > clientHeight 检测溢出（纯 overflow-hidden 方案检测可靠，
	// line-clamp 布局下 scrollHeight 不可靠），溢出时展示「查看详情」入口。
	const titleRef = useRef<HTMLParagraphElement>(null);
	const descriptionRef = useRef<HTMLParagraphElement>(null);
	const [truncated, setTruncated] = useState(false);
	useLayoutEffect(() => {
		const isClipped = (el: HTMLElement | null) => el !== null && el.scrollHeight > el.clientHeight + 1;
		setTruncated(isClipped(titleRef.current) || isClipped(descriptionRef.current));
	}, [title, description]);

	const openDetails = useCallback(() => {
		// 先关 toast 再开弹窗：toast z-index 高于 dialog，留着会浮在遮罩上方
		openNoticeDetails({ title, description, kind });
		toast.dismiss(toastId);
	}, [toastId, title, description, kind]);

	// 复制的完整文本：有标题时「标题 + 换行 + 正文」，无标题时仅正文（与详情弹窗一致，复制不截断）
	const copyText = description ? `${title}\n${description}` : title;

	const handleCopy = useCallback(async () => {
		// 走 utils/clipboard 的 writeClipboard（Electron 主进程优先）：不依赖 document focus，
		// 否则窗口失焦时 Web Clipboard API 会抛 "Document is not focused" 而静默复制失败
		const ok = await writeClipboard(copyText);
		if (!ok) return;
		setCopied(true);
		if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
		// 短暂切换成「已复制」勾号后还原，避免常驻状态
		copiedTimer.current = window.setTimeout(() => setCopied(false), 1600);
	}, [copyText]);

	// 卸载时清掉复制反馈定时器，防止已销毁卡片回写 state
	useEffect(
		() => () => {
			if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
		},
		[],
	);

	const closeToast = useCallback(() => toast.dismiss(toastId), [toastId]);

	// 操作按钮点击后收起 toast：与 sonner 原「action/cancel 点击即关闭」语义一致
	const runAction = useCallback(
		(handler?: () => void) => {
			handler?.();
			toast.dismiss(toastId);
		},
		[toastId],
	);

	const hasActions = Boolean(actions?.action || actions?.cancel);

	return (
		<div className="flex w-full items-start gap-3 rounded-lg border border-border-subtle bg-bg-panel p-3.5 shadow-[var(--shadow-popover)] select-text">
			<span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-bg-muted ${iconColor}`}>
				<Icon className="h-3.5 w-3.5" />
			</span>

			<div className="min-w-0 flex-1">
				<p ref={titleRef} className="max-h-[60px] overflow-hidden text-[13px] font-medium leading-5 break-words text-text-primary">
					{title}
				</p>
				{description ? (
					<p ref={descriptionRef} className="mt-0.5 max-h-[64px] overflow-hidden text-xs leading-4 break-words text-text-secondary">
						{description}
					</p>
				) : null}
				{truncated ? (
					// 截断兜底入口：完整内容进详情弹窗（复制按钮始终复制全文，不受截断影响）
					<button type="button" onClick={openDetails} className="mt-1 text-xs text-info underline-offset-2 transition-colors hover:underline">
						{t("notice.viewDetails")}
					</button>
				) : null}
				{hasActions ? (
					<div className="mt-2 flex items-center justify-end gap-2">
						{actions?.cancel ? (
							<button type="button" onClick={() => runAction(actions.cancel?.onClick)} className="inline-flex h-7 items-center rounded-md border border-border-subtle bg-bg-muted px-2.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary">
								{actions.cancel.label}
							</button>
						) : null}
						{actions?.action ? (
							<button type="button" onClick={() => runAction(actions.action?.onClick)} className="inline-flex h-7 items-center gap-1 rounded-md bg-primary pl-2.5 pr-2 text-xs font-medium text-primary-foreground transition-colors hover:opacity-90">
								{actions.action.label}
								{/* 箭头强化「前往/跳转」语义，让长标题 toast 里的操作一眼可识别 */}
								<ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
							</button>
						) : null}
					</div>
				) : null}
			</div>

			<div className="flex shrink-0 items-center gap-0.5">
				<button type="button" onClick={handleCopy} aria-label={copied ? t("copy.success") : t("common.copy")} title={copied ? t("copy.success") : t("common.copy")} className="inline-flex h-6 w-6 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary">
					{copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
				</button>
				<button type="button" onClick={closeToast} aria-label={t("common.close")} title={t("common.close")} className="inline-flex h-6 w-6 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary">
					<X className="h-3.5 w-3.5" />
				</button>
			</div>
		</div>
	);
}
