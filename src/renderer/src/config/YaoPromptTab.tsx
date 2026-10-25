import { Button } from "../components/ui-shadcn/button";
import { showNotice } from "../utils/notice";
import { useEffect, useRef, useState } from "react";
import { Loader2, ArrowLeft, Check, ChevronLeft, ChevronRight, Download, RotateCcw } from "lucide-react";
import type { YaoPromptListResult, YaoPromptItem, YaoPromptDetailResult, PiPromptTemplateSummary, PiPromptTemplateListResult, YaoPromptDbSnapshot } from "../../../shared/types";
import { t } from "../i18n";
import { desktopApi } from "../desktopApi";
import { StoreSearchBar } from "./StoreSearchBar";
import { ContentStoreUpdatePanel } from "./ContentStoreUpdatePanel";
import { Pagination } from "../components/ui-shadcn/pagination";
const PAGE_SIZE = 20;

async function getInstalledPromptNames(projectId?: string): Promise<Set<string>> {
	try {
		const list: PiPromptTemplateListResult = projectId ? await desktopApi.prompts.listByProject(projectId) : await desktopApi.prompts.list();
		return new Set(list.templates.filter((template) => template.userCreated).map((template) => template.name.toLowerCase()));
	} catch {
		return new Set();
	}
}

export function YaoPromptTab(props: { onImported?: () => void; projectId?: string }) {
	const [initialLoading, setInitialLoading] = useState(true);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	/* toast 已改用 sonner 实现 */
	const [data, setData] = useState<YaoPromptListResult | null>(null);
	const [activeCategory, setActiveCategory] = useState<string | null>(null);
	const [searchQuery, setSearchQuery] = useState("");
	/** 已提交的搜索词：只有回车/搜索按钮触发才更新，避免每敲一个字符就打一次接口 */
	const [appliedSearch, setAppliedSearch] = useState("");
	const [page, setPage] = useState(1);
	const [installedNames, setInstalledNames] = useState<Set<string>>(new Set());
	const [previewItem, setPreviewItem] = useState<YaoPromptItem | null>(null);
	const [previewDetail, setPreviewDetail] = useState<YaoPromptDetailResult | null>(null);
	const [previewLoading, setPreviewLoading] = useState(false);
	const [importingSlug, setImportingSlug] = useState<string | null>(null);
	/** db 远程拉取状态（安装包不内置 db；list 返回 + 主进程推送双源驱动）。 */
	const [dbSnapshot, setDbSnapshot] = useState<YaoPromptDbSnapshot | null>(null);
	const PAGE_SIZE = 20;

	// 稳定引用：订阅 effect 一次性挂载，回调经 ref 调最新实现，避免闭包过期
	const reloadRef = useRef<() => void>(() => {});
	const dataRef = useRef<YaoPromptListResult | null>(null);
	dataRef.current = data;

	// db 状态推送：下载完成（ready）时若当前无数据自动重拉（首次使用/离线重试成功场景）
	useEffect(() => {
		const unsubscribe = desktopApi.yaoPrompts.onDbStateChange((snapshot) => {
			setDbSnapshot(snapshot);
			if (snapshot.state === "ready" && (dataRef.current == null || dataRef.current.categories.length === 0)) {
				reloadRef.current();
			}
		});
		return unsubscribe;
	}, []);

	// 首次加载分类（全量，数据量小）
	useEffect(() => {
		void loadCategories();
	}, [props.projectId]);

	useEffect(() => {
		if (!initialLoading) void loadPrompts();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [activeCategory, initialLoading, page, appliedSearch]);

	const loadCategories = async () => {
		setInitialLoading(true);
		setError(null);
		try {
			// 只要分类栏（2027-02）：原先无参 list() 会触发「全量」形态——主进程逐条读
			// description BLOB 并 gunzip，再经 IPC 传 ≈0.9MB JSON，而这里只用 categories。
			const [result, installed] = await Promise.all([desktopApi.yaoPrompts.list({ categoriesOnly: true }), getInstalledPromptNames(props.projectId)]);
			setData(result);
			if (result.dbState) setDbSnapshot((previous) => (previous?.state === "ready" ? previous : ({ state: result.dbState } as YaoPromptDbSnapshot)));
			setInstalledNames(installed);
			// 默认停留「全部」而不是 categories[0]：分类按 count DESC 排序，
			// categories[0] 恒为「绘画提示词」（1000+ 条），用户一进中文精选就被锁在
			// 单一分类里，看不到自己关心的编程/办公等提示词，也完全感知不到分类入口。
			// 保持 null 让它走「全部」，分类 chip 由用户主动选择。
			setInitialLoading(false);
		} catch (err) {
			// 原始错误可能含路径/堆栈，只进日志；用户侧展示稳定的本地化文案。
			console.error("[YaoPrompts] Initial load failed", err);
			setError(t("config.yaoLoadError"));
			setInitialLoading(false);
		}
	};

	const loadPrompts = async () => {
		setLoading(true);
		setError(null);
		try {
			const result = await desktopApi.yaoPrompts.list({
				category: activeCategory ?? undefined,
				search: appliedSearch.trim() || undefined,
				page,
				pageSize: PAGE_SIZE,
			});
			setData((previous) => (previous ? { ...previous, ...result, categories: previous.categories } : result));
		} catch (err) {
			console.error("[YaoPrompts] Search failed", err);
			setError(t("config.yaoLoadError"));
		} finally {
			setLoading(false);
		}
	};

	const handleCategoryChange = (slug: string | null) => {
		setActiveCategory(slug);
		setPage(1);
	};

	/** 仅更新输入框内容，不触发请求 */
	const handleSearchChange = (value: string) => {
		setSearchQuery(value);
	};

	/** 手动提交搜索（回车 / 搜索按钮）：空词视为清除过滤 */
	const handleSearchSubmit = () => {
		setAppliedSearch(searchQuery);
		setPage(1);
	};

	const handlePreview = async (item: YaoPromptItem) => {
		setPreviewItem(item);
		setPreviewLoading(true);
		setPreviewDetail(null);
		try {
			const detail = await desktopApi.yaoPrompts.detail(item.slug, item.category);
			setPreviewDetail(detail);
		} catch (err) {
			console.error("[YaoPrompts] Preview failed", err);
			setError(t("config.yaoPreviewError"));
		} finally {
			setPreviewLoading(false);
		}
	};

	const handleImport = async (item: YaoPromptItem) => {
		setImportingSlug(item.slug);
		setError(null);
		try {
			await desktopApi.yaoPrompts.import(item.slug, item.category, props.projectId);
			showNotice(t("config.promptStoreImported"), 2500);
			props.onImported?.();
			setInstalledNames(await getInstalledPromptNames(props.projectId));
		} catch (err) {
			console.error("[YaoPrompts] Import failed", err);
			setError(t("config.yaoImportError"));
		} finally {
			setImportingSlug(null);
		}
	};

	const totalPages = data?.total ? Math.ceil(data.total / PAGE_SIZE) : 0;
	const activePrompts = data?.prompts ?? [];

	// 官方模板热更新后，覆盖层内的新模板/新分类需重新拉取才能出现在列表里
	const handleStoreApplied = () => {
		void loadCategories();
		void loadPrompts();
	};
	reloadRef.current = () => void loadCategories();

	/** db 下载失败后的重试：绕过 TTL 强制重查远程，进度经状态推送继续驱动 */
	const handleDbRetry = async () => {
		setDbSnapshot({ state: "missing" });
		try {
			const snapshot = await desktopApi.yaoPrompts.retryDb();
			setDbSnapshot(snapshot);
		} catch (err) {
			console.error("[YaoPrompts] Db retry failed", err);
			setDbSnapshot({ state: "failed", message: String(err) });
		}
	};

	/** db 拉取中的进度文案：只有 totalBytes 时显示分数，否则只显示已接收 */
	const dbProgressText = (snapshot: Extract<YaoPromptDbSnapshot, { state: "downloading" }>): string => {
		const received = (snapshot.receivedBytes / 1024 / 1024).toFixed(1);
		return snapshot.totalBytes ? t("config.yaoDbDownloading", { received, total: (snapshot.totalBytes / 1024 / 1024).toFixed(1) }) : t("config.yaoDbDownloadingNoTotal", { received });
	};

	// 预览详情视图
	if (previewItem) {
		return (
			<div className="store-sub-tab">
				{error && <div className="mb-3.5 rounded-sm border border-danger/20 bg-danger-soft px-3.5 py-2.5 text-control leading-relaxed text-danger whitespace-pre-line">{error}</div>}
				{/* toast 已改用 sonner */}
				<div className="prompt-store-toolbar">
					<Button
						size="sm"
						variant="outline"
						onClick={() => {
							setPreviewItem(null);
							setPreviewDetail(null);
						}}
					>
						<ArrowLeft size={14} strokeWidth={1.8} />
						{t("config.promptStoreBack")}
					</Button>
					<Button size="sm" variant="default" onClick={() => void handleImport(previewItem)} disabled={importingSlug === previewItem.slug}>
						{importingSlug === previewItem.slug ? (
							t("config.promptStoreImporting")
						) : (
							<>
								<Download size={14} strokeWidth={1.8} /> {t("config.promptStoreImport")}
							</>
						)}
					</Button>
				</div>
				{previewLoading ? (
					<div className="flex items-center justify-center gap-2 py-12 text-control text-text-tertiary">
						<Loader2 size={14} className="animate-pideck-spin" aria-hidden="true" />
						{t("common.loading")}
					</div>
				) : previewDetail ? (
					<div className="prompt-store-preview">
						<div className="prompt-store-preview-header">
							<h3>{previewDetail.title}</h3>
							{previewDetail.description && <p className="prompt-store-description">{previewDetail.description}</p>}
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
			{/* 官方模板热更新面板：随包模板可同步远端最新版（覆盖层优先） */}
			<ContentStoreUpdatePanel
				api={{
					status: () => desktopApi.contentStore.promptsStatus(),
					check: (branch) => desktopApi.contentStore.promptsCheck(branch),
					update: (branch) => desktopApi.contentStore.promptsUpdate(branch),
					restore: () => desktopApi.contentStore.promptsRestore(),
					restorePrevious: () => desktopApi.contentStore.promptsRestorePrevious(),
					openDir: () => desktopApi.contentStore.promptsOpenDir(),
				}}
				text={{
					title: t("config.contentStore.prompts.title"),
					description: t("config.contentStore.prompts.description"),
					restartHint: t("config.contentStore.prompts.restartHint"),
				}}
				onApplied={handleStoreApplied}
			/>
			{/* 工具栏：搜索（回车 / 搜索按钮手动触发，统一 StoreSearchBar 胶囊外观） */}
			<StoreSearchBar
				value={searchQuery}
				onChange={handleSearchChange}
				onKeyDown={(e) => {
					if (e.key === "Enter") handleSearchSubmit();
				}}
				placeholder={t("config.yaoSearchPlaceholder")}
				onSearch={handleSearchSubmit}
				searchDisabled={!searchQuery.trim() && !appliedSearch}
			/>

			{error && <div className="mb-3.5 rounded-sm border border-danger/20 bg-danger-soft px-3.5 py-2.5 text-control leading-relaxed text-danger whitespace-pre-line">{error}</div>}
			{/* toast 已改用 sonner */}
			{initialLoading ? (
				<div className="flex items-center justify-center gap-2 py-12 text-control text-text-tertiary">
					<Loader2 size={14} className="animate-pideck-spin" aria-hidden="true" />
					{t("common.loading")}
				</div>
			) : dbSnapshot && dbSnapshot.state !== "ready" && (data == null || data.categories.length === 0) ? (
				/* db 未就绪空态：下载进度 / 获取中 / 失败重试（安装包不内置 db，首次使用需远程拉取） */
				<div className="flex flex-col items-center justify-center gap-3 py-12 text-control text-text-tertiary">
					{dbSnapshot.state === "failed" ? (
						<>
							<span>{t("config.yaoDbFailed")}</span>
							<Button size="sm" variant="outline" onClick={() => void handleDbRetry()}>
								<RotateCcw size={14} strokeWidth={1.8} aria-hidden="true" />
								{t("config.yaoDbRetry")}
							</Button>
						</>
					) : (
						<>
							<Loader2 size={14} className="animate-pideck-spin" aria-hidden="true" />
							<span>{dbSnapshot.state === "downloading" ? dbProgressText(dbSnapshot) : t("config.yaoDbPreparing")}</span>
						</>
					)}
				</div>
			) : !data || data.categories.length === 0 ? (
				<div className="py-12 text-center text-control text-text-tertiary">{t("config.yaoNoData")}</div>
			) : (
				<>
					{/* 分类导航 */}
					<div className="yao-category-bar">
						<button className={`yao-category-chip ${!activeCategory ? "active" : ""}`} onClick={() => handleCategoryChange(null)}>
							{t("config.yaoAll")}
							<small>{data.categories.reduce((s, c) => s + c.count, 0)}</small>
						</button>
						{data.categories.map((cat) => (
							<button key={cat.slug} className={`yao-category-chip ${activeCategory === cat.slug ? "active" : ""}`} onClick={() => handleCategoryChange(cat.slug)}>
								{cat.name}
								<small>{cat.count}</small>
							</button>
						))}
					</div>

					{/* 提示词列表 */}
					<div className="prompt-store-results">
						{loading ? (
							<div className="flex items-center justify-center gap-2 py-12 text-control text-text-tertiary">
								<Loader2 size={14} className="animate-pideck-spin" aria-hidden="true" />
								{t("common.loading")}
							</div>
						) : activePrompts.length === 0 ? (
							<div className="py-12 text-center text-control text-text-tertiary">{t("config.yaoNoMatches")}</div>
						) : (
							activePrompts.map((item) => (
								<article key={item.slug} className="prompt-store-card" onClick={() => void handlePreview(item)}>
									<div className="prompt-store-card-main">
										<strong className="prompt-store-card-title">
											{item.title}
											{installedNames.has(item.slug.toLowerCase()) && (
												<span className="prompt-store-installed-badge">
													<Check size={11} /> {t("config.installed")}
												</span>
											)}
										</strong>
										{item.description && <p className="prompt-store-card-desc">{item.description}</p>}
										{item.tags.length > 0 && (
											<div className="yao-card-tags">
												{item.tags.slice(0, 3).map((tag) => (
													<span key={tag} className="prompt-store-tag">
														{tag}
													</span>
												))}
											</div>
										)}
									</div>
									<div className="prompt-store-card-actions">
										{!installedNames.has(item.slug.toLowerCase()) && (
											<Button
												variant="default"
												size="sm"
												onClick={(e) => {
													e.stopPropagation();
													void handleImport(item);
												}}
												disabled={importingSlug === item.slug}
											>
												{importingSlug === item.slug ? t("config.promptStoreImporting") : t("config.promptStoreImport")}
											</Button>
										)}
									</div>
								</article>
							))
						)}
					</div>

					{/* 分页控件：共享 Pagination 组件，带 aria-label 与禁用态 */}
					{totalPages > 1 && <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />}
				</>
			)}
		</div>
	);
}
