/**
 * 应用更新日志（CHANGELOG）拉取服务。
 *
 * 为何在主进程拉取而不是渲染层直接 fetch：
 * - 渲染层受 CORS 与 CSP 约束，raw 域名的跨域读取不可靠；
 * - 主进程可统一复用更新源的镜像策略与超时/大小上限，行为与更新检查一致。
 *
 * ## 源策略（atomgit 优先，GitHub 回退）
 *
 * AtomGit 是国内加速源（与更新源默认值同源）。它的匿名 `/raw/` 路径已被 GitCode
 * 前端应用接管——实测（2026-09）对匿名请求返回 HTTP 200 的 SPA HTML 壳（内含易盾
 * riddler-sdk 验证码脚本），任何 UA / 查询参数变体都一样。因此 atomgit 源**不走
 * raw，直接走官方 OpenAPI**（`api.atomgit.com/api/v5/repos/:owner/:repo/contents/:path`，
 * 返回 JSON、content 为 base64；匿名可读公开仓库，实测稳定且无需鉴权）。
 *
 * 即便如此仍不能「拿到就当成功」：API 响应同样要过内容校验（见 looksLikeChangelog），
 * 平台行为随时可能再变。校验不过就回退下一个源，全部失败返回 null，
 * 由 UI 静默降级为「在浏览器打开」。
 *
 * 注：PiAiCatalogUpdater 的 sourceBaseUrls 仍用匿名 /raw/ 拼法——它大概率同样
 * 拿不到内容（靠 parsePiAiCatalogArtifact 结构校验兜住了失败），后续应迁到同一 API。
 */

import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
	ATOMGIT_API_HOST,
	ATOMGIT_HOST,
	UPDATE_REPO,
	UPDATE_REPO_OWNER,
} from "../../shared/updateSources";
import type { UpdateSourceId } from "../../shared/types/settings";

/** CHANGELOG 文件名（按语言）——仓库根目录下的两套并行文件。 */
const CHANGELOG_FILE_ZH = "CHANGELOG.zh-CN.md";
const CHANGELOG_FILE_EN = "CHANGELOG.md";

/** 默认分支：与 catalog 更新的默认分支保持一致。 */
const DEFAULT_BRANCH = "main";

/** 单次请求超时（ms）。CHANGELOG 是纯文本，不需要 catalog 那样的 15s 宽限。 */
const DEFAULT_TIMEOUT_MS = 8_000;

/**
 * 正文大小上限（字节）。
 * 本仓库 CHANGELOG.zh-CN.md 当前约 125KB，留一个宽裕但能挡住异常响应的上限。
 */
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

/** 正文过短说明不是真 changelog（HTML 错误页/空响应），拒绝。 */
const MIN_VALID_LENGTH = 32;

/**
 * 缓存新鲜期（ms）。期内打开弹窗零网络、直接复用本地文件（秒开）。
 * CHANGELOG 的变更频率等于发版频率（数天一次），24h 足够新；
 * 期内真出了新版本，用户点「刷新」按钮即可强制取最新覆盖。
 */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export type ChangelogLanguage = "zh" | "en";

export type ChangelogResult = {
	/** markdown 正文（已确认不是 HTML 壳）。 */
	markdown: string;
	/**
	 * 实际取到内容的源，供 UI 提示与诊断。
	 * "atomgit" | "github"；旧缓存可能缺 source（读作 null）；
	 * 全部失败时整个结果为 null（见 ChangelogService.getChangelog 返回 null）。
	 */
	source: ChangelogSourceId | null;
	/** 正文中解析出的版本条目数，仅用于日志/诊断。 */
	versionCount: number;
	/** 内容抓取时间（ISO）。缓存命中=当时；网络直取=本次。 */
	fetchedAt: string;
	/** 本次内容来自本地缓存（TTL 内复用，或网络失败兜底），未发生成功的网络请求。 */
	fromCache: boolean;
	/** 网络失败、退回旧缓存：内容可能不是最新，UI 应提示。 */
	stale: boolean;
};

type ChangelogSourceId = "atomgit" | "github";

