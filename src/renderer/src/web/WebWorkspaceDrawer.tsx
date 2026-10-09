/**
 * WebWorkspaceDrawer — Web 端工作区抽屉（P3）：Git / 文件 两个只读面板。
 *
 * 与桌面右侧抽屉同定位但收窄为只读：
 * - Git：分支 + 变更分组（merge/index/workingTree/untracked）+ 文件 diff（上下两栏
 *   original/modified）+ 最近提交。写入类操作（commit/stage）仍回桌面完成。
 * - 文件：项目内目录浏览（面包屑导航）+ 有界文本预览（512KB / 二进制拦截，
 *   边界在后端 WebWorkspaceRoutes 强制）；点击文件交给全屏预览（WebFilePreview），抽屉只负责导航。
 */
import { useCallback, useEffect, useState } from "react";
import { ChevronRight, FileText, Folder, GitBranch, Loader2, X } from "lucide-react";
import type { CommitEntry, GitBranchInfo, GitResourceGroups } from "../../../shared/types";
import { Button } from "@/components/ui-shadcn/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui-shadcn/tabs";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { fetchFileList, fetchGitDiff, fetchGitLog, fetchGitStatus } from "./webApi";
import { useDismissOnBack } from "./useDismissOnBack";
import type { WebFileNodeLite } from "./webTypes";

export function WebWorkspaceDrawer(props: { projectId: string; open: boolean; onClose: () => void; onOpenFile: (path: string) => void }) {
	// 系统返回键/手势关闭（手机上抽屉是全屏覆盖层，与预览同一关闭语义）
	useDismissOnBack(props.onClose, props.open);
	return (
		<div className={cn("fixed inset-0 z-50", props.open ? "pointer-events-auto" : "pointer-events-none")} aria-hidden={!props.open}>
			{/* 遮罩：点击关闭（仅打开时可见） */}
			<div className={cn("absolute inset-0 bg-black/30 transition-opacity", props.open ? "opacity-100" : "opacity-0")} onClick={props.onClose} />
			<aside className={cn("absolute top-0 right-0 bottom-0 flex w-[min(400px,100vw)] flex-col border-l border-border bg-background shadow-xl transition-transform duration-200", props.open ? "translate-x-0" : "translate-x-full")} aria-label={t("web.workspaceDrawer")}>
				<div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2">
					<strong className="text-sm font-semibold">{t("web.workspaceDrawer")}</strong>
					<Button type="button" variant="ghost" size="icon" className="size-11" onClick={props.onClose} aria-label={t("common.close")}>
						<X className="size-5" aria-hidden="true" />
					</Button>
				</div>
				<Tabs defaultValue="git" className="flex min-h-0 flex-1 flex-col gap-0">
					<TabsList className="mx-3 mt-2 grid w-auto grid-cols-2">
						<TabsTrigger value="git">{t("web.gitTab")}</TabsTrigger>
						<TabsTrigger value="files">{t("web.filesTab")}</TabsTrigger>
					</TabsList>
					<TabsContent value="git" className="mt-2 min-h-0 flex-1 overflow-y-auto px-3 pb-3">
						<GitPanel projectId={props.projectId} active={props.open} />
					</TabsContent>
					<TabsContent value="files" className="mt-2 min-h-0 flex-1 overflow-y-auto px-3 pb-3">
						<FilesPanel projectId={props.projectId} active={props.open} onOpenFile={props.onOpenFile} />
					</TabsContent>
				</Tabs>
			</aside>
		</div>
	);
}

// ── Git 面板 ───────────────────────────────────────────────────────────

type DiffPayload = { originalContent: string; modifiedContent: string } | null;

