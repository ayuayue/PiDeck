import type { IncomingMessage, ServerResponse } from "node:http";
import type { PiPromptTemplateSummary, Project } from "../../shared/types";
import type { PromptManager } from "../prompts/PromptManager";
import { sendError, sendJson } from "./WebHttpResponders";

export type WebPromptTemplateReader = Pick<PromptManager, "list" | "listByProject" | "readTemplateContent">;

type WebPromptTemplateRoutesDeps = {
	listProjects: () => Project[];
	promptTemplates?: WebPromptTemplateReader;
};

function decodeTemplateName(encoded: string): string | null {
	try {
		const name = decodeURIComponent(encoded);
		return name && !name.includes("/") && !name.includes("\\") && !name.includes("\0") ? name : null;
	} catch {
		return null;
	}
}

/** pi 文件模板的只读 API；与 /api/prompts 的云端提示词库保持独立。 */
export class WebPromptTemplateRoutes {
	constructor(private readonly deps: WebPromptTemplateRoutesDeps) {}

	async handle(url: URL, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		if (request.method !== "GET") return false;
		const isList = url.pathname === "/api/prompt-templates";
		const detailMatch = url.pathname.match(/^\/api\/prompt-templates\/([^/]+)$/);
		if (!isList && !detailMatch) return false;
		const name = detailMatch ? decodeTemplateName(detailMatch[1]) : undefined;
		if (name === null) {
			sendError(response, 400, "webError.invalidRequest", "invalid template name");
			return true;
		}

		try {
			const reader = this.deps.promptTemplates;
			if (!reader) {
				sendError(response, 503, "webError.promptTemplatesUnavailable", "prompt templates are not available");
				return true;
			}
			const projectId = url.searchParams.get("projectId")?.trim();
			const projectPath = projectId ? this.deps.listProjects().find((entry) => entry.id === projectId)?.path : undefined;
			if (projectId && !projectPath) {
				sendError(response, 404, "webError.projectNotFound", "project not found");
				return true;
			}
			const globalList = await reader.list();
			const projectList = projectPath ? await reader.listByProject(projectPath, projectId) : undefined;
			const templates = new Map<string, PiPromptTemplateSummary>();
			// 名称是详情路由的键：项目同名模板覆盖全局模板，使列表与详情指向同一份内容。
			for (const template of [...globalList.templates, ...(projectList?.templates ?? [])]) templates.set(template.name, template);

			if (name === undefined) {
				const search = (url.searchParams.get("search") ?? "").trim().toLowerCase();
				sendJson(response, {
					templates: [...templates.values()]
						.filter((template) => !search || template.name.toLowerCase().includes(search) || template.description.toLowerCase().includes(search))
						.sort((left, right) => left.name.localeCompare(right.name))
						.map((template) => ({ name: template.name, description: template.description, scope: template.scope ?? "global", enabled: template.enabled ?? true })),
					globalDir: globalList.globalDir,
					projectDir: projectList?.globalDir,
				});
				return true;
			}

			const template = templates.get(name);
			if (!template) {
				sendError(response, 404, "webError.promptNotFound", "prompt template not found");
				return true;
			}
			let result: Awaited<ReturnType<WebPromptTemplateReader["readTemplateContent"]>>;
			try {
				result = await reader.readTemplateContent(template.path, template.scope === "project" ? projectPath : undefined);
			} catch {
				sendError(response, 404, "webError.promptNotFound", "prompt template not found");
				return true;
			}
			if ("tooLarge" in result) {
				sendError(response, 413, "webError.fileTooLarge", "prompt template is too large");
				return true;
			}
			sendJson(response, { detail: { name: template.name, description: template.description, content: result.content, scope: template.scope ?? "global" } });
		} catch {
			sendError(response, 500, "webError.internalError", "failed to read prompt templates");
		}
		return true;
	}
}
