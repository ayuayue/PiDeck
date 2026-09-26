import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "./alert-dialog";
import { t } from "../../i18n";
import { BridgeGuiSlot, useBridgeSessionId } from "../bridge/BridgeSlot";

/**
 * 全站统一的确认弹框（UI 2.0 / issue #115）：基于 shadcn AlertDialog，
 * 替代此前散落在 config-modal 体系里的两套同构实现。
 * 危险操作（删除/丢弃/重置）传 danger，按钮使用 destructive 配色。
 *
 * 使用约定：调用方仍按条件渲染（{show && <ConfirmDialog/>}），
 * 因此组件挂载即打开；ESC/遮罩关闭统一回调 onCancel。
 */
export function ConfirmDialog(props: { title: string; message: string; onConfirm: () => void; onCancel: () => void; confirmLabel?: string; danger?: boolean }) {
	// GUI 扩展桥：对话框是应用级单实例 chrome，由当前聚焦会话的 pi 进程供给内容（不做回落）。
	const bridgeSessionId = useBridgeSessionId();
	return (
		<AlertDialog
			open
			onOpenChange={(open) => {
				if (!open) props.onCancel();
			}}
		>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>{props.title}</AlertDialogTitle>
					<AlertDialogDescription>{props.message}</AlertDialogDescription>
				</AlertDialogHeader>
				{/* GUI 扩展桥：对话框主体下方落点（ctx.gui.setDialogBody）。
				 **追加**在默认内容之下 —— 不顶替标题/正文（§7.4 只追加）。无贡献时不占位。 */}
				<BridgeGuiSlot sessionId={bridgeSessionId} slot="dialog.body" className="flex flex-col gap-2" />
				<AlertDialogFooter>
					{/* GUI 扩展桥：对话框按钮区落点（ctx.gui.setDialogAction）。
					    放在既有取消/确认按钮**之前**，不改变原有按钮顺序与语义。 */}
					<BridgeGuiSlot sessionId={bridgeSessionId} slot="dialog.action" className="flex items-center gap-2" />
					<AlertDialogCancel onClick={props.onCancel}>{t("common.cancel")}</AlertDialogCancel>
					<AlertDialogAction onClick={props.onConfirm} className={props.danger ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : undefined}>
						{props.confirmLabel ?? t("common.confirm")}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
