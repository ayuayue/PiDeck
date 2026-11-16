import { CheckCircle2, Info } from "lucide-react";
import type { GitResourceGroupType } from "../../../../shared/types/git";
import type { ProjectFileTarget } from "../../../../shared/types/project";
import { t } from "../../i18n";
import type { RemoteGitViewSnapshot } from "../../utils/remoteGitViewState";
import { PaneHeader } from "../app/git/GitPanelControls";
import { FileTree, Twistie } from "../app/git/GitResourceTree";
import { Button } from "../ui-shadcn/button";
import { Textarea } from "../ui-shadcn/textarea";
import { RemoteGitCapabilityNote } from "./RemoteGitCapabilityNote";

/** 与本机 GitPanel 同一套分组标题：合并 / 暂存的更改 / 未暂存的更改，未跟踪单独一组。 */
const GROUP_ORDER: GitResourceGroupType[] = ["merge", "index", "workingTree", "untracked"];
const GROUP_LABELS = { merge: "git.mergeChanges", index: "git.stagedChanges", workingTree: "git.unstagedChanges", untracked: "remoteGit.untracked" } as const;
const EMPTY_GROUP_FLAGS: Record<GitResourceGroupType, boolean> = { merge: true, index: true, workingTree: true, untracked: true };

export type RemoteGitDiscardTarget = { group: "workingTree" | "untracked"; path: string; target: ProjectFileTarget };

export type RemoteGitChangesSectionProps = {
	/** 分区展开态：收起只影响本区（提交框 + 列表），恢复/历史/引用各有自己的折叠头。 */
	open: boolean;
	onToggle: () => void;
	snapshot: RemoteGitViewSnapshot;
	changeCount: number;
	/** 写能力（capabilities.write）：决定提交框与逐文件暂存/还原入口，缺省即整区只读。 */
	writeEnabled: boolean;
	canCommit: boolean;
	canDiscard: boolean;
	busy: boolean;
	mutating: boolean;
	committing: boolean;
	message: string;
	messageBytes: number;
	onMessageChange: (value: string) => void;
	onCommit: () => void;
	collapsedDirs: Set<string>;
	onToggleDir: (directory: string) => void;
	openGroups: Record<GitResourceGroupType, boolean>;
	onToggleGroup: (group: GitResourceGroupType) => void;
	/** 单文件暂存/取消暂存：远端只提供逐文件动作，不做批量。 */
	onMutateFile: (kind: "stage" | "unstage", group: GitResourceGroupType, target: ProjectFileTarget) => void;
	pendingDiscard: RemoteGitDiscardTarget | null;
	onRequestDiscard: (group: "workingTree" | "untracked", target: ProjectFileTarget) => void;
	onConfirmDiscard: () => void;
	onCancelDiscard: () => void;
	/** 丢弃成功后的恢复引用（或「已撤销删除」），只陈述已确认的结果。 */
	discardRecovery: { ref: string | null; path: string } | undefined;
	onOpenDiff: (group: GitResourceGroupType, target: ProjectFileTarget) => void;
};

/**
 * 远端「更改」分区：提交框 + 分组变更列表，排版与本机 `GitPanel` 的变更区一致
 * （同款面板头、同款组头、同款提交区），但只提供远端真实拥有的能力：
 * 逐文件暂存/取消暂存、只提交现有 index、丢弃前先确认并留恢复引用。
 *
 * 抽成独立模块有两个原因：面板保持装配面（与 `RemoteGitCompareSection` 同一条理由），
 * 且面板本身是受行数门禁约束的存量文件，新排版不能让它净增长。
 */
