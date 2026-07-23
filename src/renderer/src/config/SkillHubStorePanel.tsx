// @ts-nocheck - SkillHub store panel, new feature
import { useState, useEffect, useRef, useCallback } from "react";
import { Search, Download, Star, ArrowLeft, Sparkles, Check, AlertCircle } from "lucide-react";
import { t } from "../i18n";
import { showNotice } from "../utils/notice";
import type { SkillHubItem, SkillHubDetail, SkillHubSearchResult, SkillHubInstallResult } from "../../../shared/types";

const api = (window as unknown as {
	piDesktop: {
		skillHub: {
			search: (q: string, limit?: number) => Promise<SkillHubSearchResult>;
			detail: (slug: string) => Promise<SkillHubDetail | null>;
			install: (slug: string, installDir: string) => Promise<SkillHubInstallResult>;
		};
	};
}).piDesktop;

const SUGGESTED_SEARCHES = [
	"pdf", "ocr", "translate", "code review", "react",
	"python", "git", "image", "data", "writing",
];

function fmtNum(n: number): string {
	if (n >= 10000) return (n / 10000).toFixed(1) + "w";
	if (n >= 1000) return (n / 1000).toFixed(1) + "k";
	return String(n);
}

export function SkillHubStorePanel() {
	const [query, setQuery] = useState("");
	const [searching, setSearching] = useState(false);
	const [installingSlugs, setInstallingSlugs] = useState<Set<string>>(new Set());
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

	const handleSearch = useCallback(async (searchQuery: string) => {
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
			setResult(data);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSearching(false);
		}
	}, []);

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
		} catch {
			setDetail(null);
		} finally {
			setDetailLoading(false);
		}
	}, []);

	/** 列表直接安装（不进入详情） */
	const handleInstallFromList = async (slug: string, name: string) => {
		setInstallingSlugs((prev) => new Set(prev).add(slug));
		try {
			const result = await api.skillHub.install(slug, "");
			if (result.success) {
				showNotice(t("app.skillsInstalled", { name }), 3000);
			} else {
				showNotice(result.error || t("common.error"), 5000, "error");
			}
		} catch (err) {
			showNotice(err instanceof Error ? err.message : String(err), 5000, "error");
		} finally {
			setInstallingSlugs((prev) => {
				const next = new Set(prev);
				next.delete(slug);
				return next;
			});
		}
	};

	const handleInstall = async () => {
		if (!previewSlug) return;
		setInstalling(true);
		setInstallResult(null);
		try {
			const result = await api.skillHub.install(previewSlug, "");
			setInstallResult(result);
			if (result.success) {
				showNotice(t("app.skillsInstalled", { name: detail?.skill?.displayName || previewSlug }), 3000);
			}
		} catch (err) {
			setInstallResult({ success: false, slug: previewSlug, installDir: "", error: String(err) });
		} finally {
			setInstalling(false);
		}
	};

	// Detail view
	if (previewSlug) {
		return (
			<div className="skillhub-panel">
				<div className="skillhub-detail-toolbar">
					<button className="config-btn" onClick={() => { setPreviewSlug(null); setDetail(null); setInstallResult(null); }}>
						<ArrowLeft size={14} />
						{t("config.promptStoreBack")}
					</button>
				</div>
				<div className="config-empty" style={{ marginTop: 24 }}>
					<p>{t("config.skillHubDetailNotAvailable")}</p>
				</div>
			</div>
		);
	}

	// Search / List view
	return (
		<div className="skillhub-panel">
			<div className="skillhub-search-bar">
				<div className="skillhub-search-input-wrap">
					<Search size={15} strokeWidth={1.8} className="skillhub-search-icon" />
					<input
						ref={searchInputRef}
						type="text"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						onKeyDown={handleKeyDown}
						placeholder={t("config.skillHubSearchPlaceholder")}
						disabled={searching}
					/>
					<button
						className="config-btn primary"
						onClick={() => void handleSearch(query)}
						disabled={searching || !query.trim()}
					>
						{searching ? t("common.searching") + "…" : <Search size={14} />}
					</button>
				</div>
				{!result && !searching && (
					<div className="skillhub-suggestions">
						{SUGGESTED_SEARCHES.map((s) => (
							<button
								key={s}
								className="skillhub-suggestion-chip"
								onClick={() => { setQuery(s); void handleSearch(s); }}
							>
								{s}
							</button>
						))}
					</div>
				)}
			</div>

			{error && <div className="config-error">{error}</div>}
			{searching && <div className="config-loading">{t("common.searching")}…</div>}

			{result && !searching && result.total === 0 && (
				<div className="config-empty">{t("config.noSearchResults")}</div>
			)}

			{result && result.total > 0 && (
				<div className="skillhub-results">
					<small className="skillhub-result-count">
						{result.total} {t("common.results")}
					</small>
					{result.items.map((item) => (
						<article
							key={item.slug}
							className="skillhub-card"
							onClick={() => window.open(`https://www.skills.sh/search?q=${encodeURIComponent(item.name)}`, "_blank")}
						>
							<div className="skillhub-card-main">
								<strong className="skillhub-card-title">{item.name}</strong>
								<p className="skillhub-card-desc">
									{(item.description_zh || item.description || "").substring(0, 120)}
									{(item.description_zh || item.description || "").length > 120 ? "…" : ""}
								</p>
								<div className="skillhub-card-meta">
									{item.category && <span className="skillhub-card-category">{item.category}</span>}
									<span className="skillhub-card-stats">
										<Star size={11} fill="currentColor" /> {fmtNum(item.stars)}
									</span>
									<span className="skillhub-card-stats">
										<Download size={11} /> {fmtNum(item.downloads)}
									</span>
								</div>
							</div>
							<button
								className="skillhub-card-install-btn"
								title={t("common.install")}
								disabled={installingSlugs.has(item.slug)}
								onClick={async (e) => {
									e.stopPropagation();
									await handleInstallFromList(item.slug, item.name);
								}}
							>
								{installingSlugs.has(item.slug) ? <span className="skillhub-installing-dot" /> : <Download size={14} />}
							</button>
						</article>
					))}
				</div>
			)}
		</div>
	);
}
