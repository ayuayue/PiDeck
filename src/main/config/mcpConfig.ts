/**
 * pi 内置 MCP（0.99.2）的 mcp.json 校验、合并与轻量探测。
 * 不启动 MCP SDK / 不 spawn 用户 command：探测只检查命令是否在 PATH、HTTP URL 是否可达。
 * 两层配置：全局 `<agentDir>/mcp.json` 与已信任项目 `<project>/.pi/mcp.json`；
 * 同名 server 以后层定义**整体替换**前层（pi 语义，不是字段级浅合并）。
 * 两个作用域都可作为可写目标：全局页写 agentDir，项目页写项目 .pi/mcp.json。
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import type { McpConfigFile, McpConfigLayer, McpConfigLayerKind, McpConfigSnapshot, McpProbeResult, McpServerDefinition, McpServerListItem, McpServerTransport } from "../../shared/types/mcp";
import { resolveExposureAlias, resolveExposureAliases } from "../../shared/mcpExposure";
import { createProjectFileReadBoundary, resolveProjectFileReadPath, type ProjectFileReadBoundary } from "../files/projectFileAccess";
import { revisionOf, stripBom, writePiConfigFile } from "./piConfigFileStore";

const MCP_DOCS_URL = "https://earendil-works.github.io/pi/docs/mcp";
const HTTP_PROBE_TIMEOUT_MS = 8_000;
/** pi 原生：`^[A-Za-z0-9_-]+$`（下划线/短横线开头也合法），无长度上限。 */
const SERVER_NAME_RE = /^[A-Za-z0-9_-]+$/;

/** pi 1.0.1 项目覆盖条目允许的字段（无传输，只覆盖全局同名 server 的这几项）。 */
export const MCP_PROJECT_OVERRIDE_KEYS = ["enabled", "exposure", "toolExposure"] as const;

const LAYER_KIND_ORDER: McpConfigLayerKind[] = ["pi-agent", "project-pi"];

export function mcpDocsUrl(): string {
	return MCP_DOCS_URL;
}

/** `~/.pi/agent` → 用户 home；WSL 场景传入 windowsHome 映射后的 configDir。 */
export function homeFromPiAgentDir(configDir: string): string {
	const trimmed = configDir.replace(/[\\/]+$/, "");
	const piDir = trimmed.replace(/[\\/]+agent$/i, "");
	const home = piDir.replace(/[\\/]+\.pi$/i, "");
	return home || homedir();
}

export function mcpLayerPaths(home: string, piAgentDir: string, projectPath?: string): McpConfigLayer[] {
	const layers: McpConfigLayer[] = [{ kind: "pi-agent", path: join(piAgentDir, "mcp.json"), exists: false, writable: true }];
	if (projectPath?.trim()) {
		layers.push({ kind: "project-pi", path: join(projectPath.trim(), ".pi", "mcp.json"), exists: false, writable: false });
	}
	return layers;
}

export function isMcpServerName(name: string): boolean {
	const trimmed = name.trim();
	return trimmed.length > 0 && !/[\\/]/.test(trimmed) && SERVER_NAME_RE.test(trimmed);
}

/** 服务器名归一后的命名空间（pi 把 `-` 换成 `_`；同名冲突以这个为准）。 */
export function mcpNamespaceKey(name: string): string {
	return name.replace(/-/g, "_");
}

