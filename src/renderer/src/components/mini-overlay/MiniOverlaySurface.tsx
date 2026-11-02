import { useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, ChevronDown, Home, ListTodo, MessageSquare, Plus, X } from "lucide-react";
import { desktopApi } from "../../desktopApi";
import { t } from "../../i18n";
import { useMiniOverlayWorkspace, type MiniOverlayWorkspace, type MiniOverlayWorkspaceOptions } from "../../hooks/useMiniOverlayWorkspace";
import { useBackendModelCatalog } from "../../hooks/useBackendModelCatalog";
import { showNotice } from "../../utils/notice";
import { LogoMark } from "../app/LogoMark";
import { Button } from "../ui-shadcn/button";
import { Card, CardContent } from "../ui-shadcn/card";
import { Label } from "../ui-shadcn/label";
import { ModelPicker } from "../session/ComposerParts";
import { MiniOverlayProjectPicker } from "./MiniOverlayProjectPicker";

/** 悬浮工作区拥有主页/新建/会话导航；App 只注入已有会话命令与会话视图。 */
export function MiniOverlaySurface(props: MiniOverlayWorkspaceOptions & { onSwitchToQuickTask: () => void; children: ReactNode }) {
	const workspace = useMiniOverlayWorkspace(props);
	const busy = workspace.creating || Boolean(workspace.openingSessionId);
	const runWindowAction = (action: () => Promise<void>) => {
		void action().catch(() => showNotice(t("miniOverlay.windowActionFailed"), 4000, "error"));
	};
	const sessionVisible = workspace.view === "session" && Boolean(workspace.session);

	return (
		<section className="mini-overlay-root flex min-h-0 flex-1 flex-col bg-bg-app text-foreground">
			<header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/60 bg-bg-panel/75 px-2.5 [-webkit-app-region:drag]">
				<div className="flex min-w-0 flex-1 items-center gap-2">
					<LogoMark size={22} />
					<span className="truncate text-xs font-semibold">{sessionVisible ? workspace.session?.title : t("miniOverlay.title")}</span>
				</div>
				<div className="flex shrink-0 items-center gap-0.5 [-webkit-app-region:no-drag]">
					<Button type="button" variant="ghost" size="icon-sm" className="size-7" disabled={busy} onClick={workspace.showHome} title={t("miniOverlay.home")} aria-label={t("miniOverlay.home")}>
						<Home />
					</Button>
					<Button type="button" variant="ghost" size="icon-sm" className="size-7" disabled={busy} onClick={workspace.showNewSession} title={t("miniOverlay.newSession")} aria-label={t("miniOverlay.newSession")}>
						<Plus />
					</Button>
					<Button type="button" variant="ghost" size="icon-sm" className="size-7" onClick={props.onSwitchToQuickTask} title={t("miniOverlay.quickTaskMode")} aria-label={t("miniOverlay.quickTaskMode")}>
						<ListTodo />
					</Button>
					<Button type="button" variant="ghost" size="icon-sm" className="size-7" onClick={() => runWindowAction(desktopApi.miniOverlay.collapse)} title={t("miniOverlay.collapse")} aria-label={t("miniOverlay.collapse")}>
						<ChevronDown />
					</Button>
					<Button type="button" variant="ghost" size="icon-sm" className="size-7" onClick={() => runWindowAction(desktopApi.miniOverlay.close)} title={t("common.close")} aria-label={t("common.close")}>
						<X />
					</Button>
				</div>
			</header>
			{/* 主页只是导航覆盖层：不卸载会话 composer，保留输入和在途交互。 */}
			{workspace.session ? (
				<div hidden={!sessionVisible} className="flex min-h-0 flex-1 flex-col [&[hidden]]:hidden">
					{props.children}
				</div>
			) : null}
			{/* scroll-ok: transient —— 一次性弹窗 / 设置面板：内容随交互生命周期结束，不是随数据增长的列表。 */}
			{!sessionVisible ? <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-5">{workspace.view === "new" ? <MiniOverlayNewSession workspace={workspace} /> : <MiniOverlayHome workspace={workspace} />}</div> : null}
		</section>
	);
}

/** 主页给出明确的新建入口、当前会话返回与按项目最近会话，不把选项目当成创建。 */
function MiniOverlayHome({ workspace }: { workspace: MiniOverlayWorkspace }) {
	return (
		<div className="flex flex-col gap-5">
			<div className="flex items-start gap-3">
				<div className="grid size-11 shrink-0 place-items-center rounded-xl border bg-bg-panel">
					<LogoMark size={28} />
				</div>
				<div className="min-w-0">
					<h1 className="text-lg font-semibold">{t("miniOverlay.homeTitle")}</h1>
					<p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t("miniOverlay.homeDescription")}</p>
				</div>
			</div>
			<Button type="button" className="h-11 justify-between" onClick={workspace.showNewSession}>
				<span className="flex items-center gap-2">
					<Plus />
					{t("miniOverlay.newSession")}
				</span>
				<ArrowRight />
			</Button>
			{workspace.session ? (
				<Button type="button" variant="outline" className="h-auto min-h-10 justify-start gap-2 py-2 text-left" onClick={workspace.showSession}>
					<MessageSquare />
					<span className="min-w-0 flex-1 truncate">{t("miniOverlay.returnToSession", { title: workspace.session.title })}</span>
					<ArrowRight />
				</Button>
			) : null}
			<div className="flex flex-col gap-2">
				<Label htmlFor="mini-home-project" className="text-xs text-muted-foreground">
					{t("miniOverlay.project")}
				</Label>
				<MiniOverlayProjectPicker id="mini-home-project" projects={workspace.projects} value={workspace.project?.id} onSelectProject={workspace.selectProject} disabled={Boolean(workspace.openingSessionId)} />
				<p className="truncate text-micro text-muted-foreground" title={workspace.project?.path}>
					{workspace.project?.kind === "chat" ? t("miniOverlay.chatProjectHint") : workspace.project?.path || t("miniOverlay.selectProjectHint")}
				</p>
			</div>
			{/* 活动会话：正在运行 agent 的会话跨项目直达，与悬浮球角标同语义；无运行任务时不占位。 */}
			{workspace.activeSessions.length > 0 ? (
				<div className="flex flex-col gap-2">
					<h2 className="text-xs font-medium text-muted-foreground">{t("miniOverlay.activeSessions")}</h2>
					<div className="flex flex-col gap-1.5">
						{workspace.activeSessions.map((active) => (
							<Button
								key={active.id}
								type="button"
								variant="ghost"
								className={active.isRunning ? "h-auto min-h-12 shrink-0 justify-start gap-2.5 border border-success/35 bg-success/8 px-3 py-2 text-left" : "h-auto min-h-12 shrink-0 justify-start gap-2.5 border border-border/60 px-3 py-2 text-left"}
								loading={workspace.openingSessionId === active.id}
								disabled={Boolean(workspace.openingSessionId)}
								onClick={() => void workspace.openActiveSession(active.id, active.projectId)}
							>
								{/* 运行中脉冲绿点；空闲透明占位保持缩进对齐。 */}
								<span className={active.isRunning ? "size-2 shrink-0 animate-pulse rounded-full bg-success" : "size-2 shrink-0 rounded-full bg-transparent"} aria-hidden />
								<span className="min-w-0 flex-1 truncate text-xs font-medium">{active.title}</span>
								<ArrowRight className="size-3.5 text-muted-foreground" />
							</Button>
						))}
					</div>
				</div>
			) : null}
			<div className="flex flex-col gap-2">
				<h2 className="text-xs font-medium text-muted-foreground">{t("miniOverlay.recentSessions")}</h2>
				{workspace.recentSessions.length > 0 ? (
					<div className="flex flex-col gap-1.5">
						{workspace.recentSessions.map((session) => (
							<Button
								key={session.id}
								type="button"
								variant="ghost"
								className="h-auto min-h-12 shrink-0 justify-start gap-2.5 border border-border/45 bg-bg-panel/60 px-3 py-2 text-left"
								loading={workspace.openingSessionId === session.id}
								disabled={Boolean(workspace.openingSessionId)}
								onClick={() => void workspace.openSession(session.id)}
							>
								<MessageSquare className="size-4 text-muted-foreground" />
								<span className="flex min-w-0 flex-1 flex-col gap-0.5">
									<span className="truncate text-xs font-medium">{session.title}</span>
									<span className="truncate text-micro font-normal text-muted-foreground">{session.preview || t("miniOverlay.emptySession")}</span>
								</span>
								<ArrowRight className="size-3.5 text-muted-foreground" />
							</Button>
						))}
					</div>
				) : (
					<p role={workspace.recentFailed ? "alert" : "status"} className="rounded-lg border border-dashed border-border/65 p-4 text-xs leading-relaxed text-muted-foreground">
						{workspace.recentLoading ? t("miniOverlay.loadingSessions") : workspace.recentFailed ? t("miniOverlay.loadSessionsFailed") : workspace.project?.missing ? t("miniOverlay.projectMissing") : workspace.project ? t("miniOverlay.noRecentSessions") : t("miniOverlay.selectProjectHint")}
					</p>
				)}
			</div>
		</div>
	);
}

