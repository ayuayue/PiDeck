import { useCallback, useEffect, useMemo, useState } from "react";
import { X, MessageCircle, Brain, FileText } from "lucide-react";
import { t } from "../../i18n";
import type { SessionSummary } from "../../../../shared/types";
import { summarizeMessage, stripAnsi, formatTime } from "./AppUtils";

type SessionMessage = { role: string; content: string; timestamp: number };

export type SessionReferenceResult = {
	sessionName: string;
	messages: SessionMessage[];
	fullContext: boolean;
};

export function SessionReferenceModal(props: {
	session: SessionSummary;
	onClose: () => void;
	onConfirm: (result: SessionReferenceResult, selectedIndices: number[]) => void;
	loadMessages: (filePath: string) => Promise<SessionMessage[]>;
	initialSelected?: Set<number>;
}) {
	// 原始顺序存储，selectedIds 始终引用原始索引
	const [messages, setMessages] = useState<SessionMessage[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [selectedIds, setSelectedIds] = useState<Set<number>>(() => props.initialSelected ?? new Set());

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		setError(null);
		props.loadMessages(props.session.filePath).then((msgs) => {
			if (!cancelled) {
				setMessages(msgs);
				if (props.initialSelected && props.initialSelected.size > 0) {
					setSelectedIds(props.initialSelected);
				} else {
					setSelectedIds(new Set(msgs.map((_, i) => i)));
				}
				setLoading(false);
			}
		}).catch((err) => {
			if (!cancelled) { setError(String(err)); setLoading(false); }
		});
		return () => { cancelled = true; };
	}, [props.session.filePath]);

	// 倒序显示分组（最新的在前面），内部索引保持原始顺序不变
	const items = useMemo(() => {
		const result: Array<
			| { kind: "user"; index: number; msg: SessionMessage }
			| { kind: "assistant-run"; indices: number[]; msgs: SessionMessage[] }
		> = [];
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant") {
				// 收集连续的 assistant
				const runIndices: number[] = [];
				const runMsgs: SessionMessage[] = [];
				while (i >= 0 && messages[i].role === "assistant") {
					runIndices.unshift(i);
					runMsgs.unshift(messages[i]);
					i--;
				}
				i++; // 回退一个位置
				result.push({ kind: "assistant-run", indices: runIndices, msgs: runMsgs });
			} else if (msg.role === "user") {
				result.push({ kind: "user", index: i, msg });
			} else {
				result.push({ kind: "user", index: i, msg });
			}
		}
		return result;
	}, [messages]);

	const toggleMessage = useCallback((index: number) => {
		setSelectedIds((prev) => {
			const next = new Set(prev);
			next.has(index) ? next.delete(index) : next.add(index);
			return next;
		});
	}, []);

	const toggleRun = useCallback((indices: number[]) => {
		setSelectedIds((prev) => {
			const next = new Set(prev);
			const allSelected = indices.every((i) => next.has(i));
			for (const i of indices) {
				if (allSelected) next.delete(i);
				else next.add(i);
			}
			return next;
		});
	}, []);

	const toggleAll = useCallback(() => {
		setSelectedIds((prev) =>
			prev.size === messages.length ? new Set() : new Set(messages.map((_, i) => i))
		);
	}, [messages.length]);

	const handleConfirm = useCallback(() => {
		const indices = Array.from(selectedIds).sort((a, b) => a - b);
		const selected = indices.map((i) => messages[i]);
		props.onConfirm({
			sessionName: props.session.name ?? props.session.filePath,
			messages: selected,
			fullContext: selectedIds.size === messages.length,
		}, indices);
	}, [messages, selectedIds, props]);

	const selectedCount = selectedIds.size;
	const allSelected = selectedCount === messages.length;

	return (
		<div className="multi-select-modal-overlay" onClick={props.onClose}>
			<div className="multi-select-modal session-ref-modal" onClick={(e) => e.stopPropagation()}>
				<header className="multi-select-modal-header">
					<h3>
						{t("sessionRef.title")}:{" "}
						<span className="session-ref-name">{props.session.name ?? props.session.filePath}</span>
					</h3>
					<button className="multi-select-modal-close" onClick={props.onClose} aria-label={t("common.close")}>
						<X size={18} strokeWidth={2} />
					</button>
				</header>

				<div className="multi-select-modal-tree session-ref-message-list">
					{loading && <div className="session-ref-loading">{t("common.loading")}...</div>}
					{error && <div className="session-ref-error">{t("sessionRef.loadError")}: {error}</div>}

					{!loading && !error && items.map((item) => {
						// 用户消息：独立行，完全对齐 MultiSelectModal user message
						if (item.kind === "user") {
							const isChecked = selectedIds.has(item.index);
							return (
								<label
									key={item.index}
									className={`multi-select-tree-node${isChecked ? " selected" : ""}`}
								>
									<input type="checkbox" checked={isChecked} onChange={() => toggleMessage(item.index)} />
									<MessageCircle size={14} className="multi-select-node-icon user" />
									<span className="multi-select-node-label">
										<span className="multi-select-node-summary">
											{summarizeMessage(stripAnsi(item.msg.content))}
										</span>
									</span>
								</label>
							);
						}

						// 助理消息：agent-run 结构，完全对齐 MultiSelectModal agent-run
						if (item.kind === "assistant-run") {
							const runChecked = item.indices.every((i) => selectedIds.has(i));
							const runHasSome = item.indices.some((i) => selectedIds.has(i));
							const runAnyChecked = runChecked || runHasSome;

							return (
								<div key={item.indices[0]} className="multi-select-tree-run">
									<div
										className={`multi-select-tree-node run-parent${runAnyChecked ? " selected" : ""}`}
										onClick={() => toggleRun(item.indices)}
									>
										<Brain size={15} className="multi-select-node-icon assistant" />
										<span className="multi-select-node-label">
											<span className="multi-select-node-run-label">pi</span>
											<span className="multi-select-node-time">
												{formatTime(item.msgs[item.msgs.length - 1]?.timestamp ?? 0)}
											</span>
										</span>
										<span className="multi-select-node-assistant-count">
											{item.msgs.length}
										</span>
									</div>
									<div className="multi-select-run-children">
										{item.msgs.map((sub, si) => {
											const idx = item.indices[si];
											const subChecked = selectedIds.has(idx);
											return (
												<label
													key={idx}
													className={`multi-select-tree-node run-child${subChecked ? " selected" : ""}`}
												>
													<input type="checkbox" checked={subChecked} onChange={() => toggleMessage(idx)} />
													<FileText size={14} className="multi-select-node-icon child" />
													<span className="multi-select-node-label">
														<span className="multi-select-node-summary">
															{summarizeMessage(stripAnsi(sub.content))}
														</span>
													</span>
												</label>
											);
										})}
									</div>
								</div>
							);
						}

						return null;
					})}
				</div>

				<footer className="multi-select-modal-footer">
					<div className="multi-select-modal-footer-top">
						<span className="multi-select-count">
							{allSelected
								? t("sessionRef.messageCount", { count: messages.length })
								: t("sessionRef.selectedCount", { count: selectedCount, total: messages.length })}
						</span>
						<div className="multi-select-bulk-actions">
							<button className="multi-select-bulk-btn" onClick={toggleAll} disabled={!messages.length}>
								{allSelected ? t("common.deselectAll") : t("common.selectAll")}
							</button>
						</div>
					</div>
					<div className="multi-select-modal-footer-bottom">
						<button
							className="multi-select-action-btn"
							disabled={loading || !!error || selectedCount === 0}
							onClick={handleConfirm}
						>
							{allSelected
								? t("sessionRef.insertAll", { count: messages.length })
								: t("sessionRef.insertSelected", { count: selectedCount })}
						</button>
					</div>
				</footer>
			</div>
		</div>
	);
}