export function inferMcpTransport(def: McpServerDefinition): McpServerTransport | null {
	const hasCommand = typeof def.command === "string" && def.command.trim().length > 0;
	const hasUrl = typeof def.url === "string" && def.url.trim().length > 0;
	const count = Number(hasCommand) + Number(hasUrl);
	if (count !== 1) return null;
	return hasCommand ? "stdio" : "http";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 解析 mcp.json 原文。
 *
 * UTF-8 BOM 必须剥掉：Windows PowerShell 5.1 的 `Out-File` / `Set-Content` 默认写 BOM，
 * 用户手改一次 mcp.json 就带上，裸 JSON.parse 会整文件解析失败。pi 1.4.0 起自己的
 * mcp.json 读取也走 stripBom（#11191），两边口径必须一致——否则同一份文件 pi 能加载、
 * PiDeck 报「配置损坏」并拦住保存与导入，用户被卡在中间且看不出原因。
 */
export function parseMcpConfigFile(raw: string): { file: McpConfigFile; error?: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripBom(raw));
	} catch (error) {
		return { file: { mcpServers: {} }, error: error instanceof Error ? error.message : String(error) };
	}
	if (!isPlainObject(parsed)) {
		return { file: { mcpServers: {} }, error: "mcp.json must be a JSON object" };
	}
	const mcpServers = parsed.mcpServers;
	if (mcpServers !== undefined && !isPlainObject(mcpServers)) {
		return { file: { mcpServers: {} }, error: "mcpServers must be an object" };
	}
	const file: McpConfigFile = {};
	for (const [key, value] of Object.entries(parsed)) {
		file[key] = value;
	}
	if (mcpServers) {
		const normalizedServers: Record<string, McpServerDefinition> = {};
		let entryError: string | undefined;
		for (const [name, value] of Object.entries(mcpServers)) {
			// 非对象条目保留原文（用原始值 round-trip），让上层校验报错；不在这里中断整文件解析，
			// 也不清掉已经解析成功的条目。只记录错误，可视化保存由 writableError 拦住。
			const definition = normalizeMcpServerDefinition(value);
			if (!definition && entryError === undefined) entryError = `Server "${name}" must be an object`;
			normalizedServers[name] = definition ?? (value as McpServerDefinition);
		}
		file.mcpServers = normalizedServers;
		if (entryError) return { file, error: entryError };
	}
	return { file };
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
	if (!isPlainObject(value)) return undefined;
	const out: Record<string, string> = {};
	for (const [key, item] of Object.entries(value)) {
		if (typeof item === "string") out[key] = item;
	}
	return out;
}

/** 浅合并时丢掉 undefined，避免 `{ enabled: false }` 把下层 command/url 冲成空。 */
function omitUndefined(value: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		if (item !== undefined) out[key] = item;
	}
	return out;
}

function normalizeOAuth(value: unknown): McpServerDefinition["oauth"] {
	if (!isPlainObject(value)) return undefined;
	const oauth: McpServerDefinition["oauth"] = {
		clientId: typeof value.clientId === "string" ? value.clientId : undefined,
		clientSecret: typeof value.clientSecret === "string" ? value.clientSecret : undefined,
		callbackPort: typeof value.callbackPort === "number" ? value.callbackPort : undefined,
		callbackUrl: typeof value.callbackUrl === "string" ? value.callbackUrl : undefined,
		scope: typeof value.scope === "string" ? value.scope : undefined,
	};
	return Object.values(oauth).some((item) => item !== undefined) ? oauth : undefined;
}

/** 取字符串记录，但保留原始值：非全字符串时原样返回，交给校验报错，避免归一化吞掉非法值。 */
function keepStringRecord(value: unknown): Record<string, string> | undefined {
	if (!isPlainObject(value)) return undefined;
	return Object.values(value).every((item) => typeof item === "string") ? (value as Record<string, string>) : (value as Record<string, string>);
}

/**
 * 收窄未知 JSON 为定义；未知扩展字段经 rest 原样保留，且**不改写非法已知值**——
 * 归一化之前先做校验（validateMcpServerValue），归一化只做无损整形，否则可视化保存
 * 会把 `timeout:"abc"` 这类用户数据默默删掉。
 */
export function normalizeMcpServerDefinition(value: unknown): McpServerDefinition | null {
	if (!isPlainObject(value)) return null;
	const definition: McpServerDefinition = { ...value };
	if (Array.isArray(value.args)) {
		definition.args = value.args.every((item) => typeof item === "string") ? [...value.args] : (value.args as string[]);
	}
	if (value.env !== undefined && isPlainObject(value.env)) definition.env = keepStringRecord(value.env);
	if (value.headers !== undefined && isPlainObject(value.headers)) definition.headers = keepStringRecord(value.headers);
	if (value.oauth !== undefined && isPlainObject(value.oauth)) definition.oauth = { ...(value.oauth as McpServerDefinition["oauth"]) };
	if (value.toolExposure !== undefined && isPlainObject(value.toolExposure)) {
		definition.toolExposure = Object.values(value.toolExposure).every((item) => typeof item === "string") ? ({ ...value.toolExposure } as McpServerDefinition["toolExposure"]) : (value.toolExposure as McpServerDefinition["toolExposure"]);
	}
	if (value.auth !== undefined && isPlainObject(value.auth)) definition.auth = { ...(value.auth as McpServerDefinition["auth"]) };
	return definition;
}

