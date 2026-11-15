import { setTimeout, clearTimeout } from "node:timers";
import { compareVersions } from "../utils/versionCompare";

/** 只识别 GitHub 仓库源；其它 Git 主机与 URL 保持原有行为，不猜版本接口。 */
export function parseGitHubRepositorySource(source: string): { owner: string; repo: string; name: string } | null {
	const match = source.match(/^(?:git:github\.com\/|github:|git:https:\/\/github\.com\/|https:\/\/github\.com\/)([^/]+)\/([^/#@]+?)(?:[/@].+)?$/i);
	if (!match) return null;
	return { owner: match[1], repo: match[2].replace(/\.git$/i, ""), name: match[2].replace(/\.git$/i, "") };
}

export type GitHubVersionOptions = { fetchImpl?: typeof fetch; timeoutMs?: number };

/** 查最新正式 Release；无 Release 时取语义化版本标签的最高版本。 */
export async function resolveGitHubLatestVersion(repository: { owner: string; repo: string }, options: GitHubVersionOptions = {}): Promise<string | null> {
	const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
	try {
		const base = `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`;
		const headers = { Accept: "application/vnd.github+json", "User-Agent": "PiDeck-extension-version-check" };
		const release: { ok: boolean; status: number; json(): Promise<unknown> } = await fetchImpl(`${base}/releases/latest`, { headers, signal: controller.signal });
		if (release.ok) {
			const body = (await release.json()) as { tag_name?: unknown };
			if (typeof body.tag_name !== "string" || !body.tag_name.trim()) throw new Error("GitHub release has no tag_name");
			return body.tag_name.replace(/^v/i, "");
		}
		if (release.status !== 404) throw new Error(`GitHub release check failed: ${release.status}`);
		const tags = await fetchImpl(`${base}/tags?per_page=100`, { headers, signal: controller.signal });
		if (!tags.ok) throw new Error(`GitHub tag check failed: ${tags.status}`);
		const body = (await tags.json()) as Array<{ name?: unknown }>;
		if (!Array.isArray(body)) throw new Error("GitHub tags response is not an array");
		const versions = body.flatMap((tag) => (typeof tag.name === "string" && /^\d+\.\d+\.\d+(?:[-+].*)?$/.test(tag.name.replace(/^v/i, "")) ? [tag.name.replace(/^v/i, "")] : []));
		versions.sort(compareVersions);
		return versions.at(-1) ?? null;
	} finally {
		clearTimeout(timer);
	}
}