export function RemoteGitChangesSection(props: RemoteGitChangesSectionProps) {
	const { snapshot } = props;
	const groups = GROUP_ORDER.filter((group) => snapshot.groups[group].length > 0);
	const clean = groups.length === 0;
	return (
		<section id="git-pane-remote-changes" data-testid="remote-git-changes" className="bg-[var(--git-panel-bg)]">
			<PaneHeader id="remote-changes" title={t("git.changes")} count={props.changeCount} open={props.open} onToggle={props.onToggle} />
			{props.open ? (
				<>
					{/* 提交区与本机同一个位置：分区标题之下、变更列表之上。 */}
					<div className="flex shrink-0 flex-col gap-2 border-b border-[var(--git-panel-border)] bg-[var(--git-panel-bg)] px-2.5 pt-2 pb-1.5">
						<Textarea
							className="git-scm-input min-h-14 max-h-[100px] w-full resize-y rounded-sm border border-[var(--git-input-border)] bg-[var(--git-input-bg)] px-2 py-1 text-control leading-[20px] text-[var(--git-panel-fg)] outline-none placeholder:text-[var(--git-desc-fg)]"
							data-testid="remote-git-commit-message"
							aria-label={t("remoteGit.commitMessage")}
							placeholder={t("git.commitPlaceholder", { branch: snapshot.branch ?? "HEAD" })}
							value={props.message}
							rows={3}
							disabled={props.busy || !props.writeEnabled}
							onChange={(event) => props.onMessageChange(event.target.value)}
							onKeyDown={(event) => {
								// 与本机同一条提交快捷键：Ctrl/Cmd+Enter；消息为空时仍然不发提交。
								if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
									event.preventDefault();
									if (props.canCommit) props.onCommit();
								}
							}}
						/>
						<div className="flex items-stretch gap-1.5">
							<Button type="button" variant="default" className="git-commit-btn min-w-0 flex-1" disabled={!props.canCommit} onClick={() => props.onCommit()}>
								{props.committing ? t("remoteGit.committing") : t("git.commit")}
							</Button>
							{props.messageBytes > 0 ? <span className="self-center text-micro text-[var(--git-desc-fg)] tabular-nums">{props.messageBytes}/4096</span> : null}
						</div>
						{/* 本机提交区没有常驻说明段：远端规则收成一行摘要，需要时再展开原文。 */}
						<details>
							<summary className="flex cursor-pointer list-none items-center gap-1 text-micro text-[var(--git-desc-fg)] hover:text-[var(--git-panel-fg)]">
								<Info size={12} aria-hidden="true" className="shrink-0" />
								{t("remoteGit.commitRulesSummary")}
							</summary>
							<RemoteGitCapabilityNote kind="commit" context={{ commitVisible: true }} />
						</details>
					</div>
					<div className="py-1">
						<p data-testid="remote-git-branch" className="px-2.5 pb-1 text-micro text-[var(--git-desc-fg)]">
							{snapshot.branch ?? t("remoteGit.detached")}
						</p>
						{/* 干净态与本机同一套：同一句文案 + 同一个勾图标，不再各写一句。 */}
						{clean ? (
							<p data-testid="remote-git-clean" className="flex items-center gap-1.5 px-2.5 py-1 text-control text-[var(--git-desc-fg)]">
								<CheckCircle2 aria-hidden="true" size={13} className="shrink-0" />
								{t("git.noPendingChanges")}
							</p>
						) : null}
						{groups.map((group) => (
							<section key={group} data-testid={`remote-git-${group}`} className="pb-1">
								<div className="group flex h-7 items-center pr-2 pl-2 hover:bg-muted">
									<button
										type="button"
										className="inline-flex h-7 min-w-0 flex-1 items-center gap-1.5 border-0 bg-transparent p-0 text-left text-inherit focus-visible:shadow-[inset_var(--focus-ring)] focus-visible:outline-none"
										aria-expanded={props.openGroups[group] ?? EMPTY_GROUP_FLAGS[group]}
										onClick={() => props.onToggleGroup(group)}
									>
										<span aria-hidden="true" className="inline-flex h-full w-4 shrink-0 translate-x-[3px] items-center justify-center">
											<Twistie open={props.openGroups[group] ?? EMPTY_GROUP_FLAGS[group]} />
										</span>
										<span className="min-w-0 flex-1 truncate text-control font-semibold tracking-normal text-[var(--git-panel-fg)]">{t(GROUP_LABELS[group])}</span>
									</button>
									<span className="ml-1 min-w-[14px] text-right text-micro tabular-nums text-[var(--git-desc-fg)]">{snapshot.groups[group].length}</span>
								</div>
								{(props.openGroups[group] ?? EMPTY_GROUP_FLAGS[group]) ? (
									<FileTree
										readOnly={!props.writeEnabled}
										stageFile={props.writeEnabled ? (target) => props.onMutateFile("stage", group, target) : undefined}
										unstageFile={props.writeEnabled ? (target) => props.onMutateFile("unstage", group, target) : undefined}
										discardFile={!props.canDiscard ? undefined : (target, discardGroup) => props.onRequestDiscard(discardGroup, target)}
										resources={snapshot.groups[group]}
										groupType={group}
										mutating={props.mutating}
										collapsedDirs={props.collapsedDirs}
										onToggleDir={props.onToggleDir}
										onOpenWorkspaceFileDiff={props.onOpenDiff}
									/>
								) : null}
							</section>
						))}
						{props.pendingDiscard ? (
							<div data-testid="remote-git-discard-confirm-bar" className="mx-2.5 my-1 rounded-sm border border-danger p-2 text-micro">
								<p>{t(props.pendingDiscard.group === "untracked" ? "remoteGit.discardConfirmDelete" : "remoteGit.discardConfirm", { path: props.pendingDiscard.path })}</p>
								<div className="flex items-center gap-2 pt-1">
									<Button type="button" size="xs" data-testid="remote-git-discard-confirm" onClick={props.onConfirmDiscard}>
										{t("remoteGit.discardAction")}
									</Button>
									<Button type="button" variant="ghost" size="xs" data-testid="remote-git-discard-cancel" onClick={props.onCancelDiscard}>
										{t("remoteGit.discardCancel")}
									</Button>
								</div>
							</div>
						) : null}
						{props.discardRecovery ? (
							<p data-testid="remote-git-recovery-note" className="px-2.5 py-1 text-micro text-[var(--git-desc-fg)]">
								{props.discardRecovery.ref === null ? t("remoteGit.discardRestored", { path: props.discardRecovery.path }) : t("remoteGit.discardRecovered", { ref: props.discardRecovery.ref, path: props.discardRecovery.path })}
							</p>
						) : null}
					</div>
				</>
			) : null}
		</section>
	);
}
