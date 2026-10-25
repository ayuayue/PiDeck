// @ts-nocheck - SkillHub store panel, new feature
import { Button } from "../components/ui-shadcn/button";
import { useState, useEffect, useRef, useCallback } from "react";
import { Download, ArrowLeft, Check, AlertCircle, X, Trash2, BadgeCheck } from "lucide-react";
import { t } from "../i18n";
import { StoreSearchBar } from "./StoreSearchBar";
import { showNotice } from "../utils/notice";
import { desktopApi } from "../desktopApi";
import type { SkillHubItem, SkillHubDetail, SkillHubSearchResult, SkillHubInstallResult, SkillHubInstallProgress, PiSkillListResult } from "../../../shared/types";

const STORAGE_KEY = "skillhub-installed-v2";

/** localStorage 持久化的安装记录（slug + name，用于验证删除后自动清理） */
interface PersistedInstall {
	slug: string;
	name: string;
	projectId?: string;
}

function loadPersisted(): PersistedInstall[] {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function savePersisted(entries: PersistedInstall[]) {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
	} catch {
		/* noop */
	}
}

/** 添加入口到持久化列表（去重） */
function persistInstall(prev: PersistedInstall[], slug: string, name: string, projectId?: string): PersistedInstall[] {
	if (!Array.isArray(prev)) prev = [];
	const existing = prev.find((e) => e.slug === slug && e.projectId === projectId);
	if (existing) {
		existing.name = name;
		return prev;
	}
	return [...prev, { slug, name, projectId }];
}

/** 获取本地已安装 skill 名称集合 */
async function getInstalledNames(projectId?: string): Promise<Set<string>> {
	try {
		const list: PiSkillListResult = projectId ? await desktopApi.projectResources.list(projectId) : await desktopApi.skills.list();
		return new Set(list.skills.map((s) => s.name.toLowerCase()));
	} catch {
		return new Set();
	}
}

/** 获取本地已安装 skill 名称 → slugs 映射（同名取唯一匹配的 skills.sh slug） */
async function getInstalledSlugsSet(searchItems: SkillHubItem[], projectId?: string): Promise<Set<string>> {
	try {
		const installed = await getInstalledNames(projectId);

		// 统计搜索结果中各 name 出现的次数
		const nameCount = new Map<string, number>();
		for (const item of searchItems) {
			const n = item.name.toLowerCase();
			nameCount.set(n, (nameCount.get(n) || 0) + 1);
		}

		// 仅当 name 在搜索结果中唯一出现时才标为已安装，避免同名不同包误标
		// 同名歧义（如 anthropics/pdf 和 openai/pdf）由 persistedRef 精确 slug 记录处理
		const result = new Set<string>();
		for (const item of searchItems) {
			if (installed.has(item.name.toLowerCase()) && nameCount.get(item.name.toLowerCase()) === 1) {
				result.add(item.slug);
			}
		}
		return result;
	} catch {
		return new Set();
	}
}

const api = (
	window as unknown as {
		piDesktop: {
			skillHub: {
				search: (q: string, limit?: number) => Promise<SkillHubSearchResult>;
				detail: (slug: string) => Promise<SkillHubDetail | null>;
				install: (slug: string, projectId?: string) => Promise<SkillHubInstallResult>;
				onInstallProgress: (callback: (progress: SkillHubInstallProgress) => void) => () => void;
			};
		};
	}
).piDesktop;

const SUGGESTED_SEARCHES = ["pdf", "ocr", "translate", "code review", "react", "python", "git", "image", "data", "writing"];

function fmtNum(n: number): string {
	if (n >= 10000) return (n / 10000).toFixed(1) + "w";
	if (n >= 1000) return (n / 1000).toFixed(1) + "k";
	return String(n);
}

/**
 * 安装进度文案：阶段中文案 + 可能存在的真实百分比。
 * 百分比来自 git/npm 的进度行（Receiving objects 等），不是估算值；没有百分比时只说阶段，
 * 不编造进度条（用户反馈的「没有下载进度」正是这两者都没有）。
 */
function installProgressText(progress: SkillHubInstallProgress | undefined): string {
	if (!progress) return t("config.skillHubPhaseRunning");
	switch (progress.phase) {
		case "preparing":
			return t("config.skillHubPhasePreparing");
		case "downloading":
			return progress.percent === undefined ? t("config.skillHubPhaseDownloading") : t("config.skillHubPhaseDownloadingPercent", { percent: progress.percent });
		case "installing":
			return t("config.skillHubPhaseInstalling");
		default:
			return t("config.skillHubPhaseRunning");
	}
}

