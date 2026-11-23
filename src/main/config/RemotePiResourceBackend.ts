import { PROJECT_HOST_ID_PATTERN } from "../../shared/projectLocation";
import { createHash } from "node:crypto";
import { REMOTE_RESOURCE_CODES as C, type RemoteResourceFile, type RemoteResourceResult } from "../../shared/types/remotePiManagement";
import { quotePosixArgument } from "../remote/RemoteBootstrapContract";
import { parsePiListOutput } from "../extensions/piExtensionCatalog";
import { supportsPiSelfUpdate } from "../pi/piSelfUpdateRunner";
import { collectRemoteConfigSecrets } from "./RemotePiConfigBackend";
import { getAppLogger } from "../logging/sharedLogger";
import type { ProjectResourceDiscoveryResult } from "../../shared/types/app";
import { enrichRemoteExtensionVersions } from "./remoteExtensionVersions";

type Ports = {
	request(hostId: string, method: string, params: unknown): Promise<unknown>;
	/**
	 * One request on the session that is confined to `root`.
	 *
	 * A project layer must never be served by whatever session the host happens to hold: the host lock is
	 * taken for the whole frame (`withProjectSession`), so two projects that share a host cannot observe each
	 * other's root mid-operation.
	 */
	requestProject(hostId: string, root: string, method: string, params: unknown): Promise<unknown>;
	/** Registered project id → the host it belongs to and the canonical root the helper is started with. */
	resolveProject(projectId: string): Promise<{ hostId: string; root: string } | { code: string }>;
	resolveFacts(hostId: string): Promise<{ piPath: string; nodePath: string; version: string; home: string }>;
	run(input: { hostId: string; remoteCommand: string; timeoutMs?: number }): Promise<{ exitCode: number; stdout: string; stderr?: string }>;
};
function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
const roots = ["skills", "agents-skills", "prompts", "extensions"];
const hex = /^[0-9a-f]{64}$/;
function refPath(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 1024 && !/[\\%\u0000-\u001f\u007f]/.test(value) && value.split("/").length <= 12 && !value.split("/").some((part) => !part || part.startsWith(".") || part === "node_modules");
}
function file(value: unknown): RemoteResourceFile {
	if (
		!record(value) ||
		Object.keys(value).sort().join(",") !== "content,path,root,version" ||
		typeof value.root !== "string" ||
		!roots.includes(value.root) ||
		!refPath(value.path) ||
		typeof value.content !== "string" ||
		value.content.includes("\0") ||
		Buffer.byteLength(value.content, "utf8") > 1048576 ||
		typeof value.version !== "string" ||
		!hex.test(value.version) ||
		createHash("sha256").update(value.content).digest("hex") !== value.version
	)
		throw new Error(C.fileInvalid);
	// Parse into the closed reference union only after validating it.
	const root = value.root;
	if (root !== "skills" && root !== "agents-skills" && root !== "prompts" && root !== "extensions") throw new Error(C.fileInvalid);
	return { root, path: value.path, content: value.content, version: value.version };
}
function safeSource(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length < 2048 && !/[\u0000-\u001f\u007f]/.test(value) && /^(?:npm:|github:|git:|https?:\/\/|file:|\/|\.\.?\/)/i.test(value) && !/https?:\/\/[^/]*@/.test(value);
}
/** Rebuild discovery metadata without forwarding arbitrary helper fields or file contents. */
function discovery(value: unknown, scope: string): ProjectResourceDiscoveryResult {
	if (!record(value) || !Array.isArray(value.skills) || !Array.isArray(value.prompts) || !Array.isArray(value.extensions) || value.skills.length + value.prompts.length + value.extensions.length > 2000) throw new Error(C.fileInvalid);
	const text = (entry: Record<string, unknown>, key: string): string => {
		const result = entry[key];
		if (typeof result !== "string" || result.length > (key === "description" ? 16384 : 4096) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(result)) throw new Error(C.fileInvalid);
		return result;
	};
	const metadata = (entry: unknown) => {
		if (!record(entry) || !["package-user", "settings-user", "package-project", "settings-project"].includes(String(entry.sourceId)) || typeof entry.enabled !== "boolean" || entry.managed !== true || typeof entry.path !== "string" || !entry.path.startsWith("/")) throw new Error(C.fileInvalid);
		if (entry.physicalScope !== undefined && entry.physicalScope !== "user" && entry.physicalScope !== "project") throw new Error(C.fileInvalid);
		return { path: text(entry, "path"), sourceId: text(entry, "sourceId"), sourceLabel: text(entry, "sourceLabel"), enabled: entry.enabled, managed: true, ...(entry.physicalScope === "project" ? { physicalScope: "project" as const } : {}) };
	};
	/** The project layer's own `-<path>` overrides: bounded absolute paths, rebuilt so no helper field leaks. */
	const overrideList = (candidate: unknown): string[] => {
		if (candidate === undefined) return [];
		if (!Array.isArray(candidate) || candidate.length > 2000) throw new Error(C.fileInvalid);
		for (const entry of candidate) if (typeof entry !== "string" || entry.length === 0 || entry.length > 4096 || /[\u0000-\u001f\u007f]/.test(entry)) throw new Error(C.fileInvalid);
		return candidate.map((entry: string) => entry);
	};
	const overrides = record(value.overrides) ? value.overrides : {};
	return {
		projectResourcesAllowed: scope === "project",
		overrides: {
			disabledGlobalSkills: overrideList(overrides.disabledGlobalSkills),
			disabledGlobalPrompts: overrideList(overrides.disabledGlobalPrompts),
			disabledGlobalExtensions: overrideList(overrides.disabledGlobalExtensions),
		},
		skills: value.skills.map((entry: unknown) => {
			const common = metadata(entry);
			if (!record(entry) || typeof entry.userOnly !== "boolean") throw new Error(C.fileInvalid);
			return { ...common, id: text(entry, "id"), name: text(entry, "name"), dir: text(entry, "dir"), description: text(entry, "description"), userOnly: entry.userOnly };
		}),
		prompts: value.prompts.map((entry: unknown) => {
			const common = metadata(entry);
			if (!record(entry)) throw new Error(C.fileInvalid);
			return { ...common, name: text(entry, "name"), description: text(entry, "description") };
		}),
		extensions: value.extensions.map((entry: unknown) => {
			const common = metadata(entry);
			if (!record(entry) || (entry.physicalScope !== "user" && entry.physicalScope !== "project")) throw new Error(C.fileInvalid);
			return { ...common, source: text(entry, "source"), physicalScope: entry.physicalScope === "project" ? "project" : "user" };
		}),
	};
}

