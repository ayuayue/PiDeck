/**
 * Web 工作区只读路由（P1-P3 增强扩展）：
 * - GET /api/git/status|diff|log —— Git 抽屉数据（只读，写操作仍回桌面端）
 * - GET /api/files、GET /api/file-content —— 文件抽屉（项目内文件沙箱限制在项目根内 + 有界读取）
 *   与项目外文件预览（绝对路径 / `~/x` 按安全等级求值后只读读取，见 fileContent）
 * - GET /api/prompts、GET /api/prompts/:slug —— 中文提示词精选（XuePromptManager）
 *
 * 独立模块承载（WebServiceManager 已超 1600 行），经 WebServiceManager.handleRequest
 * 在 /api/* 404 兜底前分发；所有路由只读，不引入新的写通道。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { open, readFile, stat } from "node:fs/promises";
import type { CommitEntry, FileTreeNode, GitBranchInfo, PiExtensionListResult, PiExtensionSummary, PiSkillListResult, PiSkillSummary, Project, YaoPromptDetailResult, YaoPromptListResult } from "../../shared/types";
// GitService 是本地实现：它返回的是「文件系统绑定」形状（绝对路径，没有渲染层的 ProjectFileTarget），
// 由 gitIpc 在 IPC 边界装饰成 shared 的 GitResource/Target。Web 路由同样直接吃本地形状——
// 这里不能声明成 GitResourceGroups，否则类型在说谎（运行时根本没有 target/displayPath）。
import type { LocalGitResourceGroups, LocalGitWorkspaceFileDiff } from "../git/localGitTypes";
import { assertProjectFileReadPath, FILE_OUTSIDE_PROJECT_ERROR } from "../files/projectFileAccess";
import { isPathInsideProject } from "../fs/FileSystemService";
import type { UserReadAccessVerdict } from "../security/policy";
import { WEB_CORS_HEADERS } from "./WebHttpResponders";

export type WebWorkspaceRoutesDeps = {
	/** projectId → 项目根解析（沿用 WebServiceManager 同源数据，避免第二套项目表）。 */
	listProjects: () => Project[];
	/** Git 只读能力（GitService 注入；缺省时 git 路由返回 503）。 */
	git?: {
		isGitRepo: (cwd: string) => Promise<boolean>;
		getBranches: (cwd: string) => Promise<GitBranchInfo>;
		getStatus: (cwd: string) => Promise<LocalGitResourceGroups>;
		getWorkspaceFileDiff: (cwd: string, group: "merge" | "index" | "workingTree" | "untracked", filePath: string, maxBytes: number) => Promise<LocalGitWorkspaceFileDiff | null>;
		getCommitLog: (cwd: string, options?: { maxEntries?: number }) => Promise<CommitEntry[]>;
	};
	/** 文件树能力（FileSystemService 注入；缺省时 files 路由返回 503）。 */
	files?: {
		listTree: (root: string, maxDepth?: number, directory?: string) => Promise<FileTreeNode[]>;
	};
	/** 提示词库（XuePromptManager 注入；缺省时 prompts 路由返回 503）。 */
	prompts?: {
		list: (opts?: { category?: string; search?: string; page?: number; pageSize?: number }) => Promise<YaoPromptListResult>;
		detail: (slug: string, category: string) => Promise<YaoPromptDetailResult | null>;
	};
	/** 技能/扩展资产面板（SkillManager / ExtensionManager 注入；缺省时对应路由返回 503）。 */
	assets?: {
		listSkills: () => Promise<PiSkillListResult>;
		toggleSkill: (skillPath: string, enabled: boolean) => Promise<PiSkillSummary>;
		listExtensions: () => Promise<PiExtensionListResult>;
		setExtensionEnabled: (source: string, enabled: boolean, scope: PiExtensionSummary["scope"], path?: string, projectId?: string) => Promise<void>;
	};
	/**
	 * 项目外文件预览的用户意图门（安全策略求值，主进程注入 evaluateUserReadAccess）。
	 * 未注入时按「需确认」处理：确认后仍可预览（不至于因装配漏了就整条功能不可用），
	 * 但不会静默放行项目外路径。
	 */
	userReadAccess?: (input: { filePath: string; cwd: string; projectRoot: string; sessionId?: string }) => UserReadAccessVerdict;
};

