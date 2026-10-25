/**
 * WebBottomSheet — Web 端响应式弹层（跨端基石组件）。
 *
 * 交互范式对齐主流移动 AI 应用：
 * - 窄屏（<sm）：从底部滑出的半屏面板（顶部拖拽把手 + 大触控行），拇指可达
 * - 宽屏（sm+）：居中卡片（同内容零改动，自动降级为桌面 dialog 观感）
 *
 * 实现约束：
 * - 零新依赖：不引 vaul/radix，fixed 层 + tw-animate-css（animate-in/slide-in-from-bottom）
 * - Escape 关闭、遮罩点击关闭；挂 body 渲染避免被父级 overflow 裁剪
 * - 未来 UWP(WebView2)/Capacitor 手机壳直接复用：同一组件两形态
 */
import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

export function WebBottomSheet(props: { open: boolean; onOpenChange: (open: boolean) => void /** 面板标题（可访问性 + 宽屏卡片头）；窄屏隐藏由样式控制 */; title?: string; children: ReactNode /** 面板附加类（如 max-w）；两形态都生效 */; className?: string }) {
	const { open, onOpenChange } = props;

	// Escape 关闭 + 打开时锁背景滚动（移动端弹层惯例，关闭即恢复）
	useEffect(() => {
		if (!open) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") onOpenChange(false);
		};
		document.addEventListener("keydown", onKey);
		const previousOverflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		return () => {
			document.removeEventListener("keydown", onKey);
			document.body.style.overflow = previousOverflow;
		};
	}, [open, onOpenChange]);

	if (!open) return null;

	// 挂 body：弹层若渲染在带 transform/overflow 裁剪的祖先内（如移动端侧栏 drawer
	// 的滑入 transform 会把 fixed 的包含块限到 drawer），fixed inset-0 将铺不满视口
	// 且被裁剪；portal 到 body 保证两形态都相对视口定位。
	return createPortal(
		<div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:justify-center" role="dialog" aria-modal="true" aria-label={props.title}>
			{/* 遮罩：点击关闭；进场 fade */}
			<button type="button" aria-label={t("common.close")} className="absolute inset-0 h-full w-full cursor-default bg-black/50 animate-in fade-in duration-150" onClick={() => onOpenChange(false)} />
			<div
				className={cn(
					"relative flex max-h-[85dvh] w-full min-w-0 flex-col overflow-hidden border border-border bg-card text-card-foreground shadow-xl",
					// 窄屏：底部滑出圆角顶；宽屏：居中卡片
					"rounded-t-2xl sm:mb-0 sm:max-w-md sm:rounded-2xl",
					// 进场：窄屏上滑、宽屏缩放淡入
					"animate-in slide-in-from-bottom duration-200 sm:slide-in-from-bottom-0 sm:zoom-in-95",
					props.className,
				)}
			>
				{/* 窄屏拖拽把手（宽屏隐藏）；标题行两形态共用 */}
				<div className="flex shrink-0 flex-col gap-1 pt-2">
					<span className="mx-auto h-1 w-10 shrink-0 rounded-full bg-muted-foreground/30 sm:hidden" aria-hidden="true" />
					{props.title ? (
						<div className="flex items-center justify-between gap-2 px-4 pt-2 pb-1">
							<span className="min-w-0 truncate text-sm font-semibold text-foreground">{props.title}</span>
							<button type="button" aria-label={t("common.close")} className="shrink-0 rounded-full p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground pointer-coarse:p-2.5" onClick={() => onOpenChange(false)}>
								<X className="size-4" aria-hidden="true" />
							</button>
						</div>
					) : null}
				</div>
				{/* 内容区可滚动；大触控目标由内容行自带（h-12 行） */}
				<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{props.children}</div>
			</div>
		</div>,
		document.body,
	);
}
