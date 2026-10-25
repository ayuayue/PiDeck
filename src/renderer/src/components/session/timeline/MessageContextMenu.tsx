/**
 * 时间线消息右键菜单视图。
 *
 * 坐标菜单模式（与 FileContextMenu / MarkdownLink 的文件链接菜单同款）：Radix DropdownMenu +
 * 钉在右键坐标上的不可见 fixed Trigger；视口碰撞翻转、焦点圈定、ESC 关闭全由 Radix 负责。
 * 只做呈现：菜单项由 planMessageContextMenuCopyKinds 决定（有选区只给「复制」，无选区才给
 * 「复制为文本 / 复制为 Markdown」，避免三个「复制」并列），动作回抛给 useMessageContextMenu 的 controller。
 */
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../../ui-shadcn/dropdown-menu";
import { t } from "../../../i18n";
import type { MessageContextMenuState } from "../../../hooks/useMessageContextMenu";
import { planMessageContextMenuCopyKinds, type MessageContextMenuCopyKind } from "./messageContextMenuPolicy";

/** 复制项文案：选区复制叫「复制」，整条消息按形态区分文本 / Markdown。 */
function copyItemLabel(kind: MessageContextMenuCopyKind): string {
	if (kind === "selection") return t("common.copy");
	if (kind === "messageMarkdown") return t("copy.asMarkdown");
	return t("copy.asText");
}

export function MessageContextMenu(props: { state: MessageContextMenuState | null; onCopy: (kind: MessageContextMenuCopyKind) => void; onSelectAll: () => void; onFavorite: (kind: "message" | "selection") => void; onClose: () => void }) {
	const state = props.state;
	if (!state) return null;
	const copyKinds = planMessageContextMenuCopyKinds(state);
	return (
		<DropdownMenu
			// 坐标变化即重挂：同一会话内二次右键要按新坐标重新定位，复用旧锚点会把菜单留在上一处。
			key={`${state.x}:${state.y}`}
			open
			onOpenChange={(open) => {
				if (!open) props.onClose();
			}}
		>
			{/* 不可见 Trigger 钉在右键坐标上：Radix dropdown-menu 没有 Anchor 部件，
			    受控 open 下仍按 Trigger 矩形定位（官方推荐的坐标菜单模式）。 */}
			<DropdownMenuTrigger
				aria-hidden
				tabIndex={-1}
				style={{
					position: "fixed",
					left: state.x,
					top: state.y,
					width: 0,
					height: 0,
					padding: 0,
					border: 0,
					background: "transparent",
					pointerEvents: "none",
				}}
			/>
			{/* onCloseAutoFocus preventDefault：关闭时不把焦点抢回不可见 Trigger——
			    复制完用户往往还要继续划选 / 滚动，焦点跳走会顺手收掉选区。 */}
			<DropdownMenuContent align="start" side="bottom" className="min-w-40" onCloseAutoFocus={(event) => event.preventDefault()}>
				{/* 复制项互斥：有选区只渲染「复制」，无选区才渲染整条消息的文本 / Markdown 形态
				    （见 planMessageContextMenuCopyKinds 的「三个复制」注释）。 */}
				{copyKinds.map((kind) => (
					<DropdownMenuItem key={kind} onSelect={() => props.onCopy(kind)}>
						{copyItemLabel(kind)}
					</DropdownMenuItem>
				))}
				{/* 收藏与复制同源、措辞分开：选区叫「收藏所选」，整条消息按角色区分回复/消息。
				    与复制项之间加分隔线，避免菜单读起来像一排同义动作。 */}
				{copyKinds.length > 0 && (state.selectionText || state.messageText || state.liveText) ? <DropdownMenuSeparator /> : null}
				{state.selectionText && <DropdownMenuItem onSelect={() => props.onFavorite("selection")}>{t("favorites.saveSelection")}</DropdownMenuItem>}
				{(state.messageText || state.liveText) && (
					<DropdownMenuItem onSelect={() => props.onFavorite("message")}>
						{/* 已收藏态取反：同一条消息只保留一条收藏，菜单项直接提供「取消收藏」。 */}
						{state.messageRole === "user" ? (state.messageFavorited ? t("favorites.unsaveUserMessage") : t("favorites.saveUserMessage")) : state.messageFavorited ? t("favorites.unsaveMessage") : t("favorites.saveMessage")}
					</DropdownMenuItem>
				)}
				{state.canSelectAll && copyKinds.length > 0 && <DropdownMenuSeparator />}
				{state.canSelectAll && <DropdownMenuItem onSelect={props.onSelectAll}>{t("common.selectAll")}</DropdownMenuItem>}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
