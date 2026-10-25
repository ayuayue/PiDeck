/**
 * GitHub 作为第三个插件安装来源：公开仓库 → 源码 tar.gz → 定位包根 → 交回文件集。
 *
 * 为什么是 tar.gz 而不是 zip：`hostPluginArchive.ts` 已经定下「不为不可信输入引入第三方解压依赖」，
 * 而 Node 自带 `zlib`，tar 只是一串 512 字节定长头，自己解析即可；GitHub 的
 * `codeload.github.com/<owner>/<repo>/tar.gz/<ref>` 正好是这个形态（zip 则需要引入解压库）。
 *
 * 信任模型与另外两个来源完全一致：这里只负责「取字节」，不解包到正式目录、不校验 manifest、
 * 不授予任何权限。文件集交给 `HostPluginManager.installFiles` 走同一条暂存 → 全量校验 → 原子换入 →
 * 重新授权的路径，所以 GitHub 来源拿不到任何额外能力。
 */
import { gunzipSync } from "node:zlib";
import { isHostPluginAsset } from "./hostPluginManifest";
import { readTarFiles } from "../fs/tarRead";
import type { HostPluginArchiveFile } from "./hostPluginArchive";

// 保持对外 API：调用方与测试从本模块 import readTarFiles（实现已提取到 fs/tarRead）。
export { readTarFiles };

const MAX_URL_LENGTH = 300;
/** 下载字节上限：与 `.pideck-plugin` 归档同一档，避免把超大仓库整读进内存。 */
const MAX_DOWNLOAD_BYTES = 24 * 1024 * 1024;
/** 解压后 tar 上限（防解压炸弹）：包本身最多 16MiB，仓库其余内容留出余量后到此为止。 */
const MAX_EXPANDED_BYTES = 96 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 16 * 1024 * 1024;
const MAX_PACKAGE_FILES = 100;
const MAX_ASSET_BYTES = 4 * 1024 * 1024;
const MANIFEST_FILE = "pideck-plugin.json";
const METADATA_TIMEOUT_MS = 30_000;
const TARBALL_TIMEOUT_MS = 120_000;

export type GitHubPluginSource = { owner: string; repo: string; ref?: string };

export type GitHubResponse = {
	ok: boolean;
	status: number;
	headers: { get(name: string): string | null };
	body: ReadableStream<Uint8Array> | null;
};
export type GitHubFetch = (input: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<GitHubResponse>;

export type DownloadedGitHubPlugin = { files: HostPluginArchiveFile[]; owner: string; repo: string; ref: string; subpath?: string };

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const PATH_PATTERN = /^[A-Za-z0-9._/-]{1,240}$/;

/** 用户粘贴的链接只在边界收窄一次：只接受 github.com 的仓库页与 tree 子目录页。 */
export function parseGitHubPluginUrl(raw: string): GitHubPluginSource {
	const trimmed = typeof raw === "string" ? raw.trim() : "";
	if (trimmed.length === 0 || trimmed.length > MAX_URL_LENGTH) throw new Error("invalid-github-url");
	const withScheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`;
	let url: URL;
	try {
		url = new URL(withScheme);
	} catch {
		throw new Error("invalid-github-url");
	}
	if (url.protocol !== "https:" || url.port || url.username || url.password || url.search || url.hash) throw new Error("invalid-github-url");
	const host = url.hostname.toLowerCase();
	if (host !== "github.com" && host !== "www.github.com") throw new Error("invalid-github-url");
	let segments: string[];
	try {
		segments = url.pathname
			.split("/")
			.filter((part) => part.length > 0)
			.map((part) => decodeURIComponent(part));
	} catch {
		throw new Error("invalid-github-url");
	}
	if (segments.length < 2) throw new Error("invalid-github-url");
	const owner = segments[0];
	const repo = segments[1].replace(/\.git$/i, "");
	if (!OWNER_PATTERN.test(owner) || !REPO_PATTERN.test(repo)) throw new Error("invalid-github-url");
	const rest = segments.slice(2);
	// 只有 tree（目录）是有意义的：blob 是单文件、archive 是压缩包，都不构成插件包来源。
	if (rest.length === 0) return { owner, repo };
	if (rest[0] !== "tree") throw new Error("invalid-github-url");
	const tail = rest.slice(1);
	if (tail.length === 0) return { owner, repo };
	const source: GitHubPluginSource = { owner, repo };
	// tree/<ref>/<subpath>：ref 本身可能带斜杠，这里先把整串当作 ref，下载阶段再按 404 逐步缩短重试。
	source.ref = tail.join("/");
	return source;
}

/**
 * 从仓库 tarball 里挑出插件包：GitHub 会在最外层加 `<repo>-<ref>/`，先剥掉；再按 `pideck-plugin.json`
 * 定位包根（支持插件放在仓库子目录），最后只保留包根下的文件并施加与归档一致的预算。
 */
export function selectGitHubPackage(files: readonly HostPluginArchiveFile[], subpath?: string): HostPluginArchiveFile[] {
	const relative = new Map<string, Buffer>();
	for (const file of files) {
		const slash = file.path.indexOf("/");
		if (slash < 0) continue;
		let path = file.path.slice(slash + 1);
		if (subpath) {
			if (path !== subpath && !path.startsWith(`${subpath}/`)) continue;
			path = path.slice(subpath.length).replace(/^\//, "");
			if (!path) continue;
		}
		if (isHostPluginAsset(path)) relative.set(path, file.bytes);
	}
	const roots = [...relative.keys()].filter((path) => path === MANIFEST_FILE || path.endsWith(`/${MANIFEST_FILE}`)).map((path) => path.slice(0, path.length - MANIFEST_FILE.length));
	if (roots.length === 0) throw new Error("missing-manifest");
	const shallowest = Math.min(...roots.map((root) => (root.length === 0 ? 0 : root.split("/").length)));
	const candidates = roots.filter((root) => (root.length === 0 ? 0 : root.split("/").length) === shallowest);
	if (candidates.length > 1) throw new Error("plugin-manifest-ambiguous");
	const root = candidates[0];
	const collected: HostPluginArchiveFile[] = [];
	let total = 0;
	for (const [path, bytes] of relative) {
		if (root && !path.startsWith(root)) continue;
		const asset = root ? path.slice(root.length) : path;
		if (!asset || !isHostPluginAsset(asset)) continue;
		if (bytes.length > MAX_ASSET_BYTES) throw new Error("asset-too-large");
		if (collected.length >= MAX_PACKAGE_FILES) throw new Error("package-too-large");
		total += bytes.length;
		if (total > MAX_PACKAGE_BYTES) throw new Error("package-too-large");
		collected.push({ path: asset, bytes });
	}
	return collected;
}

/** 解压 tar.gz 并挑包；展开上限在 `gunzipSync` 内部生效，超限直接失败而不是先分配大缓冲。 */
export function extractGitHubPackage(tarball: Uint8Array, subpath?: string): HostPluginArchiveFile[] {
	let tar: Buffer;
	try {
		tar = gunzipSync(tarball, { maxOutputLength: MAX_EXPANDED_BYTES });
	} catch {
		throw new Error("archive-invalid");
	}
	return selectGitHubPackage(readTarFiles(tar), subpath);
}

async function readBoundedBody(response: GitHubResponse, limit: number): Promise<Buffer> {
	const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
	if (Number.isSafeInteger(declared) && declared > limit) throw new Error("archive-too-large");
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
			throw new Error("archive-too-large");
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks);
}

const defaultFetch: GitHubFetch = async (input, init) => {
	// 动态取 electron：测试注入 fetch 时不加载网络栈，也不让本模块在纯 Node 环境 import 时报错。
	const { net } = await import("electron");
	return net.fetch(input, init);
};

/** 未指定分支时问一次仓库元数据拿默认分支；被限流或失败就退回 main/master 两个常见默认值。 */
async function defaultBranch(fetchImpl: GitHubFetch, owner: string, repo: string): Promise<string | undefined> {
	try {
		const response = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}`, {
			headers: { accept: "application/vnd.github+json", "user-agent": "PiDeck" },
			signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
		});
		if (!response.ok) return undefined;
		const body = (await readBoundedBody(response, 1024 * 1024)).toString("utf8");
		const parsed: unknown = JSON.parse(body);
		const branch = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>).default_branch : undefined;
		return typeof branch === "string" && branch.length > 0 && branch.length <= 200 ? branch : undefined;
	} catch {
		return undefined;
	}
}

