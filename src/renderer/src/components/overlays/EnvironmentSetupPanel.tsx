import { AlertCircle, Check, ChevronDown, Circle, FolderOpen, Loader2, Sparkles } from "lucide-react";
import type { PiInstallExecResult, PiInstallStatus } from "../../../../shared/types";
import type { DshRuntimeState } from "../../../../shared/types/dshRuntime";
import type { PiEnvironmentGuide } from "../../hooks/usePiEnvironmentGuide";
import { t } from "../../i18n";
import { cn } from "../../lib/utils";
import { Button } from "../ui-shadcn/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui-shadcn/collapsible";
import { Input } from "../ui-shadcn/input";
import { Label } from "../ui-shadcn/label";
import { Switch } from "../ui-shadcn/switch";

type StepState = "done" | "running" | "pending" | "error";

/** 三行状态清单的一行：图标只表达「这步现在什么状态」，不承担操作入口。 */
function SetupStepRow(props: { state: StepState; title: string; detail: string }) {
	const { state, title, detail } = props;
	return (
		<li className="flex items-start gap-2.5">
			<span className={cn("mt-px flex size-4 shrink-0 items-center justify-center rounded-full", state === "done" && "bg-success/15 text-success", state === "running" && "text-primary", state === "error" && "bg-danger/15 text-danger", state === "pending" && "text-text-tertiary")}>
				{state === "done" ? <Check size={11} strokeWidth={3} aria-hidden="true" /> : state === "running" ? <Loader2 size={13} className="animate-pideck-spin" aria-hidden="true" /> : state === "error" ? <AlertCircle size={12} aria-hidden="true" /> : <Circle size={9} strokeWidth={2.5} aria-hidden="true" />}
			</span>
			<div className="min-w-0 flex-1 text-xs leading-5">
				<span className={cn("font-medium", state === "pending" ? "text-text-secondary" : "text-text-primary")}>{title}</span>
				<span className="ml-2 text-text-secondary">{detail}</span>
			</div>
		</li>
	);
}

/** 失败原因 → 一句能指导下一步的说明（不暴露内部步骤名）。 */
function failureTitle(reason: NonNullable<PiEnvironmentGuide["failure"]>["reason"]): string {
	switch (reason) {
		case "node-unsupported":
			return t("environment.setupErrorNodeUnsupported");
		case "node-prepare":
			return t("environment.setupErrorNode");
		case "npm-missing":
			return t("environment.setupErrorNpm");
		case "pi-install":
			return t("environment.setupErrorPi");
		case "pi-undetected":
			return t("environment.setupErrorUndetected");
	}
}

export interface EnvironmentSetupPanelProps {
	guide: PiEnvironmentGuide;
	/** 自动检测的报错原文（"pi 不是内部或外部命令"这类） */
	errorText?: string;
	searchedDirs: string[];
	manual: {
		command: string;
		executing: boolean;
		result: PiInstallExecResult | null;
		completed: boolean;
		onCommandChange: (command: string) => void;
		onExec: () => void;
		onRestartApp: () => void;
	};
	customPath: {
		value: string;
		validating: boolean;
		result: PiInstallStatus | null;
		browsing: boolean;
		onChange: (value: string) => void;
		onValidate: () => void;
		onBrowse: () => void;
	};
	/** 打开官方安装文档（App 层注入，链接形态由装配层决定） */
	onOpenInstallDocs: () => void;
	/** 选一份已经找到的 pi（主进程实测校验通过后切换并关窗）；没传就不渲染选择按钮 */
	onChooseInstallation?: (path: string) => void;
	/**
	 * DSH 运行时这条替代路径：不装 pi 也能用（用户要求「不止可以用 pi」）。
	 * 安装/修复统一跳到配置管理的 DSH 分页——未装时那就是安装引导页。
	 */
	dsh: {
		state: DshRuntimeState;
		runtimeVersion?: string;
		/** 当前默认后端是否已经是 dsh */
		isDefault: boolean;
		onOpenInstall: () => void;
		onUseAsDefault: () => void;
	};
}

/**
 * 未检测到 Pi 时的设置面板：一张主卡（三行状态 + 一键安装），
 * 下面两个默认收起的分支——已装过的人只需要指定路径，高级用户才看得见手动命令与检测详情。
 *
 * 为什么要重做：旧页面把一个安装流程拆成 Node/npm/pi 三个子按钮 + 顶部 4 步 stepper，
 * 用户既不知道要先点哪个，也看不出「点了会发生什么」。现在只剩一个主动作。
 */