function GitPanel(props: { projectId: string; active: boolean }) {
	const [loading, setLoading] = useState(false);
	const [branch, setBranch] = useState<GitBranchInfo | null>(null);
	const [groups, setGroups] = useState<GitResourceGroups | null>(null);
	const [commits, setCommits] = useState<CommitEntry[]>([]);
	const [noRepo, setNoRepo] = useState(false);
	const [diffPath, setDiffPath] = useState<string | null>(null);
	const [diffGroup, setDiffGroup] = useState<"merge" | "index" | "workingTree" | "untracked">("workingTree");
	const [diff, setDiff] = useState<DiffPayload>(null);
	const [diffLoading, setDiffLoading] = useState(false);

	const load = useCallback(async () => {
		setLoading(true);
		setNoRepo(false);
		try {
			const status = await fetchGitStatus(props.projectId);
			if (!status.repo) {
				setNoRepo(true);
				setBranch(null);
				setGroups(null);
				return;
			}
			setBranch(status.branch);
			setGroups(status.groups);
			setCommits(await fetchGitLog(props.projectId, 12));
		} catch {
			setNoRepo(true);
		} finally {
			setLoading(false);
		}
	}, [props.projectId]);

	useEffect(() => {
		if (props.active) void load();
	}, [props.active, load]);

	const openDiff = async (group: "merge" | "index" | "workingTree" | "untracked", path: string) => {
		if (diffPath === path) {
			setDiffPath(null);
			return;
		}
		setDiffPath(path);
		setDiffGroup(group);
		setDiffLoading(true);
		try {
			setDiff(await fetchGitDiff(props.projectId, group, path));
		} catch {
			setDiff(null);
		} finally {
			setDiffLoading(false);
		}
	};

	if (loading) {
		return (
			<div className="flex items-center justify-center gap-2 py-10 text-caption text-muted-foreground">
				<Loader2 className="size-4 animate-pideck-spin" aria-hidden="true" />
			</div>
		);
	}
	if (noRepo) {
		return <div className="py-10 text-center text-caption text-muted-foreground">{t("web.gitNoRepo")}</div>;
	}

	const totalChanges = groups ? groups.merge.length + groups.index.length + groups.workingTree.length + groups.untracked.length : 0;

	return (
		<div className="flex flex-col gap-3">
			{branch ? (
				<div className="flex items-center gap-1.5 text-caption text-foreground">
					<GitBranch className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
					<span className="truncate font-medium">{branch.current ?? "—"}</span>
					<span className="text-muted-foreground">
						· {t("web.gitChanges")} {totalChanges}
					</span>
				</div>
			) : null}
			{groups ? <ResourceGroupList label={t("git.mergeChanges")} group="merge" resources={groups.merge} diffPath={diffPath} diff={diff} diffLoading={diffLoading} diffGroup={diffGroup} onOpenDiff={openDiff} /> : null}
			{groups ? <ResourceGroupList label={t("git.stagedChanges")} group="index" resources={groups.index} diffPath={diffPath} diff={diff} diffLoading={diffLoading} diffGroup={diffGroup} onOpenDiff={openDiff} /> : null}
			{groups ? <ResourceGroupList label={t("git.changes")} group="workingTree" resources={groups.workingTree} diffPath={diffPath} diff={diff} diffLoading={diffLoading} diffGroup={diffGroup} onOpenDiff={openDiff} /> : null}
			{groups ? <ResourceGroupList label={t("web.gitUntracked")} group="untracked" resources={groups.untracked} diffPath={diffPath} diff={diff} diffLoading={diffLoading} diffGroup={diffGroup} onOpenDiff={openDiff} /> : null}
			{commits.length > 0 ? (
				<section>
					<h4 className="mb-1.5 text-caption font-medium text-foreground">{t("web.gitHistory")}</h4>
					<ul className="flex flex-col gap-1">
						{commits.map((commit) => (
							<li key={commit.hash} className="rounded-md border border-border bg-card px-2 py-1.5">
								<div className="flex items-baseline gap-1.5">
									<code className="shrink-0 text-micro text-primary">{commit.shortHash}</code>
									<span className="min-w-0 flex-1 truncate text-caption text-foreground">{commit.message}</span>
								</div>
								<div className="text-micro text-muted-foreground">
									{commit.authorName} · {new Date(commit.authorDate * 1000).toLocaleDateString()}
								</div>
							</li>
						))}
					</ul>
				</section>
			) : null}
		</div>
	);
}

