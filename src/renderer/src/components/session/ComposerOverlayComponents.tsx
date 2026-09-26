import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { FileTreeNode, ProjectFileTarget } from "../../../../shared/types";
import { t } from "../../i18n";
import type { SuggestionItem } from "../app/AppUtils";
import { Button } from "../ui-shadcn/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../ui-shadcn/dropdown-menu";
export function PromptSuggestions(props: {
	prompt: string;
	items: SuggestionItem[];
	selectedIndex: number;
	onSelectedIndexChange: (index: number) => void;
	onClose: () => void;
	onPick: (item: SuggestionItem) => void;
	/** 菜单锚定位置（屏幕坐标）。由 controller 统一计算（含无坐标时的居中兜底），
	 *  定位只用 left/top/bottom，transform 不参与定位——入场动画只动 opacity/translateY，
	 *  与锚点模式天然解耦，不会出现动画期间横跳。 */
	anchorStyle?: React.CSSProperties;
}) {
	const listRef = useRef<HTMLDivElement>(null);
	// 头部标题类型由选中项推导:光标相关触发后,第一个候选的 value 前缀即代表当前是命令还是文件。
	const isCommand = props.items[0]?.value.startsWith("/") ?? false;
	const isSession = props.items[0]?.value.startsWith("&") ?? false;
	const headerLabel = isCommand ? t("prompt.commands") : isSession ? t("prompt.sessions") : t("prompt.files");

	// 滚动到选中项
	useEffect(() => {
		const list = listRef.current;
		if (!list) return;
		const item = list.children[props.selectedIndex] as HTMLElement;
		if (item) {
			item.scrollIntoView({ block: "nearest" });
		}
	}, [props.selectedIndex]);

	if (props.items.length === 0) return null;

	// 阻止 mousedown 冒泡到 RichInput，避免点击面板时触发 blur 关闭面板，
	// 但保留各按钮的 onClick 正常工作。
	return (
		<div className="fixed z-[100] flex w-[min(520px,calc(100vw-120px))] max-h-[380px] animate-in flex-col overflow-hidden rounded-lg border border-border-subtle bg-bg-panel shadow-[var(--shadow-popover)] fade-in-0 slide-in-from-bottom-2 duration-150" style={props.anchorStyle} onMouseDown={(e) => e.preventDefault()}>
			<div className="flex items-center justify-between border-b border-border-subtle px-[14px] py-[10px] text-caption font-medium text-text-secondary">
				<span>{headerLabel}</span>
				<Button variant="ghost" size="icon" className="h-6 w-6 text-text-tertiary hover:bg-bg-hover hover:text-text-secondary" aria-label={t("common.close")} title={t("common.close")} onClick={props.onClose}>
					<X size={16} strokeWidth={2.2} aria-hidden="true" />
				</Button>
			</div>
			<div className="flex-1 overflow-y-auto p-1.5" ref={listRef}>
				{props.items.map((item, index) => (
					<button key={item.key} className={`flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors${index === props.selectedIndex ? " bg-accent-soft" : " hover:bg-bg-active"}`} onMouseEnter={() => props.onSelectedIndexChange(index)} onClick={() => props.onPick(item)}>
						{/* label 优先完整显示（文件名/命令名/会话名），description 只作父目录等辅助信息：
							之前 description 放完整相对路径会挤占宽度、长路径被截断只剩开头目录，
							看不出是哪个文件；改为 label flex-1 吃满剩余空间，description 限宽截断。 */}
						<span className="min-w-0 flex-1 truncate font-mono text-control font-semibold text-text-primary" title={item.label}>
							{item.label}
						</span>
						<span className="max-w-[40%] flex-none truncate text-caption text-text-secondary" title={item.description}>
							{item.description}
						</span>
					</button>
				))}
			</div>
			<div className="flex gap-4 border-t border-border-subtle px-[14px] py-2 text-micro text-text-tertiary">
				<span>{t("prompt.selectHint")}</span>
				<span>{t("prompt.confirmHint")}</span>
				<span>{t("prompt.closeHint")}</span>
			</div>
		</div>
	);
}

export function FileContextMenu(props: {
	menu: { x: number; y: number; node: FileTreeNode };
	onClose: () => void;
	onOpen: () => void;
	onReveal: () => void;
	onAttach: () => void;
	onCopyPath: () => void;
	onDelete?: () => void;
	onRename?: () => void;
	/** 剪贴板中有文件路径时显示「粘贴」选项 */
	hasClipboardFiles?: boolean;
	onPaste?: (targetDir: string | ProjectFileTarget) => void;
}) {
	const node = props.menu.node;
	const parentRelativePath = node.type === "directory" ? node.relativePath : node.relativePath.split("/").slice(0, -1).join("/");
	const targetDir: string | ProjectFileTarget | undefined = node.target ? { projectId: node.target.projectId, relativePath: parentRelativePath } : node.path ? (node.type === "directory" ? node.path : node.path.split(/[\\/]/).slice(0, -1).join("/") || ".") : undefined;

	// #115 U5：右键菜单换 Radix DropdownMenu。虚拟锚点把菜单钉在右键坐标上，
	// 视口碰撞翻转/焦点圈定/ESC 关闭全由 Radix 负责，删掉手写的测高翻转与遮罩。
	return (
		<DropdownMenu
			open
			onOpenChange={(open) => {
				if (!open) props.onClose();
			}}
		>
			{/* 不可见 Trigger 钉在右键坐标上：Radix dropdown-menu 没有 Anchor 部件，
			    受控 open 下仍按 Trigger 矩形定位，这是官方推荐的坐标菜单模式。 */}
			<DropdownMenuTrigger
				aria-hidden
				tabIndex={-1}
				style={{
					position: "fixed",
					left: props.menu.x,
					top: props.menu.y,
					width: 0,
					height: 0,
					padding: 0,
					border: 0,
					background: "transparent",
					pointerEvents: "none",
				}}
			/>
			<DropdownMenuContent align="start" side="bottom" className="min-w-40">
				{/* 目录同样可引用：拖拽落点与 @ 建议列表都允许目录，右键菜单不应更严。
				    引用文本由 fileNodeDragPayloadToRef 统一补尾斜杠（@dir/），
				    裸 @dir 过不了 chip 路径规则，模型也容易当成 mention。 */}
				<DropdownMenuItem onSelect={props.onAttach}>{t("menu.attachFile")}</DropdownMenuItem>
				{/* 目录也用系统默认程序打开：目录的默认处理器就是文件管理器
				    （Windows Explorer / macOS Finder / Linux xdg），与「在文件夹中显示」不冲突——
				    后者定位到父目录并选中该项。 */}
				<DropdownMenuItem onSelect={props.onOpen}>{t("menu.defaultOpen")}</DropdownMenuItem>
				<DropdownMenuItem onSelect={props.onReveal}>{t("menu.revealFile")}</DropdownMenuItem>
				<DropdownMenuItem onSelect={props.onCopyPath}>{t("menu.copyPath")}</DropdownMenuItem>
				{props.hasClipboardFiles && props.onPaste && targetDir && <DropdownMenuItem onSelect={() => props.onPaste?.(targetDir)}>{t("drawer.pasteFiles")}</DropdownMenuItem>}
				{(props.onRename || props.onDelete) && <DropdownMenuSeparator />}
				{props.onRename && <DropdownMenuItem onSelect={props.onRename}>{t("common.rename")}</DropdownMenuItem>}
				{props.onDelete && (
					<DropdownMenuItem variant="destructive" onSelect={props.onDelete}>
						{t("common.delete")}
					</DropdownMenuItem>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
