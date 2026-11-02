import type { FileTreeNode } from "../../../../shared/types";
import { useMenuFocusReturn } from "../../hooks/useMenuFocusReturn";
import { t } from "../../i18n";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../ui-shadcn/dropdown-menu";

/**
 * 远端文件树的行右键菜单（从 RemoteProjectPanel 抽出，面板必须守住 440 行单文件红线）。
 *
 * 与本地文件树同一种交互：坐标由行组件交出来，这里只负责把菜单钉在坐标上。
 * 实现与本地树的 FileContextMenu 一致——Radix DropdownMenu + 不可见 Trigger：
 * 键盘圈定、ESC 关闭、方向键换项、视口碰撞翻转都由 Radix 负责。
 *
 * 2027-01 之前这里是手写浮层（`role="menu"` + 三个原生 button + 自己监听 mousedown/keydown），
 * 代价是 `role="menuitem"` 只有名字没有行为：打开后焦点不进菜单、方向键不动、Tab 会跑到
 * 菜单背后的页面、键盘焦点看不见、ESC 后焦点掉到 body。Radix 把这几件事一次补齐。
 */
export function RemoteProjectRowMenu(props: { menu: { node: FileTreeNode; x: number; y: number }; busy: boolean; onClose: () => void; onDownload: () => void; onRename: () => void; onDelete: () => void }) {
	const isFile = props.menu.node.type === "file";
	const handleCloseAutoFocus = useMenuFocusReturn();
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
			<DropdownMenuContent align="start" side="bottom" className="min-w-40" data-testid="remote-file-row-menu" onCloseAutoFocus={handleCloseAutoFocus}>
				{isFile ? (
					<DropdownMenuItem data-testid="remote-file-row-download" disabled={props.busy} onSelect={props.onDownload}>
						{t("remoteFileEntry.downloadAction")}
					</DropdownMenuItem>
				) : null}
				{/* 分隔线放在改名/删除这一组之前，与本地文件树菜单（ComposerOverlayComponents.FileContextMenu）同构 */}
				<DropdownMenuSeparator />
				<DropdownMenuItem data-testid="remote-file-row-rename" disabled={props.busy} onSelect={props.onRename}>
					{t("remoteFileEntry.renameAction")}
				</DropdownMenuItem>
				<DropdownMenuItem variant="destructive" data-testid="remote-file-row-delete" disabled={props.busy} onSelect={props.onDelete}>
					{t("remoteFileEntry.deleteAction")}
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
