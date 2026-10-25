/**
 * WebDshToolsPanel — Web 端 DSH 工具面板（S6.3/S6.5：goals/subagents/skills/plugins 呈现）。
 *
 * 与桌面 DshAgentToolsPanel 同信息架构，但数据源走 REST（webApi 的 /api/sessions/:id/dsh/*，
 * 与桌面 IPC 同源同一批主进程方法）：
 * - 目标：runtime state 投影的当前 goal（只读呈现；创建/操作仍走桌面端或 /goal 斜杠命令）；
 * - 子代理：subagent.list 直接子代目录 + 展开只读 transcript；
 * - 技能：skill.list 只读目录（/name 斜杠调用提示）；
 * - 插件：动态 Cordis 插件清单 + 安装/运行/停止/卸载（G13 语义：进程内临时、按会话归属、
 *   面板手势免审批、hostCode 非安全边界）。
 * 无活跃 runtime 时各 tab 返回空态（REST 端点在主进程侧安全回退）。
 */
import { Boxes, Loader2, Sparkles, Target, Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { showNotice } from "@/utils/notice";
import { Button } from "@/components/ui-shadcn/button";
import { Collapsible, CollapsibleContent } from "@/components/ui-shadcn/collapsible";
import { Dialog, DialogContent } from "@/components/ui-shadcn/dialog";
import { Input } from "@/components/ui-shadcn/input";
import { Textarea } from "@/components/ui-shadcn/textarea";
import { dshPluginAction, fetchDshGoal, fetchDshPlugins, fetchDshSkills, fetchDshSubagentHistory, fetchDshSubagents, installDshPlugin, type WebDshGoal, type WebDshPlugin, type WebDshSkill, type WebDshSubagent } from "./webApi";

export function WebDshToolsPanel(props: { sessionId: string; onClose: () => void }) {
	const [tab, setTab] = useState<"goals" | "subagents" | "skills" | "plugins">("goals");
	return (
		<Dialog open onOpenChange={(next) => !next && props.onClose()}>
			<DialogContent showCloseButton className="sm:max-w-lg [&>*]:min-w-0">
				{/* tab 条横向可滚：4 个 tab 在窄屏放不下会溢出裁切（最后一个 tab 被裁掉），滚动保完整。 */}
				<div className="flex gap-1 overflow-x-auto border-b border-border-subtle pb-2">
					<Button variant={tab === "goals" ? "secondary" : "ghost"} size="sm" className="shrink-0 gap-1.5" onClick={() => setTab("goals")}>
						<Target size={14} aria-hidden="true" />
						{t("dshTools.goals")}
					</Button>
					<Button variant={tab === "subagents" ? "secondary" : "ghost"} size="sm" className="shrink-0 gap-1.5" onClick={() => setTab("subagents")}>
						<Users size={14} aria-hidden="true" />
						{t("dshTools.subagents")}
					</Button>
					<Button variant={tab === "skills" ? "secondary" : "ghost"} size="sm" className="shrink-0 gap-1.5" onClick={() => setTab("skills")}>
						<Sparkles size={14} aria-hidden="true" />
						{t("dshTools.skills")}
					</Button>
					<Button variant={tab === "plugins" ? "secondary" : "ghost"} size="sm" className="shrink-0 gap-1.5" onClick={() => setTab("plugins")}>
						<Boxes size={14} aria-hidden="true" />
						{t("config.dsh.dynamicPlugins")}
					</Button>
				</div>
				{/* 内容限高：静态插件清单可达 30+ 条，不限高会把 Dialog 撑出屏幕；
					60vh 上限 + 内部滚动，tab 条与关闭钮始终在视口内。 */}
				<div className="max-h-[60vh] min-h-40 overflow-y-auto">
					{tab === "goals" && <GoalsTab sessionId={props.sessionId} />}
					{tab === "subagents" && <SubagentsTab sessionId={props.sessionId} />}
					{tab === "skills" && <SkillsTab sessionId={props.sessionId} />}
					{tab === "plugins" && <PluginsTab sessionId={props.sessionId} />}
				</div>
			</DialogContent>
		</Dialog>
	);
}

function LoadingRow() {
	return (
		<div className="flex items-center gap-2 p-3 text-caption text-text-secondary">
			<Loader2 size={14} className="animate-pideck-spin" aria-hidden="true" />
			{t("dshTools.loading")}
		</div>
	);
}

/** 目标：当前 goal 只读呈现（phase 语义色 + 轮次进度）。 */
function GoalsTab(props: { sessionId: string }) {
	const [goal, setGoal] = useState<WebDshGoal | null | undefined>(undefined);
	useEffect(() => {
		let cancelled = false;
		void fetchDshGoal(props.sessionId)
			.then((result) => {
				if (!cancelled) setGoal(result.goal);
			})
			.catch(() => {
				if (!cancelled) setGoal(null);
			});
		return () => {
			cancelled = true;
		};
	}, [props.sessionId]);

	if (goal === undefined) return <LoadingRow />;
	if (!goal) {
		return <p className="p-3 text-caption text-text-secondary">{t("dshTools.goalEmpty")}</p>;
	}
	const phaseLabel: Record<WebDshGoal["phase"], string> = {
		active: t("dshTools.goalPhase.active"),
		paused: t("dshTools.goalPhase.paused"),
		blocked: t("dshTools.goalPhase.blocked"),
		complete: t("dshTools.goalPhase.complete"),
	};
	return (
		<div className="flex flex-col gap-1.5 p-1">
			<div className="flex flex-col gap-1 rounded-lg border border-border-subtle bg-bg-panel/60 px-3 py-2">
				<div className="flex min-w-0 items-center gap-2">
					<Target size={13} className="shrink-0 text-muted-foreground" aria-hidden="true" />
					<span
						className={cn(
							"shrink-0 rounded px-1.5 py-0.5 text-micro font-medium",
							goal.phase === "active" && "bg-primary/15 text-primary",
							goal.phase === "paused" && "bg-amber-500/15 text-amber-600 dark:text-amber-400",
							goal.phase === "blocked" && "bg-destructive/15 text-destructive",
							goal.phase === "complete" && "bg-success/15 text-success",
						)}
					>
						{phaseLabel[goal.phase]}
					</span>
					<span className="ml-auto shrink-0 text-micro text-text-tertiary">{t("dshTools.goalRounds", { rounds: goal.roundsStarted, cap: goal.maxGoalRounds })}</span>
				</div>
				<p className="text-caption text-foreground [overflow-wrap:anywhere]">{goal.objective}</p>
			</div>
		</div>
	);
}

/** 子代理目录 + 展开只读 transcript。 */
function SubagentsTab(props: { sessionId: string }) {
	const [entries, setEntries] = useState<WebDshSubagent[] | undefined>(undefined);
	const [expanded, setExpanded] = useState<string | null>(null);
	const [transcript, setTranscript] = useState<Array<{ role: string; text: string }>>([]);
	const [transcriptLoading, setTranscriptLoading] = useState(false);
	const [transcriptError, setTranscriptError] = useState(false);

	useEffect(() => {
		let cancelled = false;
		void fetchDshSubagents(props.sessionId)
			.then((result) => {
				if (!cancelled) setEntries(result.subagents);
			})
			.catch(() => {
				if (!cancelled) setEntries([]);
			});
		return () => {
			cancelled = true;
		};
	}, [props.sessionId]);

	const toggle = async (id: string) => {
		if (expanded === id) {
			setExpanded(null);
			setTranscript([]);
			setTranscriptError(false);
			return;
		}
		setExpanded(id);
		setTranscript([]);
		setTranscriptError(false);
		setTranscriptLoading(true);
		const page = await fetchDshSubagentHistory(props.sessionId, id).catch(() => null);
		setTranscriptLoading(false);
		if (page) {
			setTranscript(page.messages);
		} else {
			setTranscriptError(true);
		}
	};

	if (entries === undefined) return <LoadingRow />;
	if (entries.length === 0) {
		return <p className="p-3 text-caption text-text-secondary">{t("dshTools.subagentsEmpty")}</p>;
	}
	return (
		<div className="flex flex-col gap-1.5 p-1">
			{entries.map((entry) => (
				<div key={entry.id} className="flex flex-col rounded-lg border border-border-subtle bg-bg-panel/60">
					<button type="button" className="flex min-w-0 items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-accent/40" onClick={() => void toggle(entry.id)}>
						<Users size={13} className="shrink-0 text-muted-foreground" aria-hidden="true" />
						<span className="min-w-0 flex-1 truncate text-control font-medium text-foreground">{entry.label ?? entry.id}</span>
						{entry.activity === "running" ? (
							<span className="inline-flex shrink-0 items-center gap-1 rounded bg-primary/15 px-1.5 py-0.5 text-micro font-medium text-primary">
								<Loader2 size={11} className="animate-pideck-spin" aria-hidden="true" />
								{t("dshTools.subagentRunning")}
							</span>
						) : (
							<span className="inline-flex shrink-0 items-center rounded bg-accent/50 px-1.5 py-0.5 text-micro text-text-secondary">
								<span className="mr-1 inline-block size-1.5 rounded-full bg-muted-foreground/60" aria-hidden="true" />
								{t("dshTools.subagentInactive")}
							</span>
						)}
						{entry.kind === "diagnostic" && <span className="inline-flex shrink-0 items-center rounded bg-amber-500/15 px-1.5 py-0.5 text-micro text-amber-600 dark:text-amber-400">{t("dshTools.subagentDiagnostic")}</span>}
					</button>
					{expanded === entry.id && (
						<div className="flex max-h-56 flex-col gap-1 overflow-y-auto border-t border-border-subtle p-2">
							{transcriptLoading && (
								<p className="flex items-center gap-1.5 px-1 text-caption text-text-tertiary">
									<Loader2 size={13} className="animate-pideck-spin" aria-hidden="true" />
									{t("dshTools.loading")}
								</p>
							)}
							{!transcriptLoading && transcriptError && <p className="px-1 text-caption text-destructive">{t("dshTools.subagentTranscriptError")}</p>}
							{!transcriptLoading && !transcriptError && transcript.length === 0 && <p className="px-1 text-caption text-text-tertiary">{t("dshTools.subagentTranscriptEmpty")}</p>}
							{!transcriptLoading &&
								transcript.map((message, index) => (
									<div key={index} className={cn("flex flex-col gap-0.5 rounded-md px-2 py-1", message.role === "user" ? "bg-accent/30" : "bg-bg-panel")}>
										<span className="text-micro text-text-tertiary">{message.role === "user" ? t("dshTools.roleUser") : t("dshTools.roleAssistant")}</span>
										<span className="whitespace-pre-wrap break-words text-caption text-foreground">{message.text || "…"}</span>
									</div>
								))}
						</div>
					)}
				</div>
			))}
		</div>
	);
}

/** 技能目录：skill.list 只读 + /name 斜杠调用提示。 */
function SkillsTab(props: { sessionId: string }) {
	const [entries, setEntries] = useState<WebDshSkill[] | undefined>(undefined);
	useEffect(() => {
		let cancelled = false;
		void fetchDshSkills(props.sessionId)
			.then((result) => {
				if (!cancelled) setEntries(result.skills);
			})
			.catch(() => {
				if (!cancelled) setEntries([]);
			});
		return () => {
			cancelled = true;
		};
	}, [props.sessionId]);

	if (entries === undefined) return <LoadingRow />;
	if (entries.length === 0) {
		return <p className="p-3 text-caption text-text-secondary">{t("dshTools.skillsEmpty")}</p>;
	}
	return (
		<div className="flex flex-col gap-1.5 p-1">
			{entries.map((entry) => (
				<div key={entry.name} className="flex flex-col gap-1 rounded-lg border border-border-subtle bg-bg-panel/60 px-3 py-2">
					<div className="flex min-w-0 items-center gap-2">
						<Sparkles size={13} className="shrink-0 text-muted-foreground" aria-hidden="true" />
						<code className="min-w-0 flex-1 truncate text-control font-medium text-foreground">/{entry.name}</code>
						{!entry.modelInvocable && <span className="inline-flex shrink-0 items-center rounded bg-amber-500/15 px-1.5 py-0.5 text-micro font-medium text-amber-600 dark:text-amber-400">{t("dshTools.skillUserOnly")}</span>}
					</div>
					<p className="text-caption text-text-secondary">{entry.description}</p>
					{entry.whenToUse && <p className="text-micro text-text-tertiary">{entry.whenToUse}</p>}
					<p className="text-micro text-text-tertiary">{t("dshTools.skillInvokeHint", { name: entry.name })}</p>
				</div>
			))}
		</div>
	);
}

/**
 * 动态 Cordis 插件管理（S6.5，G13 语义）：清单 + 安装表单 + 运行/停止/两步卸载。
 * - 动态插件进程内临时：host 重启即失、按会话归属；
 * - 面板手势免审批（requestId=null）；Host 源码在 host 进程内执行——非安全边界。
 */
function PluginsTab(props: { sessionId: string }) {
	const [dynamic, setDynamic] = useState<WebDshPlugin[] | undefined>(undefined);
	const [staticEntries, setStaticEntries] = useState<Array<{ entryId: string; moduleName: string; enabled: boolean }>>([]);
	const [showInstall, setShowInstall] = useState(false);
	const [confirmUninstallId, setConfirmUninstallId] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [form, setForm] = useState({ idPrefix: "", name: "", purpose: "", hostCode: "" });

	const refresh = useCallback(() => {
		void fetchDshPlugins()
			.then((result) => {
				setDynamic(result.dynamic);
				setStaticEntries(result.static);
			})
			.catch(() => {
				setDynamic([]);
			});
	}, []);

	useEffect(() => {
		refresh();
	}, [refresh]);

	const run = useCallback(
		async (fn: () => Promise<unknown>, successKey?: "config.dsh.pluginInstalled" | "config.dsh.pluginRunStarted" | "config.dsh.pluginStoppedToast" | "config.dsh.pluginUninstalled") => {
			if (busy) return;
			setBusy(true);
			try {
				await fn();
				refresh();
				if (successKey) showNotice(t(successKey), 3000);
			} catch (error) {
				showNotice(error instanceof Error ? error.message : String(error), 4000);
			} finally {
				setBusy(false);
			}
		},
		[busy, refresh],
	);

	const submitInstall = () => {
		const idPrefix = form.idPrefix.trim();
		const name = form.name.trim();
		const purpose = form.purpose.trim();
		const hostCode = form.hostCode.trim();
		if (!/^[a-z]{3,6}$/.test(idPrefix)) {
			showNotice(t("config.dsh.pluginIdPrefixHint"), 3000);
			return;
		}
		if (!name || !purpose || !hostCode) {
			showNotice(t("config.dsh.pluginFormIncomplete"), 3000);
			return;
		}
		void run(async () => {
			await installDshPlugin({ sessionId: props.sessionId, idPrefix, name, purpose, hostCode });
		}, "config.dsh.pluginInstalled");
		setForm({ idPrefix: "", name: "", purpose: "", hostCode: "" });
		setShowInstall(false);
	};

	if (dynamic === undefined) return <LoadingRow />;
	return (
		<div className="flex flex-col gap-2 p-1">
			<div className="flex items-center justify-between gap-2">
				<p className="text-micro text-text-tertiary">{t("config.dsh.dynamicPluginsHint")}</p>
				<Button type="button" variant="outline" size="sm" className="h-7 shrink-0 text-caption" onClick={() => setShowInstall((value) => !value)}>
					{t("config.dsh.installPlugin")}
				</Button>
			</div>
			{/* 安装表单开合走共享折叠原语：高度渐变而非瞬时挂载把插件列表瞬间顶开；
			    display:contents 根不生成盒子，容器 gap 布局保持原样（与桌面端 DshPluginSection 同一套）。 */}
			<Collapsible open={showInstall} className="contents">
				<CollapsibleContent className="flex flex-col gap-1.5 rounded-lg border border-border-subtle bg-bg-panel/60 p-2">
					<Input value={form.idPrefix} onChange={(event) => setForm({ ...form, idPrefix: event.target.value })} placeholder={t("config.dsh.pluginIdPrefix")} className="h-8 text-caption" />
					<Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder={t("config.dsh.pluginName")} className="h-8 text-caption" />
					<Input value={form.purpose} onChange={(event) => setForm({ ...form, purpose: event.target.value })} placeholder={t("config.dsh.pluginPurpose")} className="h-8 text-caption" />
					<Textarea value={form.hostCode} onChange={(event) => setForm({ ...form, hostCode: event.target.value })} placeholder={t("config.dsh.pluginHostCode")} className="min-h-20 font-mono text-caption" />
					<p className="text-micro text-text-tertiary">{t("config.dsh.pluginClientCodeHint")}</p>
					<Button type="button" size="sm" className="self-end" disabled={busy} onClick={submitInstall}>
						{t("config.dsh.installPlugin")}
					</Button>
				</CollapsibleContent>
			</Collapsible>
			{dynamic.length === 0 && <p className="px-1 text-caption text-text-secondary">{t("config.dsh.dynamicPluginsEmpty")}</p>}
			{dynamic.map((plugin) => (
				<div key={plugin.pluginId} className="flex flex-col gap-1 rounded-lg border border-border-subtle bg-bg-panel/60 px-3 py-2">
					<div className="flex min-w-0 items-center gap-2">
						<Boxes size={13} className="shrink-0 text-muted-foreground" aria-hidden="true" />
						<code className="min-w-0 flex-1 truncate text-control font-medium text-foreground">{plugin.pluginId}</code>
						<span className={cn("shrink-0 rounded px-1.5 py-0.5 text-micro font-medium", plugin.activeRun ? "bg-primary/15 text-primary" : "bg-accent/50 text-text-secondary")}>{plugin.activeRun ? t("config.dsh.pluginRunning") : t("config.dsh.pluginStopped")}</span>
					</div>
					{plugin.packages.map((pkg) => (
						<div key={pkg.packageId} className="flex min-w-0 items-center gap-2">
							<span className="min-w-0 flex-1 truncate text-caption text-text-secondary">{pkg.name}</span>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className="h-6 shrink-0 px-2 text-micro"
								disabled={busy || Boolean(plugin.activeRun)}
								onClick={() =>
									void run(
										() =>
											dshPluginAction(plugin.pluginId, "run", {
												sessionId: props.sessionId,
												packageId: pkg.packageId,
											}),
										"config.dsh.pluginRunStarted",
									)
								}
							>
								{t("config.dsh.pluginRun")}
							</Button>
							<Button type="button" variant="ghost" size="sm" className="h-6 shrink-0 px-2 text-micro" disabled={busy || !plugin.activeRun} onClick={() => void run(() => dshPluginAction(plugin.pluginId, "stop", { sessionId: props.sessionId }), "config.dsh.pluginStoppedToast")}>
								{t("config.dsh.pluginStop")}
							</Button>
							<Button
								type="button"
								variant={confirmUninstallId === plugin.pluginId ? "destructive" : "ghost"}
								size="sm"
								className="h-6 shrink-0 px-2 text-micro"
								disabled={busy}
								onClick={() => {
									if (confirmUninstallId !== plugin.pluginId) {
										setConfirmUninstallId(plugin.pluginId);
										return;
									}
									setConfirmUninstallId(null);
									void run(() => dshPluginAction(plugin.pluginId, "uninstall", { sessionId: props.sessionId }), "config.dsh.pluginUninstalled");
								}}
							>
								{confirmUninstallId === plugin.pluginId ? t("common.confirm") : t("config.dsh.pluginUninstall")}
							</Button>
						</div>
					))}
					{plugin.error && <p className="text-micro text-destructive">{plugin.error}</p>}
				</div>
			))}
			{staticEntries.length > 0 && (
				<>
					<h4 className="mt-1 text-caption font-semibold text-muted-foreground">{t("config.dsh.staticPlugins")}</h4>
					<div className="flex flex-col gap-1">
						{staticEntries.map((entry) => (
							<div key={entry.entryId} className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1">
								<code className="min-w-0 flex-1 truncate text-caption text-text-secondary">{entry.moduleName}</code>
								<span className="shrink-0 text-micro text-text-tertiary">{entry.enabled ? t("config.dsh.pluginEnabled") : t("config.dsh.pluginDisabled")}</span>
							</div>
						))}
					</div>
				</>
			)}
		</div>
	);
}
