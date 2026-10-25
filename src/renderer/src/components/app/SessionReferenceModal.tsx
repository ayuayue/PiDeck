import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, X } from "lucide-react";
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle } from "../ui-shadcn/dialog";
import { Button } from "../ui-shadcn/button";
import { cn } from "../../lib/utils";
import { t } from "../../i18n";
import type { ChatMessage, SessionSummary } from "../../../../shared/types";
import type { AgentRunItem, RenderMessage } from "../app/AppUtils";
import { MessageSelectionTree } from "../session/MessageSelectionTree";
import { getSelectableMessageIds, toggleAll, toggleMessage, toggleRun } from "../../utils/messageSelection";

type SessionMessage = { role: string; content: string; timestamp: number };

export type SessionReferenceResult = {
	sessionName: string;
	messages: SessionMessage[];
	fullContext: boolean;
};

/** 合成消息 id 前缀：id 需在树内唯一，索引为原始消息下标（恢复选择/回调都靠它）。 */
const REF_ID_PREFIX = "ref-";

/**
 * 把会话原始消息构建成共享树结构（RenderMessage[]）。
 * 显示顺序保持原行为：最新在前（倒序）；连续 assistant 归入同一 agent-run。
 * 非 user/assistant 消息（tool/system）不展示也不可选 —— 旧实现会把它们
 * 隐式选中且无法取消（行不渲染但 index 在 selectedIds 里），本次修复该口径。
 */
function buildReferenceTree(messages: SessionMessage[]): {
	items: RenderMessage[];
	idToIndex: Map<string, number>;
} {
	const items: RenderMessage[] = [];
	const idToIndex = new Map<string, number>();
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			// 收集连续的 assistant 组成一个 run（顺序恢复为正序）
			const subItems: Array<{ kind: "message"; message: ChatMessage }> = [];
			let j = i;
			while (j >= 0 && messages[j].role === "assistant") {
				const id = `${REF_ID_PREFIX}${j}`;
				idToIndex.set(id, j);
				subItems.unshift({
					kind: "message",
					message: {
						id,
						agentId: "",
						role: "assistant",
						text: messages[j].content,
						timestamp: messages[j].timestamp,
					},
				});
				j--;
			}
			i = j + 1;
			items.push({
				kind: "agent-run",
				id: `ref-run-${i}`,
				items: subItems,
				startedAt: subItems[0]?.message.timestamp ?? 0,
				endedAt: subItems[subItems.length - 1]?.message.timestamp ?? 0,
				// 会话引用只用于展示所选消息列表，不参与耗时统计
				askWaitMs: 0,
				askPending: false,
			});
		} else if (msg.role === "user") {
			const id = `${REF_ID_PREFIX}${i}`;
			idToIndex.set(id, i);
			items.push({
				kind: "message",
				message: {
					id,
					agentId: "",
					role: "user",
					text: msg.content,
					timestamp: msg.timestamp,
				},
			});
		}
	}
	return { items, idToIndex };
}

