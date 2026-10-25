import { cn } from "../../lib/utils";
import { useCallback, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import { normalizeSessionPathForCompare } from "../../agentListDisplay";
import { SessionBackendMark, SessionChannelMark, SessionSourceBadge, SideTaskMark } from "./SessionSourceBadge";
import { Button } from "../ui-shadcn/button";
import { ConfirmDialog } from "../ui-shadcn/ConfirmDialog";
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle } from "../ui-shadcn/dialog";
import { Input } from "../ui-shadcn/input";
import { PathTooltip } from "../ui-shadcn/PathTooltip";
import { Collapsible, CollapsibleContent } from "../ui-shadcn/collapsible";
import { t } from "../../i18n";
import { showNotice } from "../../utils/notice";
import type { Project, SessionSummary } from "../../../../shared/types";

// 会话历史（抽屉里的会话面板 + 历史弹窗）整块从 WorkspaceSurface.tsx 迁出，行为零变化。
// 迁出原因只是 WorkspaceSurface 超过 600 行红线：这两个组件是同一个域（父/子会话列表 + 行内
// 重命名/复制/导出/删除），与文件抽屉类目无关；DrawerContent 与历史弹窗都从这里取 SessionsPanel。

export function SessionsPanel(props: {
	sessions: SessionSummary[];
	onRefresh: () => void;
	onOpen: (session: SessionSummary) => void;
	onRename: (filePath: string, newName: string) => void | Promise<void>;
	onCopy: (session: SessionSummary) => void | Promise<void>;
	onExport: (session: SessionSummary) => void | Promise<void>;
	onDelete: (session: SessionSummary) => void | Promise<void>;
}) {
	const [renamingPath, setRenamingPath] = useState<string | null>(null);
	const [editValue, setEditValue] = useState("");
	/* sessionActionNotice 已改用 toast (sonner) 实现 */
	const [sessionActionLoading, setSessionActionLoading] = useState<{
		filePath: string;
		action: "copy" | "export" | "delete";
	} | null>(null);
	const [deleteConfirmSession, setDeleteConfirmSession] = useState<SessionSummary | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	function startRename(session: SessionSummary) {
		setRenamingPath(session.filePath);
		setEditValue(session.name || "");
		requestAnimationFrame(() => inputRef.current?.focus());
	}

	function confirmRename() {
		if (renamingPath && editValue.trim()) {
			void props.onRename(renamingPath, editValue.trim());
		}
		setRenamingPath(null);
		setEditValue("");
	}

	async function runSessionAction(session: SessionSummary, actionType: "copy" | "export" | "delete", action: () => void | Promise<void>, successText: string) {
		setSessionActionLoading({ filePath: session.filePath, action: actionType });
		showNotice(actionType === "copy" ? t("drawer.sessionActionCopying") : actionType === "export" ? t("drawer.sessionActionExporting") : t("drawer.sessionActionDeleting"), 3500);
		try {
			await action();
			showNotice(successText, 1600);
		} catch (error) {
			showNotice(error instanceof Error ? error.message : t("drawer.sessionActionFailed"), 2400);
		} finally {
			setSessionActionLoading(null);
		}
	}

	// 计算子会话到父会话的分组映射；路径可能跨 Windows/WSL 或经过 IPC，统一分隔符和大小写。
	const parentToChildren = useMemo(() => {
		const map = new Map<string, SessionSummary[]>();
		for (const s of props.sessions) {
			const parentKey = normalizeSessionPathForCompare(s.parentSessionPath);
			if (parentKey) {
				const list = map.get(parentKey) ?? [];
				list.push(s);
				map.set(parentKey, list);
			}
		}
		return map;
	}, [props.sessions]);
	// 仅显示顶层会话（非子会话）的计数
	const parentSessions = useMemo(() => props.sessions.filter((s) => !s.parentSessionPath), [props.sessions]);
	const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set());
	const toggleParent = useCallback((filePath: string) => {
		const key = normalizeSessionPathForCompare(filePath) ?? filePath;
		setExpandedParents((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	}, []);

	return (
		<div className="sessions-panel">
			<div className="panel-action-row">
				<span>{t("drawer.sessionCount", { count: parentSessions.length })}</span>
				<Button variant="ghost" size="sm" onClick={props.onRefresh}>
					{t("common.refresh")}
				</Button>
			</div>
			{parentSessions.length === 0 && (
				<div className="sessions-empty">
					<strong>{t("drawer.sessionEmptyTitle")}</strong>
					<span>{t("drawer.sessionEmptyDesc")}</span>
				</div>
			)}
			{parentSessions.map((session) => {
				const children = parentToChildren.get(normalizeSessionPathForCompare(session.filePath) ?? "");
				const normalizedPath = normalizeSessionPathForCompare(session.filePath) ?? session.filePath;
				const isExpanded = expandedParents.has(normalizedPath);
				return (
					<div key={session.filePath} className="session-card-group">
						<div className="session-card">
							{renamingPath === session.filePath ? (
								<div className="session-rename-row">
									<Input
										ref={inputRef}
										value={editValue}
										onChange={(e) => setEditValue(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Enter") confirmRename();
											if (e.key === "Escape") {
												setRenamingPath(null);
												setEditValue("");
											}
										}}
										autoFocus
									/>
									<Button size="sm" onClick={confirmRename}>
										{t("common.save")}
									</Button>
									<Button
										size="sm"
										variant="outline"
										onClick={() => {
											setRenamingPath(null);
											setEditValue("");
										}}
									>
										{t("common.cancel")}
									</Button>
								</div>
							) : (
								<div className="session-card-display">
									<PathTooltip content={`${session.name || t("common.untitled")}\n${session.filePath}`}>
										<button className="session-card-inner" onClick={() => props.onOpen(session)}>
											<div className="session-card-title">
												<strong>{session.name || t("common.untitled")}</strong>
												{session.source && session.source !== "pi" && <SessionSourceBadge source={session.source} />}
												{session.channel && <SessionChannelMark channel={session.channel} />}
												{session.sideTask && <SideTaskMark />}
												{/* 非 pi 后端（dsh/imagegen/acp）用后端徽标区分；此前只显 source 徽标，ACP/DSH 会话在此卡无任何标识 */}
												{session.backend && session.backend !== "pi" && <SessionBackendMark backend={session.backend} />}
												<small>
													{new Date(session.updatedAt).toLocaleString()} ·{" "}
													{t("drawer.sessionMessages", {
														count: session.messageCount,
													})}
												</small>
											</div>
										</button>
									</PathTooltip>
									<div className="session-card-actions">
										<Button variant="ghost" className="session-rename-button" title={t("menu.copySession")} disabled={Boolean(sessionActionLoading)} onClick={() => void runSessionAction(session, "copy", () => props.onCopy(session), t("drawer.sessionCopied"))}>
											{sessionActionLoading?.filePath === session.filePath && sessionActionLoading.action === "copy" && <span className="mini-loader animate-pideck-spin" />}
											<span>{sessionActionLoading?.filePath === session.filePath && sessionActionLoading.action === "copy" ? t("menu.copying") : t("common.copy")}</span>
										</Button>
										<Button variant="ghost" className="session-rename-button" title={t("menu.exportHtml")} disabled={Boolean(sessionActionLoading)} onClick={() => void runSessionAction(session, "export", () => props.onExport(session), t("drawer.sessionExported"))}>
											{sessionActionLoading?.filePath === session.filePath && sessionActionLoading.action === "export" && <span className="mini-loader animate-pideck-spin" />}
											<span>{sessionActionLoading?.filePath === session.filePath && sessionActionLoading.action === "export" ? t("menu.exporting") : t("common.export")}</span>
										</Button>
										<Button variant="ghost" className="session-rename-button" title={t("common.rename")} onClick={() => startRename(session)}>
											<span>{t("common.rename")}</span>
										</Button>
										<Button variant="ghost" className="session-rename-button text-destructive" title={t("common.delete")} disabled={Boolean(sessionActionLoading)} onClick={() => setDeleteConfirmSession(session)}>
											{sessionActionLoading?.filePath === session.filePath && sessionActionLoading.action === "delete" && <span className="mini-loader animate-pideck-spin" />}
											<span>{sessionActionLoading?.filePath === session.filePath && sessionActionLoading.action === "delete" ? t("drawer.sessionActionDeleting") : t("common.delete")}</span>
										</Button>
									</div>
									{/* sessionActionNotice 已改用 toast (sonner) 实现 */}
								</div>
							)}
						</div>
						{children && children.length > 0 && (
							<div className="session-card-children-header">
								<button className="session-card-expand-btn" title={isExpanded ? t("drawer.collapseSubagentSessions") : t("drawer.expandSubagentSessions")} onClick={() => toggleParent(session.filePath)}>
									{isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
									<span>{t("drawer.subagentSessionCount", { count: children.length })}</span>
								</button>
							</div>
						)}
						{/* 子会话列表走共享折叠原语（真高度渐变 + exit 后卸载 + reduced-motion 回退）；
						    display:contents 根不生成盒子，折叠态零空档。 */}
						<Collapsible open={isExpanded} className="contents">
							<CollapsibleContent>
								{children?.map((child) => (
									<div key={child.filePath} className="session-card session-card-child">
										<div className="session-card-display">
											<PathTooltip content={`${child.name || t("common.untitled")}\n${child.filePath}`}>
												<button className="session-card-inner" onClick={() => props.onOpen(child)}>
													<div className="session-card-title">
														<strong>{child.name || t("common.untitled")}</strong>
														<SessionSourceBadge label={t("drawer.subagentSession")} source="codex" />
														<small>
															{new Date(child.updatedAt).toLocaleString()} ·{" "}
															{t("drawer.sessionMessages", {
																count: child.messageCount,
															})}
														</small>
													</div>
												</button>
											</PathTooltip>
										</div>
									</div>
								))}
							</CollapsibleContent>
						</Collapsible>
					</div>
				);
			})}
			{deleteConfirmSession &&
				(() => {
					const deleteChildren = parentToChildren.get(normalizeSessionPathForCompare(deleteConfirmSession.filePath) ?? "") ?? [];
					// #115 U5：删除确认统一走 shadcn ConfirmDialog（danger 变体），删掉散装 backdrop
					return (
						<ConfirmDialog
							title={t("drawer.sessionDeleteTitle")}
							message={
								deleteChildren.length > 0
									? t("drawer.sessionDeleteBodyWithChildren", {
											name: deleteConfirmSession.name || t("common.untitled"),
											count: deleteChildren.length,
										})
									: t("drawer.sessionDeleteBody", {
											name: deleteConfirmSession.name || t("common.untitled"),
										})
							}
							confirmLabel={t("common.delete")}
							danger
							onCancel={() => setDeleteConfirmSession(null)}
							onConfirm={() => {
								const target = deleteConfirmSession;
								setDeleteConfirmSession(null);
								void runSessionAction(target, "delete", () => props.onDelete(target), t("drawer.sessionDeleted"));
							}}
						/>
					);
				})()}
		</div>
	);
}

export function SessionHistoryModal(props: {
	project: Project;
	sessions: SessionSummary[];
	loading: boolean;
	onClose: () => void;
	onRefresh: () => void;
	onOpen: (session: SessionSummary) => void;
	onRename: (filePath: string, newName: string) => void | Promise<void>;
	onCopy: (session: SessionSummary) => void | Promise<void>;
	onExport: (session: SessionSummary) => void | Promise<void>;
	onDelete: (session: SessionSummary) => void | Promise<void>;
}) {
	return (
		<Dialog open onOpenChange={(next) => !next && props.onClose()}>
			<DialogContent showCloseButton={false} className={cn("flex max-h-[min(680px,calc(100vh-80px))] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(800px,calc(100vw-48px))]")}>
				<DialogHeader className="flex-row items-center justify-between px-4 py-3">
					<DialogTitle></DialogTitle>
					<DialogClose asChild>
						<Button variant="ghost" size="icon" aria-label={t("common.close")} title={t("common.close")}>
							<X size={18} strokeWidth={2.2} aria-hidden="true" />
						</Button>
					</DialogClose>
				</DialogHeader>
				<div className="truncate border-b border-border-subtle bg-bg-muted px-[18px] py-[10px] text-caption text-text-secondary" title={props.project.path}>
					{props.project.path}
				</div>
				<div className="relative flex min-h-[320px] flex-1 flex-col overflow-hidden">
					{props.loading ? (
						<div className="grid min-h-[320px] place-items-center content-center gap-3 text-body text-text-tertiary">
							<div className="loader animate-pideck-spin" />
							<span>{t("drawer.historyLoading")}</span>
						</div>
					) : (
						<SessionsPanel sessions={props.sessions} onRefresh={props.onRefresh} onOpen={props.onOpen} onRename={props.onRename} onCopy={props.onCopy} onExport={props.onExport} onDelete={props.onDelete} />
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}

/** 创建 git worktree 的对话框 */
