import { useCallback, useEffect, useState } from "react";
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

	const toggleMessage = useCallback((index: number) => {
		setSelectedIds((prev) => {
			const next = new Set(prev);
			next.has(index) ? next.delete(index) : next.add(index);
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
			fullContext: selected.length === messages.length,
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
					{!loading && !error && messages.map((msg, index) => {
						const isChecked = selectedIds.has(index);

						// 用户消息：独立行，跟 MultiSelectModal 中 user message 一致
						if (msg.role === "user") {
							return (
								<label
									key={index}
									className={`multi-select-tree-node${isChecked ? " selected" : ""}`}
								>
									<input type="checkbox" checked={isChecked} onChange={() => toggleMessage(index)} />
									<MessageCircle size={14} className="multi-select-node-icon user" />
									<span className="multi-select-node-label">
										<span className="multi-select-node-summary">{summarizeMessage(stripAnsi(msg.content))}</span>
									</span>
								</label>
							);
						}

						// 助理/其他消息：套 agent-run 结构，父行控制子行勾选
						if (msg.role === "assistant") {
							return (
								<div key={index} className="multi-select-tree-run">
									<div
										className={`multi-select-tree-node run-parent${isChecked ? " selected" : ""}`}
										onClick={() => toggleMessage(index)}
									>
										<Brain size={15} className="multi-select-node-icon assistant" />
										<span className="multi-select-node-label">
											<span className="multi-select-node-run-label">pi</span>
											<span className="multi-select-node-time">{formatTime(msg.timestamp)}</span>
										</span>
									</div>
									<div className="multi-select-run-children">
										<label className={`multi-select-tree-node run-child${isChecked ? " selected" : ""}`}>
											<input type="checkbox" checked={isChecked} onChange={() => toggleMessage(index)} />
											<FileText size={14} className="multi-select-node-icon child" />
											<span className="multi-select-node-label">
												<span className="multi-select-node-summary">{summarizeMessage(stripAnsi(msg.content))}</span>
											</span>
										</label>
									</div>
								</div>
							);
						}

						// 其他角色（system/error 等）
						return (
							<label key={index} className={`multi-select-tree-node${isChecked ? " selected" : ""}`}>
								<input type="checkbox" checked={isChecked} onChange={() => toggleMessage(index)} />
								<FileText size={14} className="multi-select-node-icon child" />
								<span className="multi-select-node-label">
									<span className="multi-select-node-summary">{summarizeMessage(stripAnsi(msg.content))}</span>
								</span>
							</label>
						);
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
