import type { Dispatch, SetStateAction } from "react";
import type { PiExtensionSummary, PiPromptTemplateSummary, PiSkillSummary } from "../../../../shared/types";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../../components/ui-shadcn/alert-dialog";
import { buttonVariants } from "../../components/ui-shadcn/button";
import { ConfirmDialog } from "../../components/ui-shadcn/ConfirmDialog";
import type { ConfigUnsavedSummary } from "../configUnsavedChangesSummary";
import { t } from "../../i18n";
import type { PendingEnvSwitch } from "./ConfigEnvSwitch";
import { ConfigRawSwitchConfirm } from "./ConfigRawTab";

/** 通用删除确认（provider/model/auth/批量）：文案与动作由调用方给出，弹窗本身只负责外观。 */
export type ConfigDeleteConfirm = {
	type: "provider" | "model" | "auth" | "batch";
	title: string;
	message: string;
	onConfirm: () => void;
};

export type ConfigModalDialogsProps = {
	deleteSkillConfirm: PiSkillSummary | null;
	confirmDeleteSkill: () => Promise<void>;
	setDeleteSkillConfirm: Dispatch<SetStateAction<PiSkillSummary | null>>;
	uninstallExtensionConfirm: PiExtensionSummary | null;
	confirmUninstallExtension: () => void;
	setUninstallExtensionConfirm: Dispatch<SetStateAction<PiExtensionSummary | null>>;
	uninstallProjectPackageConfirm: { source: string } | null;
	confirmUninstallProjectPackage: () => void;
	setUninstallProjectPackageConfirm: Dispatch<SetStateAction<{ source: string } | null>>;
	deletePromptConfirm: PiPromptTemplateSummary | null;
	confirmDeletePrompt: (target: PiPromptTemplateSummary) => Promise<void>;
	setDeletePromptConfirm: Dispatch<SetStateAction<PiPromptTemplateSummary | null>>;
	closeConfirmOpen: boolean;
	setCloseConfirmOpen: Dispatch<SetStateAction<boolean>>;
	configUnsavedSummary: ConfigUnsavedSummary | null;
	configUnsavedMessage: string;
	handleSaveAndClose: () => Promise<void>;
	handleDiscardAndClose: () => void;
	pendingEnvSwitch: PendingEnvSwitch | null;
	setPendingEnvSwitch: Dispatch<SetStateAction<PendingEnvSwitch | null>>;
	discardDraftsAndSwitch: () => void;
	saveDraftsAndSwitch: () => Promise<void>;
	pendingRawFile: string | null;
	setPendingRawFile: Dispatch<SetStateAction<string | null>>;
	applyRawFileChange: (fileName: string) => Promise<void>;
	remoteDiscardConfirmOpen: boolean;
	setRemoteDiscardConfirmOpen: Dispatch<SetStateAction<boolean>>;
	resetRemoteDirty: () => void;
	/** 远端 patch 丢弃确认后的关闭动作（由宿主提供，独立弹窗与内嵌分区各自的关闭链路）。 */
	onClose: () => void;
	deleteConfirm: ConfigDeleteConfirm | null;
	setDeleteConfirm: Dispatch<SetStateAction<ConfigDeleteConfirm | null>>;
};

/**
 * 配置弹窗的各种确认弹层（技能/扩展/提示词删除、关闭未保存、环境切换、源文件切换、远端草稿丢弃、通用删除）。
 * 整块放在所有 Tabs 之外：Radix Tabs 会卸载非激活内容，弹层若挂在某个 TabsContent 里会随切页消失。
 */