export function SkillHubStorePanel(props: { projectId?: string }) {
	const [query, setQuery] = useState("");
	const [searching, setSearching] = useState(false);
	const [installedSlugs, setInstalledSlugs] = useState<Set<string>>(new Set());
	/** 持久化安装记录（跨组件卸载/重启），用于同名歧义时强制标记已安装 */
	const persistedRef = useRef<PersistedInstall[]>(loadPersisted);
	const [installingSlugs, setInstallingSlugs] = useState<Set<string>>(new Set());
	/** 安装进度（按 slug 记录，主进程推送）：按钮旁显示「下载中 45%」这类真实进度 */
	const [installProgress, setInstallProgress] = useState<Record<string, SkillHubInstallProgress>>({});
	const [result, setResult] = useState<SkillHubSearchResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [previewSlug, setPreviewSlug] = useState<string | null>(null);
	const [detail, setDetail] = useState<SkillHubDetail | null>(null);
	const [detailLoading, setDetailLoading] = useState(false);
	const [installing, setInstalling] = useState(false);
	const [installResult, setInstallResult] = useState<SkillHubInstallResult | null>(null);
	const searchInputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		searchInputRef.current?.focus();
	}, []);

	// 安装进度订阅：spawn 流式输出在主进程翻译成阶段后推送，卸载/切换面板由退订函数收尾。
	useEffect(() => {
		const unsubscribe = api.skillHub.onInstallProgress((progress) => {
			setInstallProgress((prev) => ({ ...prev, [progress.slug]: progress }));
		});
		return unsubscribe;
	}, []);

	const handleSearch = useCallback(
		async (searchQuery: string) => {
			const q = searchQuery.trim();
			if (!q) return;
			setResult(null);
			setPreviewSlug(null);
			setDetail(null);
			setInstallResult(null);
			setError(null);
			setSearching(true);
			try {
				const data = await api.skillHub.search(q, 50);
				// 搜索后判断已安装状态（需要搜索结果列表来消除同名歧义）
				const installed = await getInstalledSlugsSet(data.items, props.projectId);
				// 合并持久化记录 → 精确 slug 匹配，无条件信任（安装时已记录完整 slug）
				const merged = new Set(installed);
				const persisted = Array.isArray(persistedRef.current) ? persistedRef.current : [];
				for (const entry of persisted) {
					if (entry.projectId === props.projectId) merged.add(entry.slug);
				}
				setResult(data);
				setInstalledSlugs(merged);
			} catch (err) {
				console.error("[SkillHub] Search failed", err);
				setError(t("config.skillHubSearchError"));
			} finally {
				setSearching(false);
			}
		},
		[props.projectId],
	);

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter") void handleSearch(query);
	};

	const openDetail = useCallback(async (slug: string) => {
		setPreviewSlug(slug);
		setDetail(null);
		setInstallResult(null);
		setDetailLoading(true);
		try {
			const data = await api.skillHub.detail(slug);
			setDetail(data);
		} catch (err) {
			console.error("[SkillHub] Detail load failed", err);
			setDetail(null);
		} finally {
			setDetailLoading(false);
		}
	}, []);

	/** 列表直接安装（不进入详情），安装成功后重新搜索以刷新状态 */
	const handleInstallFromList = async (slug: string, name: string) => {
		setInstallingSlugs((prev) => new Set(prev).add(slug));
		try {
			const result = await api.skillHub.install(slug, props.projectId);
			if (result.success) {
				showNotice(t("app.skillsInstalled", { name }), 3000);
				// 安装成功 → 持久化安装记录（确保跨组件卸载后仍显示已安装，删除后自动清理）
				persistedRef.current = persistInstall(persistedRef.current, slug, name, props.projectId);
				savePersisted(persistedRef.current);
				// 刷新搜索结果（更新已安装标注）
				void handleSearch(query);
			} else {
				if (result.error) console.error("[SkillHub] Install rejected", result.error);
				// 主进程已返回真实失败原因（npx 输出/网络/权限等），toast 直接带出便于定位
				showNotice(t("config.skillHubInstallError", { error: result.error }), 5000, "error");
			}
		} catch (err) {
			console.error("[SkillHub] Install failed", err);
			showNotice(t("config.skillHubInstallError", { error: err instanceof Error ? err.message : String(err) }), 5000, "error");
		} finally {
			setInstallingSlugs((prev) => {
				const next = new Set(prev);
				next.delete(slug);
				return next;
			});
			// 安装结束（成功或失败）都要清掉进度：否则失败后按钮旁会残留上一次的「下载中」
			setInstallProgress((prev) => {
				if (!(slug in prev)) return prev;
				const next = { ...prev };
				delete next[slug];
				return next;
			});
		}
	};

	const handleInstall = async () => {
		if (!previewSlug) return;
		setInstalling(true);
		setInstallResult(null);
		try {
			const result = await api.skillHub.install(previewSlug, props.projectId);
			if (result.success) {
				setInstallResult(result);
				showNotice(t("app.skillsInstalled", { name: detail?.skill?.displayName || previewSlug }), 3000);
			} else {
				if (result.error) console.error("[SkillHub] Install rejected", result.error);
				setInstallResult({ ...result, error: t("config.skillHubInstallError", { error: result.error }) });
			}
		} catch (err) {
			console.error("[SkillHub] Install failed", err);
			setInstallResult({ success: false, slug: previewSlug, installDir: "", error: t("config.skillHubInstallError", { error: err instanceof Error ? err.message : String(err) }) });
		} finally {
			setInstalling(false);
		}
	};

	// Detail view
	if (previewSlug) {
		return (
			<div className="skillhub-panel">
				<div className="skillhub-detail-toolbar">
					<Button
						size="sm"
						variant="outline"
						onClick={() => {
							setPreviewSlug(null);
							setDetail(null);
							setInstallResult(null);
						}}
					>
						<ArrowLeft size={14} />
						{t("config.promptStoreBack")}
					</Button>
				</div>
				<div className="py-12 text-center text-control text-text-tertiary" style={{ marginTop: 24 }}>
					<p>{t("config.skillHubDetailNotAvailable")}</p>
				</div>
			</div>
		);
	}

	// Search / List view
	return (
		<div className="skillhub-panel">
			<StoreSearchBar
				ref={searchInputRef}
				value={query}
				onChange={setQuery}
				onKeyDown={handleKeyDown}
				placeholder={t("config.skillHubSearchPlaceholder")}
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
			{searching && <div className="py-12 text-center text-control text-text-tertiary">{t("common.searching")}…</div>}

			{result && !searching && result.total === 0 && <div className="py-12 text-center text-control text-text-tertiary">{t("config.noSearchResults")}</div>}

			{result && result.total > 0 && (
				<div className="skillhub-results">
					<small className="skillhub-result-count">
						{result.total} {t("common.results")}
					</small>
					{result.items.map((item) => (
						<article
							key={item.slug}
							className="skillhub-card"
							onClick={() => {
								// 弹框（ConfigModal Dialog）内链接强制系统浏览器：内置浏览器面板位于 Dialog 下层不可见，
								// 跟随 linkOpenMode=internal 打开会被遮挡，用户看到“点了没反应”（与 openDocsInSystemBrowser 同规则）
								window.piDesktop.app.openExternal(`https://www.skills.sh/search?q=${encodeURIComponent(item.name)}`, true);
							}}
						>
							<div className="skillhub-card-main">
								<strong className="skillhub-card-title">
									{item.name}
									{installedSlugs.has(item.slug) && (
										<span className="skillhub-installed-badge">
											<Check size={11} /> {t("config.installed")}
										</span>
									)}
								</strong>
								{installingSlugs.has(item.slug) && (
									<span className="mt-0.5 block text-caption leading-snug text-text-tertiary" title={installProgress[item.slug]?.detail || undefined}>
										{installProgressText(installProgress[item.slug])}
									</span>
								)}
								<div className="skillhub-card-meta">
									<span className="skillhub-card-stats">
										<Download size={12} /> {t("config.skillHubInstallCount", { count: fmtNum(item.downloads) })}
									</span>
									<span className="skillhub-card-source">{item.ownerName}</span>
								</div>
							</div>
							<div className="skillhub-card-actions">
								<button
									className="skillhub-card-action-btn"
									title={t("config.skillHubCopyInstallCommand")}
									onClick={(e) => {
										e.stopPropagation();
										const pkg = item.slug.slice(0, item.slug.lastIndexOf("/"));
										navigator.clipboard.writeText(`npx skills add ${pkg}`);
										showNotice(t("app.codeCopied"), 1200);
									}}
								>
									<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
										<rect x="9" y="9" width="13" height="13" rx="2" />
										<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
									</svg>
								</button>
								{!installedSlugs.has(item.slug) && (
									<button
										className="skillhub-card-action-btn primary"
										title={t("common.install")}
										disabled={installingSlugs.has(item.slug)}
										onClick={async (e) => {
											e.stopPropagation();
											await handleInstallFromList(item.slug, item.name);
										}}
									>
										{installingSlugs.has(item.slug) ? <span className="skillhub-installing-dot animate-pideck-spin" /> : <Download size={14} />}
									</button>
								)}
							</div>
						</article>
					))}
				</div>
			)}
		</div>
	);
}
