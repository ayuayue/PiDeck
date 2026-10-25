/**
 * WebBranchBar — 会话分支导航条（P3）。
 *
 * 当活跃会话属于一个 fork 家族（克隆 / rewind-fork / 桌面分支产生）时，在
 * 时间线上方展示家族链：每个会话一个 chip（截断标题 + fork 徽标），点击切换。
 * 家族只有一条会话时不渲染（deriveWebBranchFamily 返回长度 ≤1）。
 */
import { GitFork } from "lucide-react";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { deriveWebBranchFamily } from "./webBranchFamily";
import type { WebSession } from "./webTypes";

export function WebBranchBar(props: { sessions: WebSession[]; activeSessionId: string; onSelect: (sessionId: string) => void }) {
	const family = deriveWebBranchFamily(props.sessions, props.activeSessionId);
	if (family.length <= 1) return null;
	return (
		<div className="flex min-w-0 shrink-0 items-center gap-1.5 overflow-x-auto border-b border-border bg-background/60 px-3 py-1.5" aria-label={t("web.branchFamily")}>
			<GitFork className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
			{family.map((session, index) => (
				<span key={session.id} className="flex min-w-0 shrink-0 items-center gap-1.5">
					{index > 0 ? (
						<span className="text-muted-foreground/60" aria-hidden="true">
							›
						</span>
					) : null}
					<button
						type="button"
						className={cn("max-w-44 truncate rounded-full px-2 py-0.5 text-micro transition-colors pointer-coarse:px-2.5 pointer-coarse:py-1.5", session.id === props.activeSessionId ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/70 hover:text-foreground")}
						title={session.title || t("common.untitled")}
						onClick={() => props.onSelect(session.id)}
					>
						{session.forked ? <GitFork className="mr-1 inline size-2.5 align-[-1px]" aria-hidden="true" /> : null}
						{session.title || t("common.untitled")}
					</button>
				</span>
			))}
		</div>
	);
}
