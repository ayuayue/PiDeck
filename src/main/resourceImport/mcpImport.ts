import type { McpProbeResult, McpServerDefinition, McpServerTransport } from "../../shared/types/mcp";
import type { ResourceImportCandidate, ResourceImportSourceStatus, StoredResourceImportCandidate } from "../../shared/types/resourceImport";
import { addUnique, isRecord, redactPreviewArgs, redactPreviewUrl, safeMessage, PROBE_CONCURRENCY, PROBE_TIMEOUT_MS, redactPreviewCommand, redactSensitiveList, redactSensitiveText, PREVIEW_TEXT_MAX } from "./common";
import { isMcpServerName, validateMcpServerValue } from "../config/mcpConfig";
import { parseCodexToml } from "./toml";

export type McpSourceParse = Record<string, unknown>;
export type McpSourceEntry = { name: string; value: unknown };

function stringRecord(value: unknown): Record<string, string> | undefined {
	if (!isRecord(value)) return undefined;
	const result: Record<string, string> = {};
	for (const [key, item] of Object.entries(value)) {
		if (typeof item === "string") result[key] = item;
	}
	return result;
}

/** Parse one Claude JSON or Codex TOML source without exposing parse details to the UI. */
export function parseMcpSource(raw: string, codex: boolean, sourceStatus: ResourceImportSourceStatus): McpSourceParse | null {
	if (codex) {
		const parsedToml = parseCodexToml(raw);
		if (parsedToml.error) {
			sourceStatus.error = "Codex TOML could not be parsed.";
			return null;
		}
		return parsedToml.value;
	}
	try {
		const value: unknown = JSON.parse(raw);
		if (!isRecord(value)) {
			sourceStatus.error = "Source JSON must be an object.";
			return null;
		}
		return value;
	} catch {
		sourceStatus.error = "Source JSON could not be parsed.";
		return null;
	}
}

/** Extract a server map from the two vendors' different top-level spellings. */
export function extractMcpServers(parsed: McpSourceParse, codex: boolean): McpSourceEntry[] {
	return extractMcpServersWithStatus(parsed, codex);
}

/** Extract servers and, when supplied, report a malformed vendor server map. */
export function extractMcpServersWithStatus(parsed: McpSourceParse, codex: boolean, status?: ResourceImportSourceStatus): McpSourceEntry[] {
	const value = parsed[codex ? "mcp_servers" : "mcpServers"];
	if (isRecord(value)) return Object.entries(value).map(([name, item]) => ({ name, value: item }));
	if (value !== undefined) {
		if (status) status.error = codex ? "Codex MCP server map must be an object." : "MCP server map must be an object.";
		return [];
	}
	if (!codex) {
		// A few Claude exports are a bare map rather than { mcpServers: ... }.
		const entries = Object.entries(parsed);
		const transportKeys = ["command", "url", "socket", "type", "args", "env", "headers"];
		if (
			entries.length > 0 &&
			entries.every(([, item]) => {
				if (!isRecord(item)) return false;
				return transportKeys.some((key) => key in item);
			})
		) {
			return entries.map(([name, item]) => ({ name, value: item }));
		}
	}
	return [];
}

