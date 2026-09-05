import { useMemo } from "react";
import { ChevronDown, ChevronUp, ExternalLink, FileEdit, FileInput, Save } from "lucide-react";
import type { AgentRunItem } from "./timeline/types";
import type { DiffFileHandler } from "./ToolCallComponents";
import { FileDiff } from "../agents/file-diff";
import { fileChangeToDiffLines } from "./TimelineFormat";
import { useSessionFileChanges } from "../../hooks/useSessionFileChanges";
import { useSessionDismissedFiles } from "../../hooks/useSessionDismissedFiles";
import type { SessionFileChange } from "../../../../shared/types";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import {
	ComposerWidgetFrame,
	useComposerWidgetCollapsed,
} from "./ComposerWidgetLayout";

/**
 * composer 上方的「修改的文件」常驻条（会话级文件汇总横栏）。
 *
 * 形态：与输入框同宽同列的折叠卡（36px 高：图标 + 标题 + 文件数 + chevron），
 * 点击展开 diff 列表（会话级全量 + 限高滚动），顶部带「保存全部」。
 * 数据：useSessionFileChanges（主进程全量 + 当前 run 增量），跨轮次/会话切换不丢；
 * 「保存全部」清空快照跨组件共享（useSessionDismissedFiles）。
 * 无任何文件修改时整体不渲染（「有那个显示那个」）。
 */

const FileEntry = (props: {
	sessionId: string;
	entry: SessionFileChange;
	/** 打开文件本体（App 级路由：图片预览 / md·html 中间栏查看 / 其他进内置编辑器） */
	onOpenFile?: (path: string) => void;
	onDiffFile?: DiffFileHandler;
}) => {
		// 行级折叠走 composer 通道（本组件在 ComposerWidgetLayoutProvider 内），
		// key 与旧弹层 widgetsDisclosureCollapsedFamily 同构，跨轮次记忆展开态
	const { collapsed, toggleCollapsed } = useComposerWidgetCollapsed(
		`modified-file-diff:${props.sessionId}:session:${props.entry.path}`,
		true,
	);
	return (
		// items-start + h-9 包裹：跳转按钮始终与顶部文件行（min-h-9）垂直居中对齐，
		// 不会因 FileDiff 展开后整体变高而跑到中间
		// flex-1 必须加在根 div 上：行宽撑满卡片后统计组（+N -N）才统一钉在右缘
		<div className="flex min-w-0 flex-1 items-start gap-1">
			<FileDiff
				className="min-w-0 flex-1"
				file={`${props.entry.path}${props.entry.count > 1 ? ` ×${props.entry.count}` : ""}`}
				lines={fileChangeToDiffLines(props.entry)}
				status="complete"
				open={!collapsed}
				onOpenChange={(open) => { if (open === collapsed) toggleCollapsed(); }}
				maxHeight={200}
				language="diff"
				// 折叠卡内展开高度变化传导给 ComposerMeasuredExtras 驱动面板增高，无需瞬时动画
				animateHeight={false}
			/>
			{(props.onOpenFile || props.onDiffFile) && (
				<div className="flex h-9 shrink-0 items-center">
					{/* "打开文件" 与 "diff 查看器" 分列两个入口：前者打开文件本体，
					    后者只看本轮修改的差异；两者横向并列、相邻且等宽，视觉上归为一组操作 */}
					<div className="flex items-center gap-0.5">
						{props.onOpenFile && (
							<Button variant="ghost" size="icon-xs" className="size-6 rounded" title={t("sessionFiles.openFile")} onClick={() => props.onOpenFile?.(props.entry.path)}>
								<FileInput size={12} />
							</Button>
						)}
						{props.onDiffFile && (
							<Button variant="ghost" size="icon-xs" className="size-6 rounded" title={t("sessionFiles.openInDiffViewer")} onClick={() => props.onDiffFile?.(props.entry.path)}>
								<ExternalLink size={12} />
							</Button>
						)}
					</div>
				</div>
			)}
		</div>
	);
};

export function SessionFilesStrip(props: {
	sessionId: string;
	run?: AgentRunItem;
	/** 打开文件本体（App 级路由），不传则条目只保留 diff 查看器入口 */
	onOpenFile?: (path: string) => void;
	onDiffFile?: DiffFileHandler;
}) {
	const { collapsed, toggleCollapsed } = useComposerWidgetCollapsed(
		`files:${props.sessionId}`,
		true,
	);

	// 会话级文件汇总（主进程全量 + 当前 run 增量），跨轮次/会话切换不丢
	const { entries: fileEntries, loading } = useSessionFileChanges(props.sessionId, props.run);

	// “保存全部”清空快照与待办/弹层共享（useSessionDismissedFiles），横栏显示未清空数量
	const { snapshot: dismissedFilesSnapshot, dismissAll } = useSessionDismissedFiles(props.sessionId);

	const visibleFileEntries = useMemo(() => {
		if (!dismissedFilesSnapshot) return fileEntries;
		return fileEntries.filter((e) => (dismissedFilesSnapshot[e.path] ?? 0) < e.count);
	}, [fileEntries, dismissedFilesSnapshot]);

	if (loading && visibleFileEntries.length === 0) return null;
	if (visibleFileEntries.length === 0) return null;

	return (
		<ComposerWidgetFrame
			data-testid="session-files-strip"
			aria-label={t("sessionFiles.title")}
		>
			<div className="flex h-9 w-full items-center gap-2.5 px-3">
				<button
					type="button"
					className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
					aria-expanded={!collapsed}
					onClick={toggleCollapsed}
				>
					<FileEdit size={14} aria-hidden="true" className="shrink-0 text-text-tertiary" />
					<span className="shrink-0 text-[13px] font-medium leading-6 text-foreground">
						{t("sessionFiles.title")}
					</span>
					<span className="shrink-0 text-[13px] leading-5 text-text-tertiary">
						{t("sessionFiles.count", { count: visibleFileEntries.length })}
					</span>
					<span className="min-w-0 flex-1" />
					<span className="shrink-0 text-text-tertiary" aria-hidden="true">
						{collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
					</span>
				</button>
			</div>
			{!collapsed && (
				<>
					<div className="flex items-center justify-between px-3 pt-1">
						<span className="text-[13px] text-text-tertiary">
							{t("sessionFiles.count", { count: visibleFileEntries.length })}
						</span>
						<Button
							variant="ghost"
							size="sm"
							className="h-6 gap-1 px-2 text-xs text-text-tertiary hover:bg-muted hover:text-foreground"
							onClick={() => dismissAll(fileEntries)}
						>
							<Save size={13} />
							<span>{t("sessionFiles.saveAll")}</span>
						</Button>
					</div>
					<ul className="mb-2 flex max-h-[200px] flex-col gap-1 overflow-y-auto overscroll-contain [contain:layout_paint] [scrollbar-gutter:stable] px-3 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-100 motion-reduce:animate-none">
						{visibleFileEntries.map((entry) => (
							<li key={entry.path} className="flex min-w-0 items-center gap-1">
								<FileEntry
									sessionId={props.sessionId}
									entry={entry}
									onOpenFile={props.onOpenFile}
									onDiffFile={props.onDiffFile}
								/>
							</li>
						))}
					</ul>
				</>
			)}
		</ComposerWidgetFrame>
	);
}