/**
 * MCP exposure 别名归一（纯函数）：主进程与渲染层共用 `shared/mcpExposure.ts`，避免两份定义。
 * 此处 re-export 兼容既有调用点与测试。
 */
export { resolveExposureAlias, resolveExposureAliases };

/** 服务名归一后的命名空间是否与另一个名字冲突（pi 据此拒绝同名冲突的 server）。 */
export function mcpNamespacesClash(left: string, right: string): boolean {
	return left !== right && mcpNamespaceKey(left) === mcpNamespaceKey(right);
}

export type McpServerMergeResult = {
	servers: McpServerListItem[];
	invalidServers: Array<{ name: string; path: string; error: string; raw: unknown }>;
};

/**
 * 按 pi 语义从低到高合并（全局 → 项目）：同名 server 由后层**整体替换**前层，
 * 不是字段级浅合并（`{enabled:false}` 不会继承下层的 command/url）。
 * 无效条目按 pi 行为报告并跳过：项目无效时保留已生效的全局项；
 * 命名空间与已生效名字冲突的条目同样跳过并报错。
 */
export function mergeMcpServersWithErrors(layers: Array<{ path: string; kind: McpConfigLayerKind; file: McpConfigFile }>, writablePath: string, options: { validateScope?: (kind: McpConfigLayerKind) => string | null } = {}): McpServerMergeResult {
	const merged = new Map<string, McpServerListItem>();
	const invalidServers: McpServerMergeResult["invalidServers"] = [];
	for (const layer of layers) {
		const servers = layer.file.mcpServers;
		if (!servers) continue;
		for (const [name, rawDef] of Object.entries(servers)) {
			const scopeError = options.validateScope?.(layer.kind);
			const def = normalizeMcpServerDefinition(rawDef);
			if (!def) {
				invalidServers.push({ name, path: layer.path, error: `server "${name}" must be an object`, raw: rawDef });
				continue;
			}
			const error = scopeError ?? validateMcpServerValue(name, def, { scope: layer.kind });
			if (error) {
				invalidServers.push({ name, path: layer.path, error, raw: rawDef });
				continue;
			}
			// pi 1.0.1 项目覆盖形态：无传输条目部分覆盖已生效的全局定义（enabled/exposure/toolExposure），
			// 传输与凭据继承全局；全局层不存在同名 server 时按 pi 行为报错跳过。
			if (layer.kind === "project-pi" && isPlainObject(rawDef) && rawDef.command === undefined && rawDef.url === undefined && rawDef.type === undefined) {
				const base = merged.get(name);
				if (!base) {
					invalidServers.push({ name, path: layer.path, error: `server "${name}" needs "command" or "url", or a global server to override`, raw: rawDef });
					continue;
				}
				const combined = normalizeMcpServerDefinition({ ...base.definition, ...def });
				if (!combined) {
					invalidServers.push({ name, path: layer.path, error: `server "${name}" must be an object`, raw: rawDef });
					continue;
				}
				merged.set(name, { ...base, definition: combined, originPath: layer.path, originScope: layer.kind, ownedByWritable: layer.path === writablePath });
				continue;
			}
			const clash = [...merged.keys()].find((other) => mcpNamespacesClash(other, name));
			if (clash) {
				invalidServers.push({ name, path: layer.path, error: `server "${name}" conflicts with "${clash}" (names that differ only in "-" and "_" share a namespace)`, raw: rawDef });
				continue;
			}
			merged.set(name, {
				name,
				definition: def,
				originPath: layer.path,
				originScope: layer.kind,
				ownedByWritable: layer.path === writablePath,
			});
		}
	}
	return { servers: [...merged.values()].sort((left, right) => left.name.localeCompare(right.name)), invalidServers };
}

