import type { WorkbenchEditorTabItem } from "../session/SessionTabsBar";
import { X } from "lucide-react";
import { t } from "../../i18n";
import { cn } from "../../lib/utils";
import { TAB_CLOSE_BUTTON_CLASS } from "../../utils/tabCloseButton";

/**
 * 简洁模式的内容区文件 Tab 条（会话栏在简洁模式下不挂 editorTabs，由这里承载）。
 *
 * 关闭按钮必须画在 Tab 自身内部：旧实现把 X 作为 Tab 按钮的兄弟节点排在右侧，
 * 视觉上会落在 Tab 的圆角底色之外，看上去像「另一个按钮」而不是这个 Tab 的关闭位。
 * 这里与 SessionTabsBar 的 EditorWorkbenchTab / SessionTab 保持同一套结构：
 * 圆角底色的容器 + 内部（标题 + 关闭 X），hover 才显出 X。
 */
export function WorkbenchFileTabs(props: { tabs: readonly WorkbenchEditorTabItem[]; onSelect: (id: string) => void; onClose: (id: string) => void; onPromote: (id: string) => void }) {
	return (
		<div role="tablist" aria-label={t("app.files")} className="simple-file-tabs flex h-12 min-h-12 shrink-0 items-center gap-1 overflow-x-auto border-b border-border/40 px-2">
			{props.tabs.map((tab) => (
				<div
					key={tab.id}
					role="tab"
					aria-selected={tab.active}
					// 无障碍名用短 label（不是完整路径 title）：e2e 与读屏都按「hello.ts」这种文件名定位
					aria-label={tab.label}
					title={tab.title}
					tabIndex={0}
					className={cn(
						// 结构按 VS Code / Chrome 的 tab 栏标准：标题是「可截断的 flex 项」，关闭钮是
						// 「不收缩的独立槽位」，二者之间靠 gap 固定隔开；标题 flex-1 + min-w-0 才能
						// 拿到确定宽度、把省略号画在自己盒子的右缘。
						//
						// 容器绝不能加 overflow-hidden（实测回归）：预览 tab 是斜体，最后字符的墨迹会
						// 超出文本布局盒（scrollWidth == clientWidth，布局上不算溢出），overflow-hidden
						// 会把它直接剪掉——文件名尾部字符凭空消失（如 `...manual.ma` 少了 d），
						// 看起来就像「被挡掉了」。只让标题 span 自己承载 truncate。
						"group relative flex h-7 w-fit max-w-64 shrink-0 cursor-pointer select-none items-center gap-2 rounded-md px-2 text-xs",
						tab.active ? "bg-bg-active font-medium text-text-primary" : "text-muted-foreground hover:bg-accent-soft hover:text-foreground",
						tab.preview && "italic",
					)}
					onClick={() => props.onSelect(tab.id)}
					onDoubleClick={() => props.onPromote(tab.id)}
					onKeyDown={(event) => {
						if (event.key === "Enter" || event.key === " ") {
							event.preventDefault();
							props.onSelect(tab.id);
						}
					}}
				>
					{/* pr-0.5：给斜体向右倾斜的墨迹留出余地，避免尾部字符被自己的 truncate 剪掉 */}
					<span className="min-w-0 flex-1 truncate pr-0.5">{tab.label}</span>
					<button
						type="button"
						role="tab-close"
						aria-label={`${t("tabs.close")} ${tab.label}`}
						title={t("tabs.close")}
						className={cn(TAB_CLOSE_BUTTON_CLASS, tab.active ? "opacity-70 hover:opacity-100" : "opacity-0 group-hover:opacity-70")}
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
