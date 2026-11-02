import { useLayoutEffect, useRef, useState } from "react";
import type { WorkbenchEditorTabItem } from "../session/SessionTabsBar";
import { X } from "lucide-react";
import { t } from "../../i18n";
import { cn } from "../../lib/utils";
import { TAB_CLOSE_BUTTON_CLASS } from "../../utils/tabCloseButton";

/**
 * 简洁模式的内容区文件 Tab 条（会话栏在简洁模式下不挂 editorTabs，由这里承载）。
 *
 * 标题与关闭钮共用圆角底色，但语义上必须同级，避免 role="tab" 隐藏内部按钮的读屏语义。
 * 只截断标题，不裁切容器，给预览文件名的斜体墨迹留出余量。
 */
export function WorkbenchFileTabs(props: { tabs: readonly WorkbenchEditorTabItem[]; onSelect: (id: string) => void; onClose: (id: string) => void; onPromote: (id: string) => void }) {
	const listRef = useRef<HTMLDivElement>(null);
	const focusedRef = useRef<{ element: HTMLElement; index: number } | null>(null);
	const [focusedId, setFocusedId] = useState<string>();
	const entryId = props.tabs.find((tab) => tab.id === focusedId)?.id ?? props.tabs.find((tab) => tab.active)?.id ?? props.tabs[0]?.id;

	useLayoutEffect(() => {
		const previous = focusedRef.current;
		const list = listRef.current;
		if (!previous || !list || previous.element.isConnected) return;
		focusedRef.current = null;
		// Dirty-close confirmation may still own focus; only recover focus lost with a removed node.
		if (list.ownerDocument.activeElement !== list.ownerDocument.body) return;
		const tabs = list.querySelectorAll<HTMLElement>('[role="tab"]');
		const next = props.tabs.findIndex((tab) => tab.active);
		tabs[next >= 0 ? next : Math.min(previous.index, tabs.length - 1)]?.focus();
	}, [props.tabs]);

	return (
		<div
			ref={listRef}
			role="tablist"
			aria-label={t("app.files")}
			className="simple-file-tabs flex h-12 min-h-12 shrink-0 items-center gap-1 overflow-x-auto border-b border-border/40 px-2"
			onBlurCapture={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget) && focusedRef.current?.element.isConnected) {
					focusedRef.current = null;
					setFocusedId(undefined);
				}
			}}
		>
			{props.tabs.map((tab, index) => (
				<div
					key={tab.id}
					role="presentation"
					className={cn(
						"group relative flex h-7 w-fit max-w-64 shrink-0 cursor-pointer select-none items-center gap-2 rounded-md px-2 text-xs has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring",
						tab.active ? "bg-bg-active font-medium text-text-primary" : "text-muted-foreground hover:bg-accent-soft hover:text-foreground",
						tab.preview && "italic",
					)}
					onClick={() => props.onSelect(tab.id)}
					onDoubleClick={() => props.onPromote(tab.id)}
					onFocus={(event) => {
						focusedRef.current = { element: event.target, index };
						setFocusedId(tab.id);
						event.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest" });
					}}
				>
					<div
						role="tab"
						aria-selected={tab.active === true}
						// 无障碍名用短 label（不是完整路径 title）：e2e 与读屏都按「hello.ts」这种文件名定位
						aria-label={tab.label}
						title={tab.title}
						tabIndex={tab.id === entryId ? 0 : -1}
						className="flex h-full min-w-0 flex-1 items-center rounded-sm outline-none"
						onKeyDown={(event) => {
							if (event.target !== event.currentTarget || event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
							const count = props.tabs.length;
							const nextIndex = event.key === "ArrowRight" ? (index + 1) % count : event.key === "ArrowLeft" ? (index + count - 1) % count : event.key === "Home" ? 0 : event.key === "End" ? count - 1 : -1;
							if (nextIndex >= 0) {
								event.preventDefault();
								listRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')[nextIndex]?.focus();
							} else if (event.key === "Enter" || event.key === " ") {
								event.preventDefault();
								props.onSelect(tab.id);
							} else if (event.key === "Delete") {
								event.preventDefault();
								props.onClose(tab.id);
							}
						}}
					>
						{/* pr-0.5：给斜体向右倾斜的墨迹留出余地，避免尾部字符被自己的 truncate 剪掉 */}
						<span className="min-w-0 flex-1 truncate pr-0.5">{tab.label}</span>
					</div>
					<button
						type="button"
						tabIndex={tab.id === entryId ? 0 : -1}
						aria-label={`${t("tabs.close")} ${tab.label}`}
						title={t("tabs.close")}
						className={cn(TAB_CLOSE_BUTTON_CLASS, "focus-visible:opacity-100 focus-visible:outline-none", tab.active || tab.id === entryId ? "opacity-70 hover:opacity-100" : "opacity-0 group-hover:opacity-70")}
						onDoubleClick={(event) => event.stopPropagation()}
						onClick={(event) => {
							event.stopPropagation();
							props.onClose(tab.id);
						}}
					>
						<X className="size-3" />
					</button>
				</div>
			))}
		</div>
	);
}
