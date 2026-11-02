/**
 * 宿主插件市场搜索：官方收录（本仓库 registry.json）+ GitHub topic 全网搜索双源合并。
 *
 * 为什么是双源：PiDeck 装不了「中心化商店」——插件作者不必把源码交给我们托管，也不该为了被搜到而
 * 走一遍审核。所以官方源只做**索引与展示**（人工核对过 manifest 与权限、支持单仓库多插件、卡片带
 * 权限列表），社区源直接搜 GitHub 上打了 `pideck-plugin` topic 的公开仓库（未审阅、按星标排序）。
 *
 * 两个源都只产出「可交给 `downloadGitHubPlugin` 的链接」，不产出任何字节：安装仍然走
 * `hostPluginsInstallGitHub` 那条既有的暂存 → 全量校验 → 原子换入 → 重新授权路径，市场拿不到
 * 任何额外能力，装完仍是禁用状态。
 *
 * 单源失败不阻断：收集 warnings 返回给 UI 展示；双源全挂才抛错。
 */
import type { HostPluginMarketEntry, HostPluginMarketSearchResult } from "../../shared/types/hostPlugin";

/** 官方收录索引（本仓库 `registry.json`，见 https://github.com/ayuayue/pideck-plugins）。 */
const REGISTRY_URL = "https://raw.githubusercontent.com/ayuayue/pideck-plugins/main/registry.json";

/** 社区源的约定 topic：作者 `gh repo edit --add-topic pideck-plugin` 即可被搜到。 */
export const HOST_PLUGIN_MARKET_TOPIC = "pideck-plugin";

/** 一次取回多少仓库（GitHub search 上限 100，30 足够铺满一屏且省 API 配额）。 */
const GITHUB_SEARCH_LIMIT = 30;

const GITHUB_SEARCH_URL = `https://api.github.com/search/repositories?q=topic:${HOST_PLUGIN_MARKET_TOPIC}&sort=stars&order=desc&per_page=${GITHUB_SEARCH_LIMIT}`;

/**
 * 社区源的内存缓存时长。GitHub search 未认证时限 10 请求/分钟，而用户可能连打十几次关键词，
 * 所以**只按 topic 拉一次全量**（不带关键词）再本地过滤——同一会话内反复搜索不重复打远程。
 */
const GITHUB_CACHE_TTL_MS = 10 * 60 * 1000;

/** 官方索引缓存时长：它变得慢，且 raw.githubusercontent 在部分地区需要代理。 */
const REGISTRY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const REGISTRY_TIMEOUT_MS = 10_000;
const GITHUB_TIMEOUT_MS = 10_000;
/** 单个仓库的根 manifest 探测超时（社区源要求 manifest 在仓库根）。 */
const MANIFEST_TIMEOUT_MS = 8_000;

/** 合并后的结果上限。 */
const MAX_SEARCH_RESULTS = 40;

const OWNER_REPO_RE = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
/** ref 与 subpath 共用：只允许 GitHub URL 里合法的相对路径字符。 */
const REPO_PATH_RE = /^[A-Za-z0-9._/-]{1,240}$/;

/**
 * ref / subpath 必须是干净的相对路径：不含空段，也不含 `.`/`..` 段——
 * 否则拼出来的链接会指到仓库之外（`tree/main/../escape`），点下去必然失败。
 */
