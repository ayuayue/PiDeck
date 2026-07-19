import { showNotice } from "../utils/notice";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Download, ExternalLink, Search, Sparkles } from "lucide-react";
import type { PromptStoreItem, PromptStoreSearchResult, PiSkillSummary } from "../../../shared/types";
import { t } from "../i18n";

const api = (window as unknown as { piDesktop: { skillStore: { search: (q: string) => Promise<PromptStoreSearchResult>; import: (item: PromptStoreItem, locationId?: string) => Promise<PiSkillSummary> } } }).piDesktop;

const SUGGESTED_SEARCHES = ["code review", "testing", "react", "python", "git", "docker", "security", "refactoring", "typescript", "node"];

export function SkillStoreTab(props: {
	onImported?: () => void;
	locationId?: string;
}) {
	const [query, setQuery] = useState("");
	const [searching, setSearching] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [result, setResult] = useState<PromptStoreSearchResult | null>(null);
	const [previewItem, setPreviewItem] = useState<PromptStoreItem | null>(null);
	const [importingId, setImportingId] = useState<string | null>(null);
	/* toast 已改用 sonner 实现 */
	const searchInputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		searchInputRef.current?.focus();
	}, []);

	const handleSearch = useCallback(async (searchQuery: string) => {
		const q = searchQuery.trim();
		if (!q) return;
		setResult(null);
		setPreviewItem(null);
		setError(null);
		setSearching(true);
		try {
			const data = await api.skillStore.search(q);
			setResult(data);
		} catch (err) {
			setError("搜索 skill 商店失败");
			setResult(null);
		} finally {
			setSearching(false);
		}
	}, []);

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter") void handleSearch(query);
	};

	const handleImport = async (item: PromptStoreItem) => {
		setImportingId(item.id);
		setError(null);
		try {
			await api.skillStore.import(item, props.locationId);
			showNotice("已导入到本地 Skills", 2500);
			props.onImported?.();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setImportingId(null);
		}
	};

	// 预览详情视图
	if (previewItem) {
		return (
			<div className="prompt-store-tab">
				{error && <div className="config-error">{error}</div>}
				{/* toast 已改用 sonner */}
				<div className="prompt-store-toolbar">
					<button className="config-btn" onClick={() => { setPreviewItem(null); }}>
						<ArrowLeft size={14} strokeWidth={1.8} />
						{t("config.promptStoreBack")}
					</button>
					<button
						className="config-btn primary"
						onClick={() => void handleImport(previewItem)}
						disabled={importingId === previewItem.id}
					>
						{importingId === previewItem.id ? (
							"导入中…"
						) : (
							<><Download size={14} strokeWidth={1.8} /> 导入为 Skill</>
						)}
					</button>
				</div>
				<div className="prompt-store-preview">
					<div className="prompt-store-preview-header">
						<h3>{previewItem.title}</h3>
						<div className="prompt-store-preview-meta">
							<span>作者 <strong>{previewItem.author}</strong></span>
							{previewItem.category && <span>分类 <strong>{previewItem.category}</strong></span>}
						</div>
						{previewItem.tags.length > 0 && (
							<div className="prompt-store-tags">
								{previewItem.tags.map((tag) => (
									<span key={tag} className="prompt-store-tag">{tag}</span>
								))}
							</div>
						)}
						{previewItem.description && (
							<p className="prompt-store-description">{previewItem.description}</p>
						)}
					</div>
					<div className="prompt-store-preview-content">
						<pre>{previewItem.content}</pre>
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className="prompt-store-tab">
			<div className="prompt-store-search-bar">
				<div className="prompt-store-search-input-wrap">
					<Search size={15} strokeWidth={1.8} className="prompt-store-search-icon" />
					<input
						ref={searchInputRef}
						type="text"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						onKeyDown={handleKeyDown}
						placeholder="搜索 prompt.chat 中的 Skill…"
						disabled={searching}
					/>
					<button
						className="config-btn primary"
						onClick={() => void handleSearch(query)}
						disabled={searching || !query.trim()}
					>
						{searching ? "搜索中…" : <Search size={14} strokeWidth={1.8} />}
					</button>
				</div>
				{!result && !searching && (
					<div className="prompt-store-suggestions">
						{SUGGESTED_SEARCHES.map((s) => (
							<button key={s} className="prompt-store-suggestion-chip" onClick={() => { setQuery(s); void handleSearch(s); }}>
								{s}
							</button>
						))}
					</div>
				)}
			</div>

			{error && <div className="config-error">{error}</div>}
			{/* toast 已改用 sonner */}
			{searching && <div className="config-loading">搜索中…</div>}

			{result && !searching && result.count === 0 && (
				<div className="config-empty">无搜索结果</div>
			)}

			{result && result.count > 0 && (
				<div className="prompt-store-results">
					<small className="prompt-store-result-count">{result.count} results</small>
					{result.prompts.map((item) => (
						<article
							key={item.id}
							className="prompt-store-card"
							onClick={() => setPreviewItem(item)}
						>
							<div className="prompt-store-card-main">
								<strong className="prompt-store-card-title">
									<Sparkles size={12} strokeWidth={1.8} style={{ marginRight: 4 }} />
									{item.title}
								</strong>
								<p className="prompt-store-card-desc">{item.description}</p>
								<div className="prompt-store-card-meta">
									<span>{item.author}</span>
									{item.category && <span className="prompt-store-card-category">{item.category}</span>}
								</div>
							</div>
							<div className="prompt-store-card-actions">
								<button
									className="config-icon-btn"
									title={t("config.promptStorePreview")}
									onClick={(e) => { e.stopPropagation(); setPreviewItem(item); }}
								>
									<ExternalLink size={14} strokeWidth={1.8} />
								</button>
								<button
									className="config-btn primary small"
									onClick={(e) => { e.stopPropagation(); void handleImport(item); }}
									disabled={importingId === item.id}
								>
									{importingId === item.id ? "导入中…" : "导入"}
								</button>
							</div>
						</article>
					))}
				</div>
			)}
		</div>
	);
}