/** 文件内容读取上限：2MB 以内完整返回（Web 端轻量预览的边界）。 */
const MAX_FILE_CONTENT_BYTES = 2 * 1024 * 1024;
/** 超过上限时不再空手而归：有界读前 512KB 给截断预览（移动端定位问题够用，也避免大文件整读的内存峰值）。 */
const TRUNCATED_PREVIEW_BYTES = 512 * 1024;
/** 单次 diff 上限：1MB（原 256KB 对合并冲突/大重构文件偏紧，超限时 GitService 返回 null 会让用户深以为文件丢了）。 */
const MAX_DIFF_BYTES = 1024 * 1024;
/** 提示词列表单页上限。 */
const MAX_PROMPT_PAGE_SIZE = 50;
/**
 * 二进制扩展名黑名单：命中直接按二进制拒绝（不看内容，快速且准确）。
 * 白名单外其余类型（含无扩展名的 Makefile/Dockerfile/LICENSE 与生僻文本格式如 .gradle/.cmake）
 * 改走 NUL 字节启发判定——常见二进制格式（图片/音视频/压缩包）内容里基本都含 NUL，双保险。
 */
const BINARY_EXTENSION_DENYLIST = new Set([
	// 图片
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
	".bmp",
	".ico",
	".tif",
	".tiff",
	".avif",
	".heic",
	// 音频
	".mp3",
	".wav",
	".flac",
	".aac",
	".ogg",
	".m4a",
	".wma",
	// 视频
	".mp4",
	".mkv",
	".avi",
	".mov",
	".webm",
	".flv",
	".wmv",
	".m4v",
	// 压缩包/磁盘镜像
	".zip",
	".rar",
	".7z",
	".tar",
	".gz",
	".bz2",
	".xz",
	".zst",
	".br",
	".iso",
	".img",
	".dmg",
	// 可执行/库/字节码
	".exe",
	".dll",
	".so",
	".dylib",
	".bin",
	".msi",
	".deb",
	".rpm",
	".apk",
	".ipa",
	".jar",
	".war",
	".class",
	".wasm",
	".node",
	".pyc",
	".pyo",
	".o",
	".a",
	".lib",
	// 文档/字体/数据库
	".pdf",
	".doc",
	".docx",
	".xls",
	".xlsx",
	".ppt",
	".pptx",
	".odt",
	".ttf",
	".otf",
	".woff",
	".woff2",
	".eot",
	".sqlite",
	".db",
]);

function sendJson(response: ServerResponse, status: number, body: unknown) {
	const payload = JSON.stringify(body);
	// workspace 路由自己写头，容易和主路由的 CORS 约定脱节：漏了 Access-Control-Allow-Origin
	// 时预检照过、200 照回，浏览器却把响应整包丢掉（Failed to fetch，issue #435）。
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		...WEB_CORS_HEADERS,
	});
	response.end(payload);
}

function sendError(response: ServerResponse, status: number, code: string, message: string, details?: Record<string, unknown>) {
	sendJson(response, status, { code, message, ...details });
}

/** `~/x` / `~\\x` 按当前用户家目录展开（消息里的配置/临时文件路径大多写成 ~ 形式）。 */
function expandHomePath(path: string): string {
	if (!path.startsWith("~")) return path;
	const rest = path.slice(1);
	if (!rest.startsWith("/") && !rest.startsWith("\\")) return path;
	return join(homedir(), rest.slice(1));
}

export class WebWorkspaceRoutes {
	constructor(private readonly deps: WebWorkspaceRoutesDeps) {}

