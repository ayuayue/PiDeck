import { Folder, FolderX, X } from "lucide-react";
import { useState } from "react";
import type { Project } from "../../../../shared/types";
import { isRemoteProject } from "../../../../shared/projectLocation";
import { t } from "../../i18n";
import { displayProjectDirectoryName } from "../../rendererUtils";
import type { BatchProjectRemovalOutcome } from "../../utils/batchProjectRemoval";
import { Button } from "../ui-shadcn/button";
import { Checkbox } from "../ui-shadcn/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui-shadcn/dialog";
import { Label } from "../ui-shadcn/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui-shadcn/table";

/** 批量移除的汇总结果：定义在纯函数模块里，App 与弹窗共用同一份契约。 */
export type { BatchProjectRemovalOutcome } from "../../utils/batchProjectRemoval";

/** 项目目录的展示路径：远端项目只有 remotePath，不能当本机路径处理。 */
function projectDisplayPath(project: Project) {
	return isRemoteProject(project) ? project.locator.remotePath : project.path;
}

/**
 * 批量删除项目记录弹窗：列出全部工作区项目，勾选后逐个移除。
 *
 * 产品行为：
 * - 只移除 PiDeck 里的项目记录（列表、会话索引、worktree 子工作区），不动磁盘目录；
 * - 「全选」勾的是整个清单（清单一次全量渲染，没有分页语义），选中集合始终按传入的清单
 *   过滤——移除过程中清单会变短，stale id 不能继续算进「已选」；
 * - 逐项串行移除并回报进度：单次 IPC 一个项目，失败不会连累后面的项目；
 * - 有失败时保留弹窗与选中项，让用户看清结果后重试；全部成功才关闭。
 *
 * 布局与会话管理（SessionManagerDialog）同一套语言：header 计数/关闭 + 工具栏全选 + 表格，
 * 行内不再堆两行文字，名称与路径各占一列。
 */
