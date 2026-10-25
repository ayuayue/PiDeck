import { FolderGit2 } from "lucide-react";
import { t } from "../../../i18n";
import type { GitRepoInfo } from "../../../../../shared/types";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui-shadcn/select";

export type GitRepoSwitcherProps = {
	repos: GitRepoInfo[];
	activePath: string | undefined;
	onSelect: (repoPath: string) => void;
};

function repoLabel(repo: GitRepoInfo): string {
	return repo.relativePath === "" ? t("git.repositoryRoot", { name: repo.name }) : repo.relativePath;
}

/**
 * VS Code SCM 风格的仓库切换器。只在发现多个独立仓库时由宿主挂载。
 */
export function GitRepoSwitcher(props: GitRepoSwitcherProps) {
	const { repos, activePath, onSelect } = props;
	if (repos.length <= 1) return null;
	const value = activePath ?? repos[0]?.path;
	return (
		<div className="flex shrink-0 items-center gap-1 border-b border-[var(--git-panel-border)] bg-[var(--git-panel-bg)] px-2 py-1.5">
			<Select value={value} onValueChange={onSelect}>
				<SelectTrigger aria-label={t("git.switchRepository")} title={t("git.switchRepository")} className="h-7 min-w-0 flex-1 gap-1.5 rounded-md border border-[var(--git-input-border)] bg-[var(--git-input-bg)] px-2 text-xs text-[var(--git-panel-fg)] hover:bg-[var(--git-panel-hover)]">
					<FolderGit2 size={14} className="shrink-0 text-muted-foreground" />
					<SelectValue placeholder={t("git.repository")} />
				</SelectTrigger>
				<SelectContent className="max-w-[min(24rem,calc(100vw-16px))]">
					{repos.map((repo) => (
						<SelectItem key={repo.path} value={repo.path} title={repo.path}>
							<span className="min-w-0 truncate">{repoLabel(repo)}</span>
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);
}
