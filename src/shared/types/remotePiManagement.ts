import type { RemotePiAuthSnapshot } from "../piConfig";
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