export function SessionReferenceModal(props: { session: SessionSummary; onClose: () => void; onConfirm: (result: SessionReferenceResult, selectedIndices: number[]) => void; loadMessages: (sessionId: string) => Promise<SessionMessage[]>; initialSelected?: Set<number> }) {
	const [messages, setMessages] = useState<SessionMessage[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

	const tree = useMemo(() => buildReferenceTree(messages), [messages]);
	const selectableIds = useMemo(() => getSelectableMessageIds(tree.items), [tree]);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		setError(null);
		props
			.loadMessages(props.session.id)
			.then((msgs) => {
				if (cancelled) return;
				setMessages(msgs);
				const built = buildReferenceTree(msgs);
				// 恢复历史选择时只保留树内存在的 id：旧版本曾把 tool 消息隐式选中，
				// 其索引在树中无对应行，恢复时应丢弃，避免「看不到也取消不掉」。
				if (props.initialSelected && props.initialSelected.size > 0) {
					setSelectedIds(
						new Set(
							Array.from(props.initialSelected)
								.map((index) => `${REF_ID_PREFIX}${index}`)
								.filter((id) => built.idToIndex.has(id)),
						),
					);
				} else {
					setSelectedIds(new Set(getSelectableMessageIds(built.items)));
				}
				setLoading(false);
			})
			.catch((err) => {
				if (!cancelled) {
					setError(String(err));
					setLoading(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [props.session.id]);

	const handleToggleMessage = useCallback((id: string) => {
		setSelectedIds((prev) => toggleMessage(prev, id));
	}, []);

	const handleToggleRun = useCallback((run: AgentRunItem) => {
		setSelectedIds((prev) => toggleRun(prev, run));
	}, []);

	const handleToggleAll = useCallback(() => {
		setSelectedIds((prev) => toggleAll(prev, selectableIds));
	}, [selectableIds]);

	const handleConfirm = useCallback(() => {
		const indices = Array.from(selectedIds)
			.map((id) => tree.idToIndex.get(id))
			.filter((index): index is number => index !== undefined)
			.sort((left, right) => left - right);
		const selected = indices.map((index) => messages[index]);
		props.onConfirm(
			{
				sessionName: props.session.name ?? props.session.filePath,
				messages: selected,
				fullContext: selectedIds.size === selectableIds.length,
			},
			indices,
		);
	}, [messages, selectedIds, tree, selectableIds, props]);

	const selectedCount = selectedIds.size;
	const allSelected = selectedCount > 0 && selectedCount === selectableIds.length;
	const canConfirm = !loading && !error && selectedCount > 0;

	return (
		<Dialog open onOpenChange={(next) => !next && props.onClose()}>
			<DialogContent
				showCloseButton={false}
				className={cn("flex h-[min(650px,calc(100vh-48px))] w-[min(780px,calc(100vw-48px))] max-w-[min(780px,calc(100vw-48px))] flex-col gap-0 overflow-hidden rounded-lg border border-border bg-bg-panel p-0 shadow-[var(--shadow-modal)]", "animate-in fade-in-0 slide-in-from-bottom-2 duration-fast")}
			>
				<DialogHeader className="flex-row items-center justify-between px-4 py-3">
					<DialogTitle>{`${t("sessionRef.title")}: ${props.session.name ?? props.session.filePath}`}</DialogTitle>
					<DialogClose asChild>
						<Button variant="ghost" size="icon" aria-label={t("common.close")} title={t("common.close")}>
							<X size={18} strokeWidth={2.2} aria-hidden="true" />
						</Button>
					</DialogClose>
				</DialogHeader>

				<div className="min-h-0 flex-1 overflow-y-auto px-3 py-2.5">
					{loading && (
						<div className="flex items-center justify-center gap-2 px-4 py-10 text-caption text-text-tertiary">
							<Loader2 size={14} className="animate-pideck-spin" aria-hidden="true" />
							{t("common.loading")}...
						</div>
					)}
					{error && (
						<div className="flex items-center justify-center px-4 py-10 text-caption text-[var(--color-error)]">
							{t("sessionRef.loadError")}: {error}
						</div>
					)}
					{!loading && !error && <MessageSelectionTree items={tree.items} selectedIds={selectedIds} onToggleMessage={handleToggleMessage} onToggleRun={handleToggleRun} />}
				</div>

				{/* 底部操作栏：与多选分享弹窗同一套视觉语言 */}
				<footer className="flex shrink-0 flex-col gap-2.5 border-t border-border-subtle px-4 py-3">
					<div className="flex items-center justify-between">
						<span className="text-control font-medium text-text-secondary">{allSelected ? t("sessionRef.messageCount", { count: messages.length }) : t("sessionRef.selectedCount", { count: selectedCount, total: selectableIds.length })}</span>
						<Button variant="ghost" size="sm" className="h-auto px-2 py-1 text-caption" onClick={handleToggleAll} disabled={!selectableIds.length}>
							{allSelected ? t("common.deselectAll") : t("common.selectAll")}
						</Button>
					</div>
					<div className="flex flex-wrap items-center gap-2">
						<Button variant="default" size="sm" className="h-auto px-4 py-1.5 shadow-none" disabled={!canConfirm} onClick={handleConfirm}>
							{allSelected ? t("sessionRef.insertAll", { count: messages.length }) : t("sessionRef.insertSelected", { count: selectedCount })}
						</Button>
						<Button variant="ghost" size="sm" className="ml-auto h-auto px-3 py-1.5 text-caption" onClick={props.onClose}>
							{t("app.multiSelectCancel")}
						</Button>
					</div>
				</footer>
			</DialogContent>
		</Dialog>
	);
}
