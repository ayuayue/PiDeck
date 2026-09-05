import { useMemo, useState } from "react";
import { t, type TranslationKey } from "../../i18n";
import { cn } from "../../lib/utils";
import { Button } from "../../components/ui-shadcn/button";
import { Badge } from "../../components/ui-shadcn/badge";
import { Progress } from "../../components/ui-shadcn/progress";
import { ScrollArea } from "../../components/ui-shadcn/scroll-area";
import { Textarea } from "../../components/ui-shadcn/textarea";
import {
	Tabs,
	TabsList,
	TabsTrigger,
	TabsContent,
} from "../../components/ui-shadcn/tabs";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "../../components/ui-shadcn/dialog";
import { SectionHeading } from "../../components/ui-shadcn/section-heading";
import { X, Copy, RefreshCw, FileDown, PackageOpen, Sparkles, MonitorCheck, Bug, MessageSquarePlus } from "lucide-react";
import type { HealthStatus } from "../../../../shared/types";
import { summarizeChecks } from "./reportFormat";
import { useFeedbackReport, type HealthCheckState } from "./useFeedbackReport";
import type { AppInfo, Project } from "../../../../shared/types";

export type FeedbackDialogProps = {
	open: boolean;
	project?: Project;
	appInfo: AppInfo;
	onClose: () => void;
	onToast: (message: string) => void;
	/** 打开外部 URL（GitHub Issue 提交页）；不传时相关按钮禁用。 */
	onOpenExternal?: (url: string) => void;
	/** 新建会话并预填提示词到输入框；返回是否成功。 */
	onCreateSessionWithPrompt?: (prompt: string) => Promise<boolean>;
};

const STATUS_TONE: Record<HealthStatus, string> = {
	ok: "bg-emerald-500/15 text-emerald-600",
	warn: "bg-amber-500/15 text-amber-600",
	error: "bg-red-500/15 text-red-600",
	skipped: "bg-muted text-muted-foreground",
};

const STATE_LABEL: Record<HealthCheckState, TranslationKey> = {
	idle: "feedback.health.idle",
	running: "feedback.health.running",
	done: "feedback.health.done",
	error: "feedback.health.error",
};

/**
 * 问题反馈工作台：把旧的「单页表单 + 环境附注」重构成四步分区诊断流程。
 *
 * - 问题描述：填现象与复现步骤
 * - 环境诊断：一键生成脱敏体检报告，逐项展示状态
 * - AI 分析：生成可复制给任意 AI 的分析提示词
 * - 导出分享：复制 Markdown / 群卡片 / 导出文件
 *
 * 使用成熟的 ui-shadcn 组件（Tabs/ScrollArea/Badge/Progress），不引入新依赖。
 * 所有复制走主进程剪贴板（大文本可靠），所有导出走主进程保存对话框。
 */
