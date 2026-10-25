import { useAtomValue } from "jotai";
import { CheckCircle2, Loader2, Pause, Play, Sparkles, Target, Users, XCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { sessionRuntimeBySessionIdAtomFamily } from "../../atoms";
import { desktopApi } from "../../desktopApi";
import { t } from "../../i18n";
import { replaceExpandedRefBlocksWithLabels } from "./composer/quoteChip";
import { showNotice } from "../../utils/notice";
import { Button } from "../ui-shadcn/button";
import { ConfirmDialog } from "../ui-shadcn/ConfirmDialog";
import { Dialog, DialogContent } from "../ui-shadcn/dialog";
import { Input } from "../ui-shadcn/input";
import { Progress } from "../ui-shadcn/progress";

/**
 * DSH 会话工具面板（G5/G6/G7）：目标管理 + 子代理呈现 + 技能目录。
 * - 目标：当前 goal（runtime state 投影）显示 + 创建 / pause / resume / complete / clear；
 * - 子代理：subagent.list 直接子代目录 + 展开只读 transcript；
 * - 技能：skill.list 只读目录（/name 斜杠调用提示，不做管理）。
 */
export function DshAgentToolsPanel(props: { sessionId: string; agentId: string; onClose: () => void }) {
	const [tab, setTab] = useState<"goals" | "subagents" | "skills">("goals");
	return (
		<Dialog open onOpenChange={(next) => !next && props.onClose()}>
			<DialogContent showCloseButton className="sm:max-w-lg">
				<div className="flex gap-1 border-b border-border-subtle pb-2">
					<Button variant={tab === "goals" ? "secondary" : "ghost"} size="sm" className="gap-1.5" onClick={() => setTab("goals")}>
						<Target size={14} aria-hidden="true" />
						{t("dshTools.goals")}
					</Button>
					<Button variant={tab === "subagents" ? "secondary" : "ghost"} size="sm" className="gap-1.5" onClick={() => setTab("subagents")}>
						<Users size={14} aria-hidden="true" />
						{t("dshTools.subagents")}
					</Button>
					<Button variant={tab === "skills" ? "secondary" : "ghost"} size="sm" className="gap-1.5" onClick={() => setTab("skills")}>
						<Sparkles size={14} aria-hidden="true" />
						{t("dshTools.skills")}
					</Button>
				</div>
				<div className="min-h-40 overflow-y-auto">
					{tab === "goals" && <GoalsPanel sessionId={props.sessionId} agentId={props.agentId} />}
					{tab === "subagents" && <SubagentsPanel agentId={props.agentId} />}
					{tab === "skills" && <SkillsPanel agentId={props.agentId} />}
				</div>
			</DialogContent>
		</Dialog>
	);
}

/** 目标管理：当前 goal（runtime state 投影）+ 创建/操作。 */
function GoalsPanel(props: { sessionId: string; agentId: string }) {
	const runtime = useAtomValue(sessionRuntimeBySessionIdAtomFamily(props.sessionId));
	const goal = runtime?.state?.goal;
	const [objective, setObjective] = useState("");
	const [busy, setBusy] = useState(false);
	const [confirmClear, setConfirmClear] = useState(false);

	const run = useCallback(
		async (fn: () => Promise<void>) => {
			if (busy) return;
			setBusy(true);
			try {
				await fn();
			} catch (error) {
				showNotice(error instanceof Error ? error.message : String(error), 4000);
			} finally {
				setBusy(false);
			}
		},
		[busy],
	);

	const create = () => {
		if (!objective.trim()) return;
		void run(async () => {
			await desktopApi.sessions.createDshGoal(props.agentId, objective);
			setObjective("");
		});
	};

	const act = (action: "pause" | "resume" | "complete" | "clear") => {
		void run(() => desktopApi.sessions.runDshGoalAction(props.agentId, action));
	};

	const goalPhase = goal?.phase ?? "active";
	const phaseBadgeClass = goalPhase === "complete" ? "bg-blue-500/15 text-blue-600 dark:text-blue-400" : goalPhase === "blocked" ? "bg-red-500/15 text-red-600 dark:text-red-400" : goalPhase === "paused" ? "bg-amber-500/15 text-amber-600 dark:text-amber-400" : "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400";
	const roundsStarted = Math.max(0, goal?.roundsStarted ?? 0);
	const maxGoalRounds = Math.max(0, goal?.maxGoalRounds ?? 0);
	const progressPercent = maxGoalRounds > 0 ? Math.max(0, Math.min(100, (roundsStarted / maxGoalRounds) * 100)) : 0;

	return (
		<div className="flex flex-col gap-3 p-1">
			{goal ? (
				<div className="flex flex-col gap-2 rounded-lg border border-border-subtle bg-bg-panel/60 p-3">
					<div className="flex items-start gap-2">
						<Target size={14} className="mt-0.5 shrink-0 text-primary" aria-hidden="true" />
						<span className="min-w-0 flex-1 whitespace-normal break-words text-control font-medium leading-5 text-foreground">{goal.objective}</span>
						<span className={`shrink-0 rounded px-1.5 py-0.5 text-micro font-medium ${phaseBadgeClass}`}>{t(`dshTools.goalPhase.${goal.phase}`)}</span>
					</div>
					<div className="flex items-center gap-2">
						<Progress value={progressPercent} className="h-1.5 flex-1" aria-valuetext={t("dshTools.goalProgressAria", { rounds: roundsStarted, cap: maxGoalRounds })} />
						<span className="shrink-0 font-mono text-micro tabular-nums text-text-tertiary">
							{roundsStarted}/{maxGoalRounds}
						</span>
					</div>
					<div className="flex items-center justify-between gap-2">
						<span className="text-micro text-text-tertiary">{t("dshTools.goalRounds", { rounds: roundsStarted, cap: maxGoalRounds })}</span>
						<div className="flex shrink-0 gap-1">
							{goal.phase === "active" && (
								<Button variant="outline" size="sm" className="h-7 gap-1 px-2" disabled={busy} onClick={() => act("pause")}>
									<Pause size={12} aria-hidden="true" />
									{t("dshTools.goalPause")}
								</Button>
							)}
							{(goal.phase === "paused" || goal.phase === "blocked") && (
								<Button variant="outline" size="sm" className="h-7 gap-1 px-2" disabled={busy} onClick={() => act("resume")}>
									<Play size={12} aria-hidden="true" />
									{t("dshTools.goalResume")}
								</Button>
							)}
							{goal.phase !== "complete" && (
								<Button variant="outline" size="sm" className="h-7 gap-1 px-2" disabled={busy} onClick={() => act("complete")}>
									<CheckCircle2 size={12} aria-hidden="true" />
									{t("dshTools.goalComplete")}
								</Button>
							)}
							<Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-destructive" disabled={busy} onClick={() => setConfirmClear(true)}>
								<XCircle size={12} aria-hidden="true" />
								{t("dshTools.goalClear")}
							</Button>
						</div>
					</div>
				</div>
			) : (
				<p className="px-1 text-caption text-text-secondary">{t("dshTools.goalEmpty")}</p>
			)}
			<div className="flex gap-2">
				<Input
					value={objective}
					onChange={(event) => setObjective(event.target.value)}
					placeholder={t("dshTools.goalPlaceholder")}
					onKeyDown={(event) => {
						if (event.key === "Enter") create();
					}}
				/>
				<Button size="sm" className="shrink-0 gap-1" disabled={busy || !objective.trim()} onClick={create}>
					{busy && <Loader2 size={12} className="animate-pideck-spin" aria-hidden="true" />}
					{t("dshTools.goalCreate")}
				</Button>
			</div>
			{confirmClear ? (
				<ConfirmDialog
					title={t("dshTools.goalClearConfirmTitle")}
					message={t("dshTools.goalClearConfirmMessage")}
					danger
					confirmLabel={t("dshTools.goalClear")}
					onConfirm={() => {
						setConfirmClear(false);
						act("clear");
					}}
					onCancel={() => setConfirmClear(false)}
				/>
			) : null}
		</div>
	);
}

type SubagentEntry = {
	id: string;
	label?: string;
	activity: "running" | "inactive";
	hasChildren: boolean;
	mode: "one-shot" | "continuable";
	kind: "child" | "diagnostic";
};

/** 子代理列表 + 展开只读 transcript。 */
function SubagentsPanel(props: { agentId: string }) {
	const [entries, setEntries] = useState<SubagentEntry[]>([]);
	const [loading, setLoading] = useState(true);
	const [expanded, setExpanded] = useState<string | null>(null);
	const [transcript, setTranscript] = useState<Array<{ role: string; text: string }>>([]);
	const [transcriptLoading, setTranscriptLoading] = useState(false);
	const [transcriptError, setTranscriptError] = useState(false);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		void desktopApi.sessions
			.listDshSubagents(props.agentId)
			.then((items) => {
				if (!cancelled) setEntries(items);
			})
			.catch(() => {
				if (!cancelled) setEntries([]);
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [props.agentId]);

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
		const page = await desktopApi.sessions.readDshSubagentHistory(props.agentId, id).catch(() => null);
		setTranscriptLoading(false);
		if (page) {
			setTranscript(page.messages.map((message) => ({ role: message.role, text: replaceExpandedRefBlocksWithLabels(message.text) })));
		} else {
			setTranscriptError(true);
		}
	};

	if (loading) {
		return (
			<div className="flex items-center gap-2 p-3 text-caption text-text-secondary">
				<Loader2 size={14} className="animate-pideck-spin" aria-hidden="true" />
				{t("dshTools.loading")}
			</div>
		);
	}
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
							<span className="shrink-0 inline-flex items-center rounded bg-accent/50 px-1.5 py-0.5 text-micro text-text-secondary">
								<span className="mr-1 inline-block size-1.5 rounded-full bg-muted-foreground/60" aria-hidden="true" />
								{t("dshTools.subagentInactive")}
							</span>
						)}
						{entry.kind === "diagnostic" && <span className="shrink-0 inline-flex items-center rounded bg-amber-500/15 px-1.5 py-0.5 text-micro text-amber-600 dark:text-amber-400">{t("dshTools.subagentDiagnostic")}</span>}
						<span className="shrink-0 text-micro text-text-tertiary">{entry.mode === "continuable" ? t("dshTools.subagentContinuable") : t("dshTools.subagentOneShot")}</span>
					</button>
					{expanded === entry.id && (
						<div className="flex max-h-56 flex-col gap-1 overflow-y-auto border-t border-border-subtle p-2">
							{transcriptLoading && (
								<p className="flex items-center gap-1.5 px-1 text-caption text-text-tertiary">
									<Loader2 size={13} className="animate-pideck-spin" aria-hidden="true" />
									{t("dshTools.loading")}
								</p>
							)}
							{!transcriptLoading && transcriptError && <p className="px-1 text-caption text-[var(--color-danger)]">{t("dshTools.subagentTranscriptError")}</p>}
							{!transcriptLoading && !transcriptError && transcript.length === 0 && <p className="px-1 text-caption text-text-tertiary">{t("dshTools.subagentTranscriptEmpty")}</p>}
							{!transcriptLoading &&
								transcript.map((message, index) => (
									<div key={index} className={`flex flex-col gap-0.5 rounded-md px-2 py-1 ${message.role === "user" ? "bg-accent/30" : "bg-bg-panel"}`}>
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

type SkillEntry = {
	name: string;
	description: string;
	whenToUse?: string;
	modelInvocable: boolean;
};

/** 技能目录（G7）：skill.list 只读清单 + /name 斜杠调用提示。 */
function SkillsPanel(props: { agentId: string }) {
	const [entries, setEntries] = useState<SkillEntry[]>([]);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		void desktopApi.sessions
			.listDshSkills(props.agentId)
			.then((items) => {
				if (!cancelled) setEntries(items);
			})
			.catch(() => {
				if (!cancelled) setEntries([]);
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [props.agentId]);

	if (loading) {
		return (
			<div className="flex items-center gap-2 p-3 text-caption text-text-secondary">
				<Loader2 size={14} className="animate-pideck-spin" aria-hidden="true" />
				{t("dshTools.loading")}
			</div>
		);
	}
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
						{!entry.modelInvocable && <span className="shrink-0 inline-flex items-center rounded bg-amber-500/15 px-1.5 py-0.5 text-micro font-medium text-amber-600 dark:text-amber-400">{t("dshTools.skillUserOnly")}</span>}
					</div>
					<p className="text-caption text-text-secondary">{entry.description}</p>
					{entry.whenToUse && <p className="text-micro text-text-tertiary">{entry.whenToUse}</p>}
					<p className="text-micro text-text-tertiary">{t("dshTools.skillInvokeHint", { name: entry.name })}</p>
				</div>
			))}
		</div>
	);
}