function ResourceGroupList(props: {
	label: string;
	group: "merge" | "index" | "workingTree" | "untracked";
	resources: Array<{ path: string; letter: string; oldPath?: string }>;
	diffPath: string | null;
	diff: DiffPayload;
	diffLoading: boolean;
	diffGroup: string;
	onOpenDiff: (group: "merge" | "index" | "workingTree" | "untracked", path: string) => void;
}) {
	if (props.resources.length === 0) return null;
	return (
		<section>
			<h4 className="mb-1.5 text-caption font-medium text-foreground">
				{props.label} <span className="text-muted-foreground">({props.resources.length})</span>
			</h4>
			<ul className="flex flex-col gap-0.5">
				{props.resources.slice(0, 30).map((resource) => (
					<li key={`${resource.path}:${resource.letter}`}>
						<button type="button" className={cn("flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-caption transition-colors hover:bg-muted/60", props.diffPath === resource.path && "bg-muted")} onClick={() => props.onOpenDiff(props.group, resource.path)}>
							<code className={cn("w-4 shrink-0 text-center text-micro font-semibold", resource.letter === "D" ? "text-danger" : resource.letter === "A" ? "text-success" : "text-warning")}>{resource.letter}</code>
							<span className="min-w-0 flex-1 truncate text-foreground">{resource.path.split(/[\\/]/).pop()}</span>
							<span className="max-w-32 shrink-0 truncate text-micro text-muted-foreground">{resource.path}</span>
						</button>
						{props.diffPath === resource.path && props.diffGroup === props.group ? (
							props.diffLoading ? (
								<div className="flex items-center gap-1.5 px-2 py-1.5 text-micro text-muted-foreground">
									<Loader2 className="size-3 animate-pideck-spin" aria-hidden="true" />
								</div>
							) : props.diff ? (
								<div className="mt-1 grid gap-1.5 rounded-md border border-border bg-card p-2">
									<div>
										<div className="mb-0.5 text-micro text-muted-foreground">original</div>
										<pre className="max-h-64 overflow-auto rounded bg-muted/50 p-1.5 text-micro leading-relaxed whitespace-pre-wrap">{props.diff.originalContent || "—"}</pre>
									</div>
									<div>
										<div className="mb-0.5 text-micro text-muted-foreground">modified</div>
										<pre className="max-h-64 overflow-auto rounded bg-muted/50 p-1.5 text-micro leading-relaxed whitespace-pre-wrap">{props.diff.modifiedContent || "—"}</pre>
									</div>
								</div>
							) : (
								<div className="px-2 py-1.5 text-micro text-muted-foreground">{t("web.diffUnavailableHint")}</div>
							)
						) : null}
					</li>
				))}
			</ul>
		</section>
	);
}

// ── 文件面板 ───────────────────────────────────────────────────────────

function FilesPanel(props: { projectId: string; active: boolean; onOpenFile: (path: string) => void }) {
	const [dir, setDir] = useState("");
	const [nodes, setNodes] = useState<WebFileNodeLite[]>([]);
	const [loading, setLoading] = useState(false);

	const loadList = useCallback(
		async (nextDir: string) => {
			setLoading(true);
			try {
				setNodes(await fetchFileList(props.projectId, nextDir || undefined));
			} catch {
				setNodes([]);
			} finally {
				setLoading(false);
			}
		},
		[props.projectId],
	);

	useEffect(() => {
		if (props.active) void loadList(dir);
		// eslint-disable-next-line react-hooks/exhaustive-deps -- dir 变化由导航按钮显式触发 loadList
	}, [props.active, dir, loadList]);

	const crumbs = dir ? dir.split("/").filter(Boolean) : [];

	return (
		<div className="flex flex-col gap-2">
			{/* 面包屑导航：项目根 / 一级 / … */}
			<div className="flex min-w-0 flex-wrap items-center gap-0.5 text-caption">
				<button type="button" className="rounded px-1 py-0.5 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground" onClick={() => setDir("")}>
					{t("web.filesTab")}
				</button>
				{crumbs.map((crumb, index) => (
					<span key={`${crumb}-${index}`} className="flex min-w-0 items-center gap-0.5">
						<ChevronRight className="size-3 shrink-0 text-muted-foreground/60" aria-hidden="true" />
						<button type="button" className="max-w-32 truncate rounded px-1 py-0.5 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground" onClick={() => setDir(crumbs.slice(0, index + 1).join("/"))}>
							{crumb}
						</button>
					</span>
				))}
			</div>
			{loading ? (
				<div className="flex items-center justify-center gap-2 py-8 text-caption text-muted-foreground">
					<Loader2 className="size-4 animate-pideck-spin" aria-hidden="true" />
				</div>
			) : (
				<ul className="flex flex-col gap-0.5">
					{nodes.map((node) => (
						<li key={node.relativePath}>
							<button type="button" className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-caption transition-colors hover:bg-muted/60" onClick={() => (node.type === "directory" ? setDir(node.relativePath) : props.onOpenFile(node.relativePath))}>
								{node.type === "directory" ? <Folder className="size-3.5 shrink-0 text-primary/70" aria-hidden="true" /> : <FileText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
								<span className="min-w-0 flex-1 truncate text-foreground">{node.name}</span>
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