	/** 命中已知路由并完成响应时返回 true；未命中返回 false 交给上层 404。 */
	async handle(url: URL, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		if (!url.pathname.startsWith("/api/")) return false;
		try {
			if (url.pathname === "/api/git/status") return await this.gitStatus(url, response);
			if (url.pathname === "/api/git/diff") return await this.gitDiff(url, response);
			if (url.pathname === "/api/git/log") return await this.gitLog(url, response);
			if (url.pathname === "/api/files") return await this.listFiles(url, response);
			if (url.pathname === "/api/file-content") return await this.fileContent(url, response);
			if (url.pathname === "/api/prompts") return await this.listPrompts(url, response);
			const promptDetailMatch = url.pathname.match(/^\/api\/prompts\/([^/]+)$/);
			if (promptDetailMatch) return await this.promptDetail(promptDetailMatch[1], url, response);
			if (url.pathname === "/api/skills" && request.method === "GET") return await this.listSkills(response);
			if (url.pathname === "/api/skills/toggle" && request.method === "POST") return await this.toggleSkill(request, response);
			if (url.pathname === "/api/extensions" && request.method === "GET") return await this.listExtensions(response);
			if (url.pathname === "/api/extensions/toggle" && request.method === "POST") return await this.toggleExtension(request, response);
			return false;
		} catch (error) {
			const message = typeof error === "object" && error !== null && "message" in error ? String((error as { message: unknown }).message) : "workspace route failed";
			sendError(response, 500, "webError.internal", message);
			return true;
		}
	}

	/** projectId → 项目根；未知项目返回 undefined（调用方回 404）。 */
	private projectRoot(projectId: string | null): string | undefined {
		if (!projectId) return undefined;
		return this.deps.listProjects().find((project) => project.id === projectId)?.path;
	}

	private async gitStatus(url: URL, response: ServerResponse): Promise<boolean> {
		if (!this.deps.git) {
			sendError(response, 503, "webError.gitUnavailable", "git service is not available");
			return true;
		}
		const root = this.projectRoot(url.searchParams.get("projectId"));
		if (!root) {
			sendError(response, 404, "webError.projectNotFound", "project not found");
			return true;
		}
		const repo = await this.deps.git.isGitRepo(root);
		if (!repo) {
			sendJson(response, 200, { repo: false });
			return true;
		}
		const [branch, groups] = await Promise.all([this.deps.git.getBranches(root), this.deps.git.getStatus(root)]);
		sendJson(response, 200, { repo: true, branch, groups });
		return true;
	}

	private async gitDiff(url: URL, response: ServerResponse): Promise<boolean> {
		if (!this.deps.git) {
			sendError(response, 503, "webError.gitUnavailable", "git service is not available");
			return true;
		}
		const root = this.projectRoot(url.searchParams.get("projectId"));
		if (!root) {
			sendError(response, 404, "webError.projectNotFound", "project not found");
			return true;
		}
		const group = url.searchParams.get("group");
		const filePath = url.searchParams.get("path") ?? "";
		if ((group !== "merge" && group !== "index" && group !== "workingTree" && group !== "untracked") || !filePath) {
			sendError(response, 400, "webError.invalidRequest", "group and path are required");
			return true;
		}
		// filePath 必须是仓库内相对路径，拒绝绝对路径与目录穿越
		if (filePath.startsWith("/") || filePath.includes("..")) {
			sendError(response, 400, "webError.invalidRequest", "path must be a relative path inside the repository");
			return true;
		}
		const diff = await this.deps.git.getWorkspaceFileDiff(root, group, filePath, MAX_DIFF_BYTES);
		sendJson(response, 200, { diff });
		return true;
	}

