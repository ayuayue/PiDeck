import { Folder, FolderX } from "lucide-react";
import { useState } from "react";
import type { Project } from "../../../../shared/types";
import { isRemoteProject } from "../../../../shared/projectLocation";
import { t } from "../../i18n";
import { cn } from "../../lib/utils";
import { displayProjectDirectoryName } from "../../rendererUtils";
import type { BatchProjectRemovalOutcome } from "../../utils/batchProjectRemoval";
import { Button } from "../ui-shadcn/button";
import { Checkbox } from "../ui-shadcn/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui-shadcn/dialog";
import { Pagination } from "../ui-shadcn/pagination";

/** 批量移除的汇总结果：定义在纯函数模块里，App 与弹窗共用同一份契约。 */
export type { BatchProjectRemovalOutcome } from "../../utils/batchProjectRemoval";
/** 每页条数：与通知历史弹窗同量级，10 行在 480px 高的列表里正好不用滚轮。 */
const PAGE_SIZE = 10;

/** 项目目录的展示路径：远端项目只有 remotePath，不能当本机路径处理。 */
function projectDisplayPath(project: Project) {
	return isRemoteProject(project) ? project.locator.remotePath : project.path;
}

/**
 * 批量删除项目记录弹窗：列出全部工作区项目，勾选后逐个移除。
 *
 * 产品行为：
 * - 只移除 PiDeck 里的项目记录（列表、会话索引、worktree 子工作区），不动磁盘目录；
 * - 全选跨页生效（「全选」勾的是当前清单的全部项目，不是当前页），但选中集合始终按
 *   传入的清单过滤——移除过程中清单会变短，stale id 不能继续算进「已选」；
 * - 逐项串行移除并回报进度：单次 IPC 一个项目，失败不会连累后面的项目；
 * - 有失败时保留弹窗与选中项，让用户看清结果后重试；全部成功才关闭。
 *
 * 分页当前页在渲染时夹到合法范围（与 notice-history-dialog 一致），不在 effect 里 setState。
 */
export function BatchRemoveProjectsDialog(props: { projects: readonly Project[]; onRemove: (projectIds: readonly string[], onProgress?: (done: number, total: number) => void) => Promise<BatchProjectRemovalOutcome>; onClose: () => void }) {
	const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
	const [page, setPage] = useState(1);
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
	const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
	const currentPage = Math.min(page, totalPages);
	const pageProjects = props.projects.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
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
			<DialogContent className="sm:max-w-[min(560px,calc(100vw-48px))]">
				<DialogHeader>
					<DialogTitle>{t("app.projectsBatchRemoveTitle")}</DialogTitle>
					<DialogDescription>{t("app.projectsBatchRemoveDesc")}</DialogDescription>
				</DialogHeader>

				{total === 0 ? (
					<p className="py-6 text-center text-body text-muted-foreground">{t("app.projectsBatchRemoveEmpty")}</p>
				) : (
					<div className="flex min-h-0 flex-col gap-2">
						{/* 全选跨页：勾的是整个清单，文案里带上总数，避免被理解成「只选这一页」。
						   行用 label 包 Checkbox（与 AgentMemoryExportDialog 同款）：整行可点、键盘可达，
						   不需要在 button 里再嵌一个 Checkbox 按钮。 */}
						<label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-label text-muted-foreground hover:bg-bg-hover">
							<Checkbox checked={allSelected ? true : someSelected ? "indeterminate" : false} disabled={removing} onCheckedChange={toggleAll} />
							{t("app.projectsBatchRemoveSelectAll", { count: total })}
						</label>
						{/* scroll-ok: bounded —— 行数有硬上限（PAGE_SIZE = 10 的受控分页，翻页组件在下方），不随项目总数增长。 */}
						<div className="max-h-[46vh] overflow-y-auto rounded-lg border border-border-subtle">
							{pageProjects.map((project) => {
								const isChecked = checked.has(project.id);
								const name = displayProjectDirectoryName(project);
								const path = projectDisplayPath(project);
								return (
									<label key={project.id} className={cn("flex cursor-pointer items-center gap-2 px-2 py-1.5 transition-colors duration-fast", isChecked ? "bg-accent/60" : "hover:bg-bg-hover")}>
										<Checkbox checked={isChecked} disabled={removing} onCheckedChange={() => toggle(project.id)} aria-label={`${name} ${path}`} />
										{project.missing ? <FolderX className="size-3.5 shrink-0 text-warning" aria-hidden="true" /> : <Folder className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
										<span className="flex min-w-0 flex-1 flex-col">
											<span className="flex min-w-0 items-center gap-1.5">
												<span className="truncate text-body text-foreground">{name}</span>
												{project.missing ? <span className="shrink-0 text-caption text-warning">{t("app.projectMissing")}</span> : null}
											</span>
											<span className="truncate text-caption text-text-tertiary" title={path}>
												{path}
											</span>
										</span>
									</label>
								);
							})}
						</div>
						{totalPages > 1 ? <Pagination page={currentPage} totalPages={totalPages} onPageChange={setPage} className="pt-0" /> : null}
					</div>
				)}

				<p className="text-label text-muted-foreground" role="status">
					{removing && busy !== null ? t("app.projectsBatchRemoving", { done: busy.done, total: busy.total }) : outcome !== null ? t("app.projectsRemovePartial", { removed: outcome.removed, failed: outcome.failed }) : t("app.projectsBatchRemoveSelected", { selected: checked.size, total })}
				</p>

				<DialogFooter>
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