/** 兼容入口：只要有效列表（旧调用点/测试）。 */
export function mergeMcpServers(layers: Array<{ path: string; file: McpConfigFile }>, writablePath: string): McpServerListItem[] {
	return mergeMcpServersWithErrors(
		layers.map((layer) => ({ ...layer, kind: layer.path === writablePath ? ("pi-agent" as McpConfigLayerKind) : ("project-pi" as McpConfigLayerKind) })),
		writablePath,
	).servers;
}

/** 有效 exposure 值（pi 0.99.2：`codemode-deferred` 是别名，不在 canonical 列表里）。 */
export const MCP_CANONICAL_EXPOSURES = ["codemode", "deferred", "direct", "hidden"] as const;
const MCP_EXPOSURE_VALUES = new Set<string>([...MCP_CANONICAL_EXPOSURES, "codemode-deferred"]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isExposureValue(value: unknown): value is NonNullable<McpServerDefinition["exposure"]> {
	return typeof value === "string" && MCP_EXPOSURE_VALUES.has(value);
}

function validateOAuth(oauth: unknown): string | null {
	if (oauth === undefined) return null;
	if (!isPlainObject(oauth)) return "oauth must be an object";
	if (oauth.clientId !== undefined && typeof oauth.clientId !== "string") return "oauth.clientId must be a string";
	if (oauth.clientSecret !== undefined && typeof oauth.clientSecret !== "string") return "oauth.clientSecret must be a string";
	const port = oauth.callbackPort;
	if (port !== undefined && (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)) {
		return "oauth.callbackPort must be a port number";
	}
	if (oauth.callbackUrl !== undefined) {
		if (typeof oauth.callbackUrl !== "string") return "oauth.callbackUrl must be a string";
		let parsed: URL;
		try {
			parsed = new URL(oauth.callbackUrl);
		} catch {
			return "oauth.callbackUrl must be an http URI on localhost, 127.0.0.1, or [::1] without query or fragment";
		}
		if (parsed.protocol !== "http:" || !LOOPBACK_HOSTS.has(parsed.hostname) || parsed.search !== "" || parsed.hash !== "") {
			return "oauth.callbackUrl must be an http URI on localhost, 127.0.0.1, or [::1] without query or fragment";
		}
		if (parsed.port !== "" && typeof port === "number" && Number(parsed.port) !== port) {
			return "oauth.callbackUrl and oauth.callbackPort name different ports";
		}
	}
	if (oauth.scope !== undefined && typeof oauth.scope !== "string") return "oauth.scope must be a string";
	if (oauth.clientName !== undefined && (typeof oauth.clientName !== "string" || !oauth.clientName.trim())) {
		return "oauth.clientName must be a non-empty string";
	}
	// pi 1.0.1：clientRegistration 选 dcr（动态注册，默认）或 cimd（Client ID Metadata Document）。
	// cimd 用 pi.dev 的元数据文档标识客户端，不能与预注册的 clientId/clientName 组合，
	// 且回调地址必须是 localhost/127.0.0.1 上的 /callback（[::1] 不行）。
	if (oauth.clientRegistration !== undefined && oauth.clientRegistration !== "dcr" && oauth.clientRegistration !== "cimd") {
		return 'oauth.clientRegistration must be "dcr" or "cimd"';
	}
	if (oauth.clientRegistration === "cimd") {
		if (oauth.clientId !== undefined || oauth.clientName !== undefined) {
			return 'oauth.clientRegistration "cimd" cannot be combined with oauth.clientId or oauth.clientName';
		}
		if (typeof oauth.callbackUrl === "string") {
			let callbackUrl: URL;
			try {
				callbackUrl = new URL(oauth.callbackUrl);
			} catch {
				return "oauth.callbackUrl must be an http URI on localhost, 127.0.0.1, or [::1] without query or fragment";
			}
			if (callbackUrl.hostname === "[::1]" || callbackUrl.pathname !== "/callback") {
				return 'oauth.clientRegistration "cimd" requires oauth.callbackUrl on localhost or 127.0.0.1 with path /callback';
			}
		}
	}
	if (oauth.authServerMetadataUrl !== undefined) {
		if (typeof oauth.authServerMetadataUrl !== "string") return "oauth.authServerMetadataUrl must be a string";
		let metadataUrl: URL;
		try {
			metadataUrl = new URL(oauth.authServerMetadataUrl);
		} catch {
			return "oauth.authServerMetadataUrl must be an https URL, or http on localhost, 127.0.0.1, or [::1]";
		}
		if (metadataUrl.protocol !== "https:" && !LOOPBACK_HOSTS.has(metadataUrl.hostname)) {
			return "oauth.authServerMetadataUrl must be an https URL, or http on localhost, 127.0.0.1, or [::1]";
		}
	}
	return null;
}

/** 只接受字符串记录；非字符串值时返回 undefined 让上层报“must map names to strings”。 */
function allStrings(value: unknown): value is Record<string, string> {
	return isPlainObject(value) && Object.values(value).every((item) => typeof item === "string");
}

/**
 * 校验**原始** server 值，遵守 pi 0.99.2 `validateMcpServerConfig` 的字段规则。
 * 在归一化之前调用，保证非法类型被报错而不是被静默丢弃。
 */
export function validateMcpServerValue(name: string, value: unknown, options: { scope?: McpConfigLayerKind } = {}): string | null {
	if (!isMcpServerName(name)) {
		return `invalid server name "${name}" (use letters, digits, "_" and "-")`;
	}
	if (!isPlainObject(value)) return `server "${name}" must be an object`;

	// exposure 兼容别名先归一，与 pi 一致。
	const exposure = resolveExposureAlias(value.exposure);
	const toolExposure = value.toolExposure;
	const type = value.type;

	if (exposure !== undefined && !isExposureValue(exposure)) {
		return `server "${name}": exposure must be one of "codemode", "deferred", "direct", "hidden"`;
	}
	if (toolExposure !== undefined) {
		if (!isPlainObject(toolExposure)) return `server "${name}": toolExposure must map tool names to exposures`;
		for (const [tool, entry] of Object.entries(toolExposure)) {
			if (!isExposureValue(resolveExposureAlias(entry))) return `server "${name}": toolExposure "${tool}" must be one of "codemode", "deferred", "direct", "hidden"`;
		}
	}
	if (value.enabled !== undefined && typeof value.enabled !== "boolean") return `server "${name}": enabled must be a boolean`;
	if (value.description !== undefined && typeof value.description !== "string") return `server "${name}": description must be a string`;
	if (value.timeout !== undefined && (typeof value.timeout !== "number" || !(value.timeout > 0))) {
		return `server "${name}": timeout must be a positive number of seconds`;
	}

	if (type === "sse") return `server "${name}": legacy SSE transport is not supported; use the streamable HTTP URL`;
	if (type !== undefined && type !== "stdio" && type !== "http" && type !== "streamable-http") {
		return `server "${name}": type must be "stdio", "http", or "streamable-http"`;
	}

	if (typeof value.url === "string" && (type === undefined || type === "http" || type === "streamable-http")) {
		let parsed: URL;
		try {
			parsed = new URL(value.url);
		} catch {
			return `server "${name}": url must be an http or https URL`;
		}
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return `server "${name}": url must be an http or https URL`;
		if (value.headers !== undefined && !allStrings(value.headers)) return `server "${name}": headers must map names to strings`;
		const oauthError = validateOAuth(value.oauth);
		if (oauthError) return `server "${name}": ${oauthError}`;
		if (value.auth !== undefined) {
			if (!isPlainObject(value.auth) || typeof value.auth.provider !== "string" || !value.auth.provider) {
				return `server "${name}": auth.provider must be a provider name`;
			}
			if (options.scope === "project-pi") return `server "${name}": auth is only allowed in the global mcp.json`;
			if (parsed.protocol !== "https:" && !LOOPBACK_HOSTS.has(parsed.hostname)) {
				return `server "${name}": auth requires an https URL, or http on localhost, 127.0.0.1, or [::1]`;
			}
		}
		return null;
	}

	if (typeof value.command === "string" && (type === undefined || type === "stdio")) {
		if (value.args !== undefined && !(Array.isArray(value.args) && value.args.every((arg) => typeof arg === "string"))) {
			return `server "${name}": args must be an array of strings`;
		}
		if (value.env !== undefined && !allStrings(value.env)) return `server "${name}": env must map names to strings`;
		if (value.cwd !== undefined && typeof value.cwd !== "string") return `server "${name}": cwd must be a string`;
		return null;
	}

	// pi 1.0.1 项目覆盖形态：无 command/url/type 的条目只覆盖全局同名 server 的
	// enabled/exposure/toolExposure（传输与凭据继承全局）。仅项目层合法；
	// 全局层仍必须给出完整传输定义。
	if (options.scope === "project-pi" && value.command === undefined && value.url === undefined && type === undefined) {
		const extra = Object.keys(value).filter((key) => !(MCP_PROJECT_OVERRIDE_KEYS as readonly string[]).includes(key));
		if (extra.length > 0) return `server "${name}": a project override can only set ${MCP_PROJECT_OVERRIDE_KEYS.join(", ")}`;
		return null;
	}

	return `server "${name}" needs either "command" (stdio) or "url" (streamable HTTP)`;
}

/** 兼容入口：已归一化的定义。`enabled:false` 仍必需传输（pi 也是这样）。 */
export function validateMcpServer(name: string, def: McpServerDefinition, options: { scope?: McpConfigLayerKind } = {}): string | null {
	return validateMcpServerValue(name, def, options);
}

export function validateMcpConfigFile(file: McpConfigFile, options: { scope?: McpConfigLayerKind } = {}): string | null {
	const servers = file.mcpServers ?? {};
	if (!isPlainObject(servers)) return "mcpServers must be an object";
	if (file.autoEnableCodemode !== undefined && typeof file.autoEnableCodemode !== "boolean") {
		return "autoEnableCodemode must be a boolean";
	}
	const seen: string[] = [];
	for (const [name, raw] of Object.entries(servers)) {
		// 先校验原始值（归一化会丢掉非法类型，不能让它变成“没有错误”）。
		const error = validateMcpServerValue(name, raw, options);
		if (error) return error;
		const clash = seen.find((other) => mcpNamespacesClash(other, name));
		if (clash) return `server "${name}" conflicts with "${clash}" (names that differ only in "-" and "_" share a namespace)`;
		seen.push(name);
	}
	return null;
}

function whichOnPath(command: string, pathEnv = process.env.PATH ?? "", platform = process.platform): string | null {
	const trimmed = command.trim().replace(/^"|"$/g, "");
	if (!trimmed) return null;
	if (isAbsolute(trimmed)) return existsSync(trimmed) ? trimmed : null;
	const extensions = platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean) : [""];
	for (const dir of pathEnv.split(delimiter)) {
		if (!dir) continue;
		const direct = join(dir, trimmed);
		if (existsSync(direct)) return direct;
		for (const ext of extensions) {
			if (!ext) continue;
			const candidate = join(dir, trimmed + (ext.startsWith(".") ? ext : `.${ext}`));
			if (existsSync(candidate)) return candidate;
			if (platform === "win32" && !trimmed.toLowerCase().endsWith(ext.toLowerCase())) {
				const withExt = join(dir, `${trimmed}${ext}`);
				if (existsSync(withExt)) return candidate;
			}
		}
	}
	return null;
}

