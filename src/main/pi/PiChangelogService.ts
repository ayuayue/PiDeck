import type { PiReleaseNotesPayload } from "../../shared/types";
import { compareVersions } from "../utils/versionCompare";

/**
 * pi CLI 更新日志服务：用户点「更新详情」时才按需拉取（版本检查的自动调度不触发）。
 *
 * ## 来源策略
 *
 * npm 包里随版本发布 CHANGELOG.md（Keep-a-Changelog 格式），按 latestVersion **钉版本**
 * 拉取（内容不可变 → 内存缓存按版本号键控天然安全）：
 *   1. jsDelivr（国内可达性最好，实测直连 200）
 *   2. unpkg（备用 npm CDN）
 *   3. GitHub raw（主分支 changelog，未发布的热修也能看到，但国内常被墙）
 * 全部失败返回 markdown=null，UI 降级为「在浏览器查看」（pageUrl 始终有值）。
 *
 * ## 渲染安全边界
 *
 * CHANGELOG 是外部数据：先用 isPlausibleChangelog 排除 CDN/代理返回的 HTML 错误壳，
 * 渲染层再经 MarkdownStream 的 sanitize 管线（与 PiDeck 自身更新日志同一套）。
 */

export type PiChangelogSource = "jsdelivr" | "unpkg" | "github";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";
/** 降级「在浏览器查看」的固定地址（GitHub blob 页，人读友好）。 */
const PI_CHANGELOG_PAGE_URL = "https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md";
const FETCH_TIMEOUT_MS = 10_000;
/** 拉取字节上限：正常 1.0.x 的 changelog 约 160KB，超过按异常处理（防内存与解析失控）。 */
const MAX_FETCH_CHARS = 800_000;
/** 交给渲染层的区间正文上限：区间可能横跨几十个大版本，截断在版本边界。 */
const MAX_RANGE_CHARS = 60_000;
/** 区间版本数上限（currentVersion 缺失时的兜底条数也用更小的值）。 */
const MAX_RANGE_VERSIONS = 12;
const FALLBACK_VERSIONS = 3;

function buildSources(latestVersion: string): Array<{ source: PiChangelogSource; url: string }> {
	const pinned = `${PI_PACKAGE}@${latestVersion}/CHANGELOG.md`;
	return [
		{ source: "jsdelivr", url: `https://cdn.jsdelivr.net/npm/${pinned}` },
		{ source: "unpkg", url: `https://unpkg.com/${pinned}` },
		{ source: "github", url: "https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/CHANGELOG.md" },
	];
}

