import type { PiDesktopApi } from "../../../preload";
import { PI_CONFIG_FILE_NAMES, REMOTE_CONFIG_CODES, isPiConfigFileKey, piConfigFileKeyFromName, remotePiConfigCodeFromError, type PiConfigFileKey, type RemotePiConfigSnapshot, type RemoteConfigSecretSource } from "../../../shared/piConfig";
import type { ModelSpec } from "../../../shared/types/modelSpecs";
import type { McpCliListResult, McpConfigFile, McpConfigScope, McpConfigSnapshot, McpProbeResult, McpServerDefinition } from "../../../shared/types/mcp";
import { REMOTE_MCP_CODES } from "../../../shared/types/remotePiManagement";
import { t } from "../i18n";
import type { RemoteModelCatalogEntry } from "../../../shared/types/remoteModel";
import { remoteConfigDocument } from "./remoteConfigDocument";
import { deepEqual } from "../utils/deepEqual";
import { readRemoteConfigSnapshot, readRemoteConfigWriteReceipt } from "./remoteConfigModel";
import { createRemoteAuthEditor } from "./remoteAuthEditorApi";
import { createRemoteResourceEditorApi } from "./remoteResourceEditorApi";

/** One instance per selected SSH host. No configuration operation falls through to local APIs. */
export function createRemoteConfigEditorApi(api: PiDesktopApi, hostId: string, ensureConnected: (hostId: string) => Promise<{ ok: boolean }>, projectId?: string) {
	const snapshots = new Map<string, RemotePiConfigSnapshot>();
	const reads = new Map<string, number>();
	const secretSources: RemoteConfigSecretSource[] = [];
	const blocked = new Map<PiConfigFileKey, string>();
	const pending = new Set<PiConfigFileKey>();
	let catalog: RemoteModelCatalogEntry[] = [];
	let catalogPending: Promise<RemoteModelCatalogEntry[]> | undefined;
	let catalogGeneration = 0;
	let epoch = 0;
	const options = { target: { kind: "ssh" as const, hostId } };
	async function connected(): Promise<void> {
		if (!(await ensureConnected(hostId)).ok) throw new Error(REMOTE_CONFIG_CODES.hostNotReady);
	}
	function resetCatalog(): void {
		catalogGeneration += 1;
		catalog = [];
		catalogPending = undefined;
	}
	const authEditor = createRemoteAuthEditor(api, hostId, connected, resetCatalog);
	const resources = createRemoteResourceEditorApi(api, hostId, connected, projectId);
	async function read(file: PiConfigFileKey, view = "form") {
		const key = `${view}:${file}`;
		const started = epoch;
		const request = (reads.get(key) ?? 0) + 1;
		reads.set(key, request);
		await connected();
		const result = await api.config.getRaw(PI_CONFIG_FILE_NAMES[file], options);
		const snapshot = readRemoteConfigSnapshot(result, { hostId, file });
		if (snapshot === "unsupported" || snapshot === "invalid") throw new Error(snapshot === "unsupported" ? REMOTE_CONFIG_CODES.unsupported : REMOTE_CONFIG_CODES.fileInvalid);
		if (started !== epoch || reads.get(key) !== request) throw new Error(REMOTE_CONFIG_CODES.versionConflict);
		snapshots.set(key, structuredClone(snapshot));
		return { raw: JSON.stringify(snapshot.data, null, 2), parsed: structuredClone(snapshot.data), remote: snapshot };
	}
	async function write(file: PiConfigFileKey, document: unknown, view = "form") {
		const key = `${view}:${file}`;
		const baseline = snapshots.get(key);
		if (!baseline) throw new Error(REMOTE_CONFIG_CODES.versionConflict);
		if (blocked.has(file)) throw new Error(blocked.get(file));
		if (pending.has(file)) throw new Error(REMOTE_CONFIG_CODES.resultUnconfirmed);
		const replacement = remoteConfigDocument(
			document,
			file === "models" && view === "form"
				? secretSources.filter((source) => {
						const providers = typeof document === "object" && document !== null ? Reflect.get(document, "providers") : undefined;
						return typeof providers === "object" && providers !== null && Object.hasOwn(providers, source.to[1]);
					})
				: [],
		);
		if (deepEqual(baseline.data, replacement.data)) return { valid: true };
		pending.add(file);
		try {
			await connected();
			const result = await api.config.saveRaw(PI_CONFIG_FILE_NAMES[file], "", { ...options, expectedVersion: baseline.version, document: replacement });
			if (!result.valid) return result;
			const receipt = readRemoteConfigWriteReceipt(result);
			if (receipt === "invalid" || receipt === "unsupported" || receipt.hostId !== hostId || receipt.file !== file) throw new Error(REMOTE_CONFIG_CODES.resultUnconfirmed);
			// Never manufacture a sanitized baseline from the draft (it may contain a newly entered secret).
			snapshots.delete(key);
			if (file === "models" && view === "form") secretSources.length = 0;
			resetCatalog();
			return result;
		} catch (error) {
			const code = remotePiConfigCodeFromError(error);
			if (code === REMOTE_CONFIG_CODES.versionConflict || code === REMOTE_CONFIG_CODES.resultUnconfirmed) blocked.set(file, code);
			throw error;
		} finally {
			pending.delete(file);
		}
	}
	async function models(force = false): Promise<RemoteModelCatalogEntry[]> {
		if (catalogPending && !force) return catalogPending;
		if (catalog.length && !force) return catalog;
		const started = ++catalogGeneration;
		const operation = (async () => {
			await connected();
			const result = await api.probeRemoteModels(hostId, force);
			if (started !== catalogGeneration) throw new Error(REMOTE_CONFIG_CODES.versionConflict);
			if (!result.ok) {
				if (result.code === "REMOTE_MODEL_PROBE_EMPTY") return [];
				throw new Error(result.code);
			}
			if (result.hostId !== hostId) throw new Error(REMOTE_CONFIG_CODES.fileInvalid);
			catalog = result.models;
			return result.models;
		})();
		catalogPending = operation;
		try {
			return await operation;
		} finally {
			if (catalogPending === operation) catalogPending = undefined;
		}
	}
	const unsupported = async (): Promise<never> => {
		throw new Error(REMOTE_CONFIG_CODES.providerOperationUnsupported);
	};
	/**
	 * 这次 MCP 调用属于哪一层。
	 *
	 * 项目层由同一台主机上「限定在该项目根」的会话服务，只读该项目的 .pi/mcp.json；项目 id 未知或与当前页
	 * 不符时拒绝，而不是退回主机全局文件（那会让用户在项目页里改到主机的配置）。
	 */
	function mcpLayer(scope?: McpConfigScope): { scope: "project"; projectId: string } | Record<string, never> {
		if (scope?.scope !== "project") return {};
		if (projectId === undefined || scope.projectId !== projectId) throw new Error(REMOTE_MCP_CODES.projectScopeUnsupported);
		return { scope: "project", projectId };
	}
	let homePath: Promise<string> | undefined;
	function home(): Promise<string> {
		homePath ??= (async () => {
			await connected();
			const facts = await api.remotePiMcp(hostId, { action: "facts" });
			if (facts.action !== "facts" || typeof facts.home !== "string" || !facts.home.startsWith("/")) {
				homePath = undefined;
				throw new Error(REMOTE_MCP_CODES.unavailable);
			}
			return facts.home;
		})();
		return homePath;
	}
	async function mcpSnapshot(scope?: McpConfigScope): Promise<McpConfigSnapshot> {
		const layer = mcpLayer(scope);
		await connected();
		const result = await api.remotePiMcp(hostId, { action: "snapshot", ...layer });
		if (result.action !== "snapshot" || typeof result.snapshot !== "object" || result.snapshot === null) throw new Error(REMOTE_MCP_CODES.fileInvalid);
		return result.snapshot as McpConfigSnapshot;
	}
	async function mcpSave(data: McpConfigFile, scope?: McpConfigScope, expectedRevision?: string): Promise<{ valid: boolean; error?: string; conflict?: boolean }> {
		const layer = mcpLayer(scope);
		await connected();
		const result = await api.remotePiMcp(hostId, { action: "save", file: data as Record<string, unknown>, expectedVersion: expectedRevision, ...layer });
		if (result.action !== "save") throw new Error(REMOTE_MCP_CODES.fileInvalid);
		return result.valid ? { valid: true } : { valid: false, error: result.error, conflict: result.conflict };
	}
	async function mcpListStatus(scope?: McpConfigScope): Promise<McpCliListResult> {
		const layer = mcpLayer(scope);
		await connected();
		const result = await api.remotePiMcp(hostId, { action: "list", ...layer });
		const report = result.action === "list" ? (result.report as McpCliListResult | undefined) : undefined;
		if (!report || !Array.isArray(report.servers)) throw new Error(REMOTE_MCP_CODES.commandFailed);
		return report;
	}
	async function mcpLogout(server: string, scope?: McpConfigScope): Promise<{ ok: boolean; output: string }> {
		const layer = mcpLayer(scope);
		await connected();
		const result = await api.remotePiMcp(hostId, { action: "logout", server, ...layer });
		if (result.action !== "logout") throw new Error(REMOTE_MCP_CODES.invalid);
		return { ok: result.ok, output: result.output };
	}
	const editor: PiDesktopApi = {
		...api,
		...resources,
		probeRemoteModels: async (_host, force = false) => {
			await connected();
			return api.probeRemoteModels(hostId, force);
		},
		projects: {
			...api.projects,
			listModels: async () => (await models()).map((model) => ({ ...model, name: model.name ?? model.id })),
			getModelSpec: async (provider, id): Promise<ModelSpec | null> => {
				const model = (await models().catch(() => [])).find((entry) => entry.provider === provider && entry.id === id);
				return model ? { contextWindow: model.contextWindow, maxTokens: model.maxTokens, reasoning: model.reasoning, input: model.input, images: model.images, matchedId: model.id, source: "pi-runtime", matchKind: "provider-id" } : null;
			},
		},
		config: {
			...api.config,
			...resources.config,
			getModels: async () => {
				const result = await read("models");
				const providers = result.parsed.providers;
				if (typeof providers !== "object" || providers === null || Array.isArray(providers)) throw new Error(REMOTE_CONFIG_CODES.fileInvalid);
				return { ...result, parsed: { ...result.parsed, providers: Object.fromEntries(Object.entries(providers)) } };
			},
			getSettings: () => read("settings"),
			getTrust: () => read("trust"),
			getAuth: () => authEditor.read(),
			getRaw: async (name) => {
				if (name === "auth.json") return authEditor.read();
				const file = piConfigFileKeyFromName(name);
				if (!isPiConfigFileKey(file)) throw new Error(REMOTE_CONFIG_CODES.unsupported);
				return read(file);
			},
			saveModels: (data) => write("models", data),
			saveSettings: (data) => write("settings", data),
			saveRaw: async (name, raw) => {
				let data: unknown;
				try {
					data = JSON.parse(raw);
				} catch {
					return { valid: false, error: REMOTE_CONFIG_CODES.fileInvalid };
				}
				if (name === "auth.json") return authEditor.write(data);
				const file = piConfigFileKeyFromName(name);
				if (!isPiConfigFileKey(file)) return unsupported();
				return write(file, data);
			},
			fetchModels: async (baseUrl) => {
				const snapshot = snapshots.get("form:models");
				const providers = snapshot?.data.providers;
				const names =
					typeof providers === "object" && providers !== null
						? Object.entries(providers)
								.filter(([, value]) => typeof value === "object" && value !== null && Reflect.get(value, "baseUrl") === baseUrl)
								.map(([name]) => name)
						: [];
				const entries = await models(true);
				return { success: true, models: entries.filter((entry) => names.includes(entry.provider)).map(({ provider: _provider, ...model }) => model) };
			},
			saveAuth: (data) => authEditor.write(data),
			testProvider: unsupported,
			export: unsupported,
			import: unsupported,
			discoverExternalAgents: unsupported,
			resolveExternalAgentKey: unsupported,
			previewProviderMigration: unsupported,
			applyProviderMigration: unsupported,
			getMcp: mcpSnapshot,
			saveMcp: mcpSave,
			// 探测在本机做，与远端不在同一个网络位置：不报“可达”误导用户，指向真正能回答的入口。
			probeMcp: async (definition: McpServerDefinition): Promise<McpProbeResult> => ({ ok: false, transport: typeof definition.url === "string" ? "http" : "stdio", error: t("config.mcp.remoteProbeUnsupported") }),
			mcpListStatus,
			// 登录在主机上跑，授权 URL 由主进程按 event.sender 回推到本窗口（McpTab 已有的 onMcpLoginUrl 订阅负责展示）。
			mcpLogin: async (server: string, timeoutSec?: number, scope?: McpConfigScope, operationId?: string): Promise<{ ok: boolean; output: string }> => {
				const layer = mcpLayer(scope);
				await connected();
				const result = await api.remotePiMcp(hostId, { action: "login", server, timeoutSec: typeof timeoutSec === "number" && Number.isInteger(timeoutSec) && timeoutSec > 0 ? Math.min(timeoutSec, 600) : 240, ...(operationId === undefined ? {} : { operationId }), ...layer });
				if (result.action !== "login") throw new Error(REMOTE_MCP_CODES.invalid);
				return { ok: result.ok, output: result.output };
			},
			mcpLogout,
			// AI 设置技能是 PiDeck 随包/本机资源，远端主机上没有它可装：明确失败，不假装装到了主机上。
			installMcpSetupSkill: async () => ({ success: false }),
		},
	};
	/** Raw and structured drafts keep separate versions so one saved view cannot overwrite the other. */
	const rawApi: PiDesktopApi = {
		...editor,
		config: {
			...editor.config,
			getRaw: async (name) => {
				if (name === "auth.json") return authEditor.read("raw");
				const file = piConfigFileKeyFromName(name);
				if (!isPiConfigFileKey(file)) return unsupported();
				return read(file, "raw");
			},
			saveRaw: async (name, text) => {
				let data: unknown;
				try {
					data = JSON.parse(text);
				} catch {
					return { valid: false, error: REMOTE_CONFIG_CODES.fileInvalid };
				}
				if (name === "auth.json") return authEditor.write(data, "raw");
				const file = piConfigFileKeyFromName(name);
				if (!isPiConfigFileKey(file)) return unsupported();
				return write(file, data, "raw");
			},
		},
	};
	return Object.assign(editor, {
		rawApi,
		reloadRemoteConfig: () => {
			epoch += 1;
			authEditor.reset();
			resources.reset();
			homePath = undefined;
			snapshots.clear();
			blocked.clear();
			resetCatalog();
			secretSources.length = 0;
		},
		loadRemoteModels: models,
		fetchRemoteProviderModels: async (provider: string) => ({ success: true, models: (await models(true)).filter((entry) => entry.provider === provider).map(({ provider: _provider, ...model }) => model) }),
		copyProviderSecrets: (from: string, to: string) => {
			const original = secretSources.find((entry) => entry.to[1] === from)?.from[1] ?? from;
			const providers = snapshots.get("form:models")?.data.providers;
			if (typeof providers !== "object" || providers === null || !Object.hasOwn(providers, original)) return;
			const previous = secretSources.findIndex((entry) => entry.to[1] === to);
			if (previous >= 0) secretSources.splice(previous, 1);
			secretSources.push({ from: ["providers", original], to: ["providers", to] });
		},
	});
}
