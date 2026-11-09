import { useRef } from "react";
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
	// 点「确认」也会关闭弹框并触发 onOpenChange(false)：用标记区分来源，
	// 保证 onCancel 只在真正取消（Cancel/Esc/遮罩）时调用且仅一次，确认路径不误触取消回调。
	const confirmedRef = useRef(false);
	return (
		<AlertDialog
			open
			onOpenChange={(open) => {
				if (open) return;
				// 确认路径刚设置过标记，不走 onCancel（父组件的取消回调可能比 setState 多做事情）。
				// 同时在此复位标记：父组件若忘了在 onConfirm 里卸载（#518 的删除弹框），
				// 下一次取消/Esc/遮罩仍能正常关闭，而不是永久失活。
				if (confirmedRef.current) {
					confirmedRef.current = false;
					return;
				}
				props.onCancel();
			}}
		>
			<AlertDialogContent className={layerClassName} overlayClassName={layerClassName}>
				<AlertDialogHeader>
					<AlertDialogTitle>{props.title}</AlertDialogTitle>
					<AlertDialogDescription>{props.message}</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					{/* Cancel 按钮自带关闭行为（会走 onOpenChange(false)），不再叠 onClick，避免取消回调双触发 */}
					<AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
					<AlertDialogAction
						onClick={() => {
							confirmedRef.current = true;
							props.onConfirm();
						}}
						className={props.danger ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : undefined}
					>
						{props.confirmLabel ?? t("common.confirm")}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
