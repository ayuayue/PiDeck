/**
 * Web 端会话活动监控条：子代理 / 任务清单。
 *
 * 数据与桌面端 SessionSubagentsStrip / SessionTodoStrip 同源
 * （agentManager.readSessionSubagentRecords / readSessionTodo，
 * 经 /api/sessions/:id/{subagents,todo}）。这里做轻量版呈现：
 * - 子代理：类型徽标 + 描述 + 状态，可展开查看 result/error；
 * - 任务清单：完成态描边文本（与桌面一致以文本为准，不做交互）。
 * 轮询 5s 且页面不可见时跳过，避免手机后台空耗流量。
 *
 * 2027-02：「文件修改」条已移除。桌面端与 Web 端都不再展示会话级文件清单——
 * 桌面侧由每轮末尾的 chip 行（turn/TurnFileChanges）承担，Web 端没有 TurnRow，
 * 因此直接不展示（原 /api/sessions/:id/file-changes 端点已随之下线）。
 */
import { useEffect, useState } from "react";
import { CheckCircle2, ChevronDown, Circle, ListTodo, Sparkles } from "lucide-react";
import type { PiSubagentEntry, SessionTodoSnapshot } from "../../../shared/types";
import { t, type TranslationKey } from "@/i18n";
import { fetchSessionSubagents, fetchSessionTodo } from "./webApi";
import { Collapsible, CollapsibleContent } from "@/components/ui-shadcn/collapsible";

