import { useCallback, useEffect, useState } from "react";
import { X, MessageCircle, Brain } from "lucide-react";
import { t } from "../../i18n";
import type { SessionSummary } from "../../../../shared/types";
import { summarizeMessage, stripAnsi } from "./AppUtils";

type SessionMessage = { role: string; content: string; timestamp: number };

export type SessionReferenceResult = {
	sessionName: string;
	messages: SessionMessage[];
	fullContext: boolean;
};

export function SessionReferenceModal(props: {
	session: SessionSummary;
	onClose: () => void;
	onConfirm: (result: SessionReferenceResult) => void;
	loadMessages: (filePath: string) => Promise<SessionMessage[]>;
}) {
	const [messages, setMessages] = useState<SessionMessage[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		setError(null);
		props.loadMessages(props.session.filePath).then((msgs) => {
			if (!cancelled) {
				setMessages(msgs);
				setSelectedIds(new Set(msgs.map((_, i) => i)));
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
		const selected = messages.filter((_, i) => selectedIds.has(i));
		props.onConfirm({
			sessionName: props.session.name ?? props.session.filePath,
			messages: selected,
			fullContext: selected.length === messages.length,
		});
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
						return (
							<label key={index} className={`multi-select-tree-node session-ref-msg${isChecked ? " selected" : ""}`}>
								<input type="checkbox" checked={isChecked} onChange={() => toggleMessage(index)} />
								{msg.role === "user"
									? <MessageCircle size={14} className="multi-select-node-icon user" />
									: <Brain size={14} className="multi-select-node-icon assistant" />}
								<span className="multi-select-node-label">
									<span className="multi-select-node-run-label">{msg.role === "user" ? "You" : "pi"}</span>
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
