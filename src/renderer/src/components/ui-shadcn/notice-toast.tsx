import { ArrowRight, Bell, Check, CircleAlert, Copy, Info, TriangleAlert, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { t } from "../../i18n";
import type { NoticeActions } from "../../utils/notice";

/**
 * 全局 toast 的自定义卡片（替代 sonner 内置 title/description/action 布局）。
 *
 * 背景：sonner 内置结构把 [图标][正文][cancel][action][关闭] 全塞在一条 flex 行里，
 * 长文案 + 双按钮时会挤成一团，且 action/cancel 按钮用的是 sonner 默认黑底小按钮，
 * 与应用 token 完全脱节。这里改为一张自绘卡片：图标 + 标题/正文 + 复制/关闭 + 按钮行，
 * 视觉与弹窗/抽屉同一套 token，类型语义只体现在图标色（沿用 surfaces.css 约定）。
 */

/** 状态图标与颜色：中性卡片 + 彩色图标（与旧 surfaces.css 的图标色约定一致）。 */
const KIND_ICON = {
	neutral: { Icon: Bell, className: "text-text-tertiary" },
	info: { Icon: Info, className: "text-info" },
	warning: { Icon: TriangleAlert, className: "text-warning" },
	error: { Icon: CircleAlert, className: "text-danger" },
} as const;

export type NoticeToastKind = keyof typeof KIND_ICON;

/**
 * 写剪贴板：优先异步 Clipboard API；Electron 窗口失焦 / 权限受限时会抛异常，
 * 降级到隐藏 textarea + execCommand('copy')（需要真实 DOM 选区）。
 */
export async function writeClipboardText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		try {
			const ta = document.createElement("textarea");
			ta.value = text;
			ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
			document.body.appendChild(ta);
			ta.select();
			const ok = document.execCommand("copy");
			ta.remove();
			return ok;
		} catch {
			return false;
		}
	}
}

export function NoticeToastCard({
	toastId,
	kind,
	title,
	description,
	actions,
}: {
	toastId: string | number;
	kind: NoticeToastKind;
	title: string;
	description?: string;
	actions?: NoticeActions;
}) {
	const [copied, setCopied] = useState(false);
	const copiedTimer = useRef<number | null>(null);
	const { Icon, className: iconColor } = KIND_ICON[kind];

	// 复制的完整文本：有标题时「标题 + 换行 + 正文」，无标题时仅正文
	const copyText = description ? `${title}\n${description}` : title;

	const handleCopy = useCallback(async () => {
		const ok = await writeClipboardText(copyText);
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
				<p className="text-[13px] font-medium leading-5 break-words text-text-primary">{title}</p>
				{description ? <p className="mt-0.5 text-xs leading-4 break-words text-text-secondary">{description}</p> : null}
				{hasActions ? (
					<div className="mt-2 flex items-center justify-end gap-2">
						{actions?.cancel ? (
							<button
								type="button"
								onClick={() => runAction(actions.cancel?.onClick)}
								className="inline-flex h-7 items-center rounded-md border border-border-subtle bg-bg-muted px-2.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
							>
								{actions.cancel.label}
							</button>
						) : null}
						{actions?.action ? (
							<button
								type="button"
								onClick={() => runAction(actions.action?.onClick)}
								className="inline-flex h-7 items-center gap-1 rounded-md bg-primary pl-2.5 pr-2 text-xs font-medium text-primary-foreground transition-colors hover:opacity-90"
							>
								{actions.action.label}
								{/* 箭头强化「前往/跳转」语义，让长标题 toast 里的操作一眼可识别 */}
								<ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
							</button>
						) : null}
					</div>
				) : null}
			</div>

			<div className="flex shrink-0 items-center gap-0.5">
				<button
					type="button"
					onClick={handleCopy}
					aria-label={copied ? t("copy.success") : t("common.copy")}
					title={copied ? t("copy.success") : t("common.copy")}
					className="inline-flex h-6 w-6 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary"
				>
					{copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
				</button>
				<button
					type="button"
					onClick={closeToast}
					aria-label={t("common.close")}
					title={t("common.close")}
					className="inline-flex h-6 w-6 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary"
				>
					<X className="h-3.5 w-3.5" />
				</button>
			</div>
		</div>
	);
}
