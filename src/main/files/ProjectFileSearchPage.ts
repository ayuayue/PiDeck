import type { FileSearchResult } from "../../shared/types";
import type { ProjectFileSearchPage } from "../../shared/types/projectFiles";
import type { RemoteProjectSearchEntry } from "../../shared/types/remoteHost";

/**
 * 文件名搜索的公共投影（位置分派收口第一片）。
 *
 * 两端返回同一个形状，位置差异只体现在调用哪条读实现：
 * - 远端：`kind:"other"`（不可预览的二进制/特殊文件）**只留在 `entries`**，不伪装成 `type:"file"`；
 *   `truncated/scanned` 原样带出（界面据此说“结果已截断”，而不是把一屏结果当完整答案）。
 * - 本机：只有结果列表；**不填** `truncated:false`/`scanned:0` 冒充“完整/扫过零个”。
 */
export function projectFileSearchPageFromRemote(projectId: string, value: { entries: RemoteProjectSearchEntry[]; scanned: number; truncated: boolean }): ProjectFileSearchPage {
	return {
		results: value.entries.flatMap((entry) => (entry.kind === "other" ? [] : [{ name: entry.name, path: entry.path, relativePath: entry.path, displayPath: entry.path, target: { projectId, relativePath: entry.path }, type: entry.kind === "directory" ? "directory" : "file" }])),
		truncated: value.truncated,
		scanned: value.scanned,
		entries: value.entries,
	};
}

export function projectFileSearchPageFromLocal(results: FileSearchResult[]): ProjectFileSearchPage {
	return { results };
}