export function ConfigModalDialogs(props: ConfigModalDialogsProps) {
	const {
		deleteSkillConfirm,
		confirmDeleteSkill,
		setDeleteSkillConfirm,
		uninstallExtensionConfirm,
		confirmUninstallExtension,
		setUninstallExtensionConfirm,
		uninstallProjectPackageConfirm,
		confirmUninstallProjectPackage,
		setUninstallProjectPackageConfirm,
		deletePromptConfirm,
		confirmDeletePrompt,
		setDeletePromptConfirm,
		closeConfirmOpen,
		setCloseConfirmOpen,
		configUnsavedSummary,
		configUnsavedMessage,
		handleSaveAndClose,
		handleDiscardAndClose,
		pendingEnvSwitch,
		setPendingEnvSwitch,
		discardDraftsAndSwitch,
		saveDraftsAndSwitch,
		pendingRawFile,
		setPendingRawFile,
		applyRawFileChange,
		remoteDiscardConfirmOpen,
		setRemoteDiscardConfirmOpen,
		resetRemoteDirty,
		onClose,
		deleteConfirm,
		setDeleteConfirm,
	} = props;

	return (
		<>
			{deleteSkillConfirm && (
				<ConfirmDialog title={t("config.deleteSkillConfirmTitle")} message={t("config.deleteSkillConfirmBody", { name: deleteSkillConfirm.name }) + "\n" + deleteSkillConfirm.path} confirmLabel={t("common.delete")} danger onConfirm={() => void confirmDeleteSkill()} onCancel={() => setDeleteSkillConfirm(null)} />
			)}

			{uninstallExtensionConfirm && (
				<ConfirmDialog
					title={t("config.deleteExtensionTitle")}
					message={t("config.deleteExtensionBody", { source: uninstallExtensionConfirm.source }) + (uninstallExtensionConfirm.path ? "\n" + uninstallExtensionConfirm.path : "")}
					confirmLabel={t("common.delete")}
					danger
					onConfirm={confirmUninstallExtension}
					onCancel={() => setUninstallExtensionConfirm(null)}
				/>
			)}

			{uninstallProjectPackageConfirm && (
				<ConfirmDialog title={t("config.deleteExtensionTitle")} message={t("config.deleteExtensionBody", { source: uninstallProjectPackageConfirm.source })} confirmLabel={t("common.delete")} danger onConfirm={confirmUninstallProjectPackage} onCancel={() => setUninstallProjectPackageConfirm(null)} />
			)}

			{deletePromptConfirm && (
				<ConfirmDialog title={t("config.deletePromptConfirmTitle")} message={t("config.deletePromptConfirmBody", { name: deletePromptConfirm.name })} confirmLabel={t("common.delete")} danger onConfirm={() => void confirmDeletePrompt(deletePromptConfirm)} onCancel={() => setDeletePromptConfirm(null)} />
			)}

			{/* 关闭确认：有未保存修改时弹出，保存并关闭 / 放弃更改 / 取消（借鉴设置页） */}
			{closeConfirmOpen && (
				<AlertDialog
					open
					onOpenChange={(open) => {
						if (!open) setCloseConfirmOpen(false);
					}}
				>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>{t("config.unsavedTitle")}</AlertDialogTitle>
							<AlertDialogDescription asChild>
								{/* scroll-ok: transient —— 一次性弹窗 / 设置面板：内容随交互生命周期结束，不是随数据增长的列表。 */}
								<div className="grid max-h-56 gap-1.5 overflow-auto text-left">
									{configUnsavedSummary && configUnsavedSummary.totalCount === 1 ? (
										/* 单项：沿用带「是否在关闭前保存？」的单行提示，不需要列表 */
										<p>{configUnsavedMessage}</p>
									) : (
										<>
											{/* 多项：先给总数，再逐条列出变更项（footer 按钮承担保存/放弃语义） */}
											<p>{t("config.unsavedListIntro", { count: configUnsavedSummary?.totalCount ?? 0 })}</p>
											<ul className="grid gap-0.5 pl-4 list-disc">
												{configUnsavedSummary?.items.map((item) => (
													<li key={`${item.tabKey}\u0000${item.itemKey}`}>
														{t(item.tabKey)} · {t(item.itemKey)}
													</li>
												))}
											</ul>
										</>
									)}
								</div>
							</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
							<AlertDialogAction className={buttonVariants({ variant: "destructive" })} onClick={handleDiscardAndClose}>
								{t("config.discardChanges")}
							</AlertDialogAction>
							<AlertDialogAction onClick={() => void handleSaveAndClose()}>{t("config.saveAndClose")}</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			)}

			{/* 环境切换确认：本环境有配置草稿或远端未应用 patch 时，先让用户选「保存并切换 / 放弃并切换 / 取消」 */}
			{pendingEnvSwitch && (
				<AlertDialog open onOpenChange={(open) => (!open ? setPendingEnvSwitch(null) : undefined)}>
					<AlertDialogContent data-testid="config-env-switch-confirm">
						<AlertDialogHeader>
							<AlertDialogTitle>{t("config.env.switchDirtyTitle")}</AlertDialogTitle>
							<AlertDialogDescription>{pendingEnvSwitch.dirtyKeys.every((key) => key.startsWith("remote:")) ? t("config.env.switchDirtyRemote") : t("config.env.switchDirtyMessage", { count: pendingEnvSwitch.dirtyKeys.length })}</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel>{t("config.env.switchCancel")}</AlertDialogCancel>
							<AlertDialogAction className={buttonVariants({ variant: "destructive" })} onClick={discardDraftsAndSwitch} data-testid="config-env-switch-discard">
								{t("config.env.switchDiscardAndGo")}
							</AlertDialogAction>
							{/* 只有本机保存链路能落盘草稿；纯远端 patch 时不给「保存并切换」（那会假装保存了远端） */}
							{pendingEnvSwitch.dirtyKeys.every((key) => key.startsWith("remote:")) ? null : (
								<AlertDialogAction onClick={() => void saveDraftsAndSwitch()} data-testid="config-env-switch-save">
									{t("config.env.switchSaveAndGo")}
								</AlertDialogAction>
							)}
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			)}

			{/* 源文件切换确认：Raw 编辑器有未保存草稿时，切换下拉会丢弃草稿，必须显式确认 */}
			<ConfigRawSwitchConfirm
				pendingRawFile={pendingRawFile}
				onDiscard={(fileName) => {
					setPendingRawFile(null);
					void applyRawFileChange(fileName);
				}}
				onCancel={() => setPendingRawFile(null)}
			/>

			{/* 远端草稿关闭确认：本机保存链路不会落盘远端 patch，只能显式丢弃或取消 */}
			{remoteDiscardConfirmOpen && (
				<ConfirmDialog
					title={t("config.target.discardTitle")}
					message={t("config.target.discardMessage")}
					confirmLabel={t("config.target.discardConfirm")}
					danger
					onConfirm={() => {
						setRemoteDiscardConfirmOpen(false);
						resetRemoteDirty();
						onClose();
					}}
					onCancel={() => setRemoteDiscardConfirmOpen(false)}
				/>
			)}

			{/* toast 已改用 sonner */}
			{deleteConfirm && <ConfirmDialog title={deleteConfirm.title} message={deleteConfirm.message} confirmLabel={t("common.delete")} danger onConfirm={deleteConfirm.onConfirm} onCancel={() => setDeleteConfirm(null)} />}
		</>
	);
}
