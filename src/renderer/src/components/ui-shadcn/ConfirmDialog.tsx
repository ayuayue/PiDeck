import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "./alert-dialog";
import { t } from "../../i18n";

/**
 * 全站统一的确认弹框（UI 2.0 / issue #115）：基于 shadcn AlertDialog，
 * 替代此前散落在 config-modal 体系里的两套同构实现。
 * 危险操作（删除/丢弃/重置）传 danger，按钮使用 destructive 配色。
 *
 * 使用约定：调用方仍按条件渲染（{show && <ConfirmDialog/>}），
 * 因此组件挂载即打开；ESC/遮罩关闭统一回调 onCancel。
 *
 * layer="drawer"：从右侧抽屉里弹出的确认框必须抬到抽屉之上（弹窗 950 < 抽屉 980），
 * 否则半张框会被抽屉面板盖住。
 */
export function ConfirmDialog(props: { title: string; message: string; onConfirm: () => void; onCancel: () => void; confirmLabel?: string; danger?: boolean; layer?: "dialog" | "drawer" }) {
	// 抽屉是 980，弹窗默认 950；+10 只是保证严格在其之上，不改变与其它浮层的相对关系。
	const layerClassName = props.layer === "drawer" ? "z-[calc(var(--z-drawer)+10)]" : undefined;
	return (
		<AlertDialog
			open
			onOpenChange={(open) => {
				if (!open) props.onCancel();
			}}
		>
			<AlertDialogContent className={layerClassName} overlayClassName={layerClassName}>
				<AlertDialogHeader>
					<AlertDialogTitle>{props.title}</AlertDialogTitle>
					<AlertDialogDescription>{props.message}</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel onClick={props.onCancel}>{t("common.cancel")}</AlertDialogCancel>
					<AlertDialogAction onClick={props.onConfirm} className={props.danger ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : undefined}>
						{props.confirmLabel ?? t("common.confirm")}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
