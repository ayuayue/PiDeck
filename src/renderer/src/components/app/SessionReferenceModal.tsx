import { useCallback, useEffect, useState } from "react";
import { X, Check, MessageCircle, Brain, FileText } from "lucide-react";
import { t } from "../../i18n";
import type { SessionSummary } from "../../../../shared/types";

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
	const [mode, setMode] = useState<"full" | "select">("full");

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		setError(null);
		props.loadMessages(props.session.filePath).then((msgs) => {
			if (!cancelled) { setMessages(msgs); setSelectedIds(new Set(msgs.map((_, i) => i))); setLoading(false); }
		}).catch((err) => {
			if (!cancelled) { setError(String(err)); setLoading(false); }
		});
		return () => { cancelled = true; };
	}, [props.session.filePath]);

	const toggleMessage = useCallback((index: number) => {
		setSelectedIds((prev) => { const next = new Set(prev); next.has(index) ? next.delete(index) : next.add(index); return next; });
	}, []);

	const toggleAll = useCallback(() => {
		setSelectedIds((prev) => prev.size === messages.length ? new Set() : new Set(messages.map((_, i) => i)));
	}, [messages.length]);

	const handleConfirm = useCallback(() => {
		props.onConfirm({
			sessionName: props.session.name ?? props.session.filePath,
			messages: mode === "full" ? messages : messages.filter((_, i) => selectedIds.has(i)),
			fullContext: mode === "full",
		});
	}, [mode, messages, selectedIds, props]);

	const selectedCount = mode === "full" ? messages.length : selectedIds.size;

	return (
		<div className="multi-select-modal-overlay" onClick={props.onClose}>
			<div className="multi-select-modal session-ref-modal" onClick={(e) => e.stopPropagation()}>
				<header className="multi-select-modal-header">
					<h3>{t("sessionRef.title")}: <span className="session-ref-name">{props.session.name ?? props.session.filePath}</span></h3>
					<button className="multi-select-modal-close" onClick={props.onClose} aria-label={t("common.close")}><X size={18} strokeWidth={2} /></button>
				</header>
				<div className="session-ref-mode-tabs">
					<button className={`session-ref-mode-btn${mode === "full" ? " active" : ""}`} onClick={() => setMode("full")}>
						<Brain size={14} /><span>{t("sessionRef.fullContext")}</span>
					</button>
					<button className={`session-ref-mode-btn${mode === "select" ? " active" : ""}`} onClick={() => setMode("select")}>
						<FileText size={14} /><span>{t("sessionRef.selectMessages")}</span>
					</button>
				</div>
				<div className="multi-select-modal-tree session-ref-message-list">
					{loading && <div className="session-ref-loading">{t("common.loading")}...</div>}
					{error && <div className="session-ref-error">{t("sessionRef.loadError")}: {error}</div>}
					{!loading && !error && messages.map((msg, index) => {
						const isChecked = selectedIds.has(index);
						return (
							<label key={index} className={`multi-select-tree-node session-ref-msg${isChecked ? " selected" : ""}${mode === "full" ? " disabled" : ""}`}>
								{mode === "select" && <input type="checkbox" checked={isChecked} onChange={() => toggleMessage(index)} />}
								{mode === "full" ? <Check size={14} className="multi-select-node-icon" /> :
									msg.role === "user" ? <MessageCircle size={14} className="multi-select-node-icon user" /> :
									<Brain size={14} className="multi-select-node-icon assistant" />}
								<span className="multi-select-node-label">
									<span className="multi-select-node-summary">{msg.content.slice(0, 200)}{msg.content.length > 200 ? "..." : ""}</span>
								</span>
							</label>
						);
					})}
				</div>
				<footer className="multi-select-modal-footer">
					<div className="multi-select-modal-footer-top">
						<span className="multi-select-count">
							{mode === "full" ? t("sessionRef.messageCount", { count: messages.length }) : t("sessionRef.selectedCount", { count: selectedCount, total: messages.length })}
						</span>
						{mode === "select" && (
							<div className="multi-select-bulk-actions">
								<button className="multi-select-bulk-btn" onClick={toggleAll} disabled={!messages.length}>
									{selectedIds.size === messages.length ? t("common.deselectAll") : t("common.selectAll")}
								</button>
							</div>
						)}
					</div>
					<div className="multi-select-modal-footer-bottom">
						<button className="multi-select-action-btn" disabled={loading || !!error || selectedCount === 0} onClick={handleConfirm}>
							{t("sessionRef.insertReference")}
						</button>
					</div>
				</footer>
			</div>
		</div>
	);
}