/** 新建页在创建前呈现项目与模型；目录仍复用会话的可搜索 ModelPicker。 */
function MiniOverlayNewSession({ workspace }: { workspace: MiniOverlayWorkspace }) {
	const [modelPickerOpen, setModelPickerOpen] = useState(false);
	const catalog = useBackendModelCatalog({ sessionId: "renderer:mini-new-session", backend: workspace.backend, projectId: workspace.project?.id, enabled: modelPickerOpen });
	const modelLabel = workspace.displayModel?.modelName ?? workspace.displayModel?.modelId ?? t("miniOverlay.defaultModel");

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-5">
			<Button type="button" variant="ghost" size="sm" className="self-start px-0 text-muted-foreground" disabled={workspace.creating} onClick={workspace.showHome}>
				<ArrowLeft />
				{t("miniOverlay.home")}
			</Button>
			<div>
				<h1 className="text-lg font-semibold">{t("miniOverlay.newSession")}</h1>
				<p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{t("miniOverlay.newSessionDescription")}</p>
			</div>
			<Card className="gap-0 bg-bg-panel/70 py-4 shadow-none">
				<CardContent className="flex flex-col gap-4 px-4">
					<div className="flex flex-col gap-2">
						<Label htmlFor="mini-new-project" className="text-xs">
							{t("miniOverlay.project")}
						</Label>
						<MiniOverlayProjectPicker id="mini-new-project" projects={workspace.projects} value={workspace.project?.id} onSelectProject={workspace.selectProject} disabled={workspace.creating} className="h-9" />
						<p className="break-all text-micro leading-relaxed text-muted-foreground">{workspace.project?.kind === "chat" ? t("miniOverlay.chatProjectHint") : workspace.project?.path || t("miniOverlay.selectProjectHint")}</p>
					</div>
					<div className="flex flex-col gap-2 border-t border-border/55 pt-4">
						<Label htmlFor="mini-new-model" className="text-xs">
							{t("miniOverlay.model")}
						</Label>
						<Button id="mini-new-model" type="button" variant="outline" className="w-full min-w-0 justify-between text-xs" disabled={!workspace.project || workspace.project.missing || workspace.creating} onClick={() => setModelPickerOpen(true)} title={modelLabel}>
							<span className="min-w-0 flex-1 truncate text-left">{modelLabel}</span>
							<ChevronDown />
						</Button>
						<p className="text-micro text-muted-foreground">{workspace.displayModel?.provider ?? t("miniOverlay.defaultModelHint")}</p>
					</div>
				</CardContent>
			</Card>
			{workspace.projects.length === 0 ? (
				<p className="text-xs leading-relaxed text-muted-foreground">{t("miniOverlay.noProjects")}</p>
			) : workspace.project?.missing ? (
				<p role="alert" className="text-xs text-destructive">
					{t("miniOverlay.projectMissing")}
				</p>
			) : null}
			<div className="mt-auto flex flex-col gap-2 pt-1">
				<Button type="button" className="h-10" loading={workspace.creating} disabled={!workspace.project || workspace.project.missing} onClick={() => void workspace.createSession()}>
					<Plus />
					{workspace.creating ? t("miniOverlay.creatingSession") : t("miniOverlay.createSession")}
				</Button>
				<p className="text-center text-micro leading-relaxed text-muted-foreground">{t("miniOverlay.createHint")}</p>
			</div>
			{modelPickerOpen ? (
				<ModelPicker
					models={catalog.models}
					report={catalog.report}
					loading={catalog.loading}
					refreshing={catalog.refreshing}
					onRefresh={() => catalog.reload(true)}
					current={workspace.displayModel}
					backend={workspace.backend === "pi" || workspace.backend === "dsh" ? workspace.backend : undefined}
					onClose={() => setModelPickerOpen(false)}
					onClear={
						workspace.selectedModel
							? () => {
									workspace.clearModel();
									setModelPickerOpen(false);
								}
							: undefined
					}
					onPick={(model) => {
						workspace.selectModel(model);
						setModelPickerOpen(false);
					}}
				/>
			) : null}
		</div>
	);
}
