import { Button } from "../components/ui-shadcn/button";
import { showNotice } from "../utils/notice";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, BookOpen, Check, Download, ExternalLink, Globe } from "lucide-react";
import type { PromptStoreItem, PromptStoreSearchResult, PiPromptTemplateSummary, PiPromptTemplateListResult } from "../../../shared/types";
import { t } from "../i18n";
import { desktopApi } from "../desktopApi";
import { YaoPromptTab } from "./YaoPromptTab";
import { ContentTabs } from "./ContentTabs";
import { StoreSearchBar } from "./StoreSearchBar";

/**
 * 根据导入逻辑生成的文件名（与主进程 promptStoreImport 中一致）
 */
function predictImportName(title: string): string {
	return title
		.trim()
		.toLowerCase()
		.replace(/[^\p{L}\p{N}-]+/gu, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

/** 获取当前作用域已安装 prompt 名称集合 */
async function getInstalledPromptNames(projectId?: string): Promise<Set<string>> {
	try {
		const list: PiPromptTemplateListResult = projectId ? await desktopApi.prompts.listByProject(projectId) : await desktopApi.prompts.list();
		return new Set(list.templates.filter((t) => t.userCreated).map((t) => t.name.toLowerCase()));
	} catch {
		return new Set();
	}
}

/**
 * 搜索提示常量：用户在商店搜索栏中看到的热门推荐关键词。
 * 方便用户快速了解商店能搜到什么类型的 Prompt。
 */
const SUGGESTED_SEARCHES = ["code review", "refactoring", "test", "git", "documentation", "security", "debugging", "docker", "api design", "typescript", "react", "python"];

export function PromptStoreTab(props: {
	/** 导入成功后的回调，用于刷新本地模板列表 */
	onImported?: () => void;
	/** Selected project id; omitted for the global pi prompt directory. */
	projectId?: string;
}) {
	const [storeSubTab, setStoreSubTab] = useState<"store" | "yao">("store");
	const [query, setQuery] = useState("");
	const [searching, setSearching] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [result, setResult] = useState<PromptStoreSearchResult | null>(null);
	const [installedNames, setInstalledNames] = useState<Set<string>>(new Set());
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
	const handleSearch = useCallback(
		async (searchQuery: string) => {
			const q = searchQuery.trim();
			if (!q) return;
			// 立即清除旧结果，避免用户看到上一次搜索的残留数据
			setResult(null);
			setPreviewItem(null);
			setError(null);
			setSearching(true);
			try {
				const [data, installed] = await Promise.all([desktopApi.promptStore.search(q, { limit: 20 }), getInstalledPromptNames(props.projectId)]);
				setResult(data);
				setInstalledNames(installed);
			} catch (err) {
				console.error("[PromptStore] Search failed", err);
				setError(t("config.promptStoreError"));
				setResult(null);
			} finally {
				setSearching(false);
			}
		},
		[props.projectId],
	);

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
			await desktopApi.promptStore.import({
				title: item.title,
				description: item.description,
				content: item.content,
				projectId: props.projectId,
			});
			showNotice(t("config.promptStoreImported"), 2500);
			// 刷新本地列表 + 重新搜索以更新已安装标注
			props.onImported?.();
			if (query.trim()) {
				void handleSearch(query);
			}
		} catch (err) {
			console.error("[PromptStore] Import failed", err);
			setError(t("config.promptStoreImportError"));
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
				{error && <div className="mb-3.5 rounded-sm border border-danger/20 bg-danger-soft px-3.5 py-2.5 text-control leading-relaxed text-danger whitespace-pre-line">{error}</div>}
				{/* toast 已改用 sonner */}
				<div className="prompt-store-toolbar">
					<Button size="sm" variant="outline" onClick={backToList}>
						<ArrowLeft size={14} strokeWidth={1.8} />
						{t("config.promptStoreBack")}
					</Button>
					<Button size="sm" variant="default" onClick={() => void handleImport(previewItem)} disabled={importingId === previewItem.id}>
						{importingId === previewItem.id ? (
							t("config.promptStoreImporting")
						) : (
							<>
								<Download size={14} strokeWidth={1.8} /> {t("config.promptStoreImport")}
							</>
						)}
					</Button>
				</div>
				<div className="prompt-store-preview">
					<div className="prompt-store-preview-header">
						<h3>{previewItem.title}</h3>
						<div className="prompt-store-preview-meta">
							<span>
								{t("config.promptStoreBy")} <strong>{previewItem.author}</strong>
							</span>
							<span>
								{t("config.promptStoreFrom")} <strong>{previewItem.category}</strong>
							</span>
							<span className="prompt-store-votes">{t("config.promptStoreVotes", { count: previewItem.votes })}</span>
						</div>
						<div className="prompt-store-preview-install-name">
							{t("config.promptStoreInstallName")} <code>/{predictImportName(previewItem.title)}</code>
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
			{/* 子 tab 切换：国际商店 / 中文精选（内容级下划线，compact 版） */}
			<ContentTabs
				compact
				fill={false}
				value={storeSubTab}
				onValueChange={(v) => {
					if (v === "store" || v === "yao") setStoreSubTab(v);
				}}
				items={[
					{ value: "store", label: "prompts.chat", icon: <Globe size={14} strokeWidth={1.8} /> },
					{ value: "yao", label: t("config.promptStoreChinesePicks"), icon: <BookOpen size={14} strokeWidth={1.8} /> },
				]}
			/>

			{storeSubTab === "yao" ? (
				<YaoPromptTab projectId={props.projectId} onImported={props.onImported} />
			) : (
				<>
					{/* 搜索栏 + 热门词建议（StoreSearchBar 统一胶囊外观，替代 prompt-store-search-* 手写 CSS） */}
					<StoreSearchBar
						ref={searchInputRef}
						value={query}
						onChange={setQuery}
						onKeyDown={handleKeyDown}
						placeholder={t("config.promptStoreSearchPlaceholder")}
						searching={searching}
						searchDisabled={!query.trim()}
						onSearch={() => void handleSearch(query)}
						suggestions={!result && !searching ? SUGGESTED_SEARCHES : undefined}
						onSuggestionClick={(s) => {
							setQuery(s);
							void handleSearch(s);
						}}
					/>

					{/* 错误提示 */}
					{error && <div className="mb-3.5 rounded-sm border border-danger/20 bg-danger-soft px-3.5 py-2.5 text-control leading-relaxed text-danger whitespace-pre-line">{error}</div>}

					{/* Toast 已改用 sonner */}
					{/* 搜索结果 */}
					{searching && <div className="py-12 text-center text-control text-text-tertiary">{t("config.promptStoreSearching")}</div>}

					{result && !searching && result.count === 0 && <div className="py-12 text-center text-control text-text-tertiary">{t("config.promptStoreSearchEmpty")}</div>}

					{result && result.count > 0 && (
						<div className="prompt-store-results">
							<small className="prompt-store-result-count">{t("config.promptStoreResultCount", { count: result.count })}</small>
							{result.prompts.map((item) => (
								<article key={item.id} className="prompt-store-card" onClick={() => showPreview(item)}>
									<div className="prompt-store-card-main">
										<strong className="prompt-store-card-title">
											{item.title}
											{installedNames.has(predictImportName(item.title)) && (
												<span className="prompt-store-installed-badge">
													<Check size={11} /> {t("config.installed")}
												</span>
											)}
										</strong>
										<p className="prompt-store-card-desc">{item.description}</p>
										<div className="prompt-store-card-meta">
											<span>{item.author}</span>
											<span className="prompt-store-card-category">{item.category}</span>
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
												showPreview(item);
											}}
										>
											<ExternalLink size={14} strokeWidth={1.8} />
										</Button>
										{!installedNames.has(predictImportName(item.title)) && (
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
										)}
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
