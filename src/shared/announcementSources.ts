/**
 * 公告源 URL 清单（无服务器拉取模式）—— 主进程与单测共用，禁止 import 运行时层。
 *
 * 源顺序即 fallback 顺序（2026-09 用户决策：走 AtomGit 与 GitHub 官方两渠道）：
 * 1. AtomGit contents API：国内直连、实时回源（改完 commit 立即生效），匿名可读；
 *    响应是 v5 API 的 base64 包裹（{ encoding: "base64", content: ... }），
 *    需经 unwrapAtomgitContents 解包后再做 feed 解析；
 * 2. raw.githubusercontent.com 直连：源站权威，海外/代理环境兜底（国内直连基本不可用）。
 *
 * 弃用历史：jsDelivr（cdn.jsdelivr.net）曾是主源，但其 CDN 缓存最长 24h 且
 * 「成功返回旧快照」不会被感知——新公告会被静默推迟最长一天，手动刷新也绕不过，
 * 故整体移除，不再作 fallback 候选。
 */

import { UPDATE_REPO, UPDATE_REPO_OWNER } from "./updateSources";

/** 公告源文件名（仓库根目录）。 */
export const ANNOUNCEMENT_FILE_NAME = "announcements.json";

/** 公告源分支：main（公告只随主干发布，dev 不承载公告）。 */
export const ANNOUNCEMENT_BRANCH = "main";

/** AtomGit contents API URL（首选源；v5 返回 base64 包裹，需 unwrapAtomgitContents 解包）。 */
export const ANNOUNCEMENT_ATOMGIT_URL = `https://api.atomgit.com/api/v5/repos/${UPDATE_REPO_OWNER}/${UPDATE_REPO}/contents/${ANNOUNCEMENT_FILE_NAME}?ref=${ANNOUNCEMENT_BRANCH}`;

/** raw.githubusercontent 直连 URL（兜底源；源站权威但国内直连基本不可达）。 */
export const ANNOUNCEMENT_RAW_URL = `https://raw.githubusercontent.com/${UPDATE_REPO_OWNER}/${UPDATE_REPO}/${ANNOUNCEMENT_BRANCH}/${ANNOUNCEMENT_FILE_NAME}`;

/** 源响应格式：atomgit-contents = v5 contents 包裹；plain = 文件原文。 */
export type AnnouncementSourceKind = "atomgit-contents" | "plain";

/** 公告源描述：URL + 响应格式，拉取侧按 kind 决定是否解包。 */
export interface AnnouncementSource {
	url: string;
	kind: AnnouncementSourceKind;
}

/**
 * 完整源列表（按序尝试，任一成功即止）。
 * AtomGit 失败（网络不可达/结构异常）自动落到 GitHub raw。
 */
export const ANNOUNCEMENT_SOURCES: readonly AnnouncementSource[] = [
	{ url: ANNOUNCEMENT_ATOMGIT_URL, kind: "atomgit-contents" },
	{ url: ANNOUNCEMENT_RAW_URL, kind: "plain" },
];

/**
 * 解包 AtomGit v5 contents 响应：{ encoding: "base64", content: <base64> } → 文件原文。
 * 结构不符 / 编码异常返回 null，调用方作为「该源不可用」fallback 到下一源——
 * 防止代理劫持返回纯 JSON 或 API 行为变化时把包裹当 feed 解析。
 */
export function unwrapAtomgitContents(text: string): string | null {
	try {
		const parsed: unknown = JSON.parse(text);
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			!("encoding" in parsed) ||
			!("content" in parsed)
		) {
			return null;
		}
		const { encoding, content } = parsed as { encoding: unknown; content: unknown };
		if (encoding !== "base64" || typeof content !== "string") return null;
		// base64 文本可能含换行（v5 API JSON 转义），Buffer.from 会忽略空白字符
		return Buffer.from(content, "base64").toString("utf8");
	} catch {
		return null;
	}
}