/**
 * AtomGit 作为宿主插件安装源（GitHub 的国内镜像）。
 *
 * AtomGit（atomgit.com）的 API 是 Gitee v5 形态：`file_list` 拿全仓库路径列表，`raw` 按路径取文件字节。
 * 它没有匿名可用的仓库归档接口，所以这里不做 tar.gz，而是「先列文件 → 定位包根 → 只下载包根下的文件」：
 * 与服务端一样受 16MiB / 100 文件 / 单文件 4MiB 预算约束，装出来的文件集与 GitHub tar 源完全同构。
 *
 * 信任模型不变：本模块只取字节，不解包到正式目录、不校验 manifest、不授权；文件集同样交给
 * `HostPluginManager.installFiles` 走暂存 → 全量校验 → 原子换入 → 重新授权。仓库内容一律不可信，
 * 路径在边界上按 `isHostPluginAsset` 收窄，避免 `..` / 绝对路径逃出包根。
 */
import type { HostPluginArchiveFile } from "./hostPluginArchive";
import { isHostPluginAsset } from "./hostPluginManifest";
import { MANIFEST_FILE, MAX_ASSET_BYTES, MAX_PACKAGE_BYTES, MAX_PACKAGE_FILES, selectHostPluginPackage } from "./hostPluginPackage";

const MAX_URL_LENGTH = 300;
/** 文件列表是整仓路径：给一个明显的上限，避免巨型仓库把 JSON 整读进内存。 */
const MAX_LIST_BYTES = 4 * 1024 * 1024;
const MAX_LIST_ENTRIES = 20_000;
const MAX_BRANCH_BYTES = 512 * 1024;
const API_ORIGIN = "https://api.atomgit.com";
const METADATA_TIMEOUT_MS = 20_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const PATH_PATTERN = /^[A-Za-z0-9._/-]{1,240}$/;

export type AtomGitPluginSource = { owner: string; repo: string; ref?: string };

