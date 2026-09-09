import { Input } from "../ui-shadcn/input";
import { useEffect, useState } from "react";
// ============================================================
// AppParts — 产品级顶层桥接文件
// ============================================================
// 本文件保留：
//   1. Overlay domain (EnvironmentDialog, ConfirmDialog)
//   2. 全局类型定义 (SessionModifiedFile, DiffFileHandler)
//   3. Re-exports from leaf modules (Composer, Sidebar, Surface)
// ============================================================

import { t } from "../../i18n";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "../ui-shadcn/dialog";
import { Button } from "../ui-shadcn/button";
import { X } from "lucide-react";
import { cn } from "../../lib/utils";
import { detectRendererPlatform } from "../../lib/detectRendererPlatform";
import { ConfirmDialog as ShadcnConfirmDialog } from "../ui-shadcn/ConfirmDialog";
import type { PiInstallStatus, PiInstallExecResult } from "../../../../shared/types";

// Re-exports from other modules
export type { WorkspaceDrawerPanel as DrawerPanel } from "../../hooks/useWorkspacePanels";

// Re-exports from leaf modules (A12 migration in progress)
import { PiLogoCanvas } from "./PiLogoCanvas";
import { TextShimmer } from "../motion/text-shimmer";
import { Label } from "../../components/ui-shadcn/label";
export { WorktreeCreateDialog } from "../sidebar/SidebarComponents";
export { ComposerBottomBar, ModelPicker, PromptTemplatePicker, ThinkingPicker, ExtensionWidgetCard } from "../session/ComposerComponents";

export type SessionModifiedFile = {
	path: string;
	toolName: string;
	status: string;
	changedLines?: number;
	/** 工具执行前的文件原始内容，用于历史会话恢复时展示差异对比。 */
	originalContent?: string;
	/** 工具写入/编辑后的新文件内容，优先于从磁盘实时读取（历史会话恢复时磁盘可能已变化或文件已删除）。 */
	content?: string;
};

type DiffFileHandler = (path: string, originalContent?: string, content?: string) => void;