export function EnvironmentSetupPanel(props: EnvironmentSetupPanelProps) {
	const { guide, manual, customPath, onChooseInstallation, dsh } = props;
	const nodeStatus = guide.nodeStatus;
	const nodeReady = Boolean(nodeStatus?.installed || nodeStatus?.systemNodeAvailable);
	const nodeUnsupported = Boolean(nodeStatus && !nodeReady && nodeStatus.installSupported === false);
	const npmReady = Boolean(guide.npmVersion);
	const piStepRunning = guide.activeStep === "pi" || guide.activeStep === "recheck";
	const piStepFailed = guide.failure?.step === "pi" || guide.failure?.reason === "pi-undetected";

	const nodeState: StepState = nodeReady ? "done" : guide.activeStep === "node" ? "running" : "pending";
	const npmState: StepState = npmReady ? "done" : guide.activeStep === "npm" ? "running" : "pending";
	const piState: StepState = guide.installed ? "done" : piStepFailed ? "error" : piStepRunning ? "running" : "pending";

	const nodeDetail = nodeStatus?.systemNodeAvailable
		? t("environment.setupNodeSystem", { version: nodeStatus.systemNodeVersion ?? "" })
		: nodeStatus?.installed
			? t("environment.setupNodePortable", { version: nodeStatus.version ?? "" })
			: nodeUnsupported
				? t("environment.setupNodeUnsupported")
				: t("environment.setupNodeMissing");
	const npmDetail = npmReady ? t("environment.setupNpmFound", { version: guide.npmVersion ?? "" }) : guide.npmChecking ? t("environment.checking") : t("environment.setupNpmMissing");
	// DSH 替代路径：文案与动作按运行时状态分派——只有真能跑的 runtime 才谈「改用」，
	// 未安装/损坏/版本不符一律先去安装页（那页同时也是修复入口）。
	const dshInstalled = dsh.state === "installed";
	const dshSummary =
		dsh.state === "checking"
			? t("environment.dshChecking")
			: dshInstalled
				? dsh.isDefault
					? t("environment.dshDefaultActive", { version: dsh.runtimeVersion ?? "" })
					: t("environment.dshInstalled", { version: dsh.runtimeVersion ?? "" })
				: dsh.state === "outdated"
					? t("environment.dshOutdated")
					: dsh.state === "broken"
						? t("environment.dshBroken")
						: t("environment.dshDesc");

	return (
		<>
			<section className="flex shrink-0 flex-col gap-3.5 rounded-lg border border-border bg-muted p-4">
				<div className="flex flex-col gap-1">
					<h3 className="m-0 text-sm font-semibold text-text-primary">{t("environment.setupTitle")}</h3>
					<p className="m-0 text-xs leading-relaxed text-text-secondary">{t("environment.setupDesc")}</p>
				</div>

				<ul className="m-0 flex list-none flex-col gap-2 rounded-md border border-border-subtle bg-background/50 px-3 py-2.5">
					<SetupStepRow state={nodeState} title={t("environment.setupNode")} detail={nodeDetail} />
					<SetupStepRow state={npmState} title={t("environment.setupNpm")} detail={npmDetail} />
					<SetupStepRow state={piState} title={t("environment.setupPi")} detail={guide.installed ? t("environment.setupPiReady") : t("environment.setupPiMissing")} />
				</ul>

				{guide.failure && (
					<div className="flex flex-col gap-1.5 rounded-md border border-danger/25 bg-danger-soft px-3 py-2.5">
						<span className="flex items-center gap-1.5 text-xs font-medium text-danger">
							<AlertCircle size={13} aria-hidden="true" />
							{failureTitle(guide.failure.reason)}
						</span>
						{guide.failure.detail && <pre className="m-0 max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-micro leading-relaxed text-text-secondary">{guide.failure.detail}</pre>}
					</div>
				)}

				<div className="flex flex-wrap items-center gap-3">
					{nodeUnsupported ? (
						<Button
							size="sm"
							onClick={() =>
								// 环境检测是 Dialog，链接必须走系统浏览器：内置浏览器面板在 Dialog 下层不可见。
								window.piDesktop.app.openExternal("https://nodejs.org/zh-cn/download/", true)
							}
						>
							{t("environment.openNodejsOrg")}
						</Button>
					) : (
						<Button size="sm" onClick={guide.installAll} disabled={guide.installing}>
							{guide.installing && <Loader2 size={14} className="animate-pideck-spin" aria-hidden="true" />}
							{guide.installing ? t("environment.setupInstalling") : t("environment.setupInstallAll")}
						</Button>
					)}
					<label className="flex cursor-pointer items-center gap-2 text-xs text-text-secondary">
						<Switch size="sm" checked={guide.piUseMirror} onCheckedChange={guide.setPiUseMirror} disabled={guide.installing} />
						{t("environment.setupUseMirror")}
					</label>
				</div>

				{guide.installed && (
					<p className="m-0 flex items-center gap-1.5 text-xs text-success">
						<Check size={13} strokeWidth={3} aria-hidden="true" />
						{t("environment.setupInstalledHint")}
					</p>
				)}
			</section>

			{/* 不装 pi 的替代路径：DSH 是内置运行时（需先下载 runtime），装上就能直接新建会话。 */}
			<aside className="flex shrink-0 flex-col gap-2.5 rounded-lg border border-border-subtle p-4">
				<div className="flex flex-col gap-1">
					<h4 className="m-0 flex items-center gap-1.5 text-xs font-semibold text-text-primary">
						<Sparkles size={13} aria-hidden="true" className="text-primary" />
						{t("environment.dshTitle")}
					</h4>
					<p className="m-0 text-xs leading-relaxed text-text-secondary">{dshSummary}</p>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					{dshInstalled && !dsh.isDefault && (
						<Button size="sm" variant="outline" onClick={dsh.onUseAsDefault}>
							{t("environment.dshUse")}
						</Button>
					)}
					{dsh.state !== "checking" && (
						<Button size="sm" variant={dshInstalled ? "ghost" : "outline"} onClick={dsh.onOpenInstall}>
							{dshInstalled ? t("environment.dshManage") : dsh.state === "notInstalled" ? t("environment.dshInstall") : t("environment.dshRepair")}
						</Button>
					)}
				</div>
			</aside>

			<Collapsible className="shrink-0 rounded-lg border border-border bg-muted" defaultOpen={guide.alreadyInstalled.length > 0 || guide.failure?.reason === "pi-undetected"}>
				<CollapsibleTrigger className="group flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-4 py-3 text-left text-xs font-medium text-text-secondary hover:text-text-primary">
					{t("environment.setupAlreadyTitle")}
					<ChevronDown size={14} aria-hidden="true" className="transition-transform duration-fast group-data-[state=open]:rotate-180" />
				</CollapsibleTrigger>
				<CollapsibleContent>
					<div className="flex flex-col gap-2.5 border-t border-border-subtle px-4 py-3">
						{/* 一键安装被「本机已有 pi」拦下、或检测不到时，这里给出可点选的现成路径，
						    否则用户只看到一句「检测不到」，还得自己去终端跑 where pi。 */}
						{guide.alreadyInstalled.length > 0 && (
							<div className="flex flex-col gap-1.5">
								<span className="text-xs text-text-secondary">{t("environment.guidePiAlreadyInstalled")}</span>
								<ul className="m-0 flex list-none flex-col gap-1.5">
									{guide.alreadyInstalled.map((item) => (
										<li key={item.path} className="flex items-center gap-2 rounded-md border border-border-subtle bg-background/60 px-2.5 py-1.5">
											<code className="min-w-0 flex-1 truncate font-mono text-micro text-text-secondary" title={item.path}>
												{item.path}
											</code>
											{onChooseInstallation && (
												<Button size="sm" variant="outline" className="shrink-0" onClick={() => onChooseInstallation(item.path)}>
													{t("environment.setupUseThisPath")}
												</Button>
											)}
										</li>
									))}
								</ul>
							</div>
						)}
						<p className="m-0 text-xs leading-relaxed text-text-secondary">{t("environment.setupAlreadyDesc")}</p>
						<div className="flex items-center gap-2">
							<span className="rounded-sm bg-bg-active/60 px-1.5 py-0.5 text-micro text-text-secondary">{t("environment.commandLabel")}</span>
							<code className="select-all rounded-sm bg-background px-2 py-1 font-mono text-xs text-text-primary">where pi</code>
						</div>
						<div className="flex flex-wrap items-center gap-2">
							<Input type="text" className="min-w-[240px] flex-1" placeholder="D:\mise-data\installs\node\24.13.0\pi.cmd" value={customPath.value} onChange={(event) => customPath.onChange(event.target.value)} disabled={customPath.validating} />
							<Button variant="outline" size="sm" onClick={customPath.onBrowse} disabled={customPath.browsing || customPath.validating}>
								<FolderOpen size={13} aria-hidden="true" />
								{t("environment.installsBrowse")}
							</Button>
							<Button size="sm" onClick={customPath.onValidate} disabled={!customPath.value.trim() || customPath.validating}>
								{customPath.validating ? t("environment.validatingPath") : t("environment.validatePath")}
							</Button>
						</div>
						{customPath.result && (
							<p className={cn("m-0 text-xs", customPath.result.installed ? "text-success" : "text-danger")}>
								{customPath.result.installed ? `✓ ${t("environment.validatePassed", { value: customPath.result.version ?? "pi" })}` : `✗ ${t("environment.validateFailed", { value: customPath.result.error ?? t("environment.unableToRun") })}`}
							</p>
						)}
					</div>
				</CollapsibleContent>
			</Collapsible>

			<Collapsible className="shrink-0 rounded-lg border border-border bg-muted">
				<CollapsibleTrigger className="group flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-4 py-3 text-left text-xs font-medium text-text-secondary hover:text-text-primary">
					{t("environment.setupAdvancedTitle")}
					<ChevronDown size={14} aria-hidden="true" className="transition-transform duration-fast group-data-[state=open]:rotate-180" />
				</CollapsibleTrigger>
				<CollapsibleContent>
					<div className="flex flex-col gap-3 border-t border-border-subtle px-4 py-3">
						<p className="m-0 text-xs leading-relaxed text-text-secondary">{t("environment.setupAdvancedDesc")}</p>

						<div className="flex flex-col gap-1.5">
							<Label className="text-xs text-text-secondary">{t("environment.installCommandLabel")}</Label>
							<div className="flex flex-wrap items-center gap-2">
								<Input type="text" className="min-w-[260px] flex-1 font-mono text-xs" value={manual.command} onChange={(event) => manual.onCommandChange(event.target.value)} disabled={manual.executing} placeholder="npm install -g @earendil-works/pi-coding-agent" />
								<Button variant="outline" size="sm" onClick={manual.onExec} disabled={manual.executing || !manual.command.trim()}>
									{manual.executing ? t("environment.installExecuting") : t("environment.installExec")}
								</Button>
							</div>
						</div>

						{manual.result && (
							<div className="flex flex-col gap-1.5">
								<span className={cn("text-xs font-medium", manual.result.success ? "text-success" : "text-danger")}>
									{manual.result.success ? t("environment.installCompleted") : t("environment.installFailed")}
									{` · ${t("environment.installExitCode")} ${manual.result.exitCode ?? "-"}`}
								</span>
								{manual.result.stdout && <pre className="m-0 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-background p-2 font-mono text-micro leading-relaxed text-text-secondary">{manual.result.stdout}</pre>}
								{manual.result.stderr && <pre className="m-0 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-background p-2 font-mono text-micro leading-relaxed text-danger">{manual.result.stderr}</pre>}
							</div>
						)}

						{manual.completed && (
							<div className="flex flex-wrap items-center gap-2">
								<span className="text-xs text-success">{t("environment.installSuccess")}</span>
								<Button size="sm" onClick={manual.onRestartApp}>
									{t("environment.restartApp")}
								</Button>
							</div>
						)}

						{props.errorText && (
							<div className="flex flex-col gap-1.5">
								<span className="text-xs font-medium text-text-secondary">{t("environment.errorDetails")}</span>
								<pre className="m-0 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-md bg-background p-2 font-mono text-micro leading-relaxed text-danger">{props.errorText}</pre>
							</div>
						)}

						{props.searchedDirs.length > 0 && (
							<div className="flex flex-col gap-1.5">
								<span className="text-xs font-medium text-text-secondary">{t("environment.searchedDirs")}</span>
								<ul className="m-0 flex list-none flex-col gap-0.5">
									{props.searchedDirs.map((dir) => (
										<li key={dir} className="break-all font-mono text-micro leading-relaxed text-text-tertiary">
											{dir}
										</li>
									))}
								</ul>
							</div>
						)}

						<button type="button" className="cursor-pointer self-start text-xs text-text-secondary underline underline-offset-2 hover:text-text-primary" onClick={props.onOpenInstallDocs}>
							{t("environment.openInstallDocs")}
						</button>
					</div>
				</CollapsibleContent>
			</Collapsible>
		</>
	);
}
