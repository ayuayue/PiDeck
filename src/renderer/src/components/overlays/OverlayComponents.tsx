import { X } from "lucide-react";
import { t } from "../../i18n";
import { cn } from "../../lib/utils";
import { Button } from "../ui-shadcn/button";
import { ConfirmDialog as ShadcnConfirmDialog } from "../ui-shadcn/ConfirmDialog";
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle } from "../ui-shadcn/dialog";
import type { PiInstallation, PiInstallStatus, PiInstallExecResult } from "../../../../shared/types";
import type { PiEnvironmentGuide } from "../../hooks/usePiEnvironmentGuide";
import { PiCommandSourcePanel } from "../app/PiCommandSourcePanel";
import { shouldOfferInstallationChoice } from "../../utils/piInstallationOptions";
import { EnvironmentSetupPanel, type EnvironmentSetupPanelProps } from "./EnvironmentSetupPanel";

/**
 * Pi 环境检测弹窗。
 *
 * 未安装态只有一条主线：一张「一键安装」卡（Node/npm/pi 三行状态 + 一个主按钮），
 * 已装过的人从「我已经装过 Pi」展开指定路径，排查问题时才展开「手动安装 / 检测详情」。
 * 旧的 Node/npm/pi 三个子按钮 + 顶部 4 步 stepper 已删除：步骤重复且必须自己判断先点哪个。
 */