export function EnvironmentDialog(props: {
	status: PiInstallStatus | null;
	checking: boolean;
	onClose: () => void;
	onRecheck: () => void;
	onOpenInstallDocs: () => void;
	/** 用户手动输入的 pi 路径 */
	customPath: string;
	/** 正在校验自定义路径 */
	customPathValidating: boolean;
	/** 自定义路径校验结果 */
	customPathResult: PiInstallStatus | null;
	onCustomPathChange: (path: string) => void;
	onValidateCustomPath: () => void;
	/** npm 可用性 */
	npmAvailable: boolean | null;
	npmVersion?: string;
	npmChecking: boolean;
	/** 当前安装命令文本 */
	installCommand: string;
	/** 是否使用国内镜像源 */
	installUseMirror: boolean;
	/** 是否正在执行安装 */
	installExecuting: boolean;
	/** 安装执行结果 */
	installResult: PiInstallExecResult | null;
	/** 安装是否已成功完成 */
	installCompleted: boolean;
	onCheckNpm: () => void;
	onInstallCommandChange: (cmd: string) => void;
	onToggleInstallMirror: () => void;
	onExecInstall: () => void;
	onRestartApp: () => void;
	/** 重置 piEnvironmentChecked 标记，使下次启动重新触发环境检测 */
	onClearCheckFlag?: () => void;
}) {
	const installed = props.status?.installed || props.customPathResult?.installed;
	const searchedDirs = props.status?.searchedDirs.slice(0, 16) ?? [];
	const errorText = props.status?.error ?? props.customPathResult?.error;
	const steps = [
		t("environment.stepInstall"),
		t("environment.stepPath"),
		t("environment.stepPermission"),
		t("environment.stepDone"),
	];
	const activeStep = props.checking ? 0 : installed ? 3 : 1;

	// Windows 统一使用 CMD 查找 .cmd/.exe shim，不再引导用户使用 PowerShell 的 .ps1 入口。
	const refCmd = 'where pi';

	return (
		<Dialog open onOpenChange={(next) => !next && props.onClose()}>
			<DialogContent showCloseButton={false} className={cn("flex flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(800px,calc(100vw-48px))]")}>
				<DialogHeader className="flex-row items-center justify-between px-4 py-3">
					<DialogTitle>{t("environment.title")}</DialogTitle>
					<DialogClose asChild>
						<Button variant="ghost" size="icon" aria-label={t("common.close")} title={t("common.close")}>
							<X size={18} strokeWidth={2.2} aria-hidden="true" />
						</Button>
					</DialogClose>
				</DialogHeader>
			<div className="environment-body">
					<div className="env-stepper" aria-label={t("environment.title")}>
						{steps.map((step, index) => (
							<div
								key={step}
								className={`env-step ${index < activeStep ? "done" : ""} ${index === activeStep ? "active" : ""}`}
							>
								<span>{index < activeStep ? "✓" : index + 1}</span>
								<b>{step}</b>
							</div>
						))}
					</div>

					{props.checking && (
						<div className="env-card env-loading-card">
							<div className="loader animate-pideck-spin" />
							<span>{t("environment.checking")}</span>
						</div>
					)}

					{!props.checking && installed && (
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
								<small>{t("environment.autoClose")}</small>
							</div>
						</div>
					)}

					{!props.checking && !installed && (
						<>
							{/* 状态说明卡片 */}
							<div className="env-card env-status-card">
								<strong>{t("environment.notFoundTitle")}</strong>
								<small>{t("environment.notFoundDesc")}</small>
							</div>

							{/* 自动检测错误信息（如有） */}
							{errorText && (
								<div className="env-card env-error-card">
									<strong>{t("environment.errorDetails")}</strong>
									<pre className="env-error-pre">{errorText}</pre>
								</div>
							)}

							{/* npm 安装 pi 卡片（合并了安装指引） */}
							<div className="env-card env-npm-install-card">
								<strong>{t("environment.installCardTitle")}</strong>
								<small>{t("environment.installCardDesc")}</small>
								<small>
									{t("environment.installDesc")}{" "}
									<a
										className="env-inline-link"
										href="#"
										onClick={(e) => {
											e.preventDefault();
											props.onOpenInstallDocs();
										}}
									>
										{t("environment.openInstallDocs")}
									</a>
								</small>

								{/* npm 可用性检测 */}
								{props.npmAvailable === null && !props.npmChecking && (
									<Button
										variant="outline"
										size="sm"
										className="env-card-btn env-card-btn h-auto rounded-[6px] px-4 py-[7px] text-xs shadow-none"
										onClick={props.onCheckNpm}
									>
										{t("environment.stepInstall")}
									</Button>
								)}

								{props.npmChecking && (
									<div className="env-install-loading">
										<div className="loader animate-pideck-spin" />
										<span>{t("environment.checking")}</span>
									</div>
								)}

								{/* npm 可用时：显示安装命令和操作 */}
								{props.npmAvailable === true && !props.npmChecking && (
									<div className="env-install-area">
										{props.npmVersion && (
											<div className="env-install-npm-version">
												npm {props.npmVersion}
											</div>
										)}
										<div className="env-install-command-row">
											<Label className="env-install-command-label">
												{t("environment.installCommandLabel")}
											</Label>
											<Input
												type="text"
												className="env-install-command-input"
												value={props.installCommand}
												onChange={(e) =>
													props.onInstallCommandChange(e.target.value)
												}
												disabled={props.installExecuting}
												placeholder="npm install -g @earendil-works/pi-coding-agent"
											/>
										</div>
										<div className="env-install-actions">
											<Button
												variant="outline"
												size="sm"
												className={`env-card-btn env-mirror-btn ${props.installUseMirror ? "active" : ""} env-card-btn h-auto rounded-[6px] px-4 py-[7px] text-xs shadow-none`}
												onClick={props.onToggleInstallMirror}
												disabled={props.installExecuting}
												title={t("environment.installUseMirror")}
											>
												{props.installUseMirror
													? t("environment.installRemoveMirror")
													: t("environment.installUseMirror")}
											</Button>
											<Button
												variant="default"
												size="sm"
												className="env-card-btn primary env-card-btn h-auto rounded-[6px] px-4 py-[7px] text-xs shadow-none"
												onClick={props.onExecInstall}
												disabled={props.installExecuting || !props.installCommand.trim()}
											>
												{props.installExecuting
													? t("environment.installExecuting")
													: t("environment.installExec")}
											</Button>
										</div>

										{/* 安装进行中：显示进度 */}
										{props.installExecuting && (
											<div className="env-install-progress">
												<div className="loader animate-pideck-spin" />
												<span>{t("environment.installExecuting")}</span>
											</div>
										)}

										{/* 安装完成 */}
										{props.installCompleted && (
											<div className="env-install-success">
												<div className="env-success-icon">✓</div>
												<div className="env-success-info">
													<strong>{t("environment.installSuccess")}</strong>
													<small>{t("environment.installRestartHint")}</small>
												</div>
												<Button
													variant="default"
													size="sm"
													className="env-card-btn primary env-card-btn h-auto rounded-[6px] px-4 py-[7px] text-xs shadow-none"
													onClick={props.onRestartApp}
												>
													{t("environment.restartApp")}
												</Button>
											</div>
										)}

										{/* 安装结果输出 */}
										{props.installResult && (
											<div className={`env-install-result ${props.installResult.success ? "success" : "error"}`}>
												<strong>
													{props.installResult.success
														? t("environment.installCompleted")
														: t("environment.installFailed")}
													{t("environment.installExitCode")}：{props.installResult.exitCode}
												</strong>
												{props.installResult.stdout && (
													<>
														<span>{t("environment.installOutput")}</span>
														<pre className="env-install-output-pre">{props.installResult.stdout}</pre>
													</>
												)}
												{props.installResult.stderr && (
													<pre className="env-install-output-pre env-install-stderr">{props.installResult.stderr}</pre>
												)}
											</div>
										)}
									</div>
								)}

								{/* npm 不可用：引导安装 Node.js */}
								{props.npmAvailable === false && !props.npmChecking && (
									<div className="env-install-npm-missing">
										<strong>{t("environment.npmNotFoundTitle")}</strong>
										<small>{t("environment.npmNotFoundDesc")}</small>
										<Button
											variant="outline"
											size="sm"
											className="env-card-btn env-card-btn h-auto rounded-[6px] px-4 py-[7px] text-xs shadow-none"
											onClick={() =>
												// 环境引导是弹框（Dialog），链接强制系统浏览器：内置浏览器面板在 Dialog 下层不可见
												window.piDesktop.app.openExternal(
													"https://nodejs.org/zh-cn/download/",
													true
												)
											}
										>
											{t("environment.openNodejsOrg")}
										</Button>
									</div>
								)}
							</div>

							{/* 手动输入 pi 路径卡片 */}
							<div className="env-card env-custom-card">
								<strong>{t("environment.customPathTitle")}</strong>
								<small>{t("environment.customPathDesc")}</small>
								<div className="ref-commands">
									<div className="ref-command-item">
										<span className="ref-label">{t("environment.commandLabel")}</span>
										<code>{refCmd}</code>
									</div>

								</div>
								<div className="custom-path-input-row">
									<Input
										type="text"
										placeholder="D:\\mise-data\\installs\\node\\24 13 0\\pi.cmd"
										value={props.customPath}
										onChange={(e) =>
											props.onCustomPathChange(e.target.value)
										}
										disabled={props.customPathValidating}
									/>
									<Button
										variant="default"
										size="sm"
										className="env-card-btn primary env-card-btn h-auto rounded-[6px] px-4 py-[7px] text-xs shadow-none"
										onClick={props.onValidateCustomPath}
										disabled={
											!props.customPath.trim() ||
											props.customPathValidating
										}
									>
										{props.customPathValidating
											? t("environment.validatingPath")
											: t("environment.validatePath")}
									</Button>
								</div>
								{props.customPathResult && (
									<div
										className={`custom-path-result ${props.customPathResult.installed ? "success" : "error"}`}
									>
										{props.customPathResult.installed
											? `✓ ${t("environment.validatePassed", { value: props.customPathResult.version ?? "pi" })}`
											: `✗ ${t("environment.validateFailed", { value: props.customPathResult.error ?? t("environment.unableToRun") })}`}
									</div>
								)}
							</div>

							{/* 检测路径卡片 */}
							{searchedDirs.length > 0 && (
								<div className="env-card env-dirs-card">
									<strong>{t("environment.searchedDirs")}</strong>
									<small>{t("environment.searchedDirsDesc")}</small>
									<ul className="env-dirs-list">
										{searchedDirs.map((dir) => (
											<li key={dir}>{dir}</li>
										))}
									</ul>
								</div>
							)}
						</>
					)}
				</div>

				<div className="environment-footer">
					<Button
					variant="default"
					size="sm"
					className="h-auto rounded-[6px] px-4 py-2.5 text-[13px]"
						onClick={props.onRecheck}
						disabled={props.checking || props.customPathValidating}
					>
						{t("environment.recheck")}
					</Button>
					{props.onClearCheckFlag && (
						<Button
							variant="ghost"
							size="sm"
							className="env-clear-flag-btn h-auto rounded-[6px] px-4 py-2.5 text-[13px]"
							onClick={props.onClearCheckFlag}
							title={t("environment.clearCheckFlagHint")}
						>
							{t("environment.clearCheckFlag")}
						</Button>
					)}
				</div>
				</DialogContent>
		</Dialog>
	);
}


