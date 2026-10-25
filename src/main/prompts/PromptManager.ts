import { existsSync } from "node:fs";
import { mkdir, open, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createProjectFileReadBoundary, resolveProjectFileReadPath, resolveProjectFileWritePath, type ProjectFileReadBoundary } from "../files/projectFileAccess";

/** 模板扫描只读文件头部该字节数：frontmatter 与首行描述都在头部，扫描不得全量读入超大 .md。 */
const TEMPLATE_META_MAX_BYTES = 64 * 1024;
import { homedir } from "node:os";
import { trashPath } from "../fs/trash";
import { openSystemPath } from "../fs/openPath";
import type { AppSettings, CreatePiPromptTemplateInput, PiPromptTemplateListResult, PiPromptTemplateSummary } from "../../shared/types";
import { parseWslUncPath, toWindowsHostPath, type WslEnvironment } from "../wsl/WslPaths";
import { projectResourceEnabled } from "../config/piResourceRules";
import type { MainProcessTranslationKey } from "../../shared/i18n/mainProcessCopy";

type PromptCopy = (key: MainProcessTranslationKey, params?: Record<string, string | number>) => string;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readDisabledPromptNames(settings: Record<string, unknown>): string[] {
	const value = settings.disabledPrompts;
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** 推荐模板：用户刚接触 prompt templates 时可快速上手的实用模板。
 * 标记 userCreated: false，在 UI 中显示为只读条目。 */

/**
 * 管理 pi 全局 Prompt Templates 目录 (~/.pi/agent/prompts/)。
 *
 * Prompt Templates 是 markdown 文件，用户可在 pi 中输入 /<name> 快速展开。
 * frontmatter 支持 description、argument-hint 等元数据。
 */
export class PromptManager {
	private promptsDir: string;
	private wslEnvironment: WslEnvironment | null = null;
	/** PiDeck 设置的读取/写入（禁用列表持久化）；未配置时开关不生效（旧行为）。 */
	private settingsProvider: (() => AppSettings) | null = null;
	private settingsPatcher: ((patch: Partial<AppSettings>) => Promise<AppSettings>) | null = null;

	constructor(
		home?: string,
		private readonly translate: PromptCopy = () => "Prompt operation failed.",
	) {
		this.promptsDir = join(home ?? homedir(), ".pi", "agent", "prompts");
	}

	/** 注入 PiDeck 设置读写：旧禁用列表的兼容通道（原生服务未装配时使用；迁移后为空）。 */
	configureSettings(getSettings: () => AppSettings, patchSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>) {
		this.settingsProvider = getSettings;
		this.settingsPatcher = patchSettings;
	}

	/**
	 * 注入原生开关与状态投影（A4：迁移完成后禁用列表不再是真值来源）。
	 * 装配后模板开关写 pi settings.json 的精确过滤规则。
	 */
	configureNativeToggle(toggle: (templatePath: string, enabled: boolean) => Promise<{ ok: boolean; error?: string }>): void {
		this.nativeToggle = toggle;
	}

	configureNativeEnabledReader(reader: (templatePath: string) => boolean | undefined): void {
		this.nativeEnabledReader = reader;
	}

	/** 项目作用域的原生开关（写项目 `.pi/settings.json` 的 prompts 精确规则）。 */
	configureNativeProjectToggle(toggle: (projectId: string, templatePath: string, enabled: boolean) => Promise<{ ok: boolean; error?: string }>): void {
		this.nativeProjectToggle = toggle;
	}

	private nativeProjectToggle: ((projectId: string, templatePath: string, enabled: boolean) => Promise<{ ok: boolean; error?: string }>) | null = null;

	private nativeToggle: ((templatePath: string, enabled: boolean) => Promise<{ ok: boolean; error?: string }>) | null = null;
	private nativeEnabledReader: ((templatePath: string) => boolean | undefined) | null = null;

	/** 模板名是否在 PiDeck settings 禁用列表（小写比较；未配置 settings 时视为未禁用）。 */
	private isDisabledInSettings(name: string): boolean {
		if (!this.settingsProvider) return false;
		const key = name.toLowerCase();
		return (this.settingsProvider().disabledPrompts ?? []).some((disabledName) => disabledName.toLowerCase() === key);
	}

	/**
	 * 开关模板：原生配置优先写 pi settings.json 的 prompts 精确规则；
	 * 未装配原生服务时退回 PiDeck settings 禁用列表（旧机制，迁移后为空）。
	 * 内置推荐模板（builtin://，无磁盘文件）不可禁用。
	 */
	async toggle(filePath: string, enabled: boolean): Promise<PiPromptTemplateSummary> {
		this.invalidateListCache();
		const comparablePath = await this.resolveExistingGlobalPath(filePath);
		const { templates } = await this.list();
		const template = templates.find((item) => item.path === comparablePath);
		if (!template) throw new Error(this.translate("mainPrompt.fileNotFound"));
		if (this.nativeToggle) {
			const result = await this.nativeToggle(template.path, enabled);
			if (!result.ok) throw new Error(this.translate("mainPrompt.toggleFailed", { error: result.error ?? "unknown" }));
			// 变更后再失效：上面 list() 已把「改之前」的 enabled 写进缓存
			this.invalidateListCache();
			return { ...template, enabled };
		}
		if (this.settingsProvider && this.settingsPatcher) {
			const current = this.settingsProvider().disabledPrompts ?? [];
			const nameKey = template.name.toLowerCase();
			const nextList = current.filter((name) => name.toLowerCase() !== nameKey);
			if (!enabled) nextList.push(template.name);
			await this.settingsPatcher({ disabledPrompts: nextList });
		}
		this.invalidateListCache();
		return { ...template, enabled };
	}

	/** Reads project-local prompt disables; global PiDeck settings must not affect equal project names. */
	private async readProjectDisabledPromptNames(projectRoot: string, boundary: ProjectFileReadBoundary): Promise<string[]> {
		const settingsFile = join(projectRoot, ".pi", "settings.json");
		if (!existsSync(settingsFile)) return [];
		try {
			const safeSettingsFile = await resolveProjectFileReadPath(boundary, settingsFile);
			const parsed: unknown = JSON.parse(await readFile(safeSettingsFile, "utf8"));
			return isRecord(parsed) ? readDisabledPromptNames(parsed) : [];
		} catch {
			return [];
		}
	}

	/** Toggles one project-owned template by updating that project's whitelist input. */
	async toggleInProject(projectPath: string, promptName: string, enabled: boolean, projectId?: string): Promise<PiPromptTemplateSummary> {
		const projectRoot = resolve(this.hostPath(projectPath));
		const boundary = await this.createProjectBoundary(projectRoot);
		const name = this.validProjectPromptName(promptName);
		const target = await this.resolveExistingProjectPath(boundary, join(projectRoot, ".pi", "prompts", `${name}.md`));
		// 原生过滤规则优先：项目自有模板写 `.pi/settings.json` 的 prompts 精确 `-path`。
		if (this.nativeProjectToggle && projectId) {
			const result = await this.nativeProjectToggle(projectId, target, enabled);
			if (!result.ok) throw new Error(this.translate("mainPrompt.toggleFailed", { error: result.error ?? "unknown" }));
			return this.readProjectTemplate(target, name, enabled);
		}
		const settingsFile = await this.resolveProjectWritePath(boundary, join(projectRoot, ".pi", "settings.json"));
		let settings: Record<string, unknown> = {};
		if (existsSync(settingsFile)) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(await readFile(settingsFile, "utf8"));
			} catch {
				throw new Error(this.translate("mainConfig.invalidJson"));
			}
			if (!isRecord(parsed)) throw new Error(this.translate("mainConfig.invalidJson"));
			settings = parsed;
		}
		const current = readDisabledPromptNames(settings);
		const nameKey = name.toLowerCase();
		const next = current.filter((entry) => entry.toLowerCase() !== nameKey);
		if (!enabled) next.push(name);
		settings.disabledPrompts = next;
		await mkdir(dirname(settingsFile), { recursive: true });
		await writeFile(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
		return this.readProjectTemplate(target, name, enabled);
	}

	/** 读取单个项目模板结果（原生与私有两条写入路径共用）。 */
	private async readProjectTemplate(target: string, name: string, enabled: boolean): Promise<PiPromptTemplateSummary> {
		const raw = await readFile(target, "utf8");
		const frontmatter = this.parseFrontmatter(raw);
		return {
			name,
			path: target,
			description: (frontmatter.description ?? "").replace(/^["']|["']$/g, "").trim(),
			content: raw,
			userCreated: true,
			scope: "project",
			enabled,
		};
	}

	/** 将 prompt 目录切换到统一解析出的 WSL HOME；null 恢复 Windows home。 */
	configureWsl(environment: WslEnvironment | null) {
		this.wslEnvironment = environment;
		this.promptsDir = join(environment?.windowsHome ?? homedir(), ".pi", "agent", "prompts");
	}

	private async globalBoundary(): Promise<ProjectFileReadBoundary> {
		await mkdir(this.promptsDir, { recursive: true });
		try {
			return await createProjectFileReadBoundary(this.promptsDir);
		} catch {
			throw new Error(this.translate("mainPrompt.globalEditOnly"));
		}
	}

	private async resolveExistingGlobalPath(filePath: string): Promise<string> {
		try {
			return await resolveProjectFileReadPath(await this.globalBoundary(), this.hostPath(filePath));
		} catch {
			throw new Error(this.translate("mainPrompt.globalEditOnly"));
		}
	}

	private async resolveGlobalWritePath(filePath: string): Promise<string> {
		try {
			return await resolveProjectFileWritePath(await this.globalBoundary(), this.hostPath(filePath));
		} catch {
			throw new Error(this.translate("mainPrompt.globalEditOnly"));
		}
	}

	/** 项目路径来自 renderer 的存储格式，Windows fs 边界统一使用当前 WSL 的主机路径。 */
	private hostPath(path: string): string {
		if (!this.wslEnvironment || process.platform !== "win32" || (!path.startsWith("/") && !parseWslUncPath(path))) {
			return path;
		}
		try {
			return toWindowsHostPath(path, this.wslEnvironment);
		} catch {
			return path;
		}
	}

	private async createProjectBoundary(projectRoot: string): Promise<ProjectFileReadBoundary> {
		try {
			return await createProjectFileReadBoundary(projectRoot);
		} catch {
			throw new Error(this.translate("mainPrompt.globalEditOnly"));
		}
	}

	private async resolveExistingProjectPath(boundary: ProjectFileReadBoundary, targetPath: string): Promise<string> {
		try {
			return await resolveProjectFileReadPath(boundary, targetPath);
		} catch {
			throw new Error(this.translate("mainPrompt.globalEditOnly"));
		}
	}

	private async resolveProjectWritePath(boundary: ProjectFileReadBoundary, targetPath: string): Promise<string> {
		try {
			return await resolveProjectFileWritePath(boundary, targetPath);
		} catch {
			throw new Error(this.translate("mainPrompt.globalEditOnly"));
		}
	}

	/** 只读文件头部用于模板元数据抽取（frontmatter / 首行描述）：
	 *  扫描路径不得把整个模板文件读进内存——用户手工放入超大 .md 时，列表扫描会逐文件全量拉取（资源边界约束）。
	 *  失败与空文件一律返回空串，与旧 readFile().catch("") 语义一致（扫描跳过，不报错）。 */
	private async readFileHead(fullPath: string): Promise<string> {
		const handle = await open(fullPath, "r").catch(() => null);
		if (!handle) return "";
		try {
			const buf = Buffer.alloc(TEMPLATE_META_MAX_BYTES);
			const { bytesRead } = await handle.read(buf, 0, TEMPLATE_META_MAX_BYTES, 0);
			return buf.subarray(0, bytesRead).toString("utf8");
		} finally {
			await handle.close();
		}
	}

	private validProjectPromptName(value: string): string {
		const raw = value.trim().replace(/\.md$/i, "");
		const normalized = this.normalizeName(raw);
		if (!normalized || normalized !== raw.toLowerCase()) {
			throw new Error(this.translate("mainPrompt.nameRequired"));
		}
		return normalized;
	}

	getDir(): string {
		return this.promptsDir;
	}

	/**
	 * 全局模板列表缓存（2027-02 性能审计）。
	 *
	 * 切会话时 composer 会重拉模板表（useSessionComposerController.loadTemplates），
	 * 设置页「提示词」tab 也各拉一次；list() 每次都要 realpath 边界 + 逐文件
	 * open/读 64KB 头部/close（每模板 3 次 syscall）并把正文随摘要一起返回。
	 * 模板目录由用户手工维护、变更频率极低：1.5s TTL + 本类所有写操作显式失效。
	 */
	private listCache: { at: number; value: PiPromptTemplateListResult } | null = null;
	private static readonly LIST_CACHE_TTL_MS = 1_500;

	/** 模板目录被本类改动后调用：下一次 list() 重新扫盘。 */
	private invalidateListCache(): void {
		this.listCache = null;
	}

	async list(): Promise<PiPromptTemplateListResult> {
		const cached = this.listCache;
		if (cached && Date.now() - cached.at < PromptManager.LIST_CACHE_TTL_MS) return cached.value;
		const boundary = await this.globalBoundary();
		const entries = await readdir(this.promptsDir).catch(() => []);
		const templates: PiPromptTemplateSummary[] = [];

		for (const entry of entries) {
			if (!entry.endsWith(".md")) continue;
			if (entry.endsWith(".d.md")) continue;
			let fullPath: string;
			try {
				fullPath = await resolveProjectFileReadPath(boundary, join(this.promptsDir, entry));
			} catch {
				continue;
			}
			const raw = await this.readFileHead(fullPath);
			if (!raw) continue;

			const name = basename(entry, ".md");
			const frontmatter = this.parseFrontmatter(raw);
			const description = frontmatter.description ?? raw.split(/\r?\n/).find((line) => line.trim()) ?? "";

			templates.push({
				name,
				path: fullPath,
				description: description.replace(/^["']|["']$/g, "").trim(),
				content: raw,
				userCreated: true,
				scope: "global",
				// 禁用状态 = 原生投影优先；未装配原生服务时退回 PiDeck settings 禁用列表
				// 优先原生投影（迁移后 disabledPrompts 已清空）；未装配时退回旧列表。
				enabled: this.nativeEnabledReader?.(fullPath) ?? !this.isDisabledInSettings(name),
			});
		}

		// 按 name 排序
		templates.sort((a, b) => a.name.localeCompare(b.name));

		const value = { templates, globalDir: this.promptsDir };
		this.listCache = { at: Date.now(), value };
		return value;
	}

	async create(input: CreatePiPromptTemplateInput): Promise<PiPromptTemplateSummary> {
		this.invalidateListCache();
		const name = this.normalizeName(input.name);
		if (!name) throw new Error(this.translate("mainPrompt.nameRequiredDetailed"));
		const description = input.description.trim();
		if (!description) throw new Error(this.translate("mainPrompt.descriptionRequired"));

		const filePath = await this.resolveGlobalWritePath(join(this.promptsDir, `${name}.md`));
		if (existsSync(filePath)) throw new Error(this.translate("mainPrompt.alreadyExists", { name }));

		// 内容仅含 frontmatter 中的 description，正文由用户后续在编辑器中编写，不与 skill 重复展示描述
		const content = `---\ndescription: ${description.replace(/\n/g, " ")}\n---\n`;
		await writeFile(filePath, content, "utf8");

		return {
			name,
			path: filePath,
			description,
			content,
			userCreated: true,
		};
	}

	async delete(filePath: string): Promise<void> {
		this.invalidateListCache();
		const candidate = await this.resolveGlobalWritePath(filePath);
		if (!existsSync(candidate)) throw new Error(this.translate("mainPrompt.fileNotFound"));
		const safeFilePath = await this.resolveExistingGlobalPath(candidate);
		// 提示词模板是用户内容：删除走系统回收站（可恢复）；回收站不可用时抛错，拒绝硬删。
		await trashPath(safeFilePath, { source: "prompts:delete" });
	}

	/** 扫描项目 .pi/prompts/ 目录下的模板 */
	async listByProject(projectPath: string, projectId?: string): Promise<PiPromptTemplateListResult> {
		const projectRoot = resolve(this.hostPath(projectPath));
		const boundary = await this.createProjectBoundary(projectRoot);
		const lexicalPromptsDir = join(projectRoot, ".pi", "prompts");
		let projectPromptsDir = lexicalPromptsDir;
		if (existsSync(lexicalPromptsDir)) {
			try {
				projectPromptsDir = await resolveProjectFileReadPath(boundary, lexicalPromptsDir);
			} catch {
				return { templates: [], globalDir: lexicalPromptsDir };
			}
		}
		const entries = await readdir(projectPromptsDir, { withFileTypes: true }).catch(() => []);
		const templates: PiPromptTemplateSummary[] = [];
		const disabledNames = new Set((await this.readProjectDisabledPromptNames(projectRoot, boundary)).map((name) => name.toLowerCase()));
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name.endsWith(".d.md")) continue;
			let fullPath: string;
			try {
				fullPath = await resolveProjectFileReadPath(boundary, join(lexicalPromptsDir, entry.name));
			} catch {
				continue;
			}
			const raw = await this.readFileHead(fullPath);
			if (!raw) continue;
			const name = basename(entry.name, ".md");
			const frontmatter = this.parseFrontmatter(raw);
			const description = frontmatter.description ?? raw.split(/\r?\n/).find((line) => line.trim()) ?? "";

			templates.push({
				name,
				path: fullPath,
				description: description.replace(/^["']|["']$/g, "").trim(),
				content: raw,
				userCreated: true,
				scope: "project",
				enabled: !disabledNames.has(name.toLowerCase()),
			});
		}
		// 原生投影优先（迁移后项目私有 disabledPrompts 已清空）。
		const projectEntries = this.nativeProjectEntries && projectId ? await this.nativeProjectEntries(projectId) : null;
		if (projectEntries) {
			const baseDir = join(projectRoot, ".pi");
			for (const template of templates) template.enabled = projectResourceEnabled({ entries: projectEntries, value: template.path, baseDir });
		}
		templates.sort((a, b) => a.name.localeCompare(b.name));
		return { templates, globalDir: lexicalPromptsDir };
	}

	/** 项目层原生 prompts 条目读取器（列表投影用）；未装配时返回 null。 */
	private nativeProjectEntries: ((projectId: string) => Promise<string[] | null>) | null = null;

	configureNativeProjectEntriesReader(reader: (projectId: string) => Promise<string[] | null>): void {
		this.nativeProjectEntries = reader;
	}

	/** 在项目 .pi/prompts/ 下创建模板 */
	async createInProject(projectPath: string, input: CreatePiPromptTemplateInput): Promise<PiPromptTemplateSummary> {
		const projectRoot = resolve(this.hostPath(projectPath));
		const boundary = await this.createProjectBoundary(projectRoot);
		const projectPromptsDir = join(projectRoot, ".pi", "prompts");
		const name = this.normalizeName(input.name);
		if (!name) throw new Error(this.translate("mainPrompt.nameRequiredDetailed"));
		const description = input.description.trim();
		if (!description) throw new Error(this.translate("mainPrompt.descriptionRequired"));
		const filePath = await this.resolveProjectWritePath(boundary, join(projectPromptsDir, `${name}.md`));
		if (existsSync(filePath)) throw new Error(this.translate("mainPrompt.alreadyExists", { name }));
		await mkdir(dirname(filePath), { recursive: true });
		// 内容仅含 frontmatter 中的 description，正文由用户后续编辑
		const content = `---\ndescription: ${description.replace(/\n/g, " ")}\n---\n`;
		await writeFile(filePath, content, "utf8");
		return {
			name,
			path: filePath,
			description,
			content,
			userCreated: true,
			scope: "project",
		};
	}

	/** 从项目 .pi/prompts/ 删除模板 */
	async deleteFromProject(projectPath: string, promptName: string): Promise<void> {
		const projectRoot = resolve(this.hostPath(projectPath));
		const boundary = await this.createProjectBoundary(projectRoot);
		const name = this.validProjectPromptName(promptName);
		const filePath = await this.resolveExistingProjectPath(boundary, join(projectRoot, ".pi", "prompts", `${name}.md`));
		// 项目内模板同样走回收站，避免误删后无法恢复。
		await trashPath(filePath, { source: "prompts:delete-project" });
	}

	async openFolder(): Promise<void> {
		await mkdir(this.promptsDir, { recursive: true });
		await openSystemPath(this.promptsDir);
	}

	/**
	 * 读取模板原始内容（供编辑器使用）
	 */
	async readContent(filePath: string): Promise<string> {
		return readFile(await this.resolveExistingGlobalPath(filePath), "utf8");
	}

	/**
	 * 保存模板内容
	 */
	async writeContent(filePath: string, content: string): Promise<void> {
		this.invalidateListCache();
		await writeFile(await this.resolveGlobalWritePath(filePath), content, "utf8");
	}

	/** Save a project-local template after re-validating the canonical project boundary. */
	async writeContentInProject(projectPath: string, filePath: string, content: string): Promise<void> {
		const projectRoot = resolve(this.hostPath(projectPath));
		const boundary = await this.createProjectBoundary(projectRoot);
		const safePath = await this.resolveProjectWritePath(boundary, filePath);
		await writeFile(safePath, content, "utf8");
	}

	private parseFrontmatter(raw: string): Record<string, string> {
		const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
		const result: Record<string, string> = {};
		if (!match) return result;
		for (const line of match[1].split(/\r?\n/)) {
			const index = line.indexOf(":");
			if (index === -1) continue;
			const key = line.slice(0, index).trim();
			let value = line.slice(index + 1).trim();
			value = value.replace(/^['\"]|['\"]$/g, "");
			if (key) result[key] = value;
		}
		return result;
	}

	/** 重命名全局模板：将 <oldName>.md 重命名为 <newName>.md */
	async rename(oldName: string, newName: string): Promise<PiPromptTemplateSummary> {
		this.invalidateListCache();
		const normalizedOld = this.normalizeName(oldName);
		const normalizedNew = this.normalizeName(newName);
		if (!normalizedOld || !normalizedNew) throw new Error(this.translate("mainPrompt.nameRequired"));
		if (normalizedOld === normalizedNew) throw new Error(this.translate("mainPrompt.sameName"));

		const oldCandidate = await this.resolveGlobalWritePath(join(this.promptsDir, `${normalizedOld}.md`));
		const newPath = await this.resolveGlobalWritePath(join(this.promptsDir, `${normalizedNew}.md`));
		if (!existsSync(oldCandidate)) throw new Error(this.translate("mainPrompt.notFound", { name: oldName }));
		const oldPath = await this.resolveExistingGlobalPath(oldCandidate);
		if (existsSync(newPath)) throw new Error(this.translate("mainPrompt.alreadyExists", { name: normalizedNew }));

		await rename(oldPath, newPath);
		// 读取新文件内容返回摘要
		const raw = await readFile(newPath, "utf8");
		const frontmatter = this.parseFrontmatter(raw);
		const description = frontmatter.description ?? "";
		return {
			name: normalizedNew,
			path: newPath,
			description: description.replace(/^["']|["']$/g, "").trim(),
			content: raw,
			userCreated: true,
			scope: "global",
		};
	}

	/** 重命名项目级模板 */
	async renameInProject(projectPath: string, oldName: string, newName: string): Promise<PiPromptTemplateSummary> {
		const projectRoot = resolve(this.hostPath(projectPath));
		const boundary = await this.createProjectBoundary(projectRoot);
		const normalizedOld = this.validProjectPromptName(oldName);
		const normalizedNew = this.normalizeName(newName);
		if (!normalizedOld || !normalizedNew) throw new Error(this.translate("mainPrompt.nameRequired"));
		if (normalizedOld === normalizedNew) throw new Error(this.translate("mainPrompt.sameName"));

		const oldPath = await this.resolveExistingProjectPath(boundary, join(projectRoot, ".pi", "prompts", `${normalizedOld}.md`));
		const newPath = await this.resolveProjectWritePath(boundary, join(projectRoot, ".pi", "prompts", `${normalizedNew}.md`));
		if (existsSync(newPath)) throw new Error(this.translate("mainPrompt.alreadyExists", { name: normalizedNew }));

		await rename(oldPath, newPath);
		const raw = await readFile(newPath, "utf8");
		const frontmatter = this.parseFrontmatter(raw);
		const description = frontmatter.description ?? "";
		return {
			name: normalizedNew,
			path: newPath,
			description: description.replace(/^["']|["']$/g, "").trim(),
			content: raw,
			userCreated: true,
			scope: "project",
		};
	}

	/** 规范化模板名称：保留 Unicode 字母（含中文等非拉丁文字）、数字和连字符，其余替换为连字符 */
	private normalizeName(value: string): string {
		return (
			value
				.trim()
				// 替换非（Unicode 字母/数字/连字符）的字符为连字符
				.replace(/[^\p{L}\p{N}-]/gu, "-")
				.replace(/-+/g, "-")
				.replace(/^-|-$/g, "")
				.toLowerCase()
		);
	}
}
