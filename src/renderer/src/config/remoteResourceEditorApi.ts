import type { PiDesktopApi } from "../../../preload";
import type { CreateProjectSkillInput, PiExtensionListResult, PiExtensionSummary, PiPromptTemplateListResult, PiPromptTemplateSummary, PiSkillListResult, PiSkillLocation, PiSkillSummary, ProjectInheritedResourceToggleInput, ProjectResourceDirectoryKind, ProjectResourceListResult } from "../../../shared/types";
import { REMOTE_RESOURCE_CODES as C, type RemoteResourceFile, type RemoteResourceList, type RemoteResourceRequest, type RemoteResourceResult, type RemoteResourceScope } from "../../../shared/types/remotePiManagement";
import { PI_BUILTIN_EXTENSIONS, PI_RESOURCE_KINDS } from "../../../shared/types/piResources";
import { writeClipboard } from "../utils/clipboard";
import { showNotice } from "../utils/notice";
import { t } from "../i18n";
import { minimatch } from "minimatch";
import { convertStoreVarsToPiVars } from "../../../shared/promptStoreVariables";

/** Absolute sub-paths of each layer, relative to its base (host HOME or one project root). */
const GLOBAL_PATHS = { skills: ".pi/agent/skills", "agents-skills": ".agents/skills", prompts: ".pi/agent/prompts", extensions: ".pi/agent/extensions" };
const PROJECT_PATHS = { skills: ".pi/skills", "agents-skills": ".agents/skills", prompts: ".pi/prompts", extensions: ".pi/extensions" };
const PROJECT_SKILL_LOCATIONS: PiSkillLocation[] = [
	{ id: "project-pi", label: ".pi/skills", path: "", rootMarkdownEnabled: true },
	{ id: "project-agents", label: ".agents/skills", path: "", rootMarkdownEnabled: false },
];