export function ConfirmDialog(props: {
	title: string;
	message: string;
	onConfirm: () => void;
	onCancel: () => void;
	confirmLabel?: string;
	danger?: boolean;
}) {
	// 实现已收敛到 ui-shadcn/ConfirmDialog（AlertDialog），此处仅保留兼容转发，
	// 避免一次性改动所有 import 路径；后续批量替换 import 后删除本包装。
	return <ShadcnConfirmDialog {...props} />;
}

// ============================================================
// Re-exports from Surface domain (session rendering components)
// 保持旧 import 路径继续工作
// ============================================================
export {
  SessionStatus,
  LogoMark,
  AgentAvatar,
  EmptyState,
  ToolCard,
  ToolGroupCard,
  DiagnosticMessageCard,
  ThinkingBlock,
  RespondingIndicator,
  AssistantText,
  UserBubble,
  ImagePreviewModal,
  stripMarkdown,
  MultiSelectModal,
  ConversationOutline,
  DrawerContent,
  SessionFileSummary,
  SessionHistoryModal,
  PromptSuggestions,
  FileContextMenu,
} from "../session/SurfaceComponents";
export { TurnRow } from "../session/turn";

// PiLogoCanvas — canvas-based animated pi logo (from upstream dev)
export { PiLogoCanvas } from "./PiLogoCanvas";