/** 提取 `## [1.0.2] - 2026-10-04` 里的版本号；非 semver 段落头返回 null。 */
function parseEntryVersion(header: string): string | null {
	const match = /\[([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)\]/.exec(header);
	return match?.[1] ?? null;
}

/** 校验拿到的是 CHANGELOG 正文而不是 CDN/代理/镜像的 HTML 错误壳。 */
export function isPlausibleChangelog(text: string): boolean {
	if (/^\s*(<!doctype\s+html|<html[\s>])/i.test(text)) return false;
	return /^#\s+Changelog\s*$/m.test(text.slice(0, 2000)) && /^## \[\d+\.\d+\.\d+/m.test(text);
}

export type ChangelogRange = {
	/** 区间条目拼接的 markdown（不含文件级 `# Changelog` 标题）。 */
	markdown: string;
	/** 命中的版本条目数。 */
	versionCount: number;
	/** 因条数/字符上限被截断（截在版本边界，不会半个段落）。 */
	truncated: boolean;
};

/**
 * 从完整 CHANGELOG 抽取 (currentVersion, latestVersion] 区间条目。
 * - currentVersion 缺失/非法：取最新 FALLBACK_VERSIONS 条（用户版本探测失败时仍看得到近况）。
 * - latestVersion 缺失/非法：不做上界过滤（钉版拉取下全文本来就是该版本为止）。
 * - 区间为空（已是最新）：markdown 为空串、versionCount 0，UI 不应走到这（按钮只在有更新时出现）。
 */
export function extractChangelogRange(markdown: string, currentVersion: string | undefined, latestVersion: string | undefined, options: { maxVersions?: number; maxChars?: number } = {}): ChangelogRange {
	const maxVersions = options.maxVersions ?? MAX_RANGE_VERSIONS;
	const maxChars = options.maxChars ?? MAX_RANGE_CHARS;
	// 按 `## [x.y.z]` 段落头切分；第一段是文件头（# Changelog 与引言），丢弃。
	const headerPattern = /^## \[.*$/gm;
	const headers = [...markdown.matchAll(headerPattern)];
	const entries: Array<{ version: string; body: string }> = [];
	for (let i = 0; i < headers.length; i++) {
		const version = parseEntryVersion(headers[i][0]);
		if (!version) continue;
		const start = headers[i].index ?? 0;
		const end = i + 1 < headers.length ? (headers[i + 1].index ?? markdown.length) : markdown.length;
		entries.push({ version, body: markdown.slice(start, end).trimEnd() });
	}
	const validCurrent = currentVersion && /^\d+\.\d+\.\d+/.test(currentVersion) ? currentVersion : null;
	const validLatest = latestVersion && /^\d+\.\d+\.\d+/.test(latestVersion) ? latestVersion : null;
	let selected = entries.filter((entry) => {
		if (validLatest && compareVersions(entry.version, validLatest) > 0) return false;
		if (validCurrent && compareVersions(entry.version, validCurrent) <= 0) return false;
		return true;
	});
	if (!validCurrent) selected = selected.slice(0, FALLBACK_VERSIONS);
	let truncated = false;
	if (selected.length > maxVersions) {
		selected = selected.slice(0, maxVersions);
		truncated = true;
	}
	let total = 0;
	const kept: string[] = [];
	for (const entry of selected) {
		if (total + entry.body.length > maxChars && kept.length > 0) {
			truncated = true;
			break;
		}
		kept.push(entry.body);
		total += entry.body.length;
	}
	return { markdown: kept.join("\n\n"), versionCount: kept.length, truncated };
}

export class PiChangelogService {
	/** 钉版内容不可变 → 按 latestVersion 键控的进程内缓存永不过期。 */
	private readonly cache = new Map<string, { markdown: string; source: PiChangelogSource; fetchedAt: string }>();

	async getReleaseNotes(options: { latestVersion: string; currentVersion?: string }): Promise<PiReleaseNotesPayload> {
		const latestVersion = typeof options.latestVersion === "string" ? options.latestVersion.trim() : "";
		if (!/^\d+\.\d+\.\d+/.test(latestVersion)) return this.emptyPayload();
		const cached = this.cache.get(latestVersion);
		const full = cached ?? (await this.fetchChangelog(latestVersion));
		if (!full) return this.emptyPayload();
		if (!cached) this.cache.set(latestVersion, full);
		const range = extractChangelogRange(full.markdown, options.currentVersion, latestVersion);
		return {
			markdown: range.markdown.length > 0 ? range.markdown : null,
			source: full.source,
			versionCount: range.versionCount,
			pageUrl: PI_CHANGELOG_PAGE_URL,
			fetchedAt: full.fetchedAt,
			truncated: range.truncated,
		};
	}

	private emptyPayload(): PiReleaseNotesPayload {
		return { markdown: null, source: null, versionCount: 0, pageUrl: PI_CHANGELOG_PAGE_URL, fetchedAt: null, truncated: false };
	}

	/** 依次尝试各源；单个源失败（网络/校验）静默换下一个，全部失败返回 null。 */
	private async fetchChangelog(latestVersion: string): Promise<{ markdown: string; source: PiChangelogSource; fetchedAt: string } | null> {
		for (const candidate of buildSources(latestVersion)) {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
			try {
				const response = await fetch(candidate.url, {
					headers: { accept: "text/plain, text/markdown, */*", "user-agent": `pi-deck/pi-changelog` },
					signal: controller.signal,
				});
				if (!response.ok) continue;
				const text = await response.text();
				if (text.length > MAX_FETCH_CHARS || !isPlausibleChangelog(text)) continue;
				return { markdown: text, source: candidate.source, fetchedAt: new Date().toISOString() };
			} catch {
				// 网络错误/超时：换下一个源。
			} finally {
				clearTimeout(timeout);
			}
		}
		return null;
	}
}

/** 进程级单例：缓存随进程生命周期，与系统其它 main 服务的装配方式一致。 */
export const piChangelogService = new PiChangelogService();