function isList(result: RemoteResourceResult): result is RemoteResourceList {
	return "files" in result;
}
function isFile(result: RemoteResourceResult): result is RemoteResourceFile {
	return "content" in result;
}
function field(content: string, key: string): string {
	// 远端文件可能带 UTF-8 BOM（helper 保留原始字节，版本号是原始字节的 sha256），解析 frontmatter 前先剥掉。
	const header = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1] ?? "";
	const value = new RegExp("^" + key + ":\\s*(.*)$", "m").exec(header)?.[1]?.trim() ?? "";
	try {
		const parsed: unknown = JSON.parse(value);
		return typeof parsed === "string" ? parsed : value;
	} catch {
		return value.replace(/^['"]|['"]$/g, "");
	}
}
function name(value: string): string {
	const result = value.trim();
	if (!result || result.length > 128 || /[\\/%\u0000-\u001f\u007f]/.test(result) || result.startsWith(".") || result === "node_modules") throw new Error(C.fileInvalid);
	return result;
}
function slug(value: string): string {
	return name(
		value
			.toLowerCase()
			.replace(/[^\p{L}\p{N}-]+/gu, "-")
			.replace(/^-|-$/g, ""),
	);
}

/** One listed file together with the layer it belongs to: the same relative reference names a different file per layer. */
type ListedFile = { file: RemoteResourceFile; scope: RemoteResourceScope; base: string };

/**
 * Host-bound resource facade.
 *
 * Two layers are served from the same host: the host's global user resources (always) and — when the page was
 * opened for one project — that project's own resources. File operations accept only references obtained from
 * this host's list, and every request carries the layer explicitly: a project page can never mutate the
 * host's global files by omitting it, because the layer is a required field of the reference map rather than
 * a default the caller has to remember.
 */
export function createRemoteResourceEditorApi(api: PiDesktopApi, hostId: string, connected: () => Promise<void>, projectId?: string) {
	let snapshot: RemoteResourceList | undefined;
	let projectSnapshot: RemoteResourceList | undefined;
	let loading: Promise<RemoteResourceList> | undefined;
	let projectLoading: Promise<RemoteResourceList> | undefined;
	let epoch = 0;
	let extensionVersions: Map<string, Pick<PiExtensionSummary, "currentVersion" | "latestVersion" | "hasUpdate" | "updateError">> | undefined;
	const listed = new Map<string, ListedFile>();
	const editing = new Map<string, ListedFile>();
	const pending = new Set<string>();
	const blocked = new Map<string, string>();
	/** Requests carry only the closed `{ root, path }` reference; the version travels separately. */
	const refOf = (file: RemoteResourceFile) => ({ root: file.root, path: file.path });
	const pathOf = (entry: ListedFile) => entry.base + "/" + (entry.scope === "project" ? PROJECT_PATHS : GLOBAL_PATHS)[entry.file.root] + "/" + entry.file.path;
	const projectRoot = () => {
		const root = projectSnapshot?.projectRoot;
		if (typeof root !== "string" || !root.startsWith("/")) throw new Error(C.fileInvalid);
		return root;
	};
	async function call(input: RemoteResourceRequest): Promise<RemoteResourceResult> {
		await connected();
		return api.remotePiResources(hostId, input.scope === "project" ? { ...input, projectId } : input);
	}
	function index(result: RemoteResourceList, scope: RemoteResourceScope, base: string): void {
		for (const file of result.files) listed.set(base + "/" + (scope === "project" ? PROJECT_PATHS : GLOBAL_PATHS)[file.root] + "/" + file.path, { file, scope, base });
	}
	async function load(): Promise<RemoteResourceList> {
		if (loading) return loading;
		const started = epoch;
		const operation = (async () => {
			const result = await call({ action: "list" });
			if (!isList(result)) throw new Error(C.fileInvalid);
			if (started !== epoch) throw new Error(C.conflict);
			snapshot = result;
			listed.clear();
			index(result, "global", result.home);
			if (projectSnapshot) index(projectSnapshot, "project", projectRoot());
			return result;
		})();
		loading = operation;
		try {
			return await operation;
		} finally {
			if (loading === operation) loading = undefined;
		}
	}
	/** Project layer: only reachable when the page was opened for one enrolled project. */
	async function loadProject(): Promise<RemoteResourceList> {
		if (projectId === undefined) throw new Error(C.unsupported);
		if (projectLoading) return projectLoading;
		const started = epoch;
		const operation = (async () => {
			const result = await call({ action: "list", scope: "project" });
			if (!isList(result)) throw new Error(C.fileInvalid);
			if (started !== epoch) throw new Error(C.conflict);
			if (result.projectRoot === null) throw new Error(C.fileInvalid);
			projectSnapshot = result;
			listed.clear();
			index(result, "project", result.projectRoot);
			if (snapshot) index(snapshot, "global", snapshot.home);
			return result;
		})();
		projectLoading = operation;
		try {
			return await operation;
		} finally {
			if (projectLoading === operation) projectLoading = undefined;
		}
	}
	async function refresh(): Promise<{ global: RemoteResourceList; project: RemoteResourceList | undefined }> {
		const [global, project] = await Promise.all([load(), projectId === undefined ? Promise.resolve(undefined) : loadProject()]);
		return { global, project };
	}
	/** 商店/导入的落点跟随当前页面的作用域：项目页写项目层，全局页写主机全局层。 */
	const pageScope = (): RemoteResourceScope => (projectId === undefined ? "global" : "project");
	function lookup(path: string): ListedFile {
		const entry = listed.get(path);
		if (!entry) throw new Error(C.fileInvalid);
		return entry;
	}
	async function mutate(key: string, input: RemoteResourceRequest) {
		if (blocked.has(key)) throw new Error(blocked.get(key));
		if (pending.has(key)) throw new Error(C.unconfirmed);
		pending.add(key);
		try {
			return await call(input);
		} catch (error) {
			const code = error instanceof Error ? error.message : String(error);
			if (code.includes(C.conflict) || code.includes(C.unconfirmed)) blocked.set(key, code.includes(C.conflict) ? C.conflict : C.unconfirmed);
			throw error;
		} finally {
			pending.delete(key);
		}
	}
	/**
	 * 原生过滤规则求值：`!pattern` 排除、`+path` 精确包含、`-path` 精确排除。
	 * 项目页里的继承行（全局技能/扩展/提示词）再叠加项目层 `-<path>` 覆盖，与本地项目资源管理器同一套语义。
	 */
	function enabled(kind: string, value: string, scope: RemoteResourceScope = "global"): boolean {
		const settings = scope === "project" ? projectSnapshot?.settings : snapshot?.settings;
		const base = scope === "project" ? projectRoot() + "/.pi" : (snapshot?.home ?? "") + "/.pi/agent";
		const entries = settings?.[kind];
		const normalised = (entry: string) => (entry.startsWith("~/") ? (scope === "project" ? projectRoot() : snapshot?.home) + entry.slice(1) : entry.startsWith("/") || entry.startsWith("builtin:") ? entry : base + entry.replace(/^\.\//, ""));
		const exact = (entry: string) => {
			const item = normalised(entry);
			return item === value || (value.endsWith("/SKILL.md") && item === value.slice(0, -9));
		};
		let result = true;
		if (Array.isArray(entries))
			for (const entry of entries)
				if (typeof entry === "string" && entry.startsWith("!")) {
					const pattern = entry.slice(1).startsWith("~/") ? normalised(entry.slice(1)) : entry.slice(1);
					const parent = value.endsWith("/SKILL.md") ? value.slice(0, -9) : "";
					if ([value, value.startsWith(base) ? value.slice(base.length) : value, value.split("/").at(-1) ?? "", parent, parent.startsWith(base) ? parent.slice(base.length) : parent, parent.split("/").at(-1) ?? ""].some((item) => item && minimatch(item, pattern))) result = false;
				}
		if (Array.isArray(entries)) {
			if (entries.some((entry) => typeof entry === "string" && entry.startsWith("+") && exact(entry.slice(1)))) result = true;
			if (entries.some((entry) => typeof entry === "string" && entry.startsWith("-") && exact(entry.slice(1)))) result = false;
		}
		// Inherited rows shown inside a project page also honour that project's own disable overrides.
		if (scope === "global" && projectSnapshot) {
			const overrides = projectSnapshot.discovery.overrides;
			const disabled = kind === "skills" ? overrides.disabledGlobalSkills : kind === "prompts" ? overrides.disabledGlobalPrompts : kind === "extensions" ? overrides.disabledGlobalExtensions : [];
			const parent = value.endsWith("/SKILL.md") ? value.slice(0, -9) : "";
			const folded = kind === "extensions" ? [value, parent] : [value.toLowerCase(), parent.toLowerCase()];
			if (disabled.some((item) => folded.includes(item))) result = false;
		}
		return result;
	}
	function skill(entry: ListedFile): PiSkillSummary {
		const path = pathOf(entry),
			file = entry.file,
			directory = file.path.endsWith("/SKILL.md");
		const title = field(file.content, "name") || (directory ? (file.path.split("/").at(-2) ?? "") : file.path.replace(/\.md$/i, ""));
		return {
			id: path,
			name: title,
			description: field(file.content, "description"),
			path,
			dir: path.slice(0, path.lastIndexOf("/")),
			sourceId: entry.scope === "project" ? (file.root === "agents-skills" ? "project-agents" : "project-pi") : file.root === "agents-skills" ? "agents-global" : "pi-global",
			sourceLabel: entry.scope === "project" ? (file.root === "agents-skills" ? ".agents/skills" : ".pi/skills") : file.root === "agents-skills" ? "~/.agents/skills" : "~/.pi/agent/skills",
			type: directory ? "directory" : "markdown",
			enabled: enabled("skills", path, entry.scope),
			valid: !!field(file.content, "name") && !!field(file.content, "description"),
			warnings: [],
			userOnly: field(file.content, "disable-model-invocation") === "true",
		};
	}
	function prompt(entry: ListedFile): PiPromptTemplateSummary {
		return {
			name: entry.file.path.replace(/\.md$/i, ""),
			path: pathOf(entry),
			description: field(entry.file.content, "description"),
			content: entry.file.content,
			userCreated: true,
			scope: entry.scope === "project" ? "project" : "global",
			enabled: enabled("prompts", pathOf(entry), entry.scope),
		};
	}
	function extension(entry: ListedFile): PiExtensionSummary {
		const path = pathOf(entry);
		return entry.scope === "project"
			? { id: `project:${path}`, source: entry.file.path.split("/")[0] ?? entry.file.path, scope: "project", path, local: true, enabled: enabled("extensions", path, "project") }
			: { id: path, source: entry.file.path, scope: "user", path, local: true, enabled: enabled("extensions", path, "global") };
	}
	async function readContent(path: string): Promise<string> {
		const entry = lookup(path);
		const result = await call({ action: "read", ref: refOf(entry.file), scope: entry.scope });
		if (!isFile(result) || result.root !== entry.file.root || result.path !== entry.file.path) throw new Error(C.fileInvalid);
		blocked.delete(path);
		editing.set(path, { ...entry, file: result });
		return result.content;
	}
	async function writeContent(path: string, content: string): Promise<void> {
		const entry = editing.get(path);
		if (!entry) throw new Error(C.conflict);
		const result = await mutate(path, { action: "write", ref: refOf(entry.file), expectedVersion: entry.file.version, content, scope: entry.scope });
		if (!isFile(result)) throw new Error(C.unconfirmed);
		editing.set(path, { ...entry, file: result });
		listed.set(path, { ...entry, file: result });
	}
	async function toggle(path: string, state: boolean) {
		const entry = lookup(path);
		const settingsVersion = entry.scope === "project" ? projectSnapshot?.settingsVersion : snapshot?.settingsVersion;
		if (!settingsVersion) throw new Error(C.conflict);
		await mutate("settings", { action: "toggle", ref: refOf(entry.file), expectedVersion: settingsVersion, enabled: state, scope: entry.scope });
		await refresh();
	}
	async function remove(path: string) {
		const entry = lookup(path);
		await mutate(path, { action: "delete", ref: refOf(entry.file), expectedVersion: entry.file.version, scope: entry.scope });
		listed.delete(path);
		editing.delete(path);
	}
	async function rename(path: string, title: string) {
		const entry = lookup(path);
		const result = await mutate(path, { action: "rename", ref: refOf(entry.file), expectedVersion: entry.file.version, name: name(title), scope: entry.scope });
		if (!isFile(result)) throw new Error(C.unconfirmed);
		listed.delete(path);
		const moved: ListedFile = { ...entry, file: result };
		listed.set(pathOf(moved), moved);
		return moved;
	}
	async function create(root: "skills" | "agents-skills" | "prompts", path: string, content: string, scope: RemoteResourceScope) {
		if (scope === "project" ? !projectSnapshot : !snapshot) await refresh();
		const result = await mutate(root + "/" + path, { action: "create", ref: { root, path }, content, scope });
		if (!isFile(result)) throw new Error(C.unconfirmed);
		const created: ListedFile = { file: result, scope, base: scope === "project" ? projectRoot() : (snapshot?.home ?? "") };
		listed.set(pathOf(created), created);
		editing.set(pathOf(created), created);
		return created;
	}
	async function packages(operation: "list" | "install" | "remove" | "update", source?: string, includeVersions?: boolean) {
		const input: RemoteResourceRequest = { action: "packages", operation, ...(source === undefined ? {} : { source }), ...(includeVersions === undefined ? {} : { includeVersions }) };
		const result = operation === "list" ? await call(input) : await mutate("packages", input);
		if (!("extensions" in result)) throw new Error(operation === "list" ? C.fileInvalid : C.unconfirmed);
		return result;
	}
	async function copyPath(path?: string) {
		if (!snapshot) await load();
		await writeClipboard(path ?? snapshot?.home + "/.pi/agent");
		showNotice(t("remoteResources.pathCopied"), 2500);
	}
	/** Project layer summary: the same shape the local project manager returns, so the pages need no branch. */
	async function projectList(): Promise<ProjectResourceListResult> {
		const data = await loadProject();
		const root = projectRoot();
		const entries = [...listed.values()].filter((entry) => entry.scope === "project");
		return {
			skills: entries.filter((entry) => entry.file.root === "skills" || entry.file.root === "agents-skills").map(skill),
			extensions: entries.filter((entry) => entry.file.root === "extensions").map(extension),
			skillLocations: PROJECT_SKILL_LOCATIONS.map((location) => ({ ...location, path: root + "/" + (location.id === "project-agents" ? ".agents/skills" : ".pi/skills") })),
			overrides: data.discovery.overrides,
		};
	}
	const unsupported = async (): Promise<never> => {
		throw new Error(C.unsupported);
	};
	return {
		reset() {
			epoch += 1;
			snapshot = undefined;
			projectSnapshot = undefined;
			loading = undefined;
			projectLoading = undefined;
			listed.clear();
			editing.clear();
			blocked.clear();
		},
		files: {
			...api.files,
			readContent: (path: Parameters<PiDesktopApi["files"]["readContent"]>[0]) => (typeof path === "string" ? readContent(path) : unsupported()),
			writeContent: (path: Parameters<PiDesktopApi["files"]["writeContent"]>[0], content: string) => (typeof path === "string" ? writeContent(path, content) : unsupported()),
			showInFolder: (path: Parameters<PiDesktopApi["files"]["showInFolder"]>[0]) => (typeof path === "string" ? copyPath(path) : unsupported()),
		},
		skills: {
			...api.skills,
			list: async (): Promise<PiSkillListResult> => {
				await refresh();
				return {
					locations: [
						{ id: "pi-global", label: "~/.pi/agent/skills", path: (snapshot?.home ?? "") + "/.pi/agent/skills", rootMarkdownEnabled: true },
						{ id: "agents-global", label: "~/.agents/skills", path: (snapshot?.home ?? "") + "/.agents/skills", rootMarkdownEnabled: false },
					],
					skills: [...listed.values()].filter((entry) => entry.scope === "global" && (entry.file.root === "skills" || entry.file.root === "agents-skills")).map(skill),
				};
			},
			readContent: async (path: string) => ({ content: await readContent(path) }),
			create: async (input: { name: string; description: string; locationId: string }) =>
				skill(await create(input.locationId === "agents-global" ? "agents-skills" : "skills", name(input.name) + "/SKILL.md", "---\nname: " + JSON.stringify(input.name) + "\ndescription: " + JSON.stringify(input.description) + "\n---\n\n", "global")),
			delete: remove,
			rename: async (path: string, value: string) => skill(await rename(path, lookup(path).file.path.endsWith("/SKILL.md") ? name(value) : name(value) + ".md")),
			toggle: async (path: string, state: boolean) => {
				await toggle(path, state);
				return skill(lookup(path));
			},
			openFolder: copyPath,
		},
		prompts: {
			...api.prompts,
			list: async (): Promise<PiPromptTemplateListResult> => {
				await refresh();
				return { templates: [...listed.values()].filter((entry) => entry.scope === "global" && entry.file.root === "prompts").map(prompt), globalDir: (snapshot?.home ?? "") + "/.pi/agent/prompts" };
			},
			listByProject: async (): Promise<PiPromptTemplateListResult> => ({ templates: (await projectList()).skills.length >= 0 ? [...listed.values()].filter((entry) => entry.scope === "project" && entry.file.root === "prompts").map(prompt) : [], globalDir: projectRoot() + "/.pi/prompts" }),
			create: async (input: { name: string; description: string }) => prompt(await create("prompts", name(input.name) + ".md", "---\ndescription: " + JSON.stringify(input.description) + "\n---\n\n", "global")),
			createInProject: async (_projectId: string, input: { name: string; description: string }) => prompt(await create("prompts", name(input.name) + ".md", "---\ndescription: " + JSON.stringify(input.description) + "\n---\n\n", "project")),
			edit: (path: string, content?: string) => (content === undefined ? readContent(path) : writeContent(path, content)),
			delete: remove,
			deleteFromProject: async (_projectId: string, templateName: string) => {
				const entry = [...listed.values()].find((candidate) => candidate.scope === "project" && candidate.file.root === "prompts" && candidate.file.path.replace(/\.md$/i, "") === templateName);
				if (!entry) throw new Error(C.fileInvalid);
				await remove(pathOf(entry));
			},
			rename: async (old: string, value: string) => {
				const entry = [...listed.values()].find((candidate) => candidate.scope === "global" && candidate.file.root === "prompts" && candidate.file.path.replace(/\.md$/i, "") === old);
				if (!entry) throw new Error(C.fileInvalid);
				return prompt(await rename(pathOf(entry), name(value) + ".md"));
			},
			renameInProject: async (_projectId: string, old: string, value: string) => {
				const entry = [...listed.values()].find((candidate) => candidate.scope === "project" && candidate.file.root === "prompts" && candidate.file.path.replace(/\.md$/i, "") === old);
				if (!entry) throw new Error(C.fileInvalid);
				return prompt(await rename(pathOf(entry), name(value) + ".md"));
			},
			toggle: async (path: string, state: boolean) => {
				await toggle(path, state);
				return prompt(lookup(path));
			},
			openFolder: async () => {
				if (!snapshot) await load();
				await copyPath(snapshot?.home + "/.pi/agent/prompts");
			},
		},
		extensions: {
			...api.extensions,
			list: async (forceRefresh = false): Promise<PiExtensionListResult> => {
				const includeVersions = forceRefresh || extensionVersions === undefined;
				const [, installed] = await Promise.all([refresh(), packages("list", undefined, includeVersions)]);
				if (includeVersions) extensionVersions = new Map(installed.extensions.map((entry) => [`${entry.source}\u0000${entry.path ?? ""}`, { currentVersion: entry.currentVersion, latestVersion: entry.latestVersion, hasUpdate: entry.hasUpdate, updateError: entry.updateError }]));
				return {
					extensions: [
						...installed.extensions.map((entry) => {
							const config = Array.isArray(snapshot?.settings.packages) ? snapshot?.settings.packages.find((value) => typeof value === "object" && value !== null && Reflect.get(value, "source") === entry.source) : undefined;
							const disabled =
								config &&
								PI_RESOURCE_KINDS.every((key) => {
									const filter: unknown = Reflect.get(config, key);
									return Array.isArray(filter) && filter.length === 0;
								});
							return { ...entry, ...(!includeVersions ? extensionVersions?.get(`${entry.source}\u0000${entry.path ?? ""}`) : {}), enabled: !disabled };
						}),
						...[...listed.values()].filter((entry) => entry.scope === "global" && entry.file.root === "extensions" && /\.(?:[cm]?js|ts)$/i.test(entry.file.path)).map(extension),
						...[...listed.values()].filter((entry) => entry.scope === "project" && entry.file.root === "extensions" && /\.(?:[cm]?js|ts)$/i.test(entry.file.path)).map(extension),
					],
					raw: "",
				};
			},
			install: async (source: string) => (await packages("install", source)).output,
			uninstall: async (source: string) => {
				const file = [...listed.values()].find((entry) => entry.file.root === "extensions" && entry.file.path === source);
				if (file) await remove(pathOf(file));
				else await packages("remove", source);
			},
			update: async () => ({ command: "pi update --extensions", output: (await packages("update")).output, updated: true }),
			updateOne: async (source: string) => ({ command: "pi update " + source, output: (await packages("update", source)).output, updated: true }),
			toggle: async (source: string, state: boolean, _scope?: unknown, path?: string) => {
				if (path && listed.has(path)) {
					await toggle(path, state);
					return;
				}
				if (!snapshot) throw new Error(C.conflict);
				await mutate("settings", { action: "togglePackage", source, expectedVersion: snapshot.settingsVersion, enabled: state });
				await load();
			},
			removeBuiltIn: unsupported,
			restoreBuiltIn: unsupported,
		},
		projectResources: {
			...api.projectResources,
			list: projectList,
			discovery: async (requested?: string) => (requested === undefined ? (await load()).discovery : (await loadProject()).discovery),
			/** Remote paths are copied, not opened: the host's file manager is not this process. */
			openDirectory: async (_projectId: string, kind: ProjectResourceDirectoryKind) => {
				const directories = { "project-pi": ".pi/skills", "project-agents": ".agents/skills", prompts: ".pi/prompts" } as const;
				await copyPath(projectRoot() + "/" + directories[kind]);
			},
			createSkill: async (input: CreateProjectSkillInput) => {
				const location = input.locationId === "project-agents" ? "agents-skills" : "skills";
				return skill(await create(location, name(input.name) + "/SKILL.md", "---\nname: " + JSON.stringify(input.name) + "\ndescription: " + JSON.stringify(input.description) + "\n---\n\n", "project"));
			},
			deleteSkill: async (_projectId: string, skillPath: string) => remove(skillPath),
			deleteExtension: async (_projectId: string, extensionPath: string) => remove(extensionPath),
			toggleSkill: async (_projectId: string, skillPath: string, state: boolean) => {
				await toggle(skillPath, state);
				return skill(lookup(skillPath));
			},
			toggleExtension: async (_projectId: string, extensionPath: string, state: boolean) => {
				await toggle(extensionPath, state);
			},
			toggleInherited: async (input: ProjectInheritedResourceToggleInput) => {
				await mutate("settings", { action: "toggleInherited", kind: input.kind, key: input.key, enabled: input.enabled, scope: "project" });
				return (await loadProject()).discovery.overrides;
			},
			renameSkill: async (_projectId: string, skillPath: string, newName: string) => skill(await rename(skillPath, lookup(skillPath).file.path.endsWith("/SKILL.md") ? name(newName) : name(newName) + ".md")),
		},
		promptStore: {
			...api.promptStore,
			import: async (input: { title: string; description: string; content: string }) => {
				const { converted, argumentHint } = convertStoreVarsToPiVars(input.content);
				return prompt(await create("prompts", slug(input.title) + ".md", "---\ndescription: " + JSON.stringify(input.description) + "\nsource: prompts.chat\n" + (argumentHint ? "argument-hint: " + JSON.stringify(argumentHint) + "\n" : "") + "---\n\n" + converted, pageScope()));
			},
		},
		yaoPrompts: {
			...api.yaoPrompts,
			import: async (slugValue: string, category: string) => {
				const detail = await api.yaoPrompts.detail(slugValue, category);
				return prompt(await create("prompts", slug(slugValue) + ".md", "---\ndescription: " + JSON.stringify(detail.description) + "\n---\n\n" + detail.promptContent, pageScope()));
			},
		},
		skillStore: {
			...api.skillStore,
			import: async (item: { title: string; description: string; content: string }, locationId?: string) =>
				skill(
					await create(
						locationId === "agents-global" || locationId === "project-agents" ? "agents-skills" : "skills",
						slug(item.title) + "/SKILL.md",
						"---\nname: " + JSON.stringify(slug(item.title)) + "\ndescription: " + JSON.stringify(item.description) + "\n---\n\n" + item.content,
						locationId?.startsWith("project") ? "project" : pageScope(),
					),
				),
		},
		skillHub: {
			...api.skillHub,
			install: async (slugValue: string) => {
				// `skills add --global` 只能写主机全局层：项目页不冒充「装进本项目」。
				if (projectId !== undefined) throw new Error(C.unsupported);
				await mutate("skills-install", { action: "skillsInstall", slug: slugValue });
				return { success: true, slug: slugValue, installDir: snapshot?.home + "/.pi/agent/skills" };
			},
			onInstallProgress: () => () => {},
		},
		config: {
			piResourcesSummary: async () => {
				const data = await load();
				return {
					settingsPath: data.home + "/.pi/agent/settings.json",
					exists: true,
					revision: data.settingsVersion,
					entries: { extensions: strings(data.settings.extensions), skills: strings(data.settings.skills), prompts: strings(data.settings.prompts), themes: strings(data.settings.themes) },
					builtins: PI_BUILTIN_EXTENSIONS.map((value) => ({ name: value, enabled: enabled("extensions", "builtin:" + value), explicitInLayer: strings(data.settings.extensions).some((entry) => entry === "+builtin:" + value || entry === "-builtin:" + value), state: "inherit" as const })),
				};
			},
			piResourcesSetBuiltin: async (input: { name: string; enabled: boolean; expectedRevision?: string }) => {
				await mutate("settings", { action: "builtin", name: input.name, expectedVersion: input.expectedRevision ?? snapshot?.settingsVersion ?? "", enabled: input.enabled });
				await load();
				return { ok: true };
			},
		},
	};
}
function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}
