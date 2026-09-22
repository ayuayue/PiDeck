/**
 * AtomGit 仓库文件读取（OpenAPI contents）—— 应用内所有「从仓库取某个文件」的通道共用。
 *
 * 为什么不走匿名 raw 直链：`atomgit.com/<owner>/<repo>/raw/<ref>/<path>` 已被 GitCode
 * 前端应用接管，程序化请求拿到的是 SPA HTML 壳（+ 易盾验证码 SDK），JSON/YAML 解析必然
 * 失败；GitHub 那边才可以用 raw 直连。官方开放接口
 * `GET {ATOMGIT_API_HOST}/api/v5/repos/:owner/:repo/contents/:path?ref=<ref>`
 * 返回 JSON（`content` 为 base64），匿名可读公开仓库，大文件也内联返回
 * （实测模型目录 605KB → 808KB base64 一次取回，内容 sha256 与本地一致）。
 *
 * 两种消费者要的形态不同，所以两个解码器都放在这里，避免各文件各写一份后漂移：
 * - 内置扩展 / 内置内容热更新按**字节**算 sha256，必须取 Buffer（经 utf8 往返会在个别
 *   字符上抖动），用 `decodeAtomGitContentsBuffer`；
 * - changelog / 模型目录是纯文本，用 `decodeAtomGitContentsResponse`（形态异常抛错，
 *   由调用方的逐源 try/catch 吞掉并换下一个源）。
 */

import { ATOMGIT_API_HOST, UPDATE_REPO, UPDATE_REPO_OWNER } from "../../shared/updateSources";
import type { UpdateSourceId } from "../../shared/types/settings";

/** 源候选条目：`id` 供日志/兜底判断，`url` 直接交给 fetch。 */
export type RepoFileSourceEntry = { id: "atomgit" | "github"; url: string };

/**
 * AtomGit contents API URL：路径按段编码（保留 `/`），分支进 query 一并编码。
 * 与 GitHub raw 的路径写法保持一致，避免文件名带 `#`/空格时拼出坏 URL。
 */
export function atomGitContentsApiUrl(filePath: string, ref: string): string {
	const repoPath = `${UPDATE_REPO_OWNER}/${UPDATE_REPO}`;
	const encoded = filePath
		.split("/")
		.map((part) => encodeURIComponent(part))
		.join("/");
	return `${ATOMGIT_API_HOST}/api/v5/repos/${repoPath}/contents/${encoded}?ref=${encodeURIComponent(ref)}`;
}

/**
 * GitHub raw 直链（官方源优先时的首选，也是 AtomGit 失败后的兜底）。
 */
export function gitHubRawFileUrl(filePath: string, ref: string): string {
	return `https://raw.githubusercontent.com/${UPDATE_REPO_OWNER}/${UPDATE_REPO}/${ref}/${filePath}`;
}

/**
 * 按用户的更新源偏好给出候选源顺序：显式选 GitHub 时 raw 直连优先（官方源用户通常
 * 网络可达），否则 AtomGit OpenAPI 优先（国内直连更稳）。
 *
 * 两个源都保留：任一源失败只影响本次尝试，由调用方依次换下一个。源顺序只决定快慢，
 * 不决定能否成功——所以任意源配置下远端更新都可用。
 */
export function repoFileSourceEntries(relPath: string, ref: string, source: UpdateSourceId): RepoFileSourceEntry[] {
	const atomgit: RepoFileSourceEntry = { id: "atomgit", url: atomGitContentsApiUrl(relPath, ref) };
	const github: RepoFileSourceEntry = { id: "github", url: gitHubRawFileUrl(relPath, ref) };
	return source === "github" ? [github, atomgit] : [atomgit, github];
}

/** contents 响应里我们认识的字段。 */
type AtomGitContentsPayload = { type?: unknown; encoding?: unknown; content?: unknown };

/** 解析响应 JSON 并校验形态；不认识返回 null（含 AtomGit 返回未知字段/结构变化）。 */
function parseAtomGitContentsPayload(body: string): { content: string; encoding: string | null } | null {
	let payload: unknown;
	try {
		payload = JSON.parse(body);
	} catch {
		// 拿到 HTML（SPA 壳 / 网关错误页）在这里就失败，调用方换下一个源
		return null;
	}
	if (!isRecord(payload)) return null;
	const record = payload as AtomGitContentsPayload;
	if (record.type !== "file" || typeof record.content !== "string") return null;
	return { content: record.content, encoding: typeof record.encoding === "string" ? record.encoding : null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 取原始字节（热更新按字节算 sha256 用）。
 * 形态不认识返回 null 而不是抛错：调用方要在多个源之间兜底，不该被解析细节打断。
 */
export function decodeAtomGitContentsBuffer(body: string): Buffer | null {
	const parsed = parseAtomGitContentsPayload(body);
	if (!parsed) return null;
	if (parsed.encoding === "base64") return Buffer.from(parsed.content, "base64");
	// 文档只描述 base64；其他 encoding 不认识的形态交调用方的内容校验把关
	return Buffer.from(parsed.content, "utf8");
}

/**
 * 取 UTF-8 原文（changelog / 模型目录这类纯文本用）。
 *
 * base64 解码后即 UTF-8 原文（`Buffer.from` 忽略 base64 序列里的换行，无需预处理）。
 * 任何形态异常都抛错，由调用方的逐源 try/catch 吞掉并尝试下一源。
 */
export function decodeAtomGitContentsResponse(body: string): string {
	let payload: unknown;
	try {
		payload = JSON.parse(body);
	} catch {
		throw new Error("atomgit contents response is not valid JSON");
	}
	if (!isRecord(payload)) throw new Error("atomgit contents response has an unexpected shape");
	const record = payload as AtomGitContentsPayload;
	if (record.type !== "file" || typeof record.content !== "string") {
		throw new Error("atomgit contents response has an unexpected shape");
	}
	if (record.encoding === "base64") {
		return Buffer.from(record.content, "base64").toString("utf8");
	}
	// 文档只描述 base64；非 base64 encoding 的形态不认识，交原文给调用方校验
	return record.content;
}
