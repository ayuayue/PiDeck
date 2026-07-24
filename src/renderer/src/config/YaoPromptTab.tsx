import { showNotice } from "../utils/notice";
import { useEffect, useState, useCallback } from "react";
import { ArrowLeft, Check, ChevronLeft, ChevronRight, Download, Search } from "lucide-react";
import type { YaoPromptListResult, YaoPromptItem, YaoPromptDetailResult, PiPromptTemplateSummary, YaoPromptCategory, PiPromptTemplateListResult } from "../../../shared/types";
import { t } from "../i18n";

const api = (window as unknown as { piDesktop: { yaoPrompts: { list: (opts?: { category?: string; search?: string; page?: number; pageSize?: number }) => Promise<YaoPromptListResult>; detail: (slug: string, category: string) => Promise<YaoPromptDetailResult>; import: (slug: string, category: string) => Promise<PiPromptTemplateSummary> } } }).piDesktop;

/** 获取本地已安装 prompt 名称集合 */
async function getInstalledPromptNames(): Promise<Set<string>> {
	try {
		const piDesktop = (window as any).piDesktop;
		if (!piDesktop?.prompts?.list) return new Set();
		const list: PiPromptTemplateListResult = await piDesktop.prompts.list();
		return new Set(list.templates.filter((t) => t.userCreated).map((t) => t.name.toLowerCase()));
	} catch {
		return new Set();
	}
}

export function YaoPromptTab(props: {
	onImported?: () => void;
}) {
	const [initialLoading, setInitialLoading] = useState(true);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	/* toast 已改用 sonner 实现 */
	const [data, setData] = useState<YaoPromptListResult | null>(null);
	const [activeCategory, setActiveCategory] = useState<string | null>(null);
	const [searchQuery, setSearchQuery] = useState("");
	const [page, setPage] = useState(1);
	const [installedNames, setInstalledNames] = useState<Set<string>>(new Set());
	const [previewItem, setPreviewItem] = useState<YaoPromptItem | null>(null);
	const [previewDetail, setPreviewDetail] = useState<YaoPromptDetailResult | null>(null);
	const [previewLoading, setPreviewLoading] = useState(false);
	const [importingSlug, setImportingSlug] = useState<string | null>(null);
	const PAGE_SIZE = 20;

	// 首次加载分类（全量，数据量小）
	useEffect(() => {
		void loadCategories();
	}, []);

	// 分类/搜索/页码变更时加载分页数据
	useEffect(() => {
		if (!initialLoading) {
			void loadPrompts();
		}
	}, [activeCategory, searchQuery, page, initialLoading]);

	const loadCategories = async () => {
		setInitialLoading(true);
		setError(null);
		try {
			const [result, installed] = await Promise.all([
				api.yaoPrompts.list(),
				getInstalledPromptNames(),
			]);
			setData(result);
			setInstalledNames(installed);
			if (result.categories.length > 0 && !activeCategory) {
				setActiveCategory(result.categories[0].slug);
			}
			setInitialLoading(false);
		} catch (err) {
			setError(err instanceof Error ? err.message : t("config.promptStoreError"));
			setInitialLoading(false);
		}
	};

	const loadPrompts = async () => {
		setLoading(true);
		setError(null);
		try {
			// 分类默认选择全部（不传 category），当 activeCategory 不为 null 时传它
			const result = await api.yaoPrompts.list({
				category: activeCategory || undefined,
				search: searchQuery.trim() || undefined,
				page,
				pageSize: PAGE_SIZE,
			});
			setData((prev) => prev ? { ...prev, prompts: result.prompts, total: result.total, page: result.page, pageSize: result.pageSize } : prev);
		} catch (err) {
			setError(err instanceof Error ? err.message : t("config.promptStoreError"));
		} finally {
			setLoading(false);
		}
	};

	const handleCategoryChange = (slug: string | null) => {
		setActiveCategory(slug);
		setPage(1);
	};

	const handleSearchChange = (value: string) => {
		setSearchQuery(value);
		setPage(1);
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
			// 刷新已安装标注，立即可见
			const installed = await getInstalledPromptNames();
			setInstalledNames(installed);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setImportingSlug(null);
		}
	};

	const totalPages = data?.total ? Math.ceil(data.total / PAGE_SIZE) : 0;
	const activePrompts = data?.prompts ?? [];

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
						onChange={(e) => handleSearchChange(e.target.value)}
						placeholder="搜索中文提示词…"
					/>
				</div>
			</div>

			{error && <div className="config-error">{error}</div>}
			{/* toast 已改用 sonner */}
			{initialLoading ? (
				<div className="config-loading">{t("common.loading")}</div>
			) : !data || data.categories.length === 0 ? (
				<div className="config-empty">暂无提示词数据</div>
			) : (
				<>
					{/* 分类导航 */}
					<div className="yao-category-bar">
						<button
							className={`yao-category-chip ${!activeCategory ? "active" : ""}`}
							onClick={() => handleCategoryChange(null)}
						>
							全部
							<small>{data.categories.reduce((s, c) => s + c.count, 0)}</small>
						</button>
						{data.categories.map((cat) => (
							<button
								key={cat.slug}
								className={`yao-category-chip ${activeCategory === cat.slug ? "active" : ""}`}
								onClick={() => handleCategoryChange(cat.slug)}
							>
								{cat.name}
								<small>{cat.count}</small>
							</button>
						))}
					</div>

					{/* 提示词列表 */}
					<div className="prompt-store-results">
						{loading ? (
							<div className="config-loading">{t("common.loading")}</div>
						) : activePrompts.length === 0 ? (
							<div className="config-empty">未匹配到提示词</div>
						) : (
							activePrompts.map((item) => (
								<article
									key={item.slug}
									className="prompt-store-card"
									onClick={() => void handlePreview(item)}
								>
									<div className="prompt-store-card-main">
										<strong className="prompt-store-card-title">
											{item.title}
											{installedNames.has(item.slug.toLowerCase()) && (
												<span className="prompt-store-installed-badge">
													<Check size={11} /> {t("config.installed")}
												</span>
											)}
										</strong>
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
										{!installedNames.has(item.slug.toLowerCase()) && (
											<button
												className="config-btn primary small"
												onClick={(e) => { e.stopPropagation(); void handleImport(item); }}
												disabled={importingSlug === item.slug}
											>
												{importingSlug === item.slug ? t("config.promptStoreImporting") : t("config.promptStoreImport")}
											</button>
										)}
									</div>
								</article>
							))
						)}
					</div>

					{/* 分页控件 */}
					{totalPages > 1 && (
						<div className="yao-pagination">
							<button
								className="config-btn"
								disabled={page <= 1}
								onClick={() => setPage((p) => Math.max(1, p - 1))}
							>
								<ChevronLeft size={14} />
							</button>
							<span className="yao-pagination-info">
								{page} / {totalPages}
							</span>
							<button
								className="config-btn"
								disabled={page >= totalPages}
								onClick={() => setPage((p) => p + 1)}
							>
								<ChevronRight size={14} />
							</button>
						</div>
					)}
				</>
			)}
		</div>
	);
}
