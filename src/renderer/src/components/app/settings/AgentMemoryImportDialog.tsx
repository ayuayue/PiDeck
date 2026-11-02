/**
 * 导入记忆包的二次确认弹窗：勾选要并入的条目、决定冲突怎么处理、是否同步删除。
 *
 * 预览来自主进程的 `previewBundle`（与真正落盘的 `mergeBundle` 是**同一份判断**），
 * 所以这里显示的「新增 / 已存在 / 冲突」与导完之后回执里的数字一定对得上。
 *
 * 四种状态里只有两种可选：
 * - `new` / `conflict` 可以勾；
 * - `duplicate`（本地已有同一条）、`tombstoned`（本地删过）与 `invalid`（拒收）灰掉并说明原因。
 *   允许勾选它们只会让用户以为「选了就会覆盖」，而实际是空操作。
 */

import { useMemo, useRef, useState } from "react";
import { Upload } from "lucide-react";
import type { AgentMemoryBundleEntryPreview, AgentMemoryBundlePreview } from "../../../../../shared/types/agentMemory";
import { t } from "../../../i18n";
import { desktopApi } from "../../../desktopApi";
import { Button } from "../../ui-shadcn/button";
import { Checkbox } from "../../ui-shadcn/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../ui-shadcn/dialog";
import { VirtualStack } from "../../ui-shadcn/virtual-stack";
import { describeAgentMemoryCode, memoryScopeLabel, memoryTargetLabel } from "./agentMemoryLabels";
import type { AgentMemoryImportResult } from "../../../../../shared/types/agentMemory";

/** 列表行：分组头（带该组第一条，用于显示作用域 / 目标）+ 条目。 */
type ImportRow = { kind: "group"; key: string; first: AgentMemoryBundleEntryPreview | undefined } | { kind: "entry"; key: string; entry: AgentMemoryBundleEntryPreview };

function selectable(entry: AgentMemoryBundleEntryPreview): boolean {
	return entry.status === "new" || entry.status === "conflict";
}

function statusLabel(entry: AgentMemoryBundleEntryPreview): string {
	switch (entry.status) {
		case "new":
			return t("settings.agentMemoryImportStatusNew");
		case "duplicate":
			return t("settings.agentMemoryImportStatusDuplicate");
		case "conflict":
			return t("settings.agentMemoryImportStatusConflict");
		case "tombstoned":
			return t("settings.agentMemoryImportStatusTombstoned");
		default:
			return t("settings.agentMemoryImportStatusInvalid");
	}
}

/** 状态徽标配色：新增=主色，冲突=警示，其余一律淡色（不可选）。 */
function statusClassName(status: AgentMemoryBundleEntryPreview["status"]): string {
	if (status === "new") return "bg-primary/10 text-primary";
	if (status === "conflict") return "bg-destructive/10 text-destructive";
	return "bg-muted text-muted-foreground";
}