export type AtomGitResponse = {
	ok: boolean;
	status: number;
	headers: { get(name: string): string | null };
	body: ReadableStream<Uint8Array> | null;
};
export type AtomGitFetch = (input: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<AtomGitResponse>;

export type DownloadedAtomGitPlugin = { files: HostPluginArchiveFile[]; owner: string; repo: string; ref: string; subpath?: string };

const defaultFetch: AtomGitFetch = async (input, init) => {
	// 动态取 electron：测试注入 fetch 时不加载网络栈。
	const { net } = await import("electron");
	return net.fetch(input, init);
};

function isRepoPath(value: string): boolean {
	if (!PATH_PATTERN.test(value)) return false;
	return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** 只判断 host：路径合法性由 `parseAtomGitPluginUrl` 收窄，IPC 据此选下载器。 */
export function isAtomGitPluginUrl(raw: string): boolean {
	const trimmed = typeof raw === "string" ? raw.trim() : "";
	if (trimmed.length === 0 || trimmed.length > MAX_URL_LENGTH) return false;
	const withScheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`;
	try {
		const url = new URL(withScheme);
		const host = url.hostname.toLowerCase();
		return url.protocol === "https:" && (host === "atomgit.com" || host === "www.atomgit.com");
	} catch {
		return false;
	}
}

/** 用户粘贴的链接只在边界收窄一次：只接受 atomgit.com 的仓库页与 tree 子目录页。 */
export function parseAtomGitPluginUrl(raw: string): AtomGitPluginSource {
	const trimmed = typeof raw === "string" ? raw.trim() : "";
	if (trimmed.length === 0 || trimmed.length > MAX_URL_LENGTH) throw new Error("invalid-atomgit-url");
	const withScheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`;
	let url: URL;
	try {
		url = new URL(withScheme);
	} catch {
		throw new Error("invalid-atomgit-url");
	}
	if (url.protocol !== "https:" || url.port || url.username || url.password || url.search || url.hash) throw new Error("invalid-atomgit-url");
	const host = url.hostname.toLowerCase();
	if (host !== "atomgit.com" && host !== "www.atomgit.com") throw new Error("invalid-atomgit-url");
	let segments: string[];
	try {
		segments = url.pathname
			.split("/")
			.filter((part) => part.length > 0)
			.map((part) => decodeURIComponent(part));
	} catch {
		throw new Error("invalid-atomgit-url");
	}
	if (segments.length < 2) throw new Error("invalid-atomgit-url");
	const owner = segments[0];
	const repo = segments[1].replace(/\.git$/i, "");
	if (!OWNER_PATTERN.test(owner) || !REPO_PATTERN.test(repo)) throw new Error("invalid-atomgit-url");
	const rest = segments.slice(2);
	if (rest.length === 0) return { owner, repo };
	if (rest[0] !== "tree") throw new Error("invalid-atomgit-url");
	const tail = rest.slice(1);
	if (tail.length === 0) return { owner, repo };
	// tree/<ref>/<subpath>：ref 可能含斜杠，先整串当 ref，下载阶段再逐步缩短。
	return { owner, repo, ref: tail.join("/") };
}

/** 显式 ref 可能带斜杠：从最长到最短逐个当 ref 试，剩下的部分当子目录。 */
function refCandidates(ref: string): Array<{ ref: string; subpath?: string }> {
	const parts = ref.split("/").filter(Boolean);
	const candidates: Array<{ ref: string; subpath?: string }> = [];
	for (let index = parts.length; index >= 1; index -= 1) {
		const candidateRef = parts.slice(0, index).join("/");
		const candidatePath = parts.slice(index).join("/");
		if (!isRepoPath(candidateRef) || (candidatePath && !isRepoPath(candidatePath))) continue;
		candidates.push(candidatePath ? { ref: candidateRef, subpath: candidatePath } : { ref: candidateRef });
	}
	if (candidates.length === 0) throw new Error("invalid-atomgit-url");
	return candidates;
}

async function readBoundedBody(response: AtomGitResponse, limit: number, tooLarge = "download-failed"): Promise<Buffer> {
	const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
	if (Number.isSafeInteger(declared) && declared > limit) throw new Error(tooLarge);
	const reader = response.body?.getReader();
	if (!reader) throw new Error("download-failed");
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value) continue;
		total += value.byteLength;
		if (total > limit) {
			await reader.cancel().catch(() => undefined);
			throw new Error(tooLarge);
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks);
}

async function readJson(response: AtomGitResponse, limit: number, tooLarge = "download-failed"): Promise<unknown> {
	const bytes = await readBoundedBody(response, limit, tooLarge);
	try {
		return JSON.parse(bytes.toString("utf8"));
	} catch {
		throw new Error("download-failed");
	}
}

function apiBase(owner: string, repo: string): string {
	return `${API_ORIGIN}/api/v5/repos/${owner}/${repo}`;
}

function listUrl(owner: string, repo: string, ref: string): string {
	return `${apiBase(owner, repo)}/file_list?ref_name=${encodeURIComponent(ref)}`;
}

function rawUrl(owner: string, repo: string, path: string, ref: string): string {
	const encoded = path.split("/").map(encodeURIComponent).join("/");
	return `${apiBase(owner, repo)}/raw/${encoded}?ref=${encodeURIComponent(ref)}`;
}

/** 未指定 ref 时问一次 branches，取带 `default_branch: true` 的那条；失败回退 main/master。 */
async function resolveDefaultBranch(fetchImpl: AtomGitFetch, owner: string, repo: string): Promise<string | undefined> {
	try {
		const response = await fetchImpl(`${apiBase(owner, repo)}/branches`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(METADATA_TIMEOUT_MS) });
		if (!response.ok) return undefined;
		const payload = await readJson(response, MAX_BRANCH_BYTES);
		if (!Array.isArray(payload)) return undefined;
		const branches = payload.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item));
		const named = branches.map((item) => (typeof item.name === "string" && item.name ? item.name : undefined)).filter((name): name is string => name !== undefined && isRepoPath(name));
		const preferred = branches.find((item) => item.default_branch === true && typeof item.name === "string")?.name;
		if (typeof preferred === "string" && isRepoPath(preferred)) return preferred;
		if (named.includes("main")) return "main";
		if (named.includes("master")) return "master";
		return named[0];
	} catch {
		return undefined;
	}
}

/** 列全仓库文件：ref 不存在时 AtomGit 返回 200 + []，routing 404 也按「该 ref 不存在」处理。 */
async function listFiles(fetchImpl: AtomGitFetch, owner: string, repo: string, ref: string): Promise<string[] | null> {
	const response = await fetchImpl(listUrl(owner, repo, ref), { headers: { accept: "application/json" }, signal: AbortSignal.timeout(METADATA_TIMEOUT_MS) });
	if (response.status === 404) return null;
	if (!response.ok) throw new Error("download-failed");
	const payload = await readJson(response, MAX_LIST_BYTES, "package-too-large");
	if (!Array.isArray(payload)) throw new Error("download-failed");
	const paths: string[] = [];
	for (const item of payload) {
		if (typeof item !== "string" || !isRepoPath(item)) continue;
		paths.push(item);
		if (paths.length > MAX_LIST_ENTRIES) throw new Error("package-too-large");
	}
	return paths;
}

