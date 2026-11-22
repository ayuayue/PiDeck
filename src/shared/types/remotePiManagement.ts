import type { RemotePiAuthSnapshot } from "../piConfig";
import type { McpCliListResult, McpConfigSnapshot } from "./mcp";
import type { PiExtensionSummary, ProjectResourceDiscoveryResult } from "./app";

/** New credentials travel only to the named host; retained/copy values never return from it. */
export type RemoteAuthEntry = { provider: string; apiKey: string } | { provider: string; retain: true; source?: string };
export type RemoteAuthReplaceInput = { hostId: string; expectedVersion: string; entries: RemoteAuthEntry[] };
export type RemoteAuthReplaceResult = { valid: true; remoteAuth: RemotePiAuthSnapshot };

/** Two closed layers: the host's global user resources and one project's own resources. */
export type RemoteResourceScope = "global" | "project";
/** Closed resource domain; paths are relative references beneath one enumerated resource root. */
export type RemoteResourceRoot = "skills" | "agents-skills" | "prompts" | "extensions";
export type RemoteResourceRef = { root: RemoteResourceRoot; path: string };
export type RemoteResourceFile = RemoteResourceRef & { version: string; content: string };
/** The project layer reuses the global list shape; `projectRoot` is the root the helper was started with. */
export type RemoteResourceList = { home: string; scope: RemoteResourceScope; projectRoot: string | null; files: RemoteResourceFile[]; settings: Record<string, unknown>; settingsVersion: string; discovery: ProjectResourceDiscoveryResult };
/**
 * Every request may name its layer (default `global`) and, for the project layer, the registered project id.
 * `projectId` is never a path: the main process resolves it through the project catalog and refuses any
 * locator that is not an enrolled SSH project, so the renderer cannot address a sibling project or the host.
 */
export type RemoteResourceRequestScope = { scope?: RemoteResourceScope; projectId?: string };
export type RemoteResourceRequest = RemoteResourceRequestScope &
	(
		| { action: "list" }
		| { action: "read"; ref: RemoteResourceRef }
		| { action: "write"; ref: RemoteResourceRef; expectedVersion: string; content: string }
		| { action: "create"; ref: RemoteResourceRef; content: string }
		| { action: "rename"; ref: RemoteResourceRef; expectedVersion: string; name: string }
		| { action: "delete"; ref: RemoteResourceRef; expectedVersion: string }
		| { action: "toggle"; ref: RemoteResourceRef; expectedVersion: string; enabled: boolean }
		/** Project layer only: switch an inherited global resource off in the project's own settings. */
		| { action: "toggleInherited"; kind: "skill" | "prompt" | "extension"; key: string; enabled: boolean }
		| { action: "togglePackage"; source: string; expectedVersion: string; enabled: boolean }
		| { action: "builtin"; name: string; expectedVersion: string; enabled: boolean }
		| { action: "skillsInstall"; slug: string }
		| { action: "packages"; operation: "list" | "install" | "remove" | "update"; source?: string }
	);
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
export type RemoteMcpRequest = RemoteResourceRequestScope &
	(
		| { action: "facts" }
		| { action: "snapshot" }
		| { action: "save"; file: Record<string, unknown>; expectedVersion?: string }
		| { action: "list" }
		| { action: "logout"; server: string }
		/** OAuth 登录：授权 URL 以 mcp:login-url 事件实时推给发起它的那个窗口。 */
		| { action: "login"; server: string; timeoutSec: number; operationId?: string }
	);
/** facts 给页面一个真实的远端路径用于展示；list/logout 是主机上 `pi mcp` 的结果。 */
export type RemoteMcpResult =
	| { action: "facts"; home: string; piVersion: string }
	| { action: "snapshot"; snapshot: McpConfigSnapshot }
	| { action: "save"; valid: boolean; revision?: string; error?: string; conflict?: boolean }
	| { action: "list"; report: McpCliListResult }
	| { action: "logout"; ok: boolean; output: string }
	| { action: "login"; ok: boolean; output: string };

export const REMOTE_MCP_CODES = {
	invalid: "REMOTE_MCP_TARGET_INVALID",
	unavailable: "REMOTE_MCP_UNAVAILABLE",
	fileInvalid: "REMOTE_MCP_FILE_INVALID",
	conflict: "REMOTE_MCP_VERSION_CONFLICT",
	unconfirmed: "REMOTE_MCP_RESULT_UNCONFIRMED",
	commandFailed: "REMOTE_MCP_COMMAND_FAILED",
	projectScopeUnsupported: "REMOTE_MCP_PROJECT_SCOPE_UNSUPPORTED",
	projectTargetInvalid: "REMOTE_RESOURCE_PROJECT_TARGET_INVALID",
	projectTargetNotFound: "REMOTE_RESOURCE_PROJECT_NOT_FOUND",
	loginUnsupported: "REMOTE_MCP_LOGIN_UNSUPPORTED",
} as const;