export function EnvironmentDialog(props: {
	status: PiInstallStatus | null;
	checking: boolean;
	/** 开发预览：无视检测结果直接渲染未安装态的一键安装面板（本机已装 pi 时也能看引导效果） */
	setupPreview?: boolean;
	onClose: () => void;
	onRecheck: () => void;
	onOpenInstallDocs: () => void;
	/** pi 环境引导（检测 Node/npm → 一键安装 → 重新检测）的域状态与命令 */
	guide: PiEnvironmentGuide;
	/** DSH 替代路径（不装 pi 也能用）：运行时状态与「去安装 / 改用」动作，由 App 装配 */
	dsh: EnvironmentSetupPanelProps["dsh"];
	/** 用户手动输入的 pi 路径 */
	customPath: string;
	/** 正在校验自定义路径 */
	customPathValidating: boolean;
	/** 自定义路径校验结果 */
	customPathResult: PiInstallStatus | null;
	onCustomPathChange: (path: string) => void;
	onValidateCustomPath: () => void;
	/**
	 * 探测到的全部 pi 安装。多份时弹窗不再自动关闭，必须让用户先选一份——
	 * 静默用其中一份正是「终端里能用、PiDeck 用的是另一份」的根源。
	 */
	installations?: PiInstallation[];
	/** 正在校验的安装路径（行内 loading） */
	applyingInstallationPath?: string | null;
	onChooseInstallation?: (path: string) => void;
	/** 反查交互式登录 shell 再找一次（zsh/自定义 PATH 场景） */
	onShellProbeInstallations?: () => void;
	shellProbingInstallations?: boolean;
	/** 系统文件选择器挑 pi 可执行文件（稀有/自定义安装） */
	onBrowsePiPath: () => void;
	browsingPiPath: boolean;
	/** 手动安装（高级区）当前命令文本 */
	installCommand: string;
	/** 是否正在执行安装 */
	installExecuting: boolean;
	/** 安装执行结果 */
	installResult: PiInstallExecResult | null;
	/** 安装是否已成功完成 */
	installCompleted: boolean;
	onInstallCommandChange: (cmd: string) => void;
	onExecInstall: () => void;
	onRestartApp: () => void;
	/** 重置 piEnvironmentChecked 标记，使下次启动重新触发环境检测 */
	onClearCheckFlag?: () => void;
}) {
	const installed = !props.setupPreview && (props.status?.installed || props.customPathResult?.installed);
	const searchedDirs = props.status?.searchedDirs.slice(0, 16) ?? [];
	const errorText = props.status?.error ?? props.customPathResult?.error;

	return (
		<Dialog open onOpenChange={(next) => !next && props.onClose()}>
			<DialogContent showCloseButton={false} className={cn("flex flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(800px,calc(100vw-48px))] max-h-[calc(100vh-48px)]", "environment-dialog")}>
				<DialogHeader className="flex-row items-center justify-between px-4 py-3">
					<DialogTitle>{t("environment.title")}</DialogTitle>
					<DialogClose asChild>
						<Button variant="ghost" size="icon" aria-label={t("common.close")} title={t("common.close")}>
							<X size={18} strokeWidth={2.2} aria-hidden="true" />
						</Button>
					</DialogClose>
				</DialogHeader>
				<div className="environment-body">
					{props.checking && (
						<div className="env-card env-loading-card">
							<div className="loader animate-pideck-spin" />
							<span>{t("environment.checking")}</span>
						</div>
					)}

					{!props.checking && installed && (
						<>
							<div className="env-card env-success-card">
								<div className="env-success-icon">✓</div>
								<div className="env-success-info">
									<strong>{t("environment.passed")}</strong>
									<span>
										{t("environment.path")}：{(props.customPathResult || props.status)?.command}
									</span>
									{(props.customPathResult || props.status)?.version && (
										<span>
											{t("environment.version")}：{(props.customPathResult || props.status)!.version}
										</span>
									)}
									{/* 多份安装时不能承诺自动关闭：用户得先在这里选一份 */}
									{!shouldOfferInstallationChoice(props.installations ?? []) && <small>{t("environment.autoClose")}</small>}
								</div>
							</div>

							{/* 多份 pi 安装：列出全部（含官方安装器那份）让用户自己选 */}
							{shouldOfferInstallationChoice(props.installations ?? []) && props.onChooseInstallation && (
								<div className="env-card">
									<PiCommandSourcePanel
										variant="dialog"
										installations={props.installations ?? []}
										applyingPath={props.applyingInstallationPath}
										onChoose={props.onChooseInstallation}
										onShellProbe={props.onShellProbeInstallations}
										shellProbing={props.shellProbingInstallations}
										onBrowse={props.onBrowsePiPath}
										browsing={props.browsingPiPath}
									/>
								</div>
							)}
						</>
					)}

					{!props.checking && !installed && (
						<>
							{props.setupPreview && <p className="m-0 shrink-0 rounded-md border border-border-subtle bg-muted px-3 py-2 text-text-secondary text-caption">{t("environment.setupPreviewBanner")}</p>}
							<EnvironmentSetupPanel
								guide={props.guide}
								errorText={errorText}
								searchedDirs={searchedDirs}
								onOpenInstallDocs={props.onOpenInstallDocs}
								onChooseInstallation={props.onChooseInstallation}
								dsh={props.dsh}
								manual={{
									command: props.installCommand,
									executing: props.installExecuting,
									result: props.installResult,
									completed: props.installCompleted,
									onCommandChange: props.onInstallCommandChange,
									onExec: props.onExecInstall,
									onRestartApp: props.onRestartApp,
								}}
								customPath={{
									value: props.customPath,
									validating: props.customPathValidating,
									result: props.customPathResult,
									browsing: props.browsingPiPath,
									onChange: props.onCustomPathChange,
									onValidate: props.onValidateCustomPath,
									onBrowse: props.onBrowsePiPath,
								}}
							/>
						</>
					)}
				</div>

				<div className="environment-footer">
					<Button variant="default" size="sm" className="h-auto rounded-sm px-4 py-2.5 text-control" onClick={props.onRecheck} disabled={props.checking || props.customPathValidating || props.guide.installing}>
						{t("environment.recheck")}
					</Button>
					{props.onClearCheckFlag && (
						<Button variant="ghost" size="sm" className="env-clear-flag-btn h-auto rounded-sm px-4 py-2.5 text-control" onClick={props.onClearCheckFlag} title={t("environment.clearCheckFlagHint")}>
							{t("environment.clearCheckFlag")}
						</Button>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}

export function ConfirmDialog(props: { title: string; message: string; onConfirm: () => void; onCancel: () => void; confirmLabel?: string; danger?: boolean }) {
	// 实现已收敛到 ui-shadcn/ConfirmDialog（AlertDialog），此处仅保留兼容转发。
	return <ShadcnConfirmDialog {...props} />;
}
