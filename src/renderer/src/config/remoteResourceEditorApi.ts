import type { PiDesktopApi } from "../../../preload";
import type { PiExtensionListResult, PiExtensionSummary, PiPromptTemplateSummary, PiSkillListResult, PiSkillSummary } from "../../../shared/types";
import { REMOTE_RESOURCE_CODES as C, type RemoteResourceFile, type RemoteResourceList, type RemoteResourceRequest, type RemoteResourceResult } from "../../../shared/types/remotePiManagement";
import { PI_BUILTIN_EXTENSIONS, PI_RESOURCE_KINDS } from "../../../shared/types/piResources";
import { writeClipboard } from "../utils/clipboard";
import { showNotice } from "../utils/notice";
import { t } from "../i18n";
import { minimatch } from "minimatch";
import { convertStoreVarsToPiVars } from "../../../shared/promptStoreVariables";

const rootPaths = { skills: ".pi/agent/skills", "agents-skills": ".agents/skills", prompts: ".pi/agent/prompts", extensions: ".pi/agent/extensions" };
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

/** Host-bound resource facade. File operations accept only references obtained from this host's list. */
export function createRemoteResourceEditorApi(api: PiDesktopApi, hostId: string, connected: () => Promise<void>) {
	let snapshot: RemoteResourceList | undefined;
	let loading: Promise<RemoteResourceList> | undefined;
	let epoch = 0;
	const listed = new Map<string, RemoteResourceFile>();
	const editing = new Map<string, RemoteResourceFile>();
	const pending = new Set<string>();
	const blocked = new Map<string, string>();
	const pathOf = (file: RemoteResourceFile) => (snapshot?.home ?? "") + "/" + rootPaths[file.root] + "/" + file.path;
	async function call(input: RemoteResourceRequest): Promise<RemoteResourceResult> {
		await connected();
		return api.remotePiResources(hostId, input);
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
			for (const file of result.files) listed.set(pathOf(file), file);
			return result;
		})();
		loading = operation;
		try {
			return await operation;
		} finally {
			if (loading === operation) loading = undefined;
		}
	}
	function lookup(path: string) {
		const file = listed.get(path);
		if (!file) throw new Error(C.fileInvalid);
		return file;
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
	function enabled(kind: string, value: string): boolean {
		const entries = snapshot?.settings[kind];
		if (!Array.isArray(entries)) return true;
		const base = (snapshot?.home ?? "") + "/.pi/agent/";
		const normalized = (entry: string) => (entry.startsWith("~/") ? snapshot?.home + entry.slice(1) : entry.startsWith("/") || entry.startsWith("builtin:") ? entry : base + entry.replace(/^\.\//, ""));
		const exact = (entry: string) => {
			const item = normalized(entry);
			return item === value || (value.endsWith("/SKILL.md") && item === value.slice(0, -9));
		};
		let result = true;
		for (const entry of entries)
			if (typeof entry === "string" && entry.startsWith("!")) {
				const pattern = entry.slice(1).startsWith("~/") ? normalized(entry.slice(1)) : entry.slice(1);
				const parent = value.endsWith("/SKILL.md") ? value.slice(0, -9) : "";
				if ([value, value.startsWith(base) ? value.slice(base.length) : value, value.split("/").at(-1) ?? "", parent, parent.startsWith(base) ? parent.slice(base.length) : parent, parent.split("/").at(-1) ?? ""].some((item) => item && minimatch(item, pattern))) result = false;
			}
		if (entries.some((entry) => typeof entry === "string" && entry.startsWith("+") && exact(entry.slice(1)))) result = true;
		if (entries.some((entry) => typeof entry === "string" && entry.startsWith("-") && exact(entry.slice(1)))) result = false;
		return result;
	}
	function skill(file: RemoteResourceFile): PiSkillSummary {
		const path = pathOf(file),
			directory = file.path.endsWith("/SKILL.md");
		const title = field(file.content, "name") || (directory ? (file.path.split("/").at(-2) ?? "") : file.path.replace(/\.md$/i, ""));
		return {
			id: path,
			name: title,
			description: field(file.content, "description"),
			path,
			dir: path.slice(0, path.lastIndexOf("/")),
			sourceId: file.root === "agents-skills" ? "agents-global" : "pi-global",
			sourceLabel: file.root === "agents-skills" ? "~/.agents/skills" : "~/.pi/agent/skills",
			type: directory ? "directory" : "markdown",
			enabled: enabled("skills", path),
			valid: !!field(file.content, "name") && !!field(file.content, "description"),
			warnings: [],
			userOnly: field(file.content, "disable-model-invocation") === "true",
		};
	}
	function prompt(file: RemoteResourceFile): PiPromptTemplateSummary {
		return { name: file.path.replace(/\.md$/i, ""), path: pathOf(file), description: field(file.content, "description"), content: file.content, userCreated: true, scope: "global", enabled: enabled("prompts", pathOf(file)) };
	}
	async function readContent(path: string): Promise<string> {
		const file = lookup(path);
		const result = await call({ action: "read", ref: { root: file.root, path: file.path } });
		if (!isFile(result) || result.root !== file.root || result.path !== file.path) throw new Error(C.fileInvalid);
		blocked.delete(path);
		editing.set(path, result);
		return result.content;
	}
	async function writeContent(path: string, content: string): Promise<void> {
		const file = editing.get(path);
		if (!file) throw new Error(C.conflict);
		const result = await mutate(path, { action: "write", ref: { root: file.root, path: file.path }, expectedVersion: file.version, content });
		if (!isFile(result)) throw new Error(C.unconfirmed);
		editing.set(path, result);
		listed.set(path, result);
	}
	async function toggle(path: string, state: boolean) {
		const file = lookup(path);
		if (!snapshot) throw new Error(C.conflict);
		await mutate("settings", { action: "toggle", ref: { root: file.root, path: file.path }, expectedVersion: snapshot.settingsVersion, enabled: state });
		await load();
	}
	async function remove(path: string) {
		const file = lookup(path);
		await mutate(path, { action: "delete", ref: { root: file.root, path: file.path }, expectedVersion: file.version });
		listed.delete(path);
		editing.delete(path);
	}
	async function rename(path: string, title: string) {
		const file = lookup(path);
		const result = await mutate(path, { action: "rename", ref: { root: file.root, path: file.path }, expectedVersion: file.version, name: name(title) });
		if (!isFile(result)) throw new Error(C.unconfirmed);
		listed.delete(path);
		listed.set(pathOf(result), result);
		return result;
	}
	async function create(root: "skills" | "agents-skills" | "prompts", path: string, content: string) {
		if (!snapshot) await load();
		const result = await mutate(root + "/" + path, { action: "create", ref: { root, path }, content });
		if (!isFile(result)) throw new Error(C.unconfirmed);
		listed.set(pathOf(result), result);
		editing.set(pathOf(result), result);
		return result;
	}
	async function packages(operation: "list" | "install" | "remove" | "update", source?: string) {
		const input: RemoteResourceRequest = { action: "packages", operation, ...(source === undefined ? {} : { source }) };
		const result = operation === "list" ? await call(input) : await mutate("packages", input);
		if (!("extensions" in result)) throw new Error(operation === "list" ? C.fileInvalid : C.unconfirmed);
		return result;
	}
	async function copyPath(path?: string) {
		if (!snapshot) await load();
		await writeClipboard(path ?? snapshot?.home + "/.pi/agent");
		showNotice(t("remoteResources.pathCopied"), 2500);
	}
	const unsupported = async (): Promise<never> => {
		throw new Error(C.unsupported);
	};
	return {
		reset() {
			epoch += 1;
			snapshot = undefined;
			loading = undefined;
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
				const data = await load();
				return {
					locations: [
						{ id: "pi-global", label: "~/.pi/agent/skills", path: data.home + "/.pi/agent/skills", rootMarkdownEnabled: true },
						{ id: "agents-global", label: "~/.agents/skills", path: data.home + "/.agents/skills", rootMarkdownEnabled: false },
					],
					skills: data.files.filter((file) => file.root === "skills" || file.root === "agents-skills").map(skill),
				};
			},
			readContent: async (path: string) => ({ content: await readContent(path) }),
			create: async (input: { name: string; description: string; locationId: string }) =>
				skill(await create(input.locationId === "agents-global" ? "agents-skills" : "skills", name(input.name) + "/SKILL.md", "---\nname: " + JSON.stringify(input.name) + "\ndescription: " + JSON.stringify(input.description) + "\n---\n\n")),
			delete: remove,
			rename: async (path: string, value: string) => skill(await rename(path, lookup(path).path.endsWith("/SKILL.md") ? name(value) : name(value) + ".md")),
			toggle: async (path: string, state: boolean) => {
				await toggle(path, state);
				return skill(lookup(path));
			},
			openFolder: copyPath,
		},
		prompts: {
			...api.prompts,
			list: async () => {
				const data = await load();
				return { templates: data.files.filter((file) => file.root === "prompts").map(prompt), globalDir: data.home + "/.pi/agent/prompts" };
			},
			create: async (input: { name: string; description: string }) => prompt(await create("prompts", name(input.name) + ".md", "---\ndescription: " + JSON.stringify(input.description) + "\n---\n\n")),
			edit: (path: string, content?: string) => (content === undefined ? readContent(path) : writeContent(path, content)),
			delete: remove,
			rename: async (old: string, value: string) => {
				const file = [...listed.values()].find((entry) => entry.root === "prompts" && entry.path.replace(/\.md$/i, "") === old);
				if (!file) throw new Error(C.fileInvalid);
				return prompt(await rename(pathOf(file), name(value) + ".md"));
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
			list: async (): Promise<PiExtensionListResult> => {
				const [data, installed] = await Promise.all([load(), packages("list")]);
				const files: PiExtensionSummary[] = data.files.filter((file) => file.root === "extensions" && /\.(?:[cm]?js|ts)$/i.test(file.path)).map((file) => ({ id: pathOf(file), source: file.path, scope: "user", path: pathOf(file), local: true, enabled: enabled("extensions", pathOf(file)) }));
				return {
					extensions: [
						...installed.extensions.map((entry) => {
							const config = Array.isArray(data.settings.packages) ? data.settings.packages.find((value) => typeof value === "object" && value !== null && Reflect.get(value, "source") === entry.source) : undefined;
							const disabled =
								config &&
								PI_RESOURCE_KINDS.every((key) => {
									const filter: unknown = Reflect.get(config, key);
									return Array.isArray(filter) && filter.length === 0;
								});
							return { ...entry, enabled: !disabled };
						}),
						...files,
					],
					raw: "",
				};
			},
			install: async (source: string) => (await packages("install", source)).output,
			uninstall: async (source: string) => {
				const file = [...listed.values()].find((entry) => entry.root === "extensions" && entry.path === source);
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
		projectResources: { ...api.projectResources, discovery: async () => (await load()).discovery },
		promptStore: {
			...api.promptStore,
			import: async (input: { title: string; description: string; content: string }) => {
				const { converted, argumentHint } = convertStoreVarsToPiVars(input.content);
				return prompt(await create("prompts", slug(input.title) + ".md", "---\ndescription: " + JSON.stringify(input.description) + "\nsource: prompts.chat\n" + (argumentHint ? "argument-hint: " + JSON.stringify(argumentHint) + "\n" : "") + "---\n\n" + converted));
			},
		},
		yaoPrompts: {
			...api.yaoPrompts,
			import: async (slugValue: string, category: string) => {
				const detail = await api.yaoPrompts.detail(slugValue, category);
				return prompt(await create("prompts", slug(slugValue) + ".md", "---\ndescription: " + JSON.stringify(detail.description) + "\n---\n\n" + detail.promptContent));
			},
		},
		skillStore: {
			...api.skillStore,
			import: async (item: { title: string; description: string; content: string }, locationId?: string) =>
				skill(await create(locationId === "agents-global" ? "agents-skills" : "skills", slug(item.title) + "/SKILL.md", "---\nname: " + JSON.stringify(slug(item.title)) + "\ndescription: " + JSON.stringify(item.description) + "\n---\n\n" + item.content)),
		},
		skillHub: {
			...api.skillHub,
			install: async (slugValue: string) => {
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
