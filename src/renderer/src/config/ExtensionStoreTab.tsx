import { Button } from "../components/ui-shadcn/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui-shadcn/select";
import { showNotice } from "../utils/notice";
import { writeClipboard } from "../utils/clipboard";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Copy, Download, ExternalLink } from "lucide-react";
import type { PiPackageCatalog, PiPackageCatalogItem, PiPackageCatalogQuery } from "../../../shared/types";
import { t } from "../i18n";
import { StoreSearchBar } from "./StoreSearchBar";

/**
 * 扩展商店（pi.dev Package Catalog）视图。
 *
 * 数据源是主进程抓取的 pi.dev 目录页（无公开 JSON API），本组件只负责
 * 查询参数（搜索/类型/排序/页码）与展示；安装复用扩展管理的 install 链路
 * （`pi install npm:<name>`），安装成功后通过 onInstalled 通知父级刷新已安装列表。
 */

const api = (
	window as unknown as {
		piDesktop: {
			extensions: {
				catalog: (query: PiPackageCatalogQuery) => Promise<PiPackageCatalog>;
				install: (source: string, projectId?: string) => Promise<string>;
			};
		};
	}
).piDesktop;

/** 类型过滤选项（对应目录页 type 参数；空 = 全部）。 */
const TYPE_OPTIONS: Array<{ value: string; label: string }> = [
	{ value: "", label: "all" },
	{ value: "extension", label: "extension" },
	{ value: "skill", label: "skill" },
	{ value: "prompt", label: "prompt" },
	{ value: "theme", label: "theme" },
];

/** 格式化月下载量：与目录页口径一致（761442 → 761.4K）。 */
export function formatDownloads(count?: number): string {
	if (count === undefined) return "";
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
	return String(count);
}

/** 格式化发布时间为相对时间（毫秒时间戳 → "3d ago" 风格，使用中文/英文语境）。 */
export function formatPublishedAt(timestamp?: number, locale?: string): string {
	if (!timestamp) return "";
	const diff = Date.now() - timestamp;
	const minutes = Math.floor(diff / 60_000);
	const hours = Math.floor(minutes / 60);
	const days = Math.floor(hours / 24);
	const isZh = locale?.startsWith("zh");
	if (minutes < 1) return isZh ? "刚刚" : "just now";
	if (minutes < 60) return isZh ? `${minutes} 分钟前` : `${minutes}m ago`;
	if (hours < 24) return isZh ? `${hours} 小时前` : `${hours}h ago`;
	if (days < 30) return isZh ? `${days} 天前` : `${days}d ago`;
	const months = Math.floor(days / 30);
	if (months < 12) return isZh ? `${months} 个月前` : `${months}mo ago`;
	return isZh ? `${Math.floor(months / 12)} 年前` : `${Math.floor(months / 12)}y ago`;
}