	private async gitLog(url: URL, response: ServerResponse): Promise<boolean> {
		if (!this.deps.git) {
			sendError(response, 503, "webError.gitUnavailable", "git service is not available");
			return true;
		}
		const root = this.projectRoot(url.searchParams.get("projectId"));
		if (!root) {
			sendError(response, 404, "webError.projectNotFound", "project not found");
			return true;
		}
		const limitRaw = url.searchParams.get("limit");
		// Number(null) === 0：参数缺失时必须回默认 20，否则 limit 被钳成 1
		const parsedLimit = limitRaw === null ? Number.NaN : Number(limitRaw);
		const maxEntries = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(50, Math.trunc(parsedLimit))) : 20;
		const commits = await this.deps.git.getCommitLog(root, { maxEntries });
		sendJson(response, 200, { commits });
		return true;
	}

	private async listFiles(url: URL, response: ServerResponse): Promise<boolean> {
		if (!this.deps.files) {
			sendError(response, 503, "webError.filesUnavailable", "file service is not available");
			return true;
		}
		const root = this.projectRoot(url.searchParams.get("projectId"));
		if (!root) {
			sendError(response, 404, "webError.projectNotFound", "project not found");
			return true;
		}
		// dir：项目内相对路径；空 = 根。listTree 的 directory 参数要求绝对路径。
		const dir = url.searchParams.get("dir") ?? "";
		if (dir.includes("..")) {
			sendError(response, 400, "webError.invalidRequest", "dir must be a relative path inside the project");
			return true;
		}
		// maxDepth=0：只列一层（Web 抽屉按需逐层展开），节点带 hasChildren 供展开箭头
		const nodes = await this.deps.files.listTree(root, 0, dir ? join(root, dir) : undefined);
		// FileTreeNode.path 是绝对路径 —— 对外剥离，只保留 name/relativePath/type/hasChildren
		const safeNodes = nodes.map((node) => ({
			name: node.name,
			relativePath: node.relativePath,
			type: node.type,
			hasChildren: node.hasChildren,
		}));
		sendJson(response, 200, { nodes: safeNodes });
		return true;
	}

	private async fileContent(url: URL, response: ServerResponse): Promise<boolean> {
		const root = this.projectRoot(url.searchParams.get("projectId"));
		if (!root) {
			sendError(response, 404, "webError.projectNotFound", "project not found");
			return true;
		}
		const rawTarget = url.searchParams.get("path") ?? "";
		if (!rawTarget) {
			sendError(response, 400, "webError.invalidRequest", "path is required");
			return true;
		}
		// 路径分流（Web 端不要求文件必须在项目内）：
		// - 项目内（相对路径或绝对路径）→ 原有项目根沙箱（含符号链接逃逸检查）；
		// - 项目外且是相对路径（`..` 逃逸）→ 仍 403，不把 Web 变成任意目录进目录浏览；
		// - 项目外绝对路径 / `~/x` → 安全等级求值（allow 直读 / ask 需确认 / deny 拒绝）。
		// 错误分流：越界 → 403；文件不存在（ENOENT）→ 404，不能一律笼统当 403。
		const target = expandHomePath(rawTarget);
		const absoluteTarget = isAbsolute(target) ? resolve(target) : resolve(root, target);
		let absolute: string;
		if (isPathInsideProject(root, absoluteTarget)) {
			try {
				absolute = await assertProjectFileReadPath(root, absoluteTarget);
			} catch (error) {
				// vm/跨模块场景下 instanceof Error 不可靠（错误可能来自另一个 realm），用 message 判别
				const message = typeof error === "object" && error !== null && "message" in error ? String((error as { message: unknown }).message) : "";
				if (message === FILE_OUTSIDE_PROJECT_ERROR) {
					sendError(response, 403, "webError.fileOutsideProject", "path escapes project root");
					return true;
				}
				const missing = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
				if (missing) {
					sendError(response, 404, "webError.fileNotFound", "file not found");
					return true;
				}
				throw error;
			}
		} else if (!isAbsolute(target)) {
			sendError(response, 403, "webError.fileOutsideProject", "path escapes project root");
			return true;
		} else {
			// 确认后的读仍然是同一条路由：`confirm=1` 只能把 ask 降为放行，deny 永远不降级
			const verdict = this.deps.userReadAccess?.({ filePath: absoluteTarget, cwd: root, projectRoot: root, sessionId: url.searchParams.get("sessionId") ?? undefined }) ?? { access: "ask" as const, reason: "policy-unavailable" as const };
			if (verdict.access === "deny") {
				sendError(response, 403, "webError.fileAccessDenied", "security policy denies this path", { reason: verdict.reason });
				return true;
			}
			if (verdict.access === "ask" && url.searchParams.get("confirm") !== "1") {
				sendError(response, 403, "webError.fileAccessNeedsConfirm", "confirmation required to read this path", { reason: verdict.reason });
				return true;
			}
			absolute = absoluteTarget;
		}
		const info = await stat(absolute).catch(() => null);
		if (!info?.isFile()) {
			sendError(response, 404, "webError.fileNotFound", "file not found");
			return true;
		}
		if (info.size > MAX_FILE_CONTENT_BYTES) {
			// 超限不再空手而归：从文件句柄有界读前 512KB 给截断预览（不整读大文件，防内存峰值）；
			// 截断样本里含 NUL 同样按二进制拒绝（大文件极可能是日志外的二进制类型）。
			const handle = await open(absolute, "r").catch(() => null);
			if (!handle) {
				sendJson(response, 200, { tooLarge: true, size: info.size });
				return true;
			}
			try {
				const buffer = Buffer.alloc(TRUNCATED_PREVIEW_BYTES);
				const { bytesRead } = await handle.read(buffer, 0, TRUNCATED_PREVIEW_BYTES, 0);
				const bounded = buffer.subarray(0, bytesRead);
				if (bounded.includes(0)) {
					sendJson(response, 200, { binary: true, size: info.size });
				} else {
					sendJson(response, 200, { truncated: true, content: bounded.toString("utf8"), size: info.size });
				}
			} finally {
				await handle.close();
			}
			return true;
		}
		// 二进制判定：明确二进制扩展名黑名单直接拒；其余（含无扩展名与生僻文本格式）走 NUL 字节启发，
		// 避免把 png/exe 当 UTF-8 吐给浏览器，同时不再误拒 Makefile/Dockerfile/LICENSE/.gradle 等。
		const dot = absolute.lastIndexOf(".");
		const ext = dot >= 0 ? absolute.slice(dot).toLowerCase() : "";
		const buffer = await readFile(absolute);
		if (BINARY_EXTENSION_DENYLIST.has(ext) || buffer.includes(0)) {
			sendJson(response, 200, { binary: true, size: info.size });
			return true;
		}
		sendJson(response, 200, { content: buffer.toString("utf8"), size: info.size });
		return true;
	}

	private async listPrompts(url: URL, response: ServerResponse): Promise<boolean> {
		if (!this.deps.prompts) {
			sendError(response, 503, "webError.promptsUnavailable", "prompt library is not available");
			return true;
		}
		const search = url.searchParams.get("search")?.trim() || undefined;
		const category = url.searchParams.get("category")?.trim() || undefined;
		const pageRaw = Number(url.searchParams.get("page"));
		const pageSizeRaw = Number(url.searchParams.get("pageSize"));
		const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
		const pageSize = Number.isFinite(pageSizeRaw) && pageSizeRaw > 0 ? Math.min(MAX_PROMPT_PAGE_SIZE, Math.trunc(pageSizeRaw)) : 20;
		const result = await this.deps.prompts.list({ search, category, page, pageSize });
		// YaoPromptItem.path 是宿主机绝对路径 —— 对外剥离
		sendJson(response, 200, {
			categories: result.categories,
			prompts: result.prompts.map(({ path: _path, ...rest }) => rest),
			total: result.total,
			page,
			pageSize,
		});
		return true;
	}

	private async promptDetail(slug: string, url: URL, response: ServerResponse): Promise<boolean> {
		if (!this.deps.prompts) {
			sendError(response, 503, "webError.promptsUnavailable", "prompt library is not available");
			return true;
		}
		const category = url.searchParams.get("category")?.trim() ?? "";
		if (!category) {
			sendError(response, 400, "webError.invalidRequest", "category is required");
			return true;
		}
		const detail = await this.deps.prompts.detail(decodeURIComponent(slug), category);
		if (!detail) {
			sendError(response, 404, "webError.promptNotFound", "prompt not found");
			return true;
		}
		sendJson(response, 200, { detail: { title: detail.title, description: detail.description, promptContent: detail.promptContent } });
		return true;
	}

	// ── 技能/扩展资产面板（第二批：与桌面设置页同源的列表 + 开关）──

	private async listSkills(response: ServerResponse): Promise<boolean> {
		if (!this.deps.assets) {
			sendError(response, 503, "webError.skillsUnavailable", "skill service is not available");
			return true;
		}
		// PiSkillSummary.path/dir 是宿主机绝对路径 —— 对外剥离（与 prompts 同款脱敏策略）
		const result = await this.deps.assets.listSkills();
		sendJson(response, 200, {
			locations: result.locations.map(({ path: _path, ...rest }) => rest),
			skills: result.skills.map(({ path: _path, dir: _dir, ...rest }) => rest),
		});
		return true;
	}

	private async toggleSkill(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		if (!this.deps.assets) {
			sendError(response, 503, "webError.skillsUnavailable", "skill service is not available");
			return true;
		}
		const body = await this.readJsonBody(request);
		// 前端拿不到宿主绝对路径（脱敏），用 name + sourceId 定位：
		// SkillManager 的持久化本身按 name 写 disabledSkills，path 仅用于进程内定位。
		if (typeof body.name !== "string" || !body.name || typeof body.enabled !== "boolean") {
			sendError(response, 400, "webError.invalidRequest", "name (string) and enabled (boolean) are required");
			return true;
		}
		const sourceId = body.sourceId;
		if (sourceId !== "pi-global" && sourceId !== "agents-global" && sourceId !== "pideck-global" && sourceId !== "project-pi" && sourceId !== "project-agents") {
			sendError(response, 400, "webError.invalidRequest", "sourceId must be a valid skill location id");
			return true;
		}
		const result = await this.deps.assets.listSkills();
		const target = result.skills.find((skill) => skill.name === body.name && skill.sourceId === sourceId);
		if (!target) {
			sendError(response, 404, "webError.skillNotFound", "skill not found");
			return true;
		}
		const skill = await this.deps.assets.toggleSkill(target.path, body.enabled);
		const { path: _path, dir: _dir, ...rest } = skill;
		sendJson(response, 200, { skill: rest });
		return true;
	}

	private async listExtensions(response: ServerResponse): Promise<boolean> {
		if (!this.deps.assets) {
			sendError(response, 503, "webError.extensionsUnavailable", "extension service is not available");
			return true;
		}
		const result = await this.deps.assets.listExtensions();
		// path 是宿主机绝对路径，对外剥离（与 skills/prompts 同款脱敏策略）
		sendJson(response, 200, {
			extensions: result.extensions.map(({ path: _path, ...rest }) => rest),
			conflicts: result.conflicts ?? [],
		});
		return true;
	}

	private async toggleExtension(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		if (!this.deps.assets) {
			sendError(response, 503, "webError.extensionsUnavailable", "extension service is not available");
			return true;
		}
		const body = await this.readJsonBody(request);
		// scope 必须是合法枚举：user/project/unknown，其余拒绝（不猜默认）
		const scope = body.scope;
		if (typeof body.source !== "string" || !body.source || typeof body.enabled !== "boolean" || (scope !== "user" && scope !== "project" && scope !== "unknown")) {
			sendError(response, 400, "webError.invalidRequest", "source (string), enabled (boolean), scope (user|project|unknown) are required");
			return true;
		}
		// 项目作用域必须带 projectId：缺了会一路走到原生配置写入才失败（HTTP 500，前端只看到「失败」）。
		const projectId = typeof body.projectId === "string" && body.projectId.trim() && body.projectId.trim().length <= 256 ? body.projectId.trim() : undefined;
		if (scope === "project" && !projectId) {
			sendError(response, 400, "webError.invalidRequest", "projectId (string) is required when scope is project");
			return true;
		}
		// 扩展列表有意剥离宿主机路径，本地文件扩展由主进程按 source 反查真实路径；内置扩展的开关
		// 也由同一入口分流到 PiDeck 设置（见 ExtensionManager.toggleFromUi）。
		const path = typeof body.path === "string" && body.path.length <= 32_768 ? body.path : undefined;
		await this.deps.assets.setExtensionEnabled(body.source, body.enabled, scope, path, projectId);
		sendJson(response, 200, { ok: true });
		return true;
	}

	/** 读 POST JSON body（开关类请求很小；上限 64KB 防滥用）。 */
	private readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
		return new Promise((resolve, reject) => {
			const chunks: Buffer[] = [];
			let total = 0;
			request.on("data", (chunk: Buffer) => {
				total += chunk.length;
				if (total > 64 * 1024) {
					request.destroy();
					reject(new Error("body too large"));
					return;
				}
				chunks.push(chunk);
			});
			request.on("end", () => {
				try {
					const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
					resolve(typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {});
				} catch (error) {
					reject(error instanceof Error ? error : new Error("invalid json"));
				}
			});
			request.on("error", reject);
		});
	}
}
