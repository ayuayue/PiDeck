import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { SessionCatalog } from "./SessionCatalog";
import type { ProjectStore } from "../projects/ProjectStore";
import type { AgentManager } from "../pi/AgentManager";
import type { DshAgentManager } from "../dsh/DshAgentManager";
import { renderDshSessionHtml, sanitizeExportFileName } from "../dsh/dshSessionHtmlExport";

type Ports = {
	catalog: Pick<SessionCatalog, "get" | "getLocalFilePath">;
	projects: Pick<ProjectStore, "get">;
	pi: Pick<AgentManager, "exportSessionHtml" | "readSessionLoadWindow">;
	dsh: Pick<DshAgentManager, "exportSessionHtml">;
	exportDir: () => string;
	copy: (key: "session.fileNotFound" | "session.exportFailed") => string;
};

/** 原完整导出保持官方 pi RPC 所有权；仅提取装配层既有逻辑，不套用安全分享策略。 */
export async function exportCatalogSessionHtmlWithPorts(ports: Ports, sessionId: string): Promise<{ path: string; truncated?: boolean }> {
	const entry = ports.catalog.get(sessionId);
	if (entry?.backend === "dsh") {
		if (!entry.dshSessionId) throw new Error(ports.copy("session.fileNotFound"));
		return ports.dsh.exportSessionHtml(entry.dshSessionId, entry.title, ports.projects.get(entry.projectId)?.path);
	}
	const filePath = ports.catalog.getLocalFilePath(sessionId);
	if (!entry || !filePath) throw new Error(ports.copy("session.fileNotFound"));
	const result = await ports.pi.exportSessionHtml(entry.projectId, filePath);
	if (!result || typeof result !== "object" || !("path" in result) || typeof result.path !== "string") throw new Error(ports.copy("session.exportFailed"));
	// pi 可能返回相对项目 cwd 的文件名；消费端不得相对 exe 目录解释。
	const projectRoot = ports.projects.get(entry.projectId)?.path ?? "";
	const absolutePath = isAbsolute(result.path) ? result.path : join(projectRoot, result.path);
	if (existsSync(absolutePath)) return { path: absolutePath };
	// 保持旧版 pi 临时会话未落盘时的投影回退，不将它标为已安全处理。
	const loadWindow = await ports.pi.readSessionLoadWindow(filePath, sessionId, { projectId: entry.projectId });
	const html = renderDshSessionHtml(loadWindow.messages, { title: entry.title, cwd: projectRoot, exportedAt: Date.now() });
	const dir = ports.exportDir();
	await mkdir(dir, { recursive: true });
	const outPath = join(dir, sanitizeExportFileName(entry.title || sessionId, sessionId));
	await writeFile(outPath, html, "utf8");
	return { path: outPath };
}