/** One host, one closed resource operation. Failures never reach a local manager or replay a mutation. */
export function createRemotePiResourceBackend(ports: Ports) {
	return {
		async execute(hostId: unknown, input: unknown): Promise<RemoteResourceResult> {
			if (typeof hostId !== "string" || !PROJECT_HOST_ID_PATTERN.test(hostId) || !record(input) || typeof input.action !== "string") throw new Error(C.invalid);
			if (Buffer.byteLength(JSON.stringify(input), "utf8") > 2 * 1048576) throw new Error(C.fileInvalid);
			const action = input.action;
			const scope = input.scope === undefined ? "global" : input.scope;
			if (scope !== "global" && scope !== "project") throw new Error(C.invalid);
			if (input.projectId !== undefined && (typeof input.projectId !== "string" || input.projectId.trim().length === 0 || input.projectId.length > 256)) throw new Error(C.invalid);
			// Pi package verbs run in the host's HOME; a project layer has no `pi install` of its own.
			if (scope === "project" && (action === "skillsInstall" || action === "packages")) throw new Error(C.unsupported);
			if (action === "skillsInstall") return installSkill(hostId, withoutLayer(input));
			if (action === "packages") return packages(hostId, withoutLayer(input));
			const shapes: Record<string, string[]> = {
				list: ["action"],
				read: ["action", "ref"],
				create: ["action", "content", "ref"],
				write: ["action", "content", "expectedVersion", "ref"],
				rename: ["action", "expectedVersion", "name", "ref"],
				delete: ["action", "expectedVersion", "ref"],
				toggle: ["action", "enabled", "expectedVersion", "ref"],
				toggleInherited: ["action", "enabled", "key", "kind"],
				togglePackage: ["action", "enabled", "expectedVersion", "source"],
				builtin: ["action", "enabled", "expectedVersion", "name"],
			};
			const allowed = new Set([...(Object.hasOwn(shapes, action) ? shapes[action] : []), "scope", "projectId"]);
			if (!Object.hasOwn(shapes, action) || Object.keys(input).some((key) => !allowed.has(key))) throw new Error(C.invalid);
			if ("ref" in input) {
				const ref = input.ref;
				if (!record(ref) || Object.keys(ref).sort().join(",") !== "path,root" || !roots.includes(String(ref.root)) || !refPath(ref.path)) throw new Error(C.fileInvalid);
			}
			if ("expectedVersion" in input && (typeof input.expectedVersion !== "string" || !hex.test(input.expectedVersion))) throw new Error(C.conflict);
			if (action === "toggleInherited") {
				if (!["skill", "prompt", "extension"].includes(String(input.kind)) || typeof input.enabled !== "boolean") throw new Error(C.invalid);
				// The key is a verified absolute path from an earlier list; a relative or control-byte key would
				// write a rule pi silently ignores instead of toggling the inherited resource.
				if (typeof input.key !== "string" || !input.key.startsWith("/") || input.key.length > 4096 || /[\u0000-\u001f\u007f]/.test(input.key)) throw new Error(C.fileInvalid);
			}
			/* A project layer must name its project: an omitted id would silently fall back to the host's global
			   user resources, which is the defect this scope exists to prevent. */
			if (scope === "project" && input.projectId === undefined) throw new Error(C.invalid);
			const projectRoot = scope === "project" ? await targetRoot(hostId, String(input.projectId)) : undefined;
			const { action: _action, scope: _scope, projectId: _projectId, ...rest } = input;
			const params = scope === "project" ? { ...rest, scope: "project" } : rest;
			const mutation = action !== "list" && action !== "read";
			let result: unknown;
			try {
				result = projectRoot === undefined ? await ports.request(hostId, "resources." + action, params) : await ports.requestProject(hostId, projectRoot, "resources." + action, params);
			} catch (error) {
				const code = record(error) ? String(error.code ?? error.message) : "";
				if (/VERSION_CONFLICT/.test(code)) throw new Error(C.conflict);
				if (code === "METHOD_NOT_FOUND") throw new Error(C.unsupported);
				if (/RESULT_UNCONFIRMED/.test(code)) throw new Error(C.unconfirmed);
				if (/^(?:RESOURCE_(?:INPUT_INVALID|PATH_INVALID|NOT_FOUND|TOO_LARGE)|CONFIG_(?:FILE_INVALID|PATH_UNSUPPORTED|FILE_TOO_LARGE))$/.test(code)) {
					// 2026-11-19：这四个 helper 拒绝被映成一个码后，用户只看到 PI_RESOURCE_FILE_INVALID，
					// 分不出「某个文件太大」与「数据形状不对」。日志里留下原始码再映射。
					getAppLogger()?.warn("remoteResources", "Remote resource helper refused", { hostId, action, code });
					throw new Error(C.fileInvalid);
				}
				if (code === "RESOURCE_UNAVAILABLE" || code === "CONFIG_UNAVAILABLE") throw new Error(C.unavailable);
				throw new Error(mutation ? C.unconfirmed : C.unavailable);
			}
			try {
				if (action === "list") {
					if (!record(result) || !Array.isArray(result.files) || result.files.length > 2000 || typeof result.home !== "string" || !result.home.startsWith("/") || /[\u0000-\u001f\u007f]/.test(result.home) || !record(result.settings) || typeof result.settingsVersion !== "string" || !hex.test(result.settingsVersion))
						throw new Error(C.fileInvalid);
					if (Buffer.byteLength(JSON.stringify(result), "utf8") > 6 * 1048576) throw new Error(C.fileInvalid);
					collectRemoteConfigSecrets(result.settings);
					const files = result.files.map(file);
					if (new Set(files.map((entry) => entry.root + "/" + entry.path)).size !== files.length) throw new Error(C.fileInvalid);
					const reportedScope = result.scope === undefined ? "global" : result.scope;
					if (reportedScope !== "global" && reportedScope !== "project") throw new Error(C.fileInvalid);
					if (reportedScope !== scope) throw new Error(C.fileInvalid);
					const reportedRoot = result.projectRoot === undefined || result.projectRoot === null ? null : result.projectRoot;
					if (reportedRoot !== null && (typeof reportedRoot !== "string" || !reportedRoot.startsWith("/") || /[\u0000-\u001f\u007f]/.test(reportedRoot))) throw new Error(C.fileInvalid);
					if ((scope === "project") !== (reportedRoot !== null)) throw new Error(C.fileInvalid);
					return { home: result.home, scope, projectRoot: reportedRoot, files, settings: result.settings, settingsVersion: result.settingsVersion, discovery: discovery(result.discovery, scope) };
				}
				if (["delete", "toggle", "toggleInherited", "togglePackage", "builtin"].includes(action)) {
					if (!record(result) || result.applied !== true) throw new Error(C.fileInvalid);
					return { applied: true };
				}
				const saved = file(result);
				if (record(input.ref) && (saved.root !== input.ref.root || (action !== "rename" && saved.path !== input.ref.path))) throw new Error(C.fileInvalid);
				if ((action === "write" || action === "create") && saved.content !== input.content) throw new Error(C.fileInvalid);
				return saved;
			} catch (error) {
				getAppLogger()?.warn("remoteResources", "Remote resource result failed validation", { hostId, action, reason: error instanceof Error ? error.message : String(error) });
				throw new Error(mutation ? C.unconfirmed : C.fileInvalid);
			}
		},
	};
	function withoutLayer(value: Record<string, unknown>): Record<string, unknown> {
		const { scope: _scope, projectId: _projectId, ...rest } = value;
		return rest;
	}
	/**
	 * Resolve one registered project id to the root its helper session is confined to.
	 *
	 * The host id the renderer passed is re-checked against the catalog: a request that pairs host A with a
	 * project that lives on host B is refused instead of being served by whichever session is warm. A project
	 * that is not an enrolled SSH project (or no longer exists) is a stable code, never a fallback to the
	 * local manager.
	 */
	async function targetRoot(hostId: string, projectId: string): Promise<string> {
		let resolved: { hostId: string; root: string } | { code: string };
		try {
			resolved = await ports.resolveProject(projectId);
		} catch (error) {
			getAppLogger()?.warn("remoteResources", "Remote project resolution failed", { hostId, projectId, reason: error instanceof Error ? error.message : String(error) });
			throw new Error(C.unavailable);
		}
		if ("code" in resolved) throw new Error(C.invalid);
		if (typeof resolved.hostId !== "string" || typeof resolved.root !== "string" || resolved.hostId !== hostId || !resolved.root.startsWith("/") || resolved.root.length > 4096 || /[\u0000-\u001f\u007f]/.test(resolved.root)) throw new Error(C.invalid);
		return resolved.root;
	}
	async function installSkill(hostId: string, input: Record<string, unknown>): Promise<RemoteResourceResult> {
		if (Object.keys(input).sort().join(",") !== "action,slug" || typeof input.slug !== "string" || input.slug.length > 512 || !/^[A-Za-z0-9_][A-Za-z0-9_.-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(input.slug)) throw new Error(C.fileInvalid);
		const facts = await ports.resolveFacts(hostId);
		const nodeDir = facts.nodePath.slice(0, facts.nodePath.lastIndexOf("/"));
		for (const value of [facts.home, facts.nodePath]) if (!value.startsWith("/") || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(C.unavailable);
		const parts = input.slug.split("/");
		// Use npx from the same verified Node installation. No login shell or PATH search selects executable code.
		const command = "cd " + quotePosixArgument(facts.home) + " && PATH=" + quotePosixArgument(nodeDir) + ':"$PATH" ' + [facts.nodePath, nodeDir + "/npx", "--yes", "skills", "add", parts.slice(0, 2).join("/"), "--skill", parts[2], "--agent", "pi", "--global", "--copy", "--yes"].map(quotePosixArgument).join(" ");
		let result;
		try {
			result = await ports.run({ hostId, remoteCommand: command, timeoutMs: 300000 });
		} catch {
			throw new Error(C.unconfirmed);
		}
		if (result.exitCode !== 0) throw new Error(C.commandFailed);
		return { applied: true };
	}

	/** Fixed Pi package verbs on the verified host; no arbitrary argv, shell, cwd or executable from renderer. */
	async function packages(hostId: string, input: Record<string, unknown>): Promise<RemoteResourceResult> {
		if (Object.keys(input).some((key) => !["action", "operation", "source", "includeVersions"].includes(key)) || !["list", "install", "remove", "update"].includes(String(input.operation))) throw new Error(C.invalid);
		const operation = input.operation;
		if (input.includeVersions !== undefined && (operation !== "list" || typeof input.includeVersions !== "boolean")) throw new Error(C.invalid);
		if (((operation === "install" || operation === "remove") && !safeSource(input.source)) || (input.source !== undefined && !safeSource(input.source)) || (operation === "list" && input.source !== undefined)) throw new Error(C.fileInvalid);
		const facts = await ports.resolveFacts(hostId);
		for (const value of [facts.home, facts.piPath, facts.nodePath]) if (typeof value !== "string" || !value.startsWith("/") || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(C.unavailable);
		// pi 1.x bare update can self-update Pi itself. Package updates always use --extensions there.
		const args = operation === "update" && input.source === undefined ? (supportsPiSelfUpdate(facts.version) ? ["update", "--extensions"] : ["update"]) : [String(operation), ...(typeof input.source === "string" ? [input.source] : [])];
		const nodeDir = facts.nodePath.slice(0, facts.nodePath.lastIndexOf("/"));
		const command = "cd " + quotePosixArgument(facts.home) + " && PATH=" + quotePosixArgument(nodeDir) + ':"$PATH" ' + [facts.nodePath, facts.piPath, ...args, "--no-approve"].map(quotePosixArgument).join(" ");
		let result;
		try {
			result = await ports.run({ hostId, remoteCommand: command, timeoutMs: operation === "list" ? 30000 : 300000 });
		} catch {
			throw new Error(operation === "list" ? C.unavailable : C.unconfirmed);
		}
		if (result.exitCode !== 0) throw new Error(C.commandFailed);
		if (Buffer.byteLength(result.stdout, "utf8") > 1048576) throw new Error(operation === "list" ? C.fileInvalid : C.unconfirmed);
		// Only list has a useful output contract. Install logs may contain registry credentials: never forward them.
		const entries = operation === "list" ? parsePiListOutput(result.stdout).filter((entry) => entry.scope === "user" && safeSource(entry.source)) : [];
		const extensions = operation === "list" && input.includeVersions !== false ? await enrichRemoteExtensionVersions(hostId, facts, entries, ports.run) : entries;
		return { output: operation === "list" ? "" : "pi " + args.join(" "), extensions };
	}
}

export type RemotePiResourceBackend = ReturnType<typeof createRemotePiResourceBackend>;
