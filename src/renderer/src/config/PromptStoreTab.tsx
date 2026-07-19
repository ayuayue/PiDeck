import { showNotice } from "../utils/notice";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, BookOpen, Download, ExternalLink, Globe, Search } from "lucide-react";
import type { PromptStoreItem, PromptStoreSearchResult, PiPromptTemplateSummary } from "../../../shared/types";
import { t } from "../i18n";
import { YaoPromptTab } from "./YaoPromptTab";

const api = (window as unknown as { piDesktop: { promptStore: { search: (q: string, opts?: { limit?: number }) => Promise<PromptStoreSearchResult>; get: (id: string) => Promise<PromptStoreItem>; import: (data: { title: string; description: string; content: string }) => Promise<PiPromptTemplateSummary> } } }).piDesktop;

/**
 * 搜索提示常量：用户在商店搜索栏中看到的热门推荐关键词。
 * 方便用户快速了解商店能搜到什么类型的 Prompt。
 */
const SUGGESTED_SEARCHES = ["code review", "refactoring", "test", "git", "documentation", "security", "debugging", "docker", "api design", "typescript", "react", "python"];

export function PromptStoreTab(props: {
	/** 导入成功后的回调，用于刷新本地模板列表 */
	onImported?: () => void;
}) {
	const [storeSubTab, setStoreSubTab] = useState<"store" | "yao">("store");
	const [query, setQuery] = useState("");
	const [searching, setSearching] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [result, setResult] = useState<PromptStoreSearchResult | null>(null);
	const [previewItem, setPreviewItem] = useState<PromptStoreItem | null>(null);
	const [importingId, setImportingId] = useState<string | null>(null);
	/* toast 已改用 sonner 实现 */
	const searchInputRef = useRef<HTMLInputElement>(null);

	// 自动聚焦搜索框
	useEffect(() => {
		searchInputRef.current?.focus();
	}, []);

	/**
	 * 执行搜索。清空旧结果和预览状态，调用 prompts.chat API 搜索。
	 * 先清除旧结果再发起请求，避免用户在输入新搜索时看到陈旧结果。
	 */
	const handleSearch = useCallback(async (searchQuery: string) => {
		const q = searchQuery.trim();
		if (!q) return;
		// 立即清除旧结果，避免用户看到上一次搜索的残留数据
		setResult(null);
		setPreviewItem(null);
		setError(null);
		setSearching(true);
		try {
			const data = await api.promptStore.search(q, { limit: 20 });
			setResult(data);
		} catch (err) {
			setError(t("config.promptStoreError"));
			setResult(null);
		} finally {
			setSearching(false);
		}
	}, []);

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter") {
			void handleSearch(query);
		}
	};

	/**
	 * 导入选中的 prompt 到本地 ~/.pi/agent/prompts/。
	 * 使用主进程的 PromptManager 创建文件，成功后显示 toast 通知。
	 */
	const handleImport = async (item: PromptStoreItem) => {
		setImportingId(item.id);
		setError(null);
		try {
			await api.promptStore.import({
				title: item.title,
				description: item.description,
				content: item.content,
			});
			showNotice(t("config.promptStoreImported"), 2500);
			props.onImported?.();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setImportingId(null);
		}
	};

	const showPreview = async (item: PromptStoreItem) => {
		setPreviewItem(item);
	};

	const backToList = () => {
		setPreviewItem(null);
	};

	// 预览详情视图
	if (previewItem) {
		return (
			<div className="prompt-store-tab">
				{/* 预览视图也需要错误提示和 toast 反馈 */}
				{error && <div className="config-error">{error}</div>}
				{/* toast 已改用 sonner */}
				<div className="prompt-store-toolbar">
					<button className="config-btn" onClick={backToList}>
						<ArrowLeft size={14} strokeWidth={1.8} />
						{t("config.promptStoreBack")}
					</button>
					<button
						className="config-btn primary"
						onClick={() => void handleImport(previewItem)}
						disabled={importingId === previewItem.id}
					>
						{importingId === previewItem.id ? (
							t("config.promptStoreImporting")
						) : (
							<><Download size={14} strokeWidth={1.8} /> {t("config.promptStoreImport")}</>
						)}
					</button>
				</div>
				<div className="prompt-store-preview">
					<div className="prompt-store-preview-header">
						<h3>{previewItem.title}</h3>
						<div className="prompt-store-preview-meta">
							<span>{t("config.promptStoreBy")} <strong>{previewItem.author}</strong></span>
							<span>{t("config.promptStoreFrom")} <strong>{previewItem.category}</strong></span>
							<span className="prompt-store-votes">{t("config.promptStoreVotes", { count: previewItem.votes })}</span>
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
			{/* 子 tab 切换：国际商店 / 中文精选 */}
			<div className="prompts-tab-bar">
				<button
					className={`prompts-tab-btn ${storeSubTab === "store" ? "active" : ""}`}
					onClick={() => setStoreSubTab("store")}
				>
					<Globe size={14} strokeWidth={1.8} />
					prompts.chat
				</button>
				<button
					className={`prompts-tab-btn ${storeSubTab === "yao" ? "active" : ""}`}
					onClick={() => setStoreSubTab("yao")}
				>
					<BookOpen size={14} strokeWidth={1.8} />
					中文精选
				</button>
			</div>

			{storeSubTab === "yao" ? (
				<YaoPromptTab onImported={props.onImported} />
			) : (
				<>
					{/* 搜索栏 */}
					<div className="prompt-store-search-bar">
				<div className="prompt-store-search-input-wrap">
					<Search size={15} strokeWidth={1.8} className="prompt-store-search-icon" />
					<input
						ref={searchInputRef}
						type="text"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						onKeyDown={handleKeyDown}
						placeholder={t("config.promptStoreSearchPlaceholder")}
						disabled={searching}
					/>
					<button
						className="config-btn primary"
						onClick={() => void handleSearch(query)}
						disabled={searching || !query.trim()}
					>
						{searching ? t("config.promptStoreSearching") : <Search size={14} strokeWidth={1.8} />}
					</button>
				</div>
				{/* 热门搜索建议 */}
				{!result && !searching && (
					<div className="prompt-store-suggestions">
						{SUGGESTED_SEARCHES.map((s) => (
							<button
								key={s}
								className="prompt-store-suggestion-chip"
								onClick={() => { setQuery(s); void handleSearch(s); }}
							>
								{s}
							</button>
						))}
					</div>
				)}
			</div>

			{/* 错误提示 */}
			{error && <div className="config-error">{error}</div>}

			{/* Toast 已改用 sonner */}
			{/* 搜索结果 */}
			{searching && <div className="config-loading">{t("config.promptStoreSearching")}</div>}

			{result && !searching && result.count === 0 && (
				<div className="config-empty">{t("config.promptStoreSearchEmpty")}</div>
			)}

			{result && result.count > 0 && (
				<div className="prompt-store-results">
					<small className="prompt-store-result-count">{result.count} results</small>
					{result.prompts.map((item) => (
						<article
							key={item.id}
							className="prompt-store-card"
							onClick={() => showPreview(item)}
						>
							<div className="prompt-store-card-main">
								<strong className="prompt-store-card-title">{item.title}</strong>
								<p className="prompt-store-card-desc">{item.description}</p>
								<div className="prompt-store-card-meta">
									<span>{item.author}</span>
									<span className="prompt-store-card-category">{item.category}</span>
								</div>
							</div>
							<div className="prompt-store-card-actions">
								<button
									className="config-icon-btn"
									title={t("config.promptStorePreview")}
									onClick={(e) => { e.stopPropagation(); showPreview(item); }}
								>
									<ExternalLink size={14} strokeWidth={1.8} />
								</button>
								<button
									className="config-btn primary small"
									onClick={(e) => { e.stopPropagation(); void handleImport(item); }}
									disabled={importingId === item.id}
								>
									{importingId === item.id ? t("config.promptStoreImporting") : t("config.promptStoreImport")}
								</button>
							</div>
						</article>
					))}
				</div>
			)}
				</>
			)}
		</div>
	);
}
