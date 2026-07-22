import { showNotice } from "../utils/notice";
import { useEffect, useState } from "react";
import { ArrowLeft, Download, Search } from "lucide-react";
import type { YaoPromptListResult, YaoPromptItem, YaoPromptDetailResult, PiPromptTemplateSummary, YaoPromptCategory } from "../../../shared/types";
import { t } from "../i18n";

const api = (window as unknown as { piDesktop: { yaoPrompts: { list: () => Promise<YaoPromptListResult>; detail: (slug: string, category: string) => Promise<YaoPromptDetailResult>; import: (slug: string, category: string) => Promise<PiPromptTemplateSummary> } } }).piDesktop;

export function YaoPromptTab(props: {
	onImported?: () => void;
}) {
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	/* toast 已改用 sonner 实现 */
	const [data, setData] = useState<YaoPromptListResult | null>(null);
	const [activeCategory, setActiveCategory] = useState<string | null>(null);
	const [searchQuery, setSearchQuery] = useState("");
	const [previewItem, setPreviewItem] = useState<YaoPromptItem | null>(null);
	const [previewDetail, setPreviewDetail] = useState<YaoPromptDetailResult | null>(null);
	const [previewLoading, setPreviewLoading] = useState(false);
	const [importingSlug, setImportingSlug] = useState<string | null>(null);

	// 首次加载
	useEffect(() => {
		void loadData();
	}, []);

	const loadData = async () => {
		setLoading(true);
		setError(null);
		try {
			const result = await api.yaoPrompts.list();
			setData(result);
			if (result.categories.length > 0 && !activeCategory) {
				setActiveCategory(result.categories[0].slug);
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : t("config.promptStoreError"));
		} finally {
			setLoading(false);
		}
	};



	const handlePreview = async (item: YaoPromptItem) => {
		setPreviewItem(item);
		setPreviewLoading(true);
		setPreviewDetail(null);
		try {
			const detail = await api.yaoPrompts.detail(item.slug, item.category);
			setPreviewDetail(detail);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setPreviewLoading(false);
		}
	};

	const handleImport = async (item: YaoPromptItem) => {
		setImportingSlug(item.slug);
		setError(null);
		try {
			await api.yaoPrompts.import(item.slug, item.category);
			showNotice("已导入到本地模板", 2500);
			props.onImported?.();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setImportingSlug(null);
		}
	};

	// 筛选当前分类 + 搜索
	const activePrompts = data?.prompts.filter((p) => {
		if (activeCategory && p.category !== activeCategory) return false;
		if (searchQuery.trim()) {
			const q = searchQuery.trim().toLowerCase();
			return (
				p.title.toLowerCase().includes(q) ||
				p.tags.some((t) => t.toLowerCase().includes(q)) ||
				p.description.toLowerCase().includes(q)
			);
		}
		return true;
	}) ?? [];

	// 预览详情视图
	if (previewItem) {
		return (
			<div className="store-sub-tab">
				{error && <div className="config-error">{error}</div>}
				{/* toast 已改用 sonner */}
				<div className="prompt-store-toolbar">
					<button className="config-btn" onClick={() => { setPreviewItem(null); setPreviewDetail(null); }}>
						<ArrowLeft size={14} strokeWidth={1.8} />
						{t("config.promptStoreBack")}
					</button>
					<button
						className="config-btn primary"
						onClick={() => void handleImport(previewItem)}
						disabled={importingSlug === previewItem.slug}
					>
						{importingSlug === previewItem.slug ? (
							t("config.promptStoreImporting")
						) : (
							<><Download size={14} strokeWidth={1.8} /> {t("config.promptStoreImport")}</>
						)}
					</button>
				</div>
				{previewLoading ? (
					<div className="config-loading">{t("common.loading")}</div>
				) : previewDetail ? (
					<div className="prompt-store-preview">
						<div className="prompt-store-preview-header">
							<h3>{previewDetail.title}</h3>
							{previewDetail.description && (
								<p className="prompt-store-description">{previewDetail.description}</p>
							)}
						</div>
						<div className="prompt-store-preview-content">
							<pre>{previewDetail.promptContent}</pre>
						</div>
					</div>
				) : null}
			</div>
		);
	}

	return (
		<div className="store-sub-tab">
			{/* 工具栏：搜索 + 更新按钮 */}
			<div className="prompt-store-search-bar">
				<div className="prompt-store-search-input-wrap">
					<Search size={15} strokeWidth={1.8} className="prompt-store-search-icon" />
					<input
						type="text"
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						placeholder="搜索中文提示词…"
					/>
				</div>
			</div>

			{error && <div className="config-error">{error}</div>}
			{/* toast 已改用 sonner */}
			{loading ? (
				<div className="config-loading">{t("common.loading")}</div>
			) : !data || data.categories.length === 0 ? (
				<div className="config-empty">暂无提示词数据</div>
			) : (
				<>
					{/* 分类导航 */}
					<div className="yao-category-bar">
						{data.categories.map((cat) => (
							<button
								key={cat.slug}
								className={`yao-category-chip ${activeCategory === cat.slug ? "active" : ""}`}
								onClick={() => setActiveCategory(cat.slug)}
							>
								{cat.name}
								<small>{cat.count}</small>
							</button>
						))}
					</div>

					{/* 提示词列表 */}
					<div className="prompt-store-results">
						{activePrompts.length === 0 ? (
							<div className="config-empty">未匹配到提示词</div>
						) : (
							activePrompts.map((item) => (
								<article
									key={item.slug}
									className="prompt-store-card"
									onClick={() => void handlePreview(item)}
								>
									<div className="prompt-store-card-main">
										<strong className="prompt-store-card-title">{item.title}</strong>
										{item.description && (
											<p className="prompt-store-card-desc">{item.description}</p>
										)}
										{item.tags.length > 0 && (
											<div className="yao-card-tags">
												{item.tags.slice(0, 3).map((tag) => (
													<span key={tag} className="prompt-store-tag">{tag}</span>
												))}
											</div>
										)}
									</div>
									<div className="prompt-store-card-actions">
										<button
											className="config-btn primary small"
											onClick={(e) => { e.stopPropagation(); void handleImport(item); }}
											disabled={importingSlug === item.slug}
										>
											{importingSlug === item.slug ? t("config.promptStoreImporting") : t("config.promptStoreImport")}
										</button>
									</div>
								</article>
							))
						)}
					</div>
				</>
			)}
		</div>
	);
}