async function downloadTarball(fetchImpl: GitHubFetch, owner: string, repo: string, ref: string): Promise<Buffer | null> {
	const url = `https://codeload.github.com/${owner}/${repo}/tar.gz/${ref.split("/").map(encodeURIComponent).join("/")}`;
	const response = await fetchImpl(url, { headers: { "user-agent": "PiDeck" }, signal: AbortSignal.timeout(TARBALL_TIMEOUT_MS) });
	// 404 = 分支或仓库不存在：交给上层试下一个候选（不读 body，避免为错误页分配缓冲）。
	if (response.status === 404) return null;
	if (!response.ok) throw new Error("download-failed");
	return readBoundedBody(response, MAX_DOWNLOAD_BYTES);
}

/** 显式 ref 可能带斜杠：从最长到最短逐个当 ref 试，剩下的部分当子目录（`tree/feature/x/plugins/a`）。 */
function refCandidates(ref: string): Array<{ ref: string; subpath?: string }> {
	const parts = ref.split("/").filter(Boolean);
	const candidates: Array<{ ref: string; subpath?: string }> = [];
	for (let index = parts.length; index >= 1; index -= 1) {
		const candidateRef = parts.slice(0, index).join("/");
		const candidatePath = parts.slice(index).join("/");
		if (!PATH_PATTERN.test(candidateRef) || (candidatePath && !PATH_PATTERN.test(candidatePath))) continue;
		candidates.push(candidatePath ? { ref: candidateRef, subpath: candidatePath } : { ref: candidateRef });
	}
	if (candidates.length === 0) throw new Error("invalid-github-url");
	return candidates;
}

export async function downloadGitHubPlugin(rawUrl: string, options: { fetchImpl?: GitHubFetch } = {}): Promise<DownloadedGitHubPlugin> {
	const source = parseGitHubPluginUrl(rawUrl);
	const fetchImpl = options.fetchImpl ?? defaultFetch;
	const candidates = source.ref ? refCandidates(source.ref) : [];
	if (candidates.length === 0) {
		// 未指定分支：先用仓库元数据里的默认分支，拿不到（限流/离线）再退回 main/master。
		const branch = await defaultBranch(fetchImpl, source.owner, source.repo);
		if (branch) candidates.push({ ref: branch });
		else candidates.push({ ref: "main" }, { ref: "master" });
	}
	for (const candidate of candidates) {
		const tarball = await downloadTarball(fetchImpl, source.owner, source.repo, candidate.ref);
		if (!tarball) continue;
		const files = extractGitHubPackage(tarball, candidate.subpath);
		return { files, owner: source.owner, repo: source.repo, ref: candidate.ref, ...(candidate.subpath ? { subpath: candidate.subpath } : {}) };
	}
	throw new Error("plugin-not-found");
}