/** 模块级缓存：dev 分支名（多 worktree 并行区分窗口）。一次拉取，全实例共享。 */
let cachedDevBranch: string | undefined;
let devBranchPromise: Promise<string | undefined> | null = null;
function loadDevBranch(): Promise<string | undefined> {
	if (cachedDevBranch !== undefined) return Promise.resolve(cachedDevBranch);
	devBranchPromise ??= (async () => {
		try {
			const info = await (window as unknown as { piDesktop?: { app?: { info: () => Promise<{ devBranch?: string }> } } })
				.piDesktop?.app?.info();
			cachedDevBranch = info?.devBranch?.trim() || undefined;
			return cachedDevBranch;
		} catch {
			return undefined;
		}
	})();
	return devBranchPromise;
}

/**
 * Brand lockup：官方 pi 风格 canvas logo + 两行字标（beUI Animated Sidebar 头部风格的文字排布）。
 * 分支名下探为副标题行（仅开发分支时显示，避免视觉噪声）；视觉变形只作用于字标，
 * 品牌语义仍由外层 aria-label 承载。字标用 beUI TextShimmer（纯 CSS 动画、无平台分支）。
 */
export function BrandLockup(props: { replayToken?: number } = {}) {
	const [branch, setBranch] = useState<string | undefined>(undefined);
	useEffect(() => {
		void loadDevBranch().then(setBranch);
	}, []);
	const brandTitle = branch ? `PiDeck · ${branch}` : "PiDeck";
	// macOS 窗口左上角已有原生交通灯，π logo + 字标挤在同一行视觉过重；
	// darwin 平台只保留字标（品牌语义仍由 aria-label 承载），其余平台维持原样。
	const showLogo = detectRendererPlatform() !== "darwin";
	return (
		<div className="brand-lockup flex h-full min-w-0 items-center gap-2" aria-label={brandTitle} title={branch ? brandTitle : undefined}>
			{showLogo && <PiLogoCanvas size={18} autoPlay playOnClick replayToken={props.replayToken} />}
			<span className="flex min-w-0 flex-col justify-center gap-1">
				<TextShimmer
					as="span"
					className="brand-wordmark truncate text-[18px] font-[PiDeckDepartureMono] font-bold uppercase leading-none"
				>
					PiDeck
				</TextShimmer>
				{branch && <span className="truncate text-[13px] font-medium leading-none text-muted-foreground">{branch}</span>}
			</span>
		</div>
	);
}


