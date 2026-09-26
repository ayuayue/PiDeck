import { useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import type { DataEnvMode } from "../../../../shared/types/dataEnv";
import { t } from "../../i18n";
import { desktopApi } from "../../desktopApi";
import { dataEnvDecisionRequiredAtom } from "../../atoms/dataEnvAtoms";
import { Button } from "../ui-shadcn/button";
import { Checkbox } from "../ui-shadcn/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui-shadcn/dialog";
import { DataImportProgressDialog } from "./DataImportProgressDialog";

/**
 * dev 打包首启的数据模式选择（规格 §5/§6）：一次性强制选择，不可经遮罩/Esc/关闭按钮跳过。
 *
 * - 共用 → chooseMode("shared")（restartRequired=false）→ 关闭弹窗直接继续；
 * - 独立 → chooseMode("channel-dev") → 勾选「从正式版导入数据」（默认勾选）时先进入导入向导，
 *   导入完成后由向导自动重启；未勾选导入则立即重启（setPath 于下次 ready 前生效）。
 *   独立模式决策即时生效于盘上：跳过/取消后同样重启，余下写入才真正落入独立目录。
 */
export function DataModeChoiceDialog() {
	const decisionRequired = useAtomValue(dataEnvDecisionRequiredAtom);
	const setDecisionRequired = useSetAtom(dataEnvDecisionRequiredAtom);
	// 独立模式附带的导入开关（默认勾选，规格 §5）；仅在选择「独立数据目录」时生效。
	const [importChecked, setImportChecked] = useState(true);
	const [importDialogOpen, setImportDialogOpen] = useState(false);
	const [chooseFailed, setChooseFailed] = useState(false);

	/** 提交模式决策：成功后按是否需要导入分流（进度向导 / 直接重启）；失败保持弹窗给出提示。 */
	const choose = (mode: DataEnvMode) => {
		setChooseFailed(false);
		void desktopApi.dataEnv.chooseMode(mode).then((result) => {
			if ("error" in result) {
				setChooseFailed(true);
				return;
			}
			if (mode === "channel-dev" && importChecked && result.importAvailable) {
				// 决策已落盘：关闭选择弹窗（决策事件不会重发，弹窗由本地导入向导接管收尾）。
				setDecisionRequired(false);
				setImportDialogOpen(true);
				return;
			}
			// shared 路径 restartRequired=false：本会话已在共用目录，关闭弹窗直接继续，无需重启。
			if (!result.restartRequired) {
				setDecisionRequired(false);
				return;
			}
			void desktopApi.dataEnv.restart();
		});
	};

	// 导入向导打开期间选择弹窗保持挂载（open=false 仅隐藏），避免向导随本组件状态丢失。
	return (
		<>
			<Dialog open={decisionRequired && !importDialogOpen}>
				<DialogContent
					className="sm:max-w-lg"
					showCloseButton={false}
					// 一次性引导必须做出选择：屏蔽遮罩点击与 Esc（未决策时下次启动会再弹，但流程上强制当场选择）。
					onInteractOutside={(event) => event.preventDefault()}
					onEscapeKeyDown={(event) => event.preventDefault()}
				>
					<DialogHeader>
						<DialogTitle>{t("dataMode.dialogTitle")}</DialogTitle>
						<DialogDescription>{t("dataMode.dialogDesc")}</DialogDescription>
					</DialogHeader>

					<div className="grid gap-2 sm:grid-cols-2">
						{/* 共用选项：整卡可点，立即生效 */}
						<button type="button" className="flex flex-col gap-1.5 rounded-lg border border-border bg-bg-muted/30 p-3 text-left transition-colors hover:bg-accent" onClick={() => choose("shared")}>
							<span className="text-control font-medium text-foreground">{t("dataMode.sharedTitle")}</span>
							<span className="text-caption leading-relaxed text-muted-foreground">{t("dataMode.sharedDesc")}</span>
						</button>
						{/* 独立选项：卡身为决策按钮，导入开关是卡内独立控件（阻止冒泡语义上互不嵌套） */}
						<div className="flex flex-col gap-1.5 rounded-lg border border-border bg-bg-muted/30 p-3">
							<button type="button" className="flex w-full flex-col gap-1.5 rounded-md p-1 text-left transition-colors hover:bg-accent" onClick={() => choose("channel-dev")}>
								<span className="text-control font-medium text-foreground">{t("dataMode.channelDevTitle")}</span>
								<span className="text-caption leading-relaxed text-muted-foreground">{t("dataMode.channelDevDesc")}</span>
							</button>
							<label className="mt-auto flex cursor-pointer items-center gap-2 pt-1 text-caption text-foreground">
								<Checkbox checked={importChecked} onCheckedChange={(checked) => setImportChecked(checked === true)} />
								{t("dataMode.importSnapshot")}
							</label>
						</div>
					</div>

					{chooseFailed && <p className="text-caption text-destructive">{t("dataMode.modeChangeFailed")}</p>}
				</DialogContent>
			</Dialog>
			{/* 跳过导入（preview/cancelled 态收口）：决策已落盘（独立目录），关闭向导后立即重启落到新目录；
			    否则本会话余下写入仍落共用目录，与用户刚做的选择相悖。 */}
			{importDialogOpen && (
				<DataImportProgressDialog
					open
					onClose={() => {
						setImportDialogOpen(false);
						void desktopApi.dataEnv.restart();
					}}
				/>
			)}
		</>
	);
}