export function AgentMemoryImportDialog(props: { filePath: string; preview: AgentMemoryBundlePreview; onCancel: () => void; onImported: (result: AgentMemoryImportResult) => void; onError: (code: string) => void }) {
	const { preview } = props;
	// 默认勾「新增 + 冲突」：这两类才是这次导入真正会改变本机的内容。
	const [selected, setSelected] = useState<Set<string>>(() => new Set(preview.entries.filter(selectable).map((entry) => entry.id)));
	const [conflictPolicy, setConflictPolicy] = useState<"append" | "overwrite">("append");
	const [applyTombstones, setApplyTombstones] = useState(true);
	const [busy, setBusy] = useState(false);

	const groups = useMemo(() => {
		const map = new Map<string, AgentMemoryBundleEntryPreview[]>();
		for (const entry of preview.entries) {
			const key = `${entry.scope}|${entry.projectId}|${entry.target}`;
			const list = map.get(key);
			if (list) list.push(entry);
			else map.set(key, [entry]);
		}
		return [...map.entries()];
	}, [preview.entries]);

	// 行模型：分组头 + 条目。包里的条目数随包大小增长，列表交给虚拟滚动（issue #481）。
	const rows = useMemo(() => {
		const out: ImportRow[] = [];
		for (const [key, entries] of groups) {
			out.push({ kind: "group", key: `group:${key}`, first: entries[0] });
			for (const entry of entries) out.push({ kind: "entry", key: entry.id || `${key}|${entry.status}|${entry.content.slice(0, 24)}`, entry });
		}
		return out;
	}, [groups]);
	const scrollRef = useRef<HTMLDivElement>(null);

	const toggle = (id: string) => {
		setSelected((current) => {
			const next = new Set(current);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	const purgeAffected = preview.tombstones.filter((item) => item.localContent).length;
	const nothingToDo = selected.size === 0 && !(applyTombstones && purgeAffected > 0);

	const runImport = async () => {
		setBusy(true);
		try {
			const result = await desktopApi.agentMemory.importBundle({ filePath: props.filePath, selection: [...selected], conflictPolicy, applyTombstones });
			if (!result.ok) props.onError(describeAgentMemoryCode(result.code));
			else if (result.value.canceled) props.onCancel();
			else props.onImported(result.value);
		} catch (cause) {
			props.onError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog open onOpenChange={(open) => (open ? undefined : props.onCancel())}>
			<DialogContent className="sm:max-w-2xl" data-testid="agent-memory-import-dialog">
				<DialogHeader>
					<DialogTitle>{t("settings.agentMemoryImportTitle")}</DialogTitle>
					<DialogDescription>{t("settings.agentMemoryImportDesc", { device: preview.device || t("settings.agentMemoryUnknownDevice") })}</DialogDescription>
				</DialogHeader>
				<p className="text-xs tabular-nums text-muted-foreground">
					{t("settings.agentMemoryImportCounts", {
						added: String(preview.counts.new),
						duplicate: String(preview.counts.duplicate),
						conflict: String(preview.counts.conflict),
						tombstoned: String(preview.counts.tombstoned),
						invalid: String(preview.counts.invalid),
					})}
				</p>
				{preview.counts.conflict > 0 ? (
					<div className="flex flex-col gap-1 rounded-md border p-2">
						<div className="flex items-center gap-2 text-xs text-muted-foreground">
							<span className="text-foreground">{t("settings.agentMemoryConflictPolicy")}</span>
							<Button type="button" size="sm" variant={conflictPolicy === "append" ? "secondary" : "outline"} onClick={() => setConflictPolicy("append")}>
								{t("settings.agentMemoryConflictAppend")}
							</Button>
							<Button type="button" size="sm" variant={conflictPolicy === "overwrite" ? "secondary" : "outline"} onClick={() => setConflictPolicy("overwrite")}>
								{t("settings.agentMemoryConflictOverwrite")}
							</Button>
						</div>
						<p className="text-xs text-muted-foreground">{conflictPolicy === "append" ? t("settings.agentMemoryConflictAppendDesc") : t("settings.agentMemoryConflictOverwriteDesc")}</p>
					</div>
				) : null}
				{/* 条目数随包大小增长：交给虚拟滚动，DOM 只挂视口附近的行。 */}
				<div ref={scrollRef} className="max-h-[48vh] overflow-y-auto rounded-md border">
					{groups.length === 0 ? <p className="px-4 py-6 text-xs text-muted-foreground">{t("settings.agentMemoryImportEmpty")}</p> : null}
					<VirtualStack
						items={rows}
						getKey={(row) => row.key}
						scrollRef={scrollRef}
						estimateHeight={64}
						renderItem={(row, index) => {
							if (row.kind === "group") {
								const first = row.first;
								return (
									<div className={`flex items-center gap-2 bg-muted/40 px-3 py-2 text-xs text-muted-foreground${index === 0 ? "" : " border-t border-border/60"}`}>
										<span className="rounded-sm bg-muted px-1.5 py-0.5 text-foreground">{first ? memoryScopeLabel(first.scope as "global" | "project", first.projectId, first.projectId) : ""}</span>
										<span>{first ? memoryTargetLabel(first.target) : ""}</span>
									</div>
								);
							}
							const entry = row.entry;
							return (
								<div className="px-3 py-1.5">
									<label className={selectable(entry) ? "flex cursor-pointer items-start gap-2 text-sm" : "flex items-start gap-2 text-sm opacity-60"}>
										<Checkbox className="mt-1" checked={selected.has(entry.id)} disabled={!selectable(entry)} onCheckedChange={() => toggle(entry.id)} aria-label={entry.content.slice(0, 40)} />
										<span className="min-w-0 flex-1">
											<span className="whitespace-pre-wrap break-words text-foreground">{entry.content}</span>
											{entry.status === "conflict" && entry.localContent ? <span className="mt-0.5 block whitespace-pre-wrap break-words text-xs text-muted-foreground">{t("settings.agentMemoryImportLocalVersion", { content: entry.localContent })}</span> : null}
										</span>
										<span className={`shrink-0 rounded-sm px-1.5 py-0.5 text-micro ${statusClassName(entry.status)}`}>{statusLabel(entry)}</span>
									</label>
								</div>
							);
						}}
					/>
				</div>
				{purgeAffected > 0 ? (
					<label className="flex cursor-pointer items-start gap-2 text-xs text-muted-foreground">
						<Checkbox className="mt-0.5" checked={applyTombstones} onCheckedChange={(value) => setApplyTombstones(value === true)} aria-label={t("settings.agentMemoryImportTombstones")} />
						<span>{t("settings.agentMemoryImportTombstones", { count: String(purgeAffected) })}</span>
					</label>
				) : null}
				<DialogFooter>
					<Button type="button" variant="outline" onClick={props.onCancel} disabled={busy}>
						{t("common.cancel")}
					</Button>
					<Button type="button" onClick={() => void runImport()} disabled={busy || nothingToDo}>
						<Upload size={14} strokeWidth={2} aria-hidden="true" />
						{t("settings.agentMemoryImport")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
