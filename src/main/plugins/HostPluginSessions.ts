/** Session data port: catalog identity is resolved here; plugins never choose filesystem paths. */
import { stat } from "node:fs/promises";
import type { HostPluginContext, HostPluginEntriesPage, HostPluginEntryCursor, HostPluginSessionPage } from "../../shared/types/hostPlugin";
import type { SessionCatalog, SessionCatalogEntry } from "../sessions/SessionCatalog";
import { SessionHistoryReader, type PluginHistoryGuard } from "../pi/SessionHistoryReader";
import { toWindowsHostPath } from "../wsl/WslPaths";
import type { SessionHistoryReaderDeps } from "../pi/SessionHistoryReader";

export class HostPluginSessions {
	private readonly reader: SessionHistoryReader;
	constructor(private readonly catalog: Pick<SessionCatalog, "listEntries" | "get">) {
		// The plugin path never calls AgentManager or activates a pi runtime.
		const deps: SessionHistoryReaderDeps = {
			toHostPath: (path) => path,
			convertMessages: () => [],
			trimMessages: (messages) => messages,
			translate: (key) => key,
		};
		this.reader = new SessionHistoryReader(deps);
	}

	private path(entry: SessionCatalogEntry): string | undefined {
		if (!entry.filePath || entry.noSession || entry.backend === "dsh") return undefined;
		if (process.platform === "win32" && entry.environment === "wsl") {
			if (!entry.wslDistro) return undefined;
			return toWindowsHostPath(entry.filePath, { distro: entry.wslDistro });
		}
		return entry.filePath;
	}

	/** A missing project grants no workspace-wide browsing by default. */
	list(context: HostPluginContext, offset = 0): HostPluginSessionPage {
		if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100_000) throw new Error("invalid-offset");
		if (!context.projectId) return { sessions: [], nextOffset: null };
		const entries = this.catalog
			.listEntries()
			.filter((entry) => entry.projectId === context.projectId && !entry.noSession && !entry.supersededBy)
			.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
		const sessions = entries.slice(offset, offset + 100).map((entry) => ({ id: entry.id, projectId: entry.projectId, title: entry.title, updatedAt: entry.updatedAt, createdAt: entry.createdAt, model: entry.model?.modelId, readable: Boolean(this.path(entry)) }));
		return { sessions, nextOffset: offset + 100 < entries.length ? offset + 100 : null };
	}

	/** 单次插件读取的硬预算：含 fork 祖先链全部文件；超限拒绝而不是拖垮主进程。 */
	private static readonly HISTORY_BUDGET = { maxScanBytes: 64 * 1024 * 1024, maxEntries: 100_000, maxSummaryChars: 2000 };

	/**
	 * fork 祖先授权：祖先 hostPath 必须能解析回同一项目的会话文件。
	 * 跨项目 fork（祖先生成其他项目的路径）在这里被拒绝，读者降级单文件读，
	 * 绝不把其他项目的消息合并进本项目的插件响应。
	 */
	private authorizeAncestor(projectId: string, hostPath: string): boolean {
		return this.catalog
			.listEntries()
			.some((entry) => entry.projectId === projectId && !entry.noSession && this.path(entry) === hostPath);
	}

	async entries(context: HostPluginContext, id: string, cursor?: HostPluginEntryCursor): Promise<HostPluginEntriesPage> {
		const entry = this.catalog.get(id);
		if (!entry || !context.projectId || entry.projectId !== context.projectId) throw new Error("session-not-authorized");
		const path = this.path(entry);
		if (!path) throw new Error("history-unavailable");
		const guard: PluginHistoryGuard = {
			...HostPluginSessions.HISTORY_BUDGET,
			authorizeSource: (hostPath) => this.authorizeAncestor(context.projectId!, hostPath),
			remaining: { bytes: 0, entries: 0 },
		};
		return this.reader.readPluginEntries(path, cursor, guard);
	}

	/** Bounded watcher signatures detect offline edits without maintaining per-plugin file watchers. */
	async revision(context: HostPluginContext): Promise<string> {
		const entries = this.catalog.listEntries().filter((entry) => entry.projectId === context.projectId && !entry.noSession);
		const signature: unknown[] = entries.map((entry) => [entry.id, entry.updatedAt, entry.title, entry.filePath]);
		const active = context.sessionId ? this.catalog.get(context.sessionId) : undefined;
		const path = active && active.projectId === context.projectId ? this.path(active) : undefined;
		if (path) {
			try {
				const info = await stat(path);
				signature.push([info.size, info.mtimeMs]);
			} catch {
				signature.push("unavailable");
			}
		}
		return JSON.stringify(signature);
	}
}
