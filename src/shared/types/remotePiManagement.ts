import type { RemotePiAuthSnapshot } from "../piConfig";
import type { McpCliListResult, McpConfigSnapshot } from "./mcp";
import type { PiExtensionSummary, ProjectResourceDiscoveryResult } from "./app";

/** New credentials travel only to the named host; retained/copy values never return from it. */
export type RemoteAuthEntry = { provider: string; apiKey: string } | { provider: string; retain: true; source?: string };
export type RemoteAuthReplaceInput = { hostId: string; expectedVersion: string; entries: RemoteAuthEntry[] };
export type RemoteAuthReplaceResult = { valid: true; remoteAuth: RemotePiAuthSnapshot };

/** Closed resource domain; paths are relative references beneath one enumerated user resource root. */
export type RemoteResourceRoot = "skills" | "agents-skills" | "prompts" | "extensions";
export type RemoteResourceRef = { root: RemoteResourceRoot; path: string };
export type RemoteResourceFile = RemoteResourceRef & { version: string; content: string };
export type RemoteResourceList = { home: string; files: RemoteResourceFile[]; settings: Record<string, unknown>; settingsVersion: string; discovery: ProjectResourceDiscoveryResult };
export type RemoteResourceRequest =
	| { action: "list" }
	| { action: "read"; ref: RemoteResourceRef }
	| { action: "write"; ref: RemoteResourceRef; expectedVersion: string; content: string }
	| { action: "create"; ref: RemoteResourceRef; content: string }
	| { action: "rename"; ref: RemoteResourceRef; expectedVersion: string; name: string }
	| { action: "delete"; ref: RemoteResourceRef; expectedVersion: string }
	| { action: "toggle"; ref: RemoteResourceRef; expectedVersion: string; enabled: boolean }
	| { action: "togglePackage"; source: string; expectedVersion: string; enabled: boolean }
	| { action: "builtin"; name: string; expectedVersion: string; enabled: boolean }
	| { action: "skillsInstall"; slug: string }
	| { action: "packages"; operation: "list" | "install" | "remove" | "update"; source?: string };
export type RemoteResourceResult = RemoteResourceList | RemoteResourceFile | { applied: true } | { output: string; extensions: PiExtensionSummary[] };

export const REMOTE_RESOURCE_CODES = {
	invalid: "PI_RESOURCE_TARGET_INVALID",
	unavailable: "PI_RESOURCE_UNAVAILABLE",
	fileInvalid: "PI_RESOURCE_FILE_INVALID",
	conflict: "PI_RESOURCE_VERSION_CONFLICT",
	unconfirmed: "PI_RESOURCE_RESULT_UNCONFIRMED",
	unsupported: "PI_RESOURCE_WRITE_UNSUPPORTED",
	commandFailed: "PI_RESOURCE_COMMAND_FAILED",
} as const;

/** 远端 MCP 只提供固定动词：读配置 / 写配置 / `pi mcp list` / `pi mcp logout`。 */
export type RemoteMcpRequest = { action: "facts" } | { action: "snapshot" } | { action: "save"; file: Record<string, unknown>; expectedVersion?: string } | { action: "list" } | { action: "logout"; server: string };
/** facts 给页面一个真实的远端路径用于展示；list/logout 是主机上 `pi mcp` 的结果。 */
export type RemoteMcpResult =
	| { action: "facts"; home: string; piVersion: string }
	| { action: "snapshot"; snapshot: McpConfigSnapshot }
	| { action: "save"; valid: boolean; revision?: string; error?: string; conflict?: boolean }
	| { action: "list"; report: McpCliListResult }
	| { action: "logout"; ok: boolean; output: string };

export const REMOTE_MCP_CODES = {
	invalid: "REMOTE_MCP_TARGET_INVALID",
	unavailable: "REMOTE_MCP_UNAVAILABLE",
	fileInvalid: "REMOTE_MCP_FILE_INVALID",
	conflict: "REMOTE_MCP_VERSION_CONFLICT",
	unconfirmed: "REMOTE_MCP_RESULT_UNCONFIRMED",
	commandFailed: "REMOTE_MCP_COMMAND_FAILED",
	projectScopeUnsupported: "REMOTE_MCP_PROJECT_SCOPE_UNSUPPORTED",
	loginUnsupported: "REMOTE_MCP_LOGIN_UNSUPPORTED",
} as const;
