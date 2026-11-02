/**
 * 导出记忆包的二次确认弹窗：勾选要写进包里的条目。
 *
 * 为什么需要它：记忆是同一条事实的多份版本在不同机器上累积的，全量导出常把「这台机器
 * 才成立」的内容也带走（尽管设备作用域已经排除）。让用户先看一眼再选，是唯一能避免
 * 「导完发现包里全是别人的项目记忆」的办法。
 *
 * 数据来源是 `list()`（与记忆 tab 同一个只读视图），勾选键用后端算好的 `exportId`：
 * 渲染层不自己拼身份，否则 `failure` 条目（包里是去掉分类前缀的纯内容）会错位。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Download } from "lucide-react";
import type { AgentMemoryEntryGroup } from "../../../../../shared/types/agentMemory";
import { t } from "../../../i18n";
import { desktopApi } from "../../../desktopApi";
import { Button } from "../../ui-shadcn/button";
import { Checkbox } from "../../ui-shadcn/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../ui-shadcn/dialog";
import { describeAgentMemoryCode, memoryGroupScopeLabel, memoryTargetLabel } from "./agentMemoryLabels";

/** 设备作用域按定义不出设备，导出弹窗里直接不出现，免得用户以为漏选了。 */
function exportableGroups(groups: AgentMemoryEntryGroup[]): AgentMemoryEntryGroup[] {
	return groups.filter((group) => group.scope !== "device" && group.entries.length > 0);
}

export function AgentMemoryExportDialog(props: { onCancel: () => void; onExported: (entries: number) => void; onError: (code: string) => void }) {
	const [groups, setGroups] = useState<AgentMemoryEntryGroup[] | null>(null);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [busy, setBusy] = useState(false);
	// 回调放 ref：父组件每次渲染都会传新的箭头函数，直接进依赖会让「读一次列表」变成死循环。
	const onErrorRef = useRef(props.onError);
	onErrorRef.current = props.onError;

	useEffect(() => {
		let alive = true;
		void desktopApi.agentMemory.list().then((result) => {
			if (!alive) return;
			if (!result.ok) {
				onErrorRef.current(describeAgentMemoryCode(result.code));
				return;
			}
			const next = exportableGroups(result.value.groups);
			setGroups(next);
			// 默认全选：导出最常见的需求就是「把这台机器上的一切带走给别人」。
			setSelected(new Set(next.flatMap((group) => group.entries.map((entry) => entry.exportId))));
		});
		return () => {
			alive = false;
		};
		// 只在挂载时读一次：弹窗打开后列表可能被后台 Agent 改动，但中途刷新会打乱用户勾选。
	}, []);

	const total = useMemo(() => groups?.reduce((sum, group) => sum + group.entries.length, 0) ?? 0, [groups]);

	const toggle = (id: string) => {
		setSelected((current) => {
			const next = new Set(current);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	const toggleGroup = (group: AgentMemoryEntryGroup) => {
		const ids = group.entries.map((entry) => entry.exportId);
		const all = ids.every((id) => selected.has(id));
		setSelected((current) => {
			const next = new Set(current);
			for (const id of ids) {
				if (all) next.delete(id);
				else next.add(id);
			}
			return next;
		});
	};

	const runExport = async () => {
		setBusy(true);
		try {
			const result = await desktopApi.agentMemory.exportBundle([...selected]);
			if (!result.ok) props.onError(describeAgentMemoryCode(result.code));
			else if (result.value.canceled) props.onCancel();
			else props.onExported(result.value.entries ?? 0);
		} catch (cause) {
			props.onError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog open onOpenChange={(open) => (open ? undefined : props.onCancel())}>
			<DialogContent className="sm:max-w-2xl" data-testid="agent-memory-export-dialog">
				<DialogHeader>
					<DialogTitle>{t("settings.agentMemoryExportTitle")}</DialogTitle>
					<DialogDescription>{t("settings.agentMemoryExportDesc")}</DialogDescription>
				</DialogHeader>
				<div className="flex items-center justify-between text-xs text-muted-foreground">
					<span className="tabular-nums">{groups ? t("settings.agentMemoryExportSelected", { selected: String(selected.size), total: String(total) }) : t("common.loading")}</span>
					<span className="flex items-center gap-2">
						<Button type="button" variant="ghost" size="sm" disabled={!groups || total === 0} onClick={() => setSelected(new Set(groups?.flatMap((group) => group.entries.map((entry) => entry.exportId)) ?? []))}>
							{t("settings.agentMemorySelectAll")}
						</Button>
						<Button type="button" variant="ghost" size="sm" disabled={!groups || total === 0} onClick={() => setSelected(new Set())}>
							{t("settings.agentMemorySelectNone")}
						</Button>
					</span>
				</div>
				{/* scroll-ok: bounded —— 导出对话框内的分组勾选列表：高度封顶 52vh，数据来自一次盘点结果，行数由所选分区决定，不需要虚拟化 */}
				<div className="max-h-[52vh] overflow-y-auto rounded-md border">
					{groups && groups.length === 0 ? <p className="px-4 py-6 text-xs text-muted-foreground">{t("settings.agentMemoryExportEmpty")}</p> : null}
					{groups?.map((group) => {
						const ids = group.entries.map((entry) => entry.exportId);
						const picked = ids.filter((id) => selected.has(id)).length;
						const state = picked === 0 ? false : picked === ids.length ? true : "indeterminate";
						return (
							<div key={`${group.scope}|${group.projectId}|${group.target}`} className="border-b last:border-b-0">
								<label className="flex cursor-pointer items-center gap-2 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
									<Checkbox checked={state} onCheckedChange={() => toggleGroup(group)} aria-label={memoryGroupScopeLabel(group)} />
									<span className="rounded-sm bg-muted px-1.5 py-0.5 text-foreground">{memoryGroupScopeLabel(group)}</span>
									<span>{memoryTargetLabel(group.target)}</span>
									<span className="font-mono opacity-70">{group.file}</span>
									<span className="ml-auto tabular-nums">
										{picked}/{ids.length}
									</span>
								</label>
								{group.entries.map((entry) => (
									<label key={entry.exportId} className="flex cursor-pointer items-start gap-2 px-3 py-1.5 text-sm hover:bg-accent/40">
										<Checkbox className="mt-1" checked={selected.has(entry.exportId)} onCheckedChange={() => toggle(entry.exportId)} aria-label={entry.content.slice(0, 40)} />
										<span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-foreground">{entry.content}</span>
									</label>
								))}
							</div>
						);
					})}
				</div>
				<DialogFooter>
					<Button type="button" variant="outline" onClick={props.onCancel} disabled={busy}>
						{t("common.cancel")}
					</Button>
					<Button type="button" onClick={() => void runExport()} disabled={busy || selected.size === 0}>
						<Download size={14} strokeWidth={2} aria-hidden="true" />
						{t("settings.agentMemoryExport")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