export function ExtensionStoreTab(props: {
	/** 已安装包的 source 集合（`npm:<name>` 等安装源形态）：标记商店卡片「已安装」并禁用安装按钮 */
	installedSources: ReadonlySet<string>;
	/** Selected project id; omitted for global pi install. */
	projectId?: string;
	/** 安装成功后触发（父级刷新扩展列表） */
	onInstalled?: () => void;
}) {
	const [query, setQuery] = useState("");
	/** 已提交的搜索词：只有回车/搜索按钮触发才更新，避免每敲一个字符就打一次 pi.dev 目录 */
	const [appliedQuery, setAppliedQuery] = useState("");
	const [type, setType] = useState("");
	const [sort, setSort] = useState<"downloads" | "recent">("downloads");
	const [page, setPage] = useState(1);
	const [catalog, setCatalog] = useState<PiPackageCatalog | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [installing, setInstalling] = useState<string | null>(null);
	// 请求竞态防护：只采纳最后一次发起的请求结果（切页/改筛选时旧响应丢弃）
	const requestSeq = useRef(0);
	const searchInputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		searchInputRef.current?.focus();
	}, []);

	const load = useCallback(
		async (opts: { page?: number; refresh?: boolean } = {}) => {
			const seq = ++requestSeq.current;
			setLoading(true);
			setError(null);
			try {
				const data = await api.extensions.catalog({
					page: opts.page ?? page,
					query: appliedQuery.trim(),
					type,
					sort,
					...(opts.refresh ? { refresh: true } : {}),
				});
				if (seq !== requestSeq.current) return; // 已被更新的请求覆盖
				setCatalog(data);
				setPage(data.page);
			} catch (err) {
				if (seq !== requestSeq.current) return;
				console.error("[ExtensionStore] Catalog failed", err);
				setError(t("config.extensionStoreLoadError"));
			} finally {
				if (seq === requestSeq.current) setLoading(false);
			}
		},
		[page, appliedQuery, type, sort],
	);

	// 搜索词不参与自动加载：只在 appliedQuery / 类型 / 排序 变化时回到第一页重新加载；
	// 挂载时该 effect 同样执行，即为首次加载
	useEffect(() => {
		void load({ page: 1 });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [appliedQuery, type, sort]);

	/** 手动提交搜索（回车 / 搜索按钮）：词未变化时直接重载（按钮语义含 refresh，可绕过目录缓存） */
	const submitSearch = (refresh = false) => {
		if (query.trim() === appliedQuery.trim()) {
			void load({ page: 1, ...(refresh ? { refresh: true } : {}) });
		} else {
			// appliedQuery 变化会命中上面的 effect，自动回到第一页
			setAppliedQuery(query);
		}
	};

	/** 已安装判断：installSource（npm:<name>）与已安装 source 集合精确匹配（集合含项目发现项，见 projectInstalledExtensionSources） */
	const isInstalled = useCallback((item: PiPackageCatalogItem) => props.installedSources.has(item.installSource), [props.installedSources]);

	const handleInstall = async (item: PiPackageCatalogItem) => {
		if (installing) return;
		setInstalling(item.installSource);
		try {
			await api.extensions.install(item.installSource, props.projectId);
			showNotice(t("config.extensionStoreInstalled", { name: item.name }), 2500);
			props.onInstalled?.();
		} catch (err) {
			console.error("[ExtensionStore] Install failed", err);
			showNotice(t("config.extensionStoreInstallError", { name: item.name }), 4500, "error");
		} finally {
			setInstalling(null);
		}
	};

	const handleOpenPage = (item: PiPackageCatalogItem) => {
		// 弹框内链接强制系统浏览器（与推荐包列表同规则：内置浏览器在 Dialog 下层不可见）
		window.piDesktop.app.openExternal(item.pageUrl, true);
	};

	const handleCopy = (item: PiPackageCatalogItem) => {
		const cmd = `pi install ${item.installSource}`;
		void writeClipboard(cmd);
		showNotice(t("app.codeCopied"), 1200);
	};

	const total = catalog?.total ?? 0;
	const lastPage = catalog?.lastPage ?? 1;

	return (
		<div className="prompt-store-tab">
			{/* 搜索 + 类型 + 排序工具栏（一行 flex：搜索框占满剩余宽度，两个下拉固定宽度并排右侧） */}
			<div className="flex items-center gap-2.5">
				<StoreSearchBar
					ref={searchInputRef}
					value={query}
					onChange={setQuery}
					placeholder={t("config.extensionStoreSearchPlaceholder")}
					searching={loading}
					onKeyDown={(e) => {
						if (e.key === "Enter") submitSearch();
					}}
					onSearch={() => submitSearch(true)}
					className="min-w-0 flex-1"
				/>
				{/* 类型过滤（目录页 type 参数） */}
				<Select value={type} onValueChange={(v) => setType(v)}>
					<SelectTrigger size="sm" className="w-36 shrink-0" aria-label={t("config.extensionStoreType")}>
						<SelectValue placeholder={t("config.extensionStoreType")} />
					</SelectTrigger>
					<SelectContent>
						{TYPE_OPTIONS.map((opt) => (
							<SelectItem key={opt.value} value={opt.value}>
								{opt.value === "" ? t("config.extensionStoreTypeAll") : opt.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				{/* 排序（目录页 sort 参数） */}
				<Select value={sort} onValueChange={(v) => setSort(v as "downloads" | "recent")}>
					<SelectTrigger size="sm" className="w-32 shrink-0" aria-label={t("config.extensionStoreSort")}>
						<SelectValue placeholder={t("config.extensionStoreSort")} />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="downloads">{t("config.extensionStoreSortDownloads")}</SelectItem>
						<SelectItem value="recent">{t("config.extensionStoreSortRecent")}</SelectItem>
					</SelectContent>
				</Select>
			</div>

			{error && <div className="mb-3.5 rounded-sm border border-danger/20 bg-danger-soft px-3.5 py-2.5 text-control leading-relaxed text-danger whitespace-pre-line">{error}</div>}

			{loading && !catalog && <div className="py-12 text-center text-control text-text-tertiary">{t("config.promptStoreSearching")}</div>}

			{catalog && !loading && catalog.items.length === 0 && <div className="py-12 text-center text-control text-text-tertiary">{t("config.extensionStoreNoResults")}</div>}

			{catalog && catalog.items.length > 0 && (
				<div className="prompt-store-results">
					<small className="prompt-store-result-count">{t("config.extensionStoreResultCount", { count: total })}</small>
					{catalog.items.map((item) => {
						const installed = isInstalled(item);
						const installingThis = installing === item.installSource;
						return (
							<article key={item.name} className="prompt-store-card">
								<div className="prompt-store-card-main">
									<strong className="prompt-store-card-title">
										{item.name}
										{installed && (
											<span className="config-im-connected-badge" style={{ marginLeft: 8 }}>
												{t("config.installed")}
											</span>
										)}
									</strong>
									<p className="prompt-store-card-desc">{item.description}</p>
									<div className="prompt-store-card-meta">
										{item.author && (
											<span>
												{t("config.skillStoreAuthor")}: {item.author}
											</span>
										)}
										{item.downloadsPerMonth !== undefined && <span className="prompt-store-card-category">{formatDownloads(item.downloadsPerMonth)}/mo</span>}
										{item.publishedAt && <span>{formatPublishedAt(item.publishedAt)}</span>}
										{item.types.length > 0 && <span className="prompt-store-card-category">{item.types.join(", ")}</span>}
									</div>
								</div>
								<div className="prompt-store-card-actions">
									{/* 复制安装命令 */}
									<Button
										variant="ghost"
										size="icon-sm"
										className="size-7"
										title={t("common.copy")}
										onClick={(e) => {
											e.stopPropagation();
											handleCopy(item);
										}}
									>
										<Copy size={14} strokeWidth={1.8} />
									</Button>
									{/* 打开 pi.dev 详情页（系统浏览器） */}
									<Button
										variant="ghost"
										size="icon-sm"
										className="size-7"
										title={t("config.extensionStoreOpenPage")}
										onClick={(e) => {
											e.stopPropagation();
											handleOpenPage(item);
										}}
									>
										<ExternalLink size={14} strokeWidth={1.8} />
									</Button>
									{/* 安装 */}
									<Button
										variant="default"
										size="sm"
										onClick={(e) => {
											e.stopPropagation();
											void handleInstall(item);
										}}
										disabled={installed || installingThis || Boolean(installing)}
									>
										{installingThis ? (
											t("config.installing")
										) : installed ? (
											t("config.installed")
										) : (
											<>
												<Download size={14} strokeWidth={1.8} className="mr-1" aria-hidden="true" />
												{t("config.install")}
											</>
										)}
									</Button>
								</div>
							</article>
						);
					})}
				</div>
			)}

			{/* 分页：上一页 / 下一页 */}
			{catalog && lastPage > 1 && (
				<div className="mt-4 flex items-center justify-center gap-3">
					<Button variant="outline" size="sm" onClick={() => void load({ page: page - 1 })} disabled={loading || page <= 1}>
						<ArrowLeft size={14} strokeWidth={1.8} className="mr-1" aria-hidden="true" />
						{t("config.extensionStorePrevPage")}
					</Button>
					<span className="text-caption text-muted-foreground">{t("config.extensionStorePage", { page, lastPage })}</span>
					<Button variant="outline" size="sm" onClick={() => void load({ page: page + 1 })} disabled={loading || page >= lastPage}>
						{t("config.extensionStoreNextPage")}
						<ArrowRight size={14} strokeWidth={1.8} className="ml-1" aria-hidden="true" />
					</Button>
				</div>
			)}
		</div>
	);
}