export function BatchRemoveProjectsDialog(props: { projects: readonly Project[]; onRemove: (projectIds: readonly string[], onProgress?: (done: number, total: number) => void) => Promise<BatchProjectRemovalOutcome>; onClose: () => void }) {
	const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
	const [busy, setBusy] = useState<{ done: number; total: number } | null>(null);
	// 移除后仍有失败项时留在弹窗里给一句结论，避免「点完没反应、也不知道删没删」。
	const [outcome, setOutcome] = useState<BatchProjectRemovalOutcome | null>(null);

	// 清单可能在中途变短（前面的项目被移除）：选中集合只存 id，实际勾选取值按当前清单过滤，
	// stale id 自动失效，不需要额外维护。
	const checkedIds = props.projects.filter((project) => selected.has(project.id)).map((project) => project.id);
	const checked = new Set(checkedIds);
	const total = props.projects.length;
	const allSelected = total > 0 && checked.size === total;
	const someSelected = checked.size > 0 && !allSelected;
	const removing = busy !== null;

	const toggle = (projectId: string) => {
		if (removing) return;
		setOutcome(null);
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(projectId)) next.delete(projectId);
			else next.add(projectId);
			return next;
		});
	};
	const toggleAll = () => {
		if (removing) return;
		setOutcome(null);
		setSelected(allSelected ? new Set() : new Set(props.projects.map((project) => project.id)));
	};
	const remove = async () => {
		if (checkedIds.length === 0 || removing) return;
		const target = checkedIds;
		setBusy({ done: 0, total: target.length });
		setOutcome(null);
		const result = await props.onRemove(target, (done, count) => setBusy({ done, total: count }));
		setBusy(null);
		if (result.failed === 0) {
			props.onClose();
			return;
		}
		// 失败项保持选中（成功项已被过滤出勾选集合）：用户可以只针对剩下的重试，或直接取消。
		setOutcome(result);
	};

	return (
		<Dialog
			open
			onOpenChange={(next) => {
				if (!next && !removing) props.onClose();
			}}
		>
			<DialogContent showCloseButton={false} className="flex max-h-[min(760px,calc(100vh-48px))] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(820px,calc(100vw-48px))]">
				<DialogHeader className="flex-row items-start justify-between gap-3 px-5 py-4">
					<div className="flex min-w-0 flex-col gap-1 text-left">
						<DialogTitle>{t("app.projectsBatchRemoveTitle")}</DialogTitle>
						<DialogDescription className="text-label">{t("app.projectsBatchRemoveDesc")}</DialogDescription>
					</div>
					<Button variant="ghost" size="icon" className="-mt-1 shrink-0" aria-label={t("common.close")} title={t("common.close")} disabled={removing} onClick={props.onClose}>
						<X size={18} strokeWidth={2.2} aria-hidden="true" />
					</Button>
				</DialogHeader>

				{total === 0 ? (
					<p className="px-5 py-12 text-center text-body text-muted-foreground">{t("app.projectsBatchRemoveEmpty")}</p>
				) : (
					<>
						{/* 工具栏与会话管理同层级：左边全选（勾整个清单），右边是选中/进度/结果一句话。
						    行用 label 包 Checkbox，整块可点、键盘可达。 */}
						<div className="flex shrink-0 items-center justify-between gap-3 border-y border-border-subtle bg-bg-muted px-5 py-2.5">
							<Label className="flex cursor-pointer items-center gap-2 text-control text-text-secondary select-none">
								<Checkbox checked={allSelected ? true : someSelected ? "indeterminate" : false} disabled={removing} onCheckedChange={toggleAll} className="m-0 size-[15px] cursor-pointer accent-[var(--color-accent)]" />
								{t("app.projectsBatchRemoveSelectAll", { count: total })}
							</Label>
							<p className="truncate text-label text-muted-foreground" role="status">
								{removing && busy !== null ? t("app.projectsBatchRemoving", { done: busy.done, total: busy.total }) : outcome !== null ? t("app.projectsRemovePartial", { removed: outcome.removed, failed: outcome.failed }) : t("app.projectsBatchRemoveSelected", { selected: checked.size, total })}
							</p>
						</div>
						{/* scroll-ok: bounded —— 列表在 max-h 弹窗里 flex-1 吸收剩余高度，行数再多也只滚动这一层。 */}
						<div className="min-h-0 flex-1 overflow-y-auto bg-bg-muted [scrollbar-gutter:stable]">
							<Table>
								<TableHeader>
									<TableRow className="bg-bg-muted hover:bg-bg-muted">
										<TableHead className="w-10" />
										<TableHead className="w-[42%]">{t("common.project")}</TableHead>
										<TableHead>{t("app.path")}</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{props.projects.map((project) => {
										const isChecked = checked.has(project.id);
										const name = displayProjectDirectoryName(project);
										const path = projectDisplayPath(project);
										return (
											<TableRow key={project.id} className="bg-bg-panel" data-state={isChecked ? "selected" : undefined}>
												<TableCell className="w-10">
													<Label className="flex shrink-0 cursor-pointer items-center">
														<Checkbox checked={isChecked} disabled={removing} onCheckedChange={() => toggle(project.id)} aria-label={`${name} ${path}`} className="m-0 size-[15px] cursor-pointer accent-[var(--color-accent)]" />
													</Label>
												</TableCell>
												<TableCell className="w-[42%] max-w-0">
													<div className="flex min-w-0 cursor-pointer items-center gap-2" onClick={() => toggle(project.id)}>
														{project.missing ? <FolderX className="size-3.5 shrink-0 text-warning" aria-hidden="true" /> : <Folder className="size-3.5 shrink-0 text-text-tertiary" aria-hidden="true" />}
														<span className="truncate text-control text-text-primary">{name}</span>
														{project.missing ? <span className="shrink-0 text-caption text-warning">{t("app.projectMissing")}</span> : null}
													</div>
												</TableCell>
												{/* 路径列吃剩余宽度：max-w-0 + truncate 让超长路径不撑破弹窗，完整路径走 title。 */}
												<TableCell className="max-w-0">
													<span className="block truncate font-mono text-caption text-text-tertiary" title={path}>
														{path}
													</span>
												</TableCell>
											</TableRow>
										);
									})}
								</TableBody>
							</Table>
						</div>
					</>
				)}

				<DialogFooter className="border-t border-border-subtle px-5 py-3">
					<Button variant="ghost" onClick={props.onClose} disabled={removing}>
						{t("common.cancel")}
					</Button>
					<Button variant="destructive" loading={removing} onClick={() => void remove()} disabled={checked.size === 0}>
						{t("app.projectsBatchRemoveConfirm", { count: checked.size })}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