export function probeStdioCommand(command: string, options?: { pathEnv?: string; platform?: NodeJS.Platform }): McpProbeResult {
	const resolved = whichOnPath(command, options?.pathEnv, options?.platform);
	if (!resolved) {
		return { ok: false, transport: "stdio", error: `Command not found: ${command}` };
	}
	return { ok: true, transport: "stdio", detail: resolved };
}

function isHttpReachableStatus(status: number): boolean {
	// MCP HTTP 端点对裸 GET 常回 404/405/406，只要能连上就视为配置可达。
	return status >= 200 && status < 500;
}

type HttpGet = (input: string, init?: RequestInit) => Promise<{ status: number }>;

export async function probeHttpUrl(url: string, fetchImpl?: HttpGet, timeoutMs = HTTP_PROBE_TIMEOUT_MS): Promise<McpProbeResult> {
	const request: HttpGet | undefined = fetchImpl ?? (typeof globalThis.fetch === "function" ? (input, init) => globalThis.fetch(input, init) : undefined);
	if (!request) {
		return { ok: false, transport: "http", error: "fetch is not available" };
	}
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return { ok: false, transport: "http", error: "URL is invalid" };
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return { ok: false, transport: "http", error: "URL must be http(s)" };
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await request(parsed.toString(), {
			method: "GET",
			redirect: "manual",
			signal: controller.signal,
			headers: { accept: "application/json, text/event-stream, */*" },
		});
		if (!isHttpReachableStatus(response.status)) {
			return {
				ok: false,
				transport: "http",
				error: `HTTP ${response.status}`,
			};
		}
		return { ok: true, transport: "http", detail: `HTTP ${response.status}` };
	} catch (error) {
		const aborted = error instanceof Error && error.name === "AbortError";
		return {
			ok: false,
			transport: "http",
			error: aborted ? "Timed out" : error instanceof Error ? error.message : String(error),
		};
	} finally {
		clearTimeout(timer);
	}
}