function isRepoPath(value: string): boolean {
	if (!REPO_PATH_RE.test(value)) return false;
	return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

let registryCache: { at: number; entries: HostPluginMarketEntry[] } | undefined;
let githubCache: { at: number; entries: HostPluginMarketEntry[] } | undefined;

/** 测试用：清空两个源的内存缓存（生产无调用方；fake fetch 场景防缓存串测）。 */
export function clearHostPluginMarketCache(): void {
	registryCache = undefined;
	githubCache = undefined;
}

/** fetch 的最小注入面（测试替身用；生产传 Electron 的 net.fetch）。 */
export type HostPluginMarketFetch = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/**
 * 默认实现：动态取 Electron 的 `net.fetch`。
 * 不用全局 `fetch`——undici 不读系统代理，境外 API 会挂到超时；`net.fetch` 跟随 PiDeck 自己的代理设置。
 */
const defaultFetch: HostPluginMarketFetch = async (input, init) => {
	const { net } = await import("electron");
	return net.fetch(input, init);
};

/** 收窄「带 message 的对象」给错误文本兜底。 */
function describeError(error: unknown): string {
	if (typeof error === "object" && error !== null && typeof Reflect.get(error, "message") === "string") return String(Reflect.get(error, "message"));
	return String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringArray(record: Record<string, unknown>, key: string): string[] {
	const value = record[key];
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

/** 拼出 PiDeck 能直接吃的 GitHub 链接；`repo`/`ref`/`subpath` 任一形态不合法就返回 undefined。 */
function buildInstallUrl(repo: string, ref: string | undefined, subpath: string | undefined): string | undefined {
	if (!OWNER_REPO_RE.test(repo)) return undefined;
	if (ref !== undefined && !isRepoPath(ref)) return undefined;
	if (subpath !== undefined && !isRepoPath(subpath)) return undefined;
	if (ref === undefined && subpath === undefined) return `https://github.com/${repo}`;
	const branch = ref ?? "main";
	const path = subpath === undefined ? "" : `/${subpath}`;
	return `https://github.com/${repo}/tree/${branch}${path}`;
}

/** 带超时的 fetch，把 AbortController 的生命周期收在一处。 */
async function fetchWithTimeout(fetchImpl: HostPluginMarketFetch, url: string, timeoutMs: number, headers?: Record<string, string>): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetchImpl(url, headers === undefined ? { signal: controller.signal } : { headers, signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
}

/**
 * 解析 registry.json（`{ schemaVersion: 1, plugins: [...] }`）。
 * 远程数据一律当作不可信输入：形态不对的条目跳过，`installUrl` 拼不出来也跳过——
 * 宁可少一条，也不给用户一个点下去必然失败的「安装」。
 */
export function parseRegistryEntries(payload: unknown): HostPluginMarketEntry[] {
	if (!isRecord(payload)) return [];
	const plugins = payload.plugins;
	if (!Array.isArray(plugins)) return [];
	const entries: HostPluginMarketEntry[] = [];
	for (const item of plugins) {
		if (!isRecord(item)) continue;
		const id = readString(item, "id");
		const repo = readString(item, "repo");
		if (id === undefined || repo === undefined) continue;
		const ref = readString(item, "ref");
		const subpath = readString(item, "subpath");
		const installUrl = buildInstallUrl(repo, ref, subpath);
		if (installUrl === undefined) continue;
		entries.push({
			id,
			name: readString(item, "name") ?? id,
			version: readString(item, "version"),
			description: readString(item, "description"),
			source: "registry",
			installUrl,
			repo,
			author: readString(item, "author"),
			license: readString(item, "license"),
			permissions: readStringArray(item, "permissions"),
			icon: readString(item, "icon"),
			presentations: readStringArray(item, "presentations"),
			tags: readStringArray(item, "tags"),
			homepage: readString(item, "homepage"),
		});
	}
	return entries;
}

/** 拉官方索引（带内存缓存与超时）；失败抛错由调用方降级。 */
async function fetchRegistryEntries(fetchImpl: HostPluginMarketFetch): Promise<HostPluginMarketEntry[]> {
	const cached = registryCache;
	if (cached !== undefined && Date.now() - cached.at < REGISTRY_CACHE_TTL_MS) return cached.entries;
	const response = await fetchWithTimeout(fetchImpl, REGISTRY_URL, REGISTRY_TIMEOUT_MS, { Accept: "application/json" });
	if (!response.ok) throw new Error(`registry HTTP ${response.status}`);
	const entries = parseRegistryEntries(await response.json());
	registryCache = { at: Date.now(), entries };
	return entries;
}

/**
 * 探一个仓库根的 `pideck-plugin.json`。
 *
 * 社区源**只认仓库根**的那一个（与 Magpie 要求 package.json 在仓库根同理）：这样一次 raw 请求
 * 就能拿到 id/name/权限，不必翻目录树；一个仓库想收多个插件就进 registry 的 `subpath`。
 * 取不到（没有 manifest、私有、网络失败）就返回 undefined，由调用方静默跳过——
 * 打了 topic 但不是 PiDeck 插件的仓库本来就会走到这里。
 */
async function probeRootManifest(fetchImpl: HostPluginMarketFetch, fullName: string, branch: string): Promise<Record<string, unknown> | undefined> {
	if (!OWNER_REPO_RE.test(fullName) || !isRepoPath(branch)) return undefined;
	const url = `https://raw.githubusercontent.com/${fullName}/${branch}/pideck-plugin.json`;
	try {
		const response = await fetchWithTimeout(fetchImpl, url, MANIFEST_TIMEOUT_MS);
		if (!response.ok) return undefined;
		const payload = await response.json();
		return isRecord(payload) ? payload : undefined;
	} catch {
		return undefined;
	}
}

/**
 * 拉社区源：`topic:pideck-plugin` 全网搜索 → 逐仓库探根 manifest。
 * fork / 归档 / 已在官方索引里的仓库排除（后者由 `searchHostPluginMarket` 去重）。
 */
async function fetchGitHubEntries(fetchImpl: HostPluginMarketFetch): Promise<HostPluginMarketEntry[]> {
	const cached = githubCache;
	if (cached !== undefined && Date.now() - cached.at < GITHUB_CACHE_TTL_MS) return cached.entries;
	const response = await fetchWithTimeout(fetchImpl, GITHUB_SEARCH_URL, GITHUB_TIMEOUT_MS, { Accept: "application/vnd.github+json" });
	if (!response.ok) throw new Error(`github search HTTP ${response.status}`);
	const payload = await response.json();
	const items = isRecord(payload) && Array.isArray(payload.items) ? payload.items : [];
	const repos: Array<{ fullName: string; branch: string; description?: string; stars: number; license?: string; pushedAt?: string; homepage?: string }> = [];
	for (const item of items) {
		if (!isRecord(item)) continue;
		if (item.fork === true || item.archived === true) continue;
		const fullName = readString(item, "full_name");
		const branch = readString(item, "default_branch") ?? "main";
		if (fullName === undefined) continue;
		const license = isRecord(item.license) ? readString(item.license, "spdx_id") : undefined;
		repos.push({
			fullName,
			branch,
			description: readString(item, "description"),
			stars: typeof item.stargazers_count === "number" ? item.stargazers_count : 0,
			// GitHub 识别不出许可时给的是 NOASSERTION，等同于「没说」。
			license: license === undefined || license === "NOASSERTION" ? undefined : license,
			pushedAt: readString(item, "pushed_at"),
			homepage: readString(item, "homepage"),
		});
	}
	// 并发探 manifest；取不到的直接丢掉（不是 PiDeck 插件，或没把 manifest 放在仓库根）。
	const probed = await Promise.all(repos.map(async (repo) => ({ repo, manifest: await probeRootManifest(fetchImpl, repo.fullName, repo.branch) })));
	const entries: HostPluginMarketEntry[] = [];
	for (const { repo, manifest } of probed) {
		if (manifest === undefined) continue;
		const id = readString(manifest, "id");
		if (id === undefined) continue;
		// 社区源固定按仓库根安装：不带 ref/subpath，让 downloadGitHubPlugin 自己问默认分支。
		const installUrl = `https://github.com/${repo.fullName}`;
		const panels = isRecord(manifest.contributes) && Array.isArray(manifest.contributes.panels) ? manifest.contributes.panels : [];
		const presentations: string[] = [];
		for (const panel of panels) {
			if (!isRecord(panel)) continue;
			const presentation = readString(panel, "presentation");
			if (presentation !== undefined && !presentations.includes(presentation)) presentations.push(presentation);
		}
		const firstPanel = panels.find(isRecord);
		entries.push({
			id,
			name: readString(manifest, "name") ?? id,
			version: readString(manifest, "version"),
			description: readString(manifest, "description") ?? repo.description,
			source: "github",
			installUrl,
			repo: repo.fullName,
			license: repo.license,
			permissions: readStringArray(manifest, "permissions"),
			icon: firstPanel === undefined ? undefined : readString(firstPanel, "icon"),
			presentations,
			stars: repo.stars,
			pushedAt: repo.pushedAt,
			homepage: repo.homepage,
		});
	}
	githubCache = { at: Date.now(), entries };
	return entries;
}

/** 关键词匹配面：id / 名称 / 描述 / 作者 / 仓库 / 标签。空关键词 = 全都要（浏览模式）。 */
function matchesKeyword(entry: HostPluginMarketEntry, keyword: string): boolean {
	if (!keyword) return true;
	const haystack = [entry.id, entry.name, entry.description ?? "", entry.author ?? "", entry.repo, ...(entry.tags ?? [])].join(" ").toLowerCase();
	return haystack.includes(keyword);
}

/** 搜索条件（fetch 注入，测试禁真实网络）。 */
export type SearchHostPluginMarketInput = {
	/** 已 trim 的关键词；空字符串表示浏览全部。 */
	keyword: string;
	fetchImpl?: HostPluginMarketFetch;
};

/**
 * 双源并行搜索：官方收录排在社区结果之前（它是策展数据），同仓库的两源重复只保留官方那条
 * （registry 的 `subpath` 能精确到子目录，比社区源的整仓安装更准），截断到 40 条。
 * 任一源失败记 warning，双源全挂时抛错。
 */
export async function searchHostPluginMarket(input: SearchHostPluginMarketInput): Promise<HostPluginMarketSearchResult> {
	const keyword = input.keyword.trim().toLowerCase();
	const fetchImpl = input.fetchImpl ?? defaultFetch;
	const warnings: string[] = [];
	const [registrySettled, githubSettled] = await Promise.allSettled([fetchRegistryEntries(fetchImpl), fetchGitHubEntries(fetchImpl)]);
	let registryEntries: HostPluginMarketEntry[] = [];
	if (registrySettled.status === "fulfilled") {
		registryEntries = registrySettled.value.filter((entry) => matchesKeyword(entry, keyword));
	} else {
		warnings.push(`registry: ${describeError(registrySettled.reason)}`);
	}
	let githubEntries: HostPluginMarketEntry[] = [];
	if (githubSettled.status === "fulfilled") {
		githubEntries = githubSettled.value.filter((entry) => matchesKeyword(entry, keyword));
	} else {
		warnings.push(`github: ${describeError(githubSettled.reason)}`);
	}
	if (registrySettled.status === "rejected" && githubSettled.status === "rejected") {
		throw new Error(warnings.join("; "));
	}
	const seenUrls = new Set<string>();
	// 官方收录允许一个仓库出多条（`subpath` 精确到子目录），所以**官方源内部不按仓库去重**；
	// 只有社区条目要避开已被收录的仓库——社区源只能整仓装，而 registry 那条更精确。
	const curatedRepos = new Set(registryEntries.map((entry) => entry.repo.toLowerCase()));
	const entries: HostPluginMarketEntry[] = [];
	for (const entry of [...registryEntries, ...githubEntries]) {
		if (entry.source === "github" && curatedRepos.has(entry.repo.toLowerCase())) continue;
		if (seenUrls.has(entry.installUrl)) continue;
		seenUrls.add(entry.installUrl);
		entries.push(entry);
		if (entries.length >= MAX_SEARCH_RESULTS) break;
	}
	return { entries, warnings };
}