/** 包根候选（相对仓库的路径）；空字符串表示包在仓库（子目录）根上。 */
function rootOf(relative: string): string {
	return relative.slice(0, relative.length - MANIFEST_FILE.length);
}

/** 在文件列表里定位包根，并只保留包根下的文件；预算在下载前就挡住超大包。 */
function packageFiles(paths: readonly string[], subpath?: string): Array<{ repoPath: string; relative: string }> {
	const candidates: Array<{ repoPath: string; relative: string }> = [];
	for (const repoPath of paths) {
		let relative = repoPath;
		if (subpath) {
			if (repoPath === subpath) continue;
			if (!repoPath.startsWith(`${subpath}/`)) continue;
			relative = repoPath.slice(subpath.length + 1);
		}
		if (!relative || !isHostPluginAsset(relative)) continue;
		candidates.push({ repoPath, relative });
	}
	const manifests = candidates.filter((file) => file.relative === MANIFEST_FILE || file.relative.endsWith(`/${MANIFEST_FILE}`));
	if (manifests.length === 0) throw new Error("missing-manifest");
	const depth = (relative: string): number => {
		const root = rootOf(relative);
		return root ? root.split("/").filter(Boolean).length : 0;
	};
	const shallowest = Math.min(...manifests.map((file) => depth(file.relative)));
	const roots = [...new Set(manifests.filter((file) => depth(file.relative) === shallowest).map((file) => rootOf(file.relative)))];
	if (roots.length > 1) throw new Error("plugin-manifest-ambiguous");
	const root = roots[0];
	const inPackage = candidates.filter((file) => file.relative.startsWith(root)).map((file) => ({ repoPath: file.repoPath, relative: file.relative.slice(root.length) }));
	if (inPackage.length > MAX_PACKAGE_FILES) throw new Error("package-too-large");
	return inPackage;
}

/** 下载一个候选 ref 的包；列表为空返回 undefined 交给外层试下一个候选。 */
async function downloadPackage(fetchImpl: AtomGitFetch, owner: string, repo: string, ref: string, subpath: string | undefined): Promise<HostPluginArchiveFile[] | undefined> {
	const paths = await listFiles(fetchImpl, owner, repo, ref);
	if (paths === null || paths.length === 0) return undefined;
	const files = packageFiles(paths, subpath);
	const collected: HostPluginArchiveFile[] = [];
	let total = 0;
	for (const file of files) {
		const response = await fetchImpl(rawUrl(owner, repo, file.repoPath, ref), { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
		if (!response.ok) throw new Error("download-failed");
		const bytes = await readBoundedBody(response, MAX_ASSET_BYTES, "asset-too-large");
		total += bytes.length;
		if (total > MAX_PACKAGE_BYTES) throw new Error("package-too-large");
		collected.push({ path: file.relative, bytes });
	}
	// 与 GitHub 源共用包根/预算判定：路径已相对包根，这里再做一次一致性校验与预算兜底。
	return selectHostPluginPackage(collected);
}

export async function downloadAtomGitPlugin(rawUrl: string, options: { fetchImpl?: AtomGitFetch } = {}): Promise<DownloadedAtomGitPlugin> {
	const source = parseAtomGitPluginUrl(rawUrl);
	const fetchImpl = options.fetchImpl ?? defaultFetch;
	const candidates = source.ref ? refCandidates(source.ref) : [];
	if (candidates.length === 0) {
		const branch = await resolveDefaultBranch(fetchImpl, source.owner, source.repo);
		if (branch) candidates.push({ ref: branch });
		else candidates.push({ ref: "main" }, { ref: "master" });
	}
	for (const candidate of candidates) {
		const files = await downloadPackage(fetchImpl, source.owner, source.repo, candidate.ref, candidate.subpath);
		if (files === undefined) continue;
		return { files, owner: source.owner, repo: source.repo, ref: candidate.ref, ...(candidate.subpath ? { subpath: candidate.subpath } : {}) };
	}
	throw new Error("plugin-not-found");
}