/** Convert a vendor definition to the PiDeck MCP schema. */
export function convertMcpDefinition(raw: Record<string, unknown>, codex: boolean, warnings: string[], blockers: string[]): McpServerDefinition | null {
	// Claude calls this field `type`; a few Codex exporters use `transport`.  Treat
	// either spelling as a declaration so an unsupported value gets a useful blocker
	// instead of the less actionable "transport missing" message.
	const declaredTransport = raw.type ?? raw.transport;
	if (raw.type !== undefined && typeof raw.type !== "string") {
		blockers.push("Transport type must be a string.");
		return null;
	}
	if (raw.transport !== undefined && typeof raw.transport !== "string") {
		blockers.push("Transport type must be a string.");
		return null;
	}
	if (typeof raw.type === "string" && typeof raw.transport === "string" && raw.type.trim().toLowerCase() !== raw.transport.trim().toLowerCase()) {
		blockers.push("Multiple transport declarations were found.");
		return null;
	}
	const type = typeof declaredTransport === "string" ? declaredTransport.trim().toLowerCase() : undefined;
	if (typeof declaredTransport === "string" && !type) {
		blockers.push("Transport type is empty.");
		return null;
	}
	// pi 0.99 只支持 stdio / http（streamable-http 为 http 的别名）；socket 与 legacy SSE 都不再受支持。
	if (type && type !== "http" && type !== "streamable-http" && type !== "stdio") {
		blockers.push(type === "socket" ? "Socket transport is not supported; use a stdio command or an HTTP URL." : `Unsupported transport: ${type}`);
		return null;
	}

	const command = typeof raw.command === "string" && raw.command.trim() ? raw.command : undefined;
	const url = typeof raw.url === "string" && raw.url.trim() ? raw.url : undefined;
	const socket = typeof raw.socket === "string" && raw.socket.trim() ? raw.socket : undefined;
	const transportCount = Number(Boolean(command)) + Number(Boolean(url)) + Number(Boolean(socket));
	if (socket) {
		blockers.push("Socket transport is not supported; use a stdio command or an HTTP URL.");
		return null;
	}
	if (transportCount !== 1) {
		blockers.push("Exactly one transport is required.");
		return null;
	}
	if ((type === "http" || type === "streamable-http") && !url) {
		blockers.push("Transport type does not match the configured fields.");
		return null;
	}
	if (type === "stdio" && !command) {
		blockers.push("Transport type does not match the configured fields.");
		return null;
	}

	const definition: McpServerDefinition = {};
	// A source field is only treated as preserved when this specific transport
	// writes it to the PiDeck definition, or when a dedicated warning already
	// explains why a competing spelling was ignored. A static allow-list here
	// would hide valid source fields (for example HTTP `env`) that PiDeck cannot
	// represent on that transport.
	const convertedOrReportedKeys = new Set<string>(["type", "transport"]);
	if (command) {
		definition.command = command;
		convertedOrReportedKeys.add("command");
		if (Array.isArray(raw.args)) {
			definition.args = raw.args.filter((item): item is string => typeof item === "string");
			if (definition.args.length !== raw.args.length) addUnique(warnings, "Some command arguments were not strings and were omitted.");
		} else if (raw.args !== undefined) {
			addUnique(warnings, "Command arguments were not an array and were omitted.");
		}
		convertedOrReportedKeys.add("args");
		if (isRecord(raw.env)) {
			definition.env = stringRecord(raw.env);
			if (Object.values(raw.env).some((value) => typeof value !== "string")) addUnique(warnings, "Some environment values were not strings and were omitted.");
			if (Object.values(raw.env).some((value) => typeof value === "string" && looksUnresolved(value))) addUnique(warnings, "Environment variables may be missing at runtime.");
		} else if (raw.env !== undefined) {
			addUnique(warnings, "Environment variables were not an object and were omitted.");
		}
		convertedOrReportedKeys.add("env");
		if (typeof raw.cwd === "string" && raw.cwd.trim()) {
			definition.cwd = raw.cwd;
		} else if (raw.cwd !== undefined) {
			addUnique(warnings, "Working directory was not a non-empty string and was omitted.");
		}
		convertedOrReportedKeys.add("cwd");
	}
	if (url) {
		definition.url = url;
		convertedOrReportedKeys.add("url");
		const headerValue = raw.headers ?? raw.http_headers;
		if (isRecord(headerValue)) {
			definition.headers = stringRecord(headerValue);
			if (Object.values(headerValue).some((value) => typeof value !== "string")) addUnique(warnings, "Some header values were not strings and were omitted.");
			if (Object.values(headerValue).some((value) => typeof value === "string" && looksUnresolved(value))) addUnique(warnings, "HTTP headers may be missing at runtime.");
		} else if (headerValue !== undefined && headerValue !== null) {
			addUnique(warnings, "HTTP headers were not an object and were omitted.");
		}
		if (raw.headers !== undefined && raw.headers !== null) convertedOrReportedKeys.add("headers");
		else if (raw.http_headers !== undefined && raw.http_headers !== null) convertedOrReportedKeys.add("http_headers");
		if (isRecord(raw.headers) && isRecord(raw.http_headers)) {
			addUnique(warnings, "Both headers fields were present; the standard headers field was used.");
			convertedOrReportedKeys.add("http_headers");
		}
	}
	// 原生字段：description / exposure / toolExposure / oauth 能表达就保留，否则上报警告。
	if (typeof raw.description === "string" && raw.description.trim()) {
		definition.description = raw.description;
		convertedOrReportedKeys.add("description");
	} else if (raw.description !== undefined) {
		addUnique(warnings, "Server description was not a non-empty string and was omitted.");
		convertedOrReportedKeys.add("description");
	}
	if (typeof raw.exposure === "string") {
		definition.exposure = raw.exposure as McpServerDefinition["exposure"];
		convertedOrReportedKeys.add("exposure");
	}
	if (isRecord(raw.toolExposure) && Object.values(raw.toolExposure).every((item) => typeof item === "string")) {
		definition.toolExposure = { ...raw.toolExposure } as McpServerDefinition["toolExposure"];
		convertedOrReportedKeys.add("toolExposure");
	} else if (raw.toolExposure !== undefined) {
		addUnique(warnings, "toolExposure was not a map of exposure values and was omitted.");
		convertedOrReportedKeys.add("toolExposure");
	}
	if (typeof raw.timeout === "number" && raw.timeout > 0) {
		definition.timeout = raw.timeout;
		convertedOrReportedKeys.add("timeout");
	} else if (raw.timeout !== undefined) {
		addUnique(warnings, "Timeout was not a positive number and was omitted.");
		convertedOrReportedKeys.add("timeout");
	}
	if (isRecord(raw.oauth)) {
		definition.oauth = { ...raw.oauth } as McpServerDefinition["oauth"];
		convertedOrReportedKeys.add("oauth");
	}
	if (codex && typeof raw.enabled === "boolean") {
		// 原生唯一开关是 `enabled`：Codex 的 false → `enabled:false`；true 是默认值，不写。
		if (raw.enabled === false) definition.enabled = false;
		convertedOrReportedKeys.add("enabled");
	}
	// 旧客户端字段 `disabled` 只在明确提供时迁移成原生 `enabled:false`，冲突则报告。
	if (!codex && typeof raw.disabled === "boolean") {
		if (raw.disabled === true && definition.enabled === undefined) definition.enabled = false;
		else if (raw.disabled === true && definition.enabled === true) addUnique(warnings, "Conflicting enabled/disabled values; enabled was kept.");
		convertedOrReportedKeys.add("disabled");
	}

	for (const key of Object.keys(raw)) {
		if (!convertedOrReportedKeys.has(key)) addUnique(warnings, `Field not preserved: ${key.replace(/[\r\n]/g, " ").slice(0, 80)}`);
	}
	if ("token" in raw || "api_key" in raw || "apiKey" in raw || "bearer_token" in raw) {
		addUnique(warnings, "Authentication values require manual verification.");
	}

	const validationError = validateMcpServerValue("candidate", definition);
	if (validationError) {
		blockers.push("Converted MCP definition is invalid.");
		return null;
	}
	return definition;
}

