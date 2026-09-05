import { useMemo } from "react";
import { useAtomValue } from "jotai";
import { ChevronLeft, ChevronRight, CornerUpLeft, GitFork } from "lucide-react";
import { sessionRecordsAtom } from "../../atoms/session-atoms";
import { t } from "../../i18n";
import { sessionDisplayName } from "../../utils/sessionDisplayName";
import { Popover, PopoverContent, PopoverTrigger } from "../ui-shadcn/popover";
import { deriveBranchFamily } from "./branchFamily";
import type { SessionRecord } from "../../../../shared/types";

/** 分支行的展示名：fork 会话的 (fork) 后缀直接拼进会话名，与侧栏/Tab 一致。 */
function displayName(record: SessionRecord): string {
	return sessionDisplayName(record.title, record.forked) ?? record.title;
}

/**
 * 会话分支导航条（借鉴 AI Elements MessageBranch 的 ◀ i/N ▶ 分页器）。
 *
 * pi 的 fork 以「会话」为分支单位（parentSession 文件头链），此处提供：
 * - 来源会话链接（点击回到父会话）；
 * - 同源兄弟分支前后切换（分页器，边界禁用不循环，与 AI Elements 语义一致）；
 * - 下游子分支列表（Popover）。
 * 无分支关系时 deriveBranchFamily 返回 undefined，整条不渲染。
 */
export function SessionBranchBar(props: {
	sessionId: string;
	onOpenSession?: (sessionId: string) => void;
}) {
	const records = useAtomValue(sessionRecordsAtom);
	const family = useMemo(
		() => deriveBranchFamily(records, props.sessionId),
		[records, props.sessionId],
	);
	if (!family || !props.onOpenSession) return null;
	const { parent, siblings, currentIndex, children } = family;
	const open = props.onOpenSession;

	return (
		<div className="flex min-w-0 items-center gap-2 border-b border-border-subtle px-3 py-1 text-xs text-muted-foreground">
			{parent && (
				<button
					type="button"
					className="inline-flex min-w-0 items-center gap-1 rounded-sm px-1 py-0.5 transition-colors hover:bg-accent hover:text-foreground"
					title={displayName(parent)}
					onClick={() => open(parent.id)}
				>
					<CornerUpLeft size={12} className="shrink-0" aria-hidden="true" />
					<span className="truncate">{t("branch.parent", { title: parent.title })}</span>
				</button>
			)}
			{siblings.length > 1 && (
				<span className="inline-flex shrink-0 items-center gap-0.5">
					<button
						type="button"
						className="inline-flex size-5 items-center justify-center rounded-sm transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
						disabled={currentIndex <= 0}
						title={t("branch.prev")}
						aria-label={t("branch.prev")}
						onClick={() => open(siblings[currentIndex - 1].id)}
					>
						<ChevronLeft size={13} aria-hidden="true" />
					</button>
					<span className="min-w-8 text-center tabular-nums">
						{t("branch.pager", { index: currentIndex + 1, total: siblings.length })}
					</span>
					<button
						type="button"
						className="inline-flex size-5 items-center justify-center rounded-sm transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
						disabled={currentIndex >= siblings.length - 1}
						title={t("branch.next")}
						aria-label={t("branch.next")}
						onClick={() => open(siblings[currentIndex + 1].id)}
					>
						<ChevronRight size={13} aria-hidden="true" />
					</button>
				</span>
			)}
			{children.length > 0 && (
				<Popover>
					<PopoverTrigger asChild>
						<button
							type="button"
							className="inline-flex shrink-0 items-center gap-1 rounded-sm px-1 py-0.5 transition-colors hover:bg-accent hover:text-foreground"
							title={t("branch.childrenTitle")}
						>
							<GitFork size={12} aria-hidden="true" />
							<span className="tabular-nums">{t("branch.children", { count: children.length })}</span>
						</button>
					</PopoverTrigger>
					<PopoverContent align="start" className="w-64 p-1">
						{children.map((child) => (
							<button
								key={child.id}
								type="button"
								className="flex w-full min-w-0 items-center rounded-sm px-2 py-1.5 text-left text-body text-foreground transition-colors hover:bg-accent"
								title={child.title}
								onClick={() => open(child.id)}
							>
								<span className="truncate">{displayName(child)}</span>
							</button>
						))}
					</PopoverContent>
				</Popover>
			)}
		</div>
	);
}