function useSessionActivity(sessionId: string | null) {
	const [subagents, setSubagents] = useState<PiSubagentEntry[]>([]);
	const [todo, setTodo] = useState<SessionTodoSnapshot | null>(null);

	useEffect(() => {
		if (!sessionId) {
			setSubagents([]);
			setTodo(null);
			return;
		}
		let cancelled = false;
		const load = async () => {
			if (document.hidden) return; // 后台标签页不轮询（SSE 断流时也无需刷新 strips）
			try {
				const [nextSubagents, nextTodo] = await Promise.all([fetchSessionSubagents(sessionId), fetchSessionTodo(sessionId)]);
				if (cancelled) return;
				setSubagents(nextSubagents);
				setTodo(nextTodo);
			} catch {
				// 503（服务未注入）/ 网络抖动：保留上一份快照，下轮重试
			}
		};
		load();
		const timer = setInterval(load, 5000);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [sessionId]);

	return { subagents, todo };
}

const SUB_STATUS_LABEL: Record<PiSubagentEntry["status"], TranslationKey> = {
	queued: "web.subStatusQueued",
	running: "web.subStatusRunning",
	completed: "web.subStatusCompleted",
	steered: "web.subStatusSteered",
	aborted: "web.subStatusAborted",
	stopped: "web.subStatusStopped",
	error: "web.subStatusError",
};

const SUB_STATUS_TONE: Record<PiSubagentEntry["status"], string> = {
	queued: "text-zinc-500",
	running: "text-sky-500",
	completed: "text-emerald-500",
	steered: "text-amber-500",
	aborted: "text-zinc-500",
	stopped: "text-zinc-500",
	error: "text-red-500",
};

function basename(path: string): string {
	const parts = path.split(/[\\/]/);
	return parts[parts.length - 1] || path;
}

function StripShell({ icon, title, count, children }: { icon: React.ReactNode; title: string; count: number; children: React.ReactNode }) {
	// 默认折叠：三条 strip 全展开在移动端正屏占位过大；标题行本身就是可点的摘要，点按才展开明细。
	const [open, setOpen] = useState(false);
	return (
		<section className="border-b border-border-subtle last:border-b-0">
			<button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="flex min-h-8 w-full items-center gap-1.5 px-1 py-1 text-xs text-text-tertiary transition-colors hover:text-text-secondary">
				<span className="text-text-tertiary">{icon}</span>
				<span className="font-medium">{title}</span>
				<span className="rounded-full bg-bg-muted px-1.5 py-px text-micro leading-4 tabular-nums text-text-secondary">{count}</span>
				<ChevronDown className={`ml-auto size-3.5 transition-transform ${open ? "" : "-rotate-90"}`} />
			</button>
			{/* 折叠体走共享折叠原语（真高度渐变 + exit 后卸载 + reduced-motion 回退）；
			    display:contents 根不生成盒子，折叠态零空档；与桌面端 SessionTodoStrip/SessionSubagentsStrip 同一套。 */}
			<Collapsible open={open} className="contents">
				<CollapsibleContent className="px-1 pt-0.5 pb-2">{children}</CollapsibleContent>
			</Collapsible>
		</section>
	);
}

function WebSubagentsStrip({ subagents }: { subagents: PiSubagentEntry[] }) {
	const [expanded, setExpanded] = useState<string | null>(null);
	if (subagents.length === 0) return null;
	return (
		<StripShell icon={<Sparkles className="size-3.5" />} title={t("web.subagentsStripTitle")} count={subagents.length}>
			<ul className="flex max-h-40 flex-col gap-1 overflow-y-auto">
				{subagents.map((entry) => {
					const isOpen = expanded === entry.id;
					return (
						<li key={entry.id} className="shrink-0 rounded border border-border-subtle bg-bg-panel px-2 py-1 text-xs">
							<div className="flex items-center gap-1.5">
								<span className="shrink-0 rounded bg-primary/10 px-1 py-0.5 text-micro font-medium text-primary">{entry.type}</span>
								<span className="min-w-0 flex-1 truncate text-text-tertiary" title={entry.description}>
									{entry.description}
								</span>
								<span className={`shrink-0 text-micro ${SUB_STATUS_TONE[entry.status]}`}>{t(SUB_STATUS_LABEL[entry.status])}</span>
								{(entry.result || entry.error) && (
									<button type="button" aria-label={entry.description} onClick={() => setExpanded(isOpen ? null : entry.id)} className="shrink-0 rounded p-0.5 text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary pointer-coarse:p-1.5">
										<ChevronDown className={`size-3 transition-transform ${isOpen ? "rotate-180" : ""}`} />
									</button>
								)}
							</div>
							{/* 行详情走共享折叠原语（真高度渐变 + exit 后卸载）；与桌面端子代理行详情同一套。 */}
							<Collapsible open={isOpen} className="contents">
								<CollapsibleContent>
									<pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-bg-muted p-1.5 text-micro leading-relaxed text-text-secondary">{entry.error ?? entry.result}</pre>
								</CollapsibleContent>
							</Collapsible>
						</li>
					);
				})}
			</ul>
		</StripShell>
	);
}

function WebTodoStrip({ todo }: { todo: SessionTodoSnapshot | null }) {
	if (!todo || todo.todos.length === 0) return null;
	return (
		<StripShell icon={<ListTodo className="size-3.5" />} title={t("web.todoStripTitle")} count={todo.todos.length}>
			{/* 限高滚动容器内的行必须 shrink-0（2027-01 桌面端压缩事故：overflow-hidden 行会被 flex 压扁叠字） */}
			<ul className="flex max-h-40 flex-col gap-1 overflow-y-auto">
				{todo.todos.map((item) => (
					<li key={`${todo.planId}-${item.id}`} className="flex shrink-0 items-start gap-1.5 rounded border border-border-subtle bg-bg-panel px-2 py-1 text-xs">
						{item.status === "completed" ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-500" /> : item.status === "in_progress" ? <Circle className="mt-0.5 size-3.5 shrink-0 animate-pulse text-sky-500" /> : <Circle className="mt-0.5 size-3.5 shrink-0 text-text-tertiary" />}
						<span className={item.status === "completed" ? "text-text-tertiary line-through" : ""}>{item.text}</span>
					</li>
				))}
			</ul>
		</StripShell>
	);
}

/** strip 组合容器：仅渲染有数据的一条或多条。 */
export function WebSessionStrips({ sessionId }: { sessionId: string | null }) {
	const { subagents, todo } = useSessionActivity(sessionId);
	if (!sessionId) return null;
	const empty = subagents.length === 0 && (!todo || todo.todos.length === 0);
	if (empty) return null;
	return (
		<div className="flex flex-col border-t border-border-subtle px-3" aria-label={t("web.subagentsStripTitle")}>
			<WebSubagentsStrip subagents={subagents} />
			<WebTodoStrip todo={todo} />
		</div>
	);
}
