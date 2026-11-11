import type { SessionCatalog } from "./SessionCatalog";
import { isRemoteProject } from "../../shared/projectLocation";
import type { ProjectStore } from "../projects/ProjectStore";
import type { SessionHistoryReader } from "../pi/SessionHistoryReader";
import { toWindowsHostPath, toWslLinuxPath } from "../wsl/WslPaths";
import type { ChatMessage } from "../../shared/types/session";
import type { SessionShareOptions } from "../../shared/types/sessionExport";
import type { SessionShareSource } from "./sessionShareExport";
import { collectPiSessionShareMessages } from "../pi/piSessionShareMessages";

type Ports = {
	catalog: Pick<SessionCatalog, "get" | "getLocator" | "getLocalFilePath">;
	projects: Pick<ProjectStore, "get">;
	pi: Pick<SessionHistoryReader, "readSessionDisplayTurnPage">;
	dsh: { readSessionExportMessages: (sessionId: string, options: { includeImages: boolean }) => Promise<{ messages: ChatMessage[]; truncated: boolean }> };
};

/** 安全分享来源由 main 按目录身份解析，不接受 renderer 的路径；远端/ACP 显式不支持。 */
export function createSessionShareSourceLoader(ports: Ports): (sessionId: string, options: SessionShareOptions) => Promise<SessionShareSource> {
	return async (sessionId, options) => {
		const entry = ports.catalog.get(sessionId);
		if (!entry || ports.catalog.getLocator(sessionId)?.kind === "ssh" || (entry.backend && entry.backend !== "pi" && entry.backend !== "dsh")) throw new Error("SESSION_SHARE_UNSUPPORTED");
		const project = ports.projects.get(entry.projectId);
		if (project && isRemoteProject(project)) throw new Error("SESSION_SHARE_UNSUPPORTED");
		const cwd = project?.path && entry.environment === "wsl" && entry.wslDistro ? toWslLinuxPath(project.path, { distro: entry.wslDistro }) : project?.path;
		if (entry.backend === "dsh") {
			if (!entry.dshSessionId) throw new Error("SESSION_SHARE_READ_FAILED");
			const collection = await ports.dsh.readSessionExportMessages(entry.dshSessionId, { includeImages: !options.excludeImages });
			return { ...collection, backend: "dsh", title: entry.title, cwd };
		}
		const path = ports.catalog.getLocalFilePath(sessionId);
		if (!path) throw new Error("SESSION_SHARE_READ_FAILED");
		const hostPath = entry.environment === "wsl" && entry.wslDistro ? toWindowsHostPath(path, { distro: entry.wslDistro }) : path;
		const collection = await collectPiSessionShareMessages({ readPage: (before) => ports.pi.readSessionDisplayTurnPage(hostPath, "_share", before, 20) });
		return { ...collection, backend: "pi", title: entry.title, cwd };
	};
}