export async function probeMcpServer(def: McpServerDefinition): Promise<McpProbeResult> {
	const transport = inferMcpTransport(def);
	if (!transport) {
		return { ok: false, error: "Each server needs exactly one of command or url" };
	}
	if (transport === "stdio") return probeStdioCommand(def.command ?? "");
	return probeHttpUrl(def.url ?? "");
}

async function readMcpLayerFile(path: string, projectBoundary?: ProjectFileReadBoundary): Promise<{ exists: boolean; file: McpConfigFile; raw: string; error?: string }> {
	try {
		const readPath = projectBoundary ? await resolveProjectFileReadPath(projectBoundary, path) : path;
		const raw = await readFile(readPath, "utf8");
		const parsed = parseMcpConfigFile(raw);
		return { exists: true, file: parsed.file, raw, error: parsed.error };
	} catch {
		return { exists: false, file: { mcpServers: {} }, raw: "" };
	}
}

export async function loadMcpConfigSnapshot(piAgentDir: string, projectPath?: string, home = homeFromPiAgentDir(piAgentDir), options: { writableScope?: McpConfigLayerKind; projectTrusted?: boolean } = {}): Promise<McpConfigSnapshot> {
	const declared = mcpLayerPaths(home, piAgentDir, projectPath);
	const writableScope: McpConfigLayerKind = options.writableScope ?? "pi-agent";
	const loaded: Array<{ path: string; kind: McpConfigLayerKind; file: McpConfigFile }> = [];
	const layers: McpConfigLayer[] = [];
	let writableFile: McpConfigFile = { mcpServers: {} };
	let writableRaw = `${JSON.stringify({ mcpServers: {} }, null, 2)}
`;
	let writableExists = false;
	let writablePath = join(piAgentDir, "mcp.json");
	let writableError: string | undefined;
	let projectBoundary: ProjectFileReadBoundary | undefined;
	if (projectPath) {
		try {
			projectBoundary = await createProjectFileReadBoundary(projectPath);
		} catch {
			// Missing/unreadable project roots expose no project MCP layers.
		}
	}

	for (const layer of declared) {
		const projectLayer = layer.kind === "project-pi";
		const result = projectLayer && !projectBoundary ? { exists: false, file: { mcpServers: {} }, raw: "" } : await readMcpLayerFile(layer.path, projectLayer ? projectBoundary : undefined);
		// 可写层由调用方指定的作用域决定：全局页写 agentDir，项目页写项目 .pi/mcp.json。
		const isWritable = layer.kind === writableScope;
		layers.push({ ...layer, exists: result.exists, writable: isWritable });
		if (isWritable) {
			writablePath = layer.path;
			writableError = result.error;
			writableExists = result.exists;
			writableRaw =
				result.exists && result.raw
					? result.raw
					: `${JSON.stringify({ mcpServers: {} }, null, 2)}
`;
			// JSON 损坏时 parsed 是空对象兜底，不能拿去可视化保存，否则会覆盖用户原文件。
			// 其他层的非法值也保留在 writableFile 里，由校验报错而不是静默清掉。
			writableFile = result.exists && !result.error ? result.file : { mcpServers: {} };
		}
		if (result.exists && !result.error) {
			// 未信任项目不参与合并（pi 不会读未信任项目的 .pi/mcp.json）。
			if (layer.kind === "project-pi" && options.projectTrusted === false) continue;
			loaded.push({ path: layer.path, kind: layer.kind, file: result.file });
		}
	}

	const merged = mergeMcpServersWithErrors(loaded, writablePath);
	// 已存 OAuth 凭据的 server 名：读 mcp-auth.json 的键名（mcp__<名>|<url>，历史版本是裸 URL 键）。
	// 只读键名，凭据值永不进内存/日志。
	let oauthCredentialNames: string[] = [];
	try {
		const authRaw = await readFile(join(piAgentDir, "mcp-auth.json"), "utf8");
		const parsedAuth: unknown = JSON.parse(authRaw);
		if (parsedAuth && typeof parsedAuth === "object" && !Array.isArray(parsedAuth)) {
			const keys = Object.keys(parsedAuth as Record<string, unknown>);
			const byUrl = new Map(loaded.flatMap((layer) => Object.entries(layer.file.mcpServers ?? {}).map(([name, def]) => [typeof def.url === "string" ? def.url : "", name])));
			const knownNames = new Set(loaded.flatMap((layer) => Object.keys(layer.file.mcpServers ?? {})));
			oauthCredentialNames = [...new Set(keys.map((key) => (key.startsWith("mcp__") ? key.slice(5).split("|")[0] : (byUrl.get(key) ?? ""))).filter((name) => name && knownNames.has(name)))].sort();
		}
	} catch {
		// 没有 mcp-auth.json / 解析失败：视为没有任何已存凭据。
	}
	// 可写层以下各层定义过的名字：项目层删除覆盖时，UI 据此区分「回退为继承」与「消失」。
	const lowerLayerNames = [...new Set(loaded.filter((layer) => layer.kind !== writableScope).flatMap((layer) => Object.keys(layer.file.mcpServers ?? {})))].sort();
	return {
		writablePath,
		writableFile,
		writableRaw,
		writableError,
		revision: revisionOf(writableRaw, writableExists),
		oauthCredentialNames,
		lowerLayerNames,
		layers,
		servers: merged.servers,
		invalidServers: merged.invalidServers,
	};
}