/** 本地缓存条目（meta.json 里按语言存放的元数据 + 同目录的正文文件）。 */
type CachedChangelog = {
	markdown: string;
	fetchedAt: string;
	source: ChangelogSourceId | null;
	versionCount: number;
};

export type ChangelogServiceOptions = {
	/** 网络实现注入（单测）；默认 globalThis.fetch。 */
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
	maxBytes?: number;
	/** 默认分支，默认 main。 */
	branch?: string;
	/**
	 * 期望的更新源：决定源顺序（atomgit 优先 / github 直连优先）。
	 * 用函数而非快照：设置可在运行时更改，每次拉取读最新值。
	 */
	source?: () => UpdateSourceId;
	/**
	 * 本地缓存目录（一般传 `<userData>/changelog-cache`）。缺省禁用缓存——
	 * 类保持纯网络语义，缓存是调用方（主进程 handler）显式开启的能力。
	 */
	cacheDir?: string;
	/** 缓存新鲜期（ms），默认 24h；测试注入小值控制过期。 */
	cacheTtlMs?: number;
};

/**
 * 判断响应体是否长得像一份 CHANGELOG（而不是 AtomGit 的 HTML 拦截页）。
 *
 * 校验点刻意保持"宽进严出"：只排除确定不是 markdown 的情形，不试图做严格的
 * markdown 解析——CHANGELOG 由维护者手写，格式只要大致合理就应放行。
 */
export function looksLikeChangelog(body: string): boolean {
	const text = body.trim();
	if (text.length < MIN_VALID_LENGTH) return false;
	// HTML 壳：AtomGit 反爬页/Apache 错误页都以 <!DOCTYPE 或 <html 开头。
	// 用 toLowerCase 前缀判断而不是 includes，避免正文里出现 "<html>" 字样（如
	// 某条 changelog 提到 HTML 相关改动）被误杀。
	const head = text.slice(0, 512).toLowerCase();
	if (head.startsWith("<!doctype") || head.startsWith("<html")) return false;
	// captcha 拦截页的兜底特征（即便不以上述前缀开头）
	if (head.includes("captcha")) return false;
	// 真正的 CHANGELOG 必有 markdown 标题（本仓库为 "## vX.Y.Z"）
	return /^#{1,3}\s/m.test(text);
}

/**
 * 从 changelog 正文中数出版本条目数（"## vX.Y.Z" 形态）。
 * 仅用于日志与诊断，不参与正确性判断。
 */
