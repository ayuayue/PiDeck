import { Button } from "../components/ui-shadcn/button";
import { showNotice } from "../utils/notice";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Download, ExternalLink, Sparkles } from "lucide-react";
import type { PromptStoreItem, PromptStoreSearchResult, PiSkillSummary } from "../../../shared/types";
import { t } from "../i18n";
import { StoreSearchBar } from "./StoreSearchBar";

const api = (window as unknown as { piDesktop: { skillStore: { search: (q: string) => Promise<PromptStoreSearchResult>; import: (item: PromptStoreItem, locationId?: string, projectId?: string) => Promise<PiSkillSummary> } } }).piDesktop;

const SUGGESTED_SEARCHES = ["code review", "testing", "react", "python", "git", "docker", "security", "refactoring", "typescript", "node"];

export function SkillStoreTab(props: { onImported?: () => void; locationId?: string; projectId?: string }) {
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
			console.error("[SkillStore] Search failed", err);
			setError(t("config.skillStoreSearchError"));
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
			await api.skillStore.import(item, props.locationId, props.projectId);
			showNotice(t("config.skillStoreImported"), 2500);
			props.onImported?.();
		} catch (err) {
			console.error("[SkillStore] Import failed", err);
			setError(t("config.skillStoreImportError"));
		} finally {
			setImportingId(null);
		}
	};

	// 预览详情视图
	if (previewItem) {
		return (
			<div className="prompt-store-tab">
				{error && <div className="mb-3.5 rounded-sm border border-danger/20 bg-danger-soft px-3.5 py-2.5 text-control leading-relaxed text-danger whitespace-pre-line">{error}</div>}
				{/* toast 已改用 sonner */}
				<div className="prompt-store-toolbar">
					<Button
						size="sm"
						variant="outline"
						onClick={() => {
							setPreviewItem(null);
						}}
					>
						<ArrowLeft size={14} strokeWidth={1.8} />
						{t("config.promptStoreBack")}
					</Button>
					<Button size="sm" variant="default" onClick={() => void handleImport(previewItem)} disabled={importingId === previewItem.id}>
						{importingId === previewItem.id ? (
							t("config.promptStoreImporting")
						) : (
							<>
								<Download size={14} strokeWidth={1.8} /> {t("config.skillStoreImportAs")}
							</>
						)}
					</Button>
				</div>
				<div className="prompt-store-preview">
					<div className="prompt-store-preview-header">
						<h3>{previewItem.title}</h3>
						<div className="prompt-store-preview-meta">
							<span>
								{t("config.skillStoreAuthor")} <strong>{previewItem.author}</strong>
							</span>
							{previewItem.category && (
								<span>
									{t("config.skillStoreCategory")} <strong>{previewItem.category}</strong>
								</span>
							)}
						</div>
						{previewItem.tags.length > 0 && (
							<div className="prompt-store-tags">
								{previewItem.tags.map((tag) => (
									<span key={tag} className="prompt-store-tag">
										{tag}
									</span>
								))}
							</div>
						)}
						{previewItem.description && <p className="prompt-store-description">{previewItem.description}</p>}
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
			<StoreSearchBar
				ref={searchInputRef}
				value={query}
				onChange={setQuery}
				onKeyDown={handleKeyDown}
				placeholder={t("config.skillStoreSearchPlaceholder")}
				searching={searching}
				searchDisabled={!query.trim()}
				onSearch={() => void handleSearch(query)}
				suggestions={!result && !searching ? SUGGESTED_SEARCHES : undefined}
				onSuggestionClick={(s) => {
					setQuery(s);
					void handleSearch(s);
				}}
			/>

			{error && <div className="mb-3.5 rounded-sm border border-danger/20 bg-danger-soft px-3.5 py-2.5 text-control leading-relaxed text-danger whitespace-pre-line">{error}</div>}
			{/* toast 已改用 sonner */}
			{searching && <div className="py-12 text-center text-control text-text-tertiary">{t("config.promptStoreSearching")}</div>}

			{result && !searching && result.count === 0 && <div className="py-12 text-center text-control text-text-tertiary">{t("config.skillStoreNoResults")}</div>}

			{result && result.count > 0 && (
				<div className="prompt-store-results">
					<small className="prompt-store-result-count">{t("config.skillStoreResultCount", { count: result.count })}</small>
					{result.prompts.map((item) => (
						<article key={item.id} className="prompt-store-card" onClick={() => setPreviewItem(item)}>
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
								<Button
									variant="ghost"
									size="icon-sm"
									className="size-7"
									title={t("config.promptStorePreview")}
									onClick={(e) => {
										e.stopPropagation();
										setPreviewItem(item);
									}}
								>
									<ExternalLink size={14} strokeWidth={1.8} />
								</Button>
								<Button
									variant="default"
									size="sm"
									onClick={(e) => {
										e.stopPropagation();
										void handleImport(item);
									}}
									disabled={importingId === item.id}
								>
									{importingId === item.id ? t("config.promptStoreImporting") : t("config.promptStoreImport")}
								</Button>
							</div>
						</article>
					))}
				</div>
			)}
		</div>
	);
}