/**
 * 把可视化表单的可写层写回 mcp.json（乐观锁）。
 *
 * 锁内重读 + revision 比对：不匹配 = 文件被外部（pi/手改/其它实例）改过，拒绝覆盖并
 * 返回 conflict，让页面重新加载。mutate 只替换 mcpServers 键，顶层未知字段保留。
 */
export async function saveMcpConfigFile(path: string, file: McpConfigFile, options: { expectedRevision?: string } = {}): Promise<{ ok: boolean; error?: string; conflict?: boolean; revision?: string }> {
	const validationError = validateMcpConfigFile(file);
	if (validationError) return { ok: false, error: validationError };
	const result = await writePiConfigFile(path, (current) => ({ ...current, mcpServers: file.mcpServers }), { expectedRevision: options.expectedRevision });
	if (!result.ok) return { ok: false, error: result.error, conflict: result.conflict, revision: result.revision };
	return { ok: true, revision: result.revision };
}

export function upsertWritableServer(writable: McpConfigFile, name: string, definition: McpServerDefinition): McpConfigFile {
	return {
		...writable,
		mcpServers: {
			...(writable.mcpServers ?? {}),
			[name]: definition,
		},
	};
}

export function removeWritableServer(writable: McpConfigFile, name: string): McpConfigFile {
	const next = { ...(writable.mcpServers ?? {}) };
	delete next[name];
	return { ...writable, mcpServers: next };
}

export { LAYER_KIND_ORDER };