function looksUnresolved(value: string): boolean {
	return value.trim().length === 0 || /^\$\{[^}]+\}$/.test(value.trim()) || /^\$[A-Z_][A-Z0-9_]*$/i.test(value.trim());
}

export function mcpTransportOf(definition: McpServerDefinition | null): McpServerTransport | undefined {
	if (!definition) return undefined;
	// pi 0.99 不支持 socket 传输：转换器已在入口拦截，这里不会产生 socket 定义。
	if (definition.command) return "stdio";
	if (definition.url) return "http";
	return undefined;
}

type ProbeProvider = {
	probeMcpServer?: (definition: McpServerDefinition) => Promise<McpProbeResult>;
};

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("probe-timeout")), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** Probe valid definitions with a small concurrency cap; never returns vendor secrets. */
export async function probeMcpCandidates(provider: ProbeProvider, candidates: StoredResourceImportCandidate[]): Promise<void> {
	const probeMcpServer = provider.probeMcpServer;
	if (typeof probeMcpServer !== "function") return;
	const pending = candidates.filter((candidate) => candidate.importable && candidate.mcpDefinition);
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < pending.length) {
			const candidate = pending[next++];
			if (!candidate.mcpDefinition) continue;
			try {
				const result = await withTimeout(probeMcpServer.call(provider, candidate.mcpDefinition), PROBE_TIMEOUT_MS);
				if (!result.ok) {
					addUnique(candidate.warnings, result.transport === "stdio" ? "Command was not found on PATH." : result.transport === "http" ? "URL could not be reached during the compatibility check." : "MCP endpoint could not be reached during the compatibility check.");
				}
			} catch {
				addUnique(candidate.warnings, "Compatibility check timed out or failed.");
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, pending.length) }, () => worker()));
}

export function publicMcpCandidate(candidate: StoredResourceImportCandidate): ResourceImportCandidate {
	const { sourcePath: _sourcePath, sourcePathLexical: _sourcePathLexical, sourceFingerprint: _sourceFingerprint, mcpDefinition: _mcpDefinition, ...publicCandidate } = candidate;
	return {
		...publicCandidate,
		name: redactSensitiveText(publicCandidate.name, PREVIEW_TEXT_MAX),
		targetName: redactSensitiveText(publicCandidate.targetName, PREVIEW_TEXT_MAX),
		sourcePathLabel: redactSensitiveText(publicCandidate.sourcePathLabel, PREVIEW_TEXT_MAX),
		description: redactSensitiveText(publicCandidate.description, PREVIEW_TEXT_MAX),
		warnings: redactSensitiveList(publicCandidate.warnings),
		blockers: redactSensitiveList(publicCandidate.blockers),
		preview: candidate.preview
			? {
					...candidate.preview,
					...(candidate.preview.command ? { command: redactPreviewCommand(candidate.preview.command) } : {}),
					...(candidate.preview.url ? { url: redactPreviewUrl(candidate.preview.url) } : {}),
					...(candidate.preview.args ? { args: redactPreviewArgs(candidate.preview.args) } : {}),
				}
			: undefined,
	};
}

export function mcpErrorMessage(error: unknown): string {
	return safeMessage(error, "MCP compatibility check failed.");
}