export function countChangelogVersions(markdown: string): number {
	const matches = markdown.match(/^##\s+v?\d+\.\d+/gm);
	return matches ? matches.length : 0;
}

/**
 * 解码 AtomGit OpenAPI contents 响应（`GET /api/v5/repos/:owner/:repo/contents/:path`）。
 *
 * 官方文档形态：`{ type: "file", encoding: "base64", content: "<base64>", ... }`。
 * base64 解码后是 UTF-8 原文（Buffer.from 忽略 base64 序列里的换行，无需预处理）。
 * 任何形态异常都抛错，由 getChangelog 的逐源 try/catch 吞掉并尝试下一源。
 */
export function decodeAtomGitContentsResponse(body: string): string {
	let payload: unknown;
	try {
		payload = JSON.parse(body);
	} catch {
		throw new Error("atomgit contents response is not valid JSON");
	}
	const record = payload as { type?: unknown; encoding?: unknown; content?: unknown } | null;
	if (
		typeof record !== "object" ||
		record === null ||
		record.type !== "file" ||
		typeof record.content !== "string"
	) {
		throw new Error("atomgit contents response has an unexpected shape");
	}
	if (record.encoding === "base64") {
		return Buffer.from(record.content, "base64").toString("utf8");
	}
	// 文档只描述 base64；非 base64 encoding 的形态不认识，交原文给 looksLikeChangelog 把关
	return record.content;
}

/**
 * 生成候选源 URL 列表（按优先级）。
 *
 * AtomGit 走 OpenAPI contents 接口（匿名 raw 已被 GitCode SPA 接管，拿不到文件）；
 * GitHub 保持 raw 直链。文件名/分支做 URI 编码以容忍未来出现特殊字符。
 */
export function buildChangelogUrls(input: {
	source: UpdateSourceId;
	branch?: string;
	language: ChangelogLanguage;
}): { id: ChangelogSourceId; url: string }[] {
	const branch = input.branch ?? DEFAULT_BRANCH;
	const file = input.language === "zh" ? CHANGELOG_FILE_ZH : CHANGELOG_FILE_EN;
	const repoPath = `${UPDATE_REPO_OWNER}/${UPDATE_REPO}`;
	const candidates: { id: ChangelogSourceId; url: string }[] = [];
	const atomgit = {
		id: "atomgit" as const,
		url:
			`${ATOMGIT_API_HOST}/api/v5/repos/${repoPath}/contents/${encodeURIComponent(file)}` +
			`?ref=${encodeURIComponent(branch)}`,
	};
	const github = {
		id: "github" as const,
		url: `https://raw.githubusercontent.com/${repoPath}/${branch}/${file}`,
	};
	// 用户显式选了官方源时把 GitHub 提前，尊重其选择（官方源用户通常网络可达）。
	if (input.source === "github") {
		candidates.push(github, atomgit);
	} else {
		candidates.push(atomgit, github);
	}
	return candidates;
}

export class ChangelogService {
	private readonly fetchImpl: typeof fetch;
	private readonly timeoutMs: number;
	private readonly maxBytes: number;
	private readonly branch: string;
	private readonly source: () => UpdateSourceId;
	private readonly cacheDir: string | null;
	private readonly cacheTtlMs: number;

	constructor(options: ChangelogServiceOptions = {}) {
		this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
		this.branch = options.branch ?? DEFAULT_BRANCH;
		this.source = options.source ?? (() => "atomgit");
		this.cacheDir = options.cacheDir ?? null;
		this.cacheTtlMs = options.cacheTtlMs ?? CACHE_TTL_MS;
	}

	/**
	 * 拉取更新日志正文（带本地缓存）。
	 *
	 * 取用顺序：
	 * 1. 缓存新鲜（存在且未过 TTL）且非强制刷新 → 直接复用，零网络（秒开）；
	 * 2. 否则逐源网络拉取，成功后写回缓存；
	 * 3. 网络全败但有旧缓存 → 退回旧缓存（stale=true，UI 提示可能不是最新）；
	 * 4. 无缓存 → 返回 null，调用方降级为「在浏览器打开」。
	 *
	 * 「刷新」按钮走 forceRefresh：跳过 TTL 强制拉最新，成功即覆盖缓存；
	 * 即便强制刷新失败，只要本地有缓存也仍然有内容可看（stale 兜底）。
	 */
	async getChangelog(
		language: ChangelogLanguage = "zh",
		options: { forceRefresh?: boolean } = {},
	): Promise<ChangelogResult | null> {
		const cached = await this.readCache(language);
		if (cached && !options.forceRefresh && this.isCacheFresh(cached.fetchedAt)) {
			return { ...cached, fromCache: true, stale: false };
		}

		const urls = buildChangelogUrls({
			source: this.source(),
			branch: this.branch,
			language,
		});
		for (const candidate of urls) {
			try {
				const body = await this.downloadText(candidate.url);
				// atomgit 候选是 OpenAPI JSON（content 为 base64），github 候选是纯文本
				const text =
					candidate.id === "atomgit" ? decodeAtomGitContentsResponse(body) : body;
				// 内容校验：即便走官方 API，200 也不等于拿到了合法 changelog。
				if (!looksLikeChangelog(text)) continue;
				const result: ChangelogResult = {
					markdown: text,
					source: candidate.id,
					versionCount: countChangelogVersions(text),
					fetchedAt: new Date().toISOString(),
					fromCache: false,
					stale: false,
				};
				await this.writeCache(language, result);
				return result;
			} catch {
				// 单源失败（网络/超时/过大/响应形态异常）静默尝试下一个源
			}
		}

		// 网络全败：有旧缓存就退回（stale 标注），让用户至少能看到上次的内容。
		if (cached) return { ...cached, fromCache: true, stale: true };
		return null;
	}

	/** 供 UI 降级用：CHANGELOG 在 AtomGit 上的网页地址（走系统浏览器）。 */
	changelogPageUrl(language: ChangelogLanguage = "zh"): string {
		const file = language === "zh" ? CHANGELOG_FILE_ZH : CHANGELOG_FILE_EN;
		return `${ATOMGIT_HOST}/${UPDATE_REPO_OWNER}/${UPDATE_REPO}/blob/${this.branch}/${file}`;
	}

	// ── 本地缓存：正文文件 + meta.json（按语言存抓取时间/来源）。全部静默容错——
	// 缓存读写失败只影响「复用/兜底」这一增益，绝不能反过来弄挂主流程。 ──

	private changelogCacheFile(language: ChangelogLanguage): string {
		return join(this.cacheDir ?? "", language === "zh" ? CHANGELOG_FILE_ZH : CHANGELOG_FILE_EN);
	}

	private isCacheFresh(fetchedAt: string): boolean {
		const ts = Date.parse(fetchedAt);
		if (!Number.isFinite(ts)) return false;
		return Date.now() - ts < this.cacheTtlMs;
	}

	private async readCache(language: ChangelogLanguage): Promise<CachedChangelog | null> {
		if (!this.cacheDir) return null;
		try {
			const markdown = await readFile(this.changelogCacheFile(language), "utf8");
			// 缓存内容同样过内容校验：防止历史脏数据（例如早期版本的坏缓存）被当正文渲染。
			if (!looksLikeChangelog(markdown)) return null;
			const metaRaw = await readFile(join(this.cacheDir, "meta.json"), "utf8").catch(
				() => null,
			);
			const meta = (JSON.parse(metaRaw ?? "{}") as Record<string, unknown>)[language];
			const fetchedAt =
				typeof meta === "object" && meta !== null && typeof (meta as { fetchedAt?: unknown }).fetchedAt === "string"
					? (meta as { fetchedAt: string }).fetchedAt
					: null;
			if (!fetchedAt) return null;
			return {
				markdown,
				fetchedAt,
				source:
					typeof meta === "object" && meta !== null &&
					((meta as { source?: unknown }).source === "atomgit" ||
						(meta as { source?: unknown }).source === "github")
						? (meta as { source: ChangelogSourceId }).source
						: null,
				versionCount: countChangelogVersions(markdown),
			};
		} catch {
			return null;
		}
	}

	private async writeCache(language: ChangelogLanguage, result: ChangelogResult): Promise<void> {
		if (!this.cacheDir) return;
		try {
			await mkdir(this.cacheDir, { recursive: true });
			const metaPath = join(this.cacheDir, "meta.json");
			const all = await readFile(metaPath, "utf8")
				.then((raw) => JSON.parse(raw) as Record<string, unknown>)
				.catch(() => ({}) as Record<string, unknown>);
			all[language] = {
				fetchedAt: result.fetchedAt,
				source: result.source,
				versionCount: result.versionCount,
			};
			// 正文与 meta 各自落盘；任一失败（如磁盘满）都静默——下次拉取会再写。
			await Promise.all([
				writeFile(this.changelogCacheFile(language), result.markdown, "utf8"),
				writeFile(metaPath, JSON.stringify(all, null, 2), "utf8"),
			]);
		} catch {
			// 缓存写失败不影响本次返回结果
		}
	}

	/** 带超时、大小上限与 UA 的文本下载（形态与 PiAiCatalogUpdater.downloadText 一致）。 */
	private async downloadText(url: string): Promise<string> {
		const controller = new AbortController();
		// 超时中止：网络挂起（DNS/连接阶段）时同样生效，防止 UI 长期转圈。
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		try {
			const response = await this.fetchImpl(url, {
				signal: controller.signal,
				redirect: "follow",
				headers: { "user-agent": "PiDeck-changelog" },
			});
			if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
			const buffer = await response.arrayBuffer();
			if (buffer.byteLength > this.maxBytes) {
				throw new Error(`response too large (${buffer.byteLength} bytes) for ${url}`);
			}
			return new TextDecoder("utf-8").decode(buffer);
		} finally {
			clearTimeout(timer);
		}
	}
}