export function FeedbackDialog({ open, project, appInfo, onClose, onToast, onOpenExternal, onCreateSessionWithPrompt }: FeedbackDialogProps) {
	const feedback = useFeedbackReport({ projectName: project?.name ?? "", projectId: project?.id });
	const [activeTab, setActiveTab] = useState("describe");

	const summary = useMemo(
		() => (feedback.report ? summarizeChecks(feedback.report.checks) : null),
		[feedback.report],
	);

	if (!open) return null;

	const issueTitle = `${t("feedback.issueTitle")}${feedback.context.description.trim().split("\n")[0].slice(0, 60) || t("feedback.issueTitleEmpty")}`;
	const githubUrl = `https://github.com/ayuayue/PiDeck/issues/new?title=${encodeURIComponent(issueTitle)}&body=${encodeURIComponent(feedback.text)}`;

	const handleCopy = async () => {
		const ok = await feedback.copyText();
		onToast(ok ? t("feedback.copiedOk") : t("feedback.copyFailed"));
	};

	/** AI 分析页复制：固定复制提示词形态（带项目上下文），与展示内容一致。 */
	const handleCopyPrompt = async () => {
		const ok = await feedback.copyPrompt();
		onToast(ok ? t("feedback.copiedOk") : t("feedback.copyFailed"));
	};

	/** 新建会话并预填提示词：创建成功后关掉反馈弹窗，让用户直接在新会话里回车发送。 */
	const handleCreateSession = async () => {
		if (!feedback.report) {
			onToast(t("feedback.ai.notReady"));
			return;
		}
		if (!project) {
			onToast(t("feedback.ai.noProject"));
			return;
		}
		if (!onCreateSessionWithPrompt || !feedback.promptText) return;
		const ok = await onCreateSessionWithPrompt(feedback.promptText);
		onToast(ok ? t("feedback.ai.sessionCreated") : t("feedback.ai.sessionCreateFailed"));
		if (ok) onClose();
	};

	/** 直接用系统浏览器打开 GitHub Issue 预填页（issue 页需要登录/富文本，不适合内置浏览器）。 */
	const handleOpenIssue = () => {
		if (!onOpenExternal) return;
		onOpenExternal(githubUrl);
	};

	const handleExport = async (kind: "md" | "zip") => {
		const result = kind === "md" ? await feedback.exportMarkdown() : await feedback.exportBundle();
		if (result.canceled) return;
		onToast(result.ok ? t("feedback.exportOk") : `${t("feedback.exportFail")}${result.error ?? ""}`);
	};

	return (
		<Dialog open onOpenChange={(next) => !next && onClose()}>
			<DialogContent
				showCloseButton={false}
				className={cn(
					"flex flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(860px,calc(100vw-48px))]",
					"h-[min(640px,calc(100vh-80px))]",
				)}
			>
				<DialogHeader className="flex-row items-center justify-between border-b px-4 py-3">
					<div className="min-w-0 flex-1">
						<DialogTitle className="flex items-center gap-2 text-base">
							<MonitorCheck size={18} className="text-primary" aria-hidden="true" />
							{t("feedback.title")}
						</DialogTitle>
						<p className="mt-0.5 text-xs text-muted-foreground">{t("feedback.intro")}</p>
					</div>
					<DialogClose asChild>
						<Button variant="ghost" size="icon" aria-label={t("common.close")} title={t("common.close")}>
							<X size={18} strokeWidth={2.2} aria-hidden="true" />
						</Button>
					</DialogClose>
				</DialogHeader>

				<Tabs value={activeTab} onValueChange={setActiveTab} className="flex min-h-0 flex-1 flex-col">
					<div className="border-b px-4 pt-2">
						<TabsList className="w-full justify-start">
							<TabsTrigger value="describe">{t("feedback.tab.describe")}</TabsTrigger>
							<TabsTrigger value="health">
								{t("feedback.tab.health")}
								{summary && summary.error > 0 ? (
									<Badge variant="destructive" className="ml-1.5 h-4 px-1 text-[10px]">
										{summary.error}
									</Badge>
								) : null}
							</TabsTrigger>
							<TabsTrigger value="ai">{t("feedback.tab.ai")}</TabsTrigger>
							<TabsTrigger value="share">{t("feedback.tab.share")}</TabsTrigger>
						</TabsList>
					</div>

					<div className="min-h-0 flex-1">
						{/* ── 问题描述 ── */}
						<TabsContent value="describe" className="m-0 flex h-full flex-col gap-3 overflow-y-auto p-4">
							<SectionHeading
								title={t("feedback.descriptionLabel")}
								description={t("feedback.descriptionHint")}
							/>
							<Textarea
								className="min-h-[120px]"
								value={feedback.context.description}
								onChange={(event) =>
									feedback.setContext((prev) => ({ ...prev, description: event.target.value }))
								}
								placeholder={t("feedback.descriptionPlaceholder")}
							/>
							<SectionHeading
								title={t("feedback.stepsLabel")}
								description={t("feedback.stepsHint")}
							/>
							<Textarea
								className="min-h-[100px]"
								value={feedback.context.steps}
								onChange={(event) =>
									feedback.setContext((prev) => ({ ...prev, steps: event.target.value }))
								}
								placeholder={t("feedback.stepsPlaceholder")}
							/>
							<div className="mt-auto flex justify-end gap-2 pt-2">
								<Button variant="default" onClick={() => setActiveTab("health")}>
									{t("feedback.nextDiagnose")}
								</Button>
							</div>
						</TabsContent>

						{/* ── 环境诊断 ── */}
						<TabsContent value="health" className="m-0 flex h-full flex-col">
							<div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
								<Button
									variant="default"
									size="sm"
									disabled={feedback.state === "running"}
									onClick={() => void feedback.runCheck()}
								>
									{feedback.state === "running" ? (
										<RefreshCw size={15} className="animate-pideck-spin" aria-hidden="true" />
									) : (
										<MonitorCheck size={15} aria-hidden="true" />
									)}
									<span className="ml-1.5">{t(STATE_LABEL[feedback.state])}</span>
								</Button>
								{feedback.report ? (
									<div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
										<span>
											{t("feedback.health.score")}：{summary?.score ?? "-"}
										</span>
										{summary?.error ? (
											<Badge variant="destructive">{t("feedback.health.errors", { count: summary.error })}</Badge>
										) : null}
										{summary?.warn ? (
											<Badge className="bg-amber-500/15 text-amber-600">
												{t("feedback.health.warns", { count: summary.warn })}
											</Badge>
										) : null}
									</div>
								) : null}
							</div>

							<div className="min-h-0 flex-1 overflow-y-auto p-4">
								{feedback.state === "idle" ? (
									<div className="flex h-full flex-col items-center justify-center gap-3 text-center text-muted-foreground">
										<MonitorCheck size={40} className="opacity-40" aria-hidden="true" />
										<p className="max-w-sm text-sm">{t("feedback.health.idleHint")}</p>
									</div>
								) : feedback.state === "running" ? (
									<div className="flex h-full flex-col items-center justify-center gap-3">
										<Progress className="h-1.5 w-56" />
										<p className="text-sm text-muted-foreground">{t("feedback.health.runningHint")}</p>
									</div>
								) : feedback.state === "error" ? (
									<div className="text-sm text-red-600">{t("feedback.health.errorDetail")}：{feedback.error}</div>
								) : (
									<div className="space-y-2">
										{feedback.report!.checks.map((check) => (
											<div
												key={check.id}
												className="flex items-start gap-2 rounded-lg border px-3 py-2"
											>
												<span className={cn("mt-0.5 rounded px-1.5 py-0.5 text-[11px] font-medium", STATUS_TONE[check.status])}>
													{check.status.toUpperCase()}
												</span>
												<div className="min-w-0 flex-1">
													<div className="text-sm font-medium">{t(`health.check.${check.id}` as never)}</div>
													{check.detail ? (
														<div className="truncate text-xs text-muted-foreground" title={check.detail}>
															{check.detail}
														</div>
													) : null}
												</div>
											</div>
										))}
										{feedback.report!.checks.length === 0 ? (
											<p className="text-sm text-muted-foreground">{t("feedback.health.empty")}</p>
										) : null}
									</div>
								)}
							</div>
						</TabsContent>

						{/* ── AI 分析 ── */}
						<TabsContent value="ai" className="m-0 flex h-full flex-col">
							<div className="border-b px-4 py-2.5">
								<SectionHeading
									className="[&>h3]:text-sm"
									title={t("feedback.ai.title")}
									description={t("feedback.ai.hint")}
								/>
							</div>
							<div className="flex min-h-0 flex-1 flex-col p-4">
								<div className="mb-2 flex justify-end">
									<Button variant="secondary" size="sm" onClick={() => void handleCopyPrompt()}>
										<Copy size={14} aria-hidden="true" />
										<span className="ml-1.5">{t("feedback.copyReport")}</span>
									</Button>
									<Button
										variant="default"
										size="sm"
										className="ml-2"
										disabled={!feedback.report || !onCreateSessionWithPrompt}
										onClick={() => void handleCreateSession()}
										title={t("feedback.ai.createSessionHint")}
									>
										<MessageSquarePlus size={14} aria-hidden="true" />
										<span className="ml-1.5">{t("feedback.ai.createSession")}</span>
									</Button>
								</div>
								<ScrollArea className="min-h-0 flex-1 rounded-lg border bg-muted/30 p-3">
									<pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground">
										{feedback.state === "done" ? feedback.promptText : t("feedback.ai.notReady")}
									</pre>
								</ScrollArea>
							</div>
						</TabsContent>

						{/* ── 导出分享 ── */}
						<TabsContent value="share" className="m-0 flex h-full flex-col">
							<div className="border-b px-4 py-2.5">
								<SectionHeading
									className="[&>h3]:text-sm"
									title={t("feedback.share.title")}
									description={t("feedback.share.hint")}
								/>
							</div>
							<div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
								<div className="grid gap-3 sm:grid-cols-2">
									<ShareCard
										icon={<Copy size={18} aria-hidden="true" />}
										title={t("feedback.share.copyMarkdown")}
										desc={t("feedback.share.copyMarkdownDesc")}
										action={
											<Button variant="secondary" size="sm" onClick={() => { feedback.setFormat("markdown"); void handleCopy(); }}>
												{t("feedback.copyReport")}
											</Button>
										}
									/>
									<ShareCard
										icon={<Sparkles size={18} aria-hidden="true" />}
										title={t("feedback.share.copyPrompt")}
										desc={t("feedback.share.copyPromptDesc")}
										action={
											<Button variant="secondary" size="sm" onClick={() => void handleCopyPrompt()}>
												{t("feedback.share.copyPromptAction")}
											</Button>
										}
									/>
									<ShareCard
										icon={<FileDown size={18} aria-hidden="true" />}
										title={t("feedback.share.exportMarkdown")}
										desc={t("feedback.share.exportMarkdownDesc")}
										action={
											<Button variant="outline" size="sm" onClick={() => void handleExport("md")}>
												{t("feedback.share.exportAction")}
											</Button>
										}
									/>
									<ShareCard
										icon={<PackageOpen size={18} aria-hidden="true" />}
										title={t("feedback.share.exportZip")}
										desc={t("feedback.share.exportZipDesc")}
										action={
											<Button variant="outline" size="sm" onClick={() => void handleExport("zip")}>
												{t("feedback.share.exportZipAction")}
											</Button>
										}
									/>
								</div>
								<div className="mt-auto flex flex-wrap items-center gap-2 border-t pt-3">
									<Button
										variant="default"
										size="sm"
										onClick={() => void handleOpenIssue()}
										disabled={!onOpenExternal}
										title={t("feedback.openIssueHint")}
									>
										<Bug size={14} aria-hidden="true" />
										<span className="ml-1.5">{t("feedback.openIssue")}</span>
									</Button>
									<Button
										variant="secondary"
										size="sm"
										onClick={() => onOpenExternal?.("https://github.com/ayuayue/PiDeck")}
										disabled={!onOpenExternal}
									>
										{t("feedback.authorGithub")}
									</Button>
								</div>
							</div>
						</TabsContent>
					</div>
				</Tabs>
			</DialogContent>
		</Dialog>
	);
}

function ShareCard({
	icon,
	title,
	desc,
	action,
}: {
	icon: React.ReactNode;
	title: string;
	desc: string;
	action: React.ReactNode;
}) {
	return (
		<div className="flex flex-col gap-2 rounded-lg border p-3">
			<div className="flex items-center gap-2 text-sm font-medium">
				<span className="text-primary">{icon}</span>
				{title}
			</div>
			<p className="text-xs text-muted-foreground">{desc}</p>
			<div className="mt-auto pt-1">{action}</div>
		</div>
	);
}
