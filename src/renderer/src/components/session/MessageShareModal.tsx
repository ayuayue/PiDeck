import { useCallback, useMemo, useState } from "react";
import { Check, X } from "lucide-react";
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle } from "../ui-shadcn/dialog";
import { Button } from "../ui-shadcn/button";
import { cn } from "../../lib/utils";
import type { AgentRunItem, RenderMessage } from "../app/AppUtils";
import { t } from "../../i18n";
import { MessageSelectionTree } from "./MessageSelectionTree";
import { getSelectableMessageIds, toggleAll, toggleMessage, toggleRun } from "../../utils/messageSelection";

/**
 * 多选分享弹框：勾选会话消息后复制为文本/Markdown/图片。
 * 选择逻辑与树渲染由共享模块承担（utils/messageSelection + MessageSelectionTree），
 * 本组件只负责弹框外壳、底部操作栏与复制动作。
 */
export function MultiSelectModal(props: { renderedRuns: RenderMessage[]; onClose: () => void; onCopy: (selectedIds: Set<string>, kind: "text" | "markdown" | "image") => void }) {
	const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set(getSelectableMessageIds(props.renderedRuns)));
	const [copying, setCopying] = useState<"text" | "markdown" | "image" | null>(null);

	const allSelectableIds = useMemo(() => getSelectableMessageIds(props.renderedRuns), [props.renderedRuns]);

	const handleToggleMessage = useCallback((id: string) => {
		setSelectedIds((prev) => toggleMessage(prev, id));
	}, []);

	const handleToggleRun = useCallback((run: AgentRunItem) => {
		setSelectedIds((prev) => toggleRun(prev, run));
	}, []);

	const handleSelectAll = useCallback(() => {
		setSelectedIds((prev) => toggleAll(prev, allSelectableIds));
	}, [allSelectableIds]);

	/** 点击分享按钮：先渲染一帧复制反馈，再执行复制并关闭弹框 */
	const handleCopy = useCallback(
		async (kind: "text" | "markdown" | "image") => {
			setCopying(kind);
			// 让按钮先渲染出复制反馈（Check 图标）再执行复制
			await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 120)));
			setCopying(null);
			props.onCopy(selectedIds, kind);
		},
		[selectedIds, props.onCopy],
	);

	const selectedCount = selectedIds.size;
	const totalCount = allSelectableIds.length;
	const busy = copying !== null;

	return (
		<Dialog open onOpenChange={(next) => !next && props.onClose()}>
			<DialogContent
				showCloseButton={false}
				className={cn("flex h-[min(720px,calc(100vh-48px))] w-[min(780px,calc(100vw-48px))] max-w-[min(780px,calc(100vw-48px))] flex-col gap-0 overflow-hidden rounded-lg border border-border bg-bg-panel p-0 shadow-[var(--shadow-modal)]", "animate-in fade-in-0 slide-in-from-bottom-2 duration-fast")}
			>
				<DialogHeader className="flex-row items-center justify-between px-4 py-3">
					<DialogTitle>{t("app.multiSelectEnter")}</DialogTitle>
					<DialogClose asChild>
						<Button variant="ghost" size="icon" aria-label={t("common.close")} title={t("common.close")}>
							<X size={18} strokeWidth={2.2} aria-hidden="true" />
						</Button>
					</DialogClose>
				</DialogHeader>

				{/* 消息树 */}
				<div className="min-h-0 flex-1 overflow-y-auto px-3 py-2.5">
					<MessageSelectionTree items={props.renderedRuns} selectedIds={selectedIds} onToggleMessage={handleToggleMessage} onToggleRun={handleToggleRun} />
				</div>

				{/* 底部操作栏：计数 + 全选/清空 + 分享动作 */}
				<footer className="flex shrink-0 flex-col gap-2.5 border-t border-border-subtle px-4 py-3">
					<div className="flex items-center justify-between">
						<span className="text-control font-medium text-text-secondary">{t("app.multiSelectCount", { count: selectedCount })}</span>
						<div className="flex gap-1">
							<Button variant="ghost" size="sm" className="h-auto px-2 py-1 text-caption" onClick={handleSelectAll} disabled={!totalCount || busy}>
								{t("common.selectAll")}
							</Button>
							<Button variant="ghost" size="sm" className="h-auto px-2 py-1 text-caption" onClick={() => setSelectedIds(new Set())} disabled={!selectedCount || busy}>
								{t("common.deselectAll")}
							</Button>
						</div>
					</div>
					<div className="flex flex-wrap items-center gap-2">
						<Button variant="default" size="sm" className={cn("h-auto px-4 py-1.5 shadow-none", copying === "text" && "border-[var(--color-success)] bg-transparent text-[var(--color-success)] hover:bg-transparent")} disabled={!selectedCount || busy} onClick={() => handleCopy("text")}>
							{copying === "text" ? <Check size={14} strokeWidth={3} aria-hidden="true" /> : t("app.shareAsText")}
						</Button>
						<Button variant="outline" size="sm" className={cn("h-auto px-4 py-1.5 shadow-none", copying === "markdown" && "border-[var(--color-success)] text-[var(--color-success)]")} disabled={!selectedCount || busy} onClick={() => handleCopy("markdown")}>
							{copying === "markdown" ? <Check size={14} strokeWidth={3} aria-hidden="true" /> : t("app.shareAsMarkdown")}
						</Button>
						<Button variant="outline" size="sm" className={cn("h-auto px-4 py-1.5 shadow-none", copying === "image" && "border-[var(--color-success)] text-[var(--color-success)]")} disabled={!selectedCount || busy} onClick={() => handleCopy("image")}>
							{copying === "image" ? <Check size={14} strokeWidth={3} aria-hidden="true" /> : t("app.shareAsImage")}
						</Button>
						<Button variant="ghost" size="sm" className="ml-auto h-auto px-3 py-1.5 text-caption" onClick={props.onClose} disabled={busy}>
							{t("app.multiSelectCancel")}
						</Button>
					</div>
				</footer>
			</DialogContent>
		</Dialog>
	);
}
