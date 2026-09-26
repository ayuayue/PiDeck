import { useAtomValue, useSetAtom } from "jotai";
import { t } from "../../i18n";
import { desktopApi } from "../../desktopApi";
import { dataEnvMismatchAtom } from "../../atoms/dataEnvAtoms";
import { buttonVariants } from "../ui-shadcn/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../ui-shadcn/alert-dialog";

/**
 * 数据目录标记警告（规格 §6：stable 包落在 channel-dev 目录 → mismatch）。
 * 主进程 did-finish-load 后推送一次；「继续使用」放行本会话，「退出」交给主进程退出应用。
 * Esc/遮罩等关闭手势等价「继续使用」（较不破坏数据的保守侧）。
 */
export function DataEnvMismatchDialog() {
	const mismatch = useAtomValue(dataEnvMismatchAtom);
	const setMismatch = useSetAtom(dataEnvMismatchAtom);
	if (!mismatch) return null;

	return (
		<AlertDialog
			open
			onOpenChange={(open) => {
				if (!open) {
					setMismatch(null);
					void desktopApi.dataEnv.confirmMismatch("continue");
				}
			}}
		>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>{t("dataMode.mismatchTitle")}</AlertDialogTitle>
					<AlertDialogDescription>{t("dataMode.mismatchDesc")}</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel
						onClick={() => {
							setMismatch(null);
							void desktopApi.dataEnv.confirmMismatch("continue");
						}}
					>
						{t("dataMode.mismatchContinue")}
					</AlertDialogCancel>
					<AlertDialogAction
						className={buttonVariants({ variant: "destructive" })}
						onClick={() => {
							setMismatch(null);
							void desktopApi.dataEnv.confirmMismatch("quit");
						}}
					>
						{t("dataMode.mismatchQuit")}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
