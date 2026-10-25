import type { McpServerTransport, McpServerDefinition } from "./mcp";

export type ResourceImportKind = "mcp" | "skill";

export type ResourceImportTarget = { scope: "global"; locationId: "pi-global" | "agents-global" } | { scope: "project"; projectId: string; locationId: "project-pi" | "project-agents" };

export type ResourceImportSourceKind = "claude-global" | "claude-project" | "codex-global" | "codex-project";

export type ResourceImportScanInput = {
	kind: ResourceImportKind;
	sourceProjectId?: string;
	target: ResourceImportTarget;
};

export type ResourceImportSourceStatus = {
	source: ResourceImportSourceKind;
	pathLabel: string;
	exists: boolean;
	error?: string;
};

export type ResourceImportCandidate = {
	candidateId: string;
	kind: ResourceImportKind;
	source: ResourceImportSourceKind;
	sourceLabel: string;
	sourcePathLabel: string;
	name: string;
	targetName: string;
	description: string;
	importable: boolean;
	warnings: string[];
	blockers: string[];
	conflict: boolean;
	transport?: McpServerTransport;
	preview?: { command?: string; args?: string[]; url?: string };
};

export type ResourceImportScanResult = {
	scanId: string;
	kind: ResourceImportKind;
	target: ResourceImportTarget;
	sources: ResourceImportSourceStatus[];
	candidates: ResourceImportCandidate[];
};

/** Stable error codes returned by the resource-import IPC boundary. */
export type ResourceImportErrorCode = "INVALID_INPUT" | "PROJECT_UNAVAILABLE" | "PROJECT_UNTRUSTED" | "SCAN_EXPIRED" | "TARGET_CHANGED" | "SOURCE_CHANGED" | "CONFLICT" | "IMPORT_FAILED";

/** User-safe, structured failure payload. Raw stacks and vendor secrets never cross IPC. */
export type ResourceImportError = {
	code: ResourceImportErrorCode;
	message: string;
};

export type ResourceImportScanResponse = { ok: true; result: ResourceImportScanResult } | { ok: false; error: ResourceImportError };

export type ResourceImportApplyInput = {
	scanId: string;
	target: ResourceImportTarget;
	candidateIds: string[];
};

export type ResourceImportItemResult = {
	candidateId: string;
	name: string;
	status: "imported" | "skipped" | "failed";
	reason?: string;
	warnings?: string[];
};

export type ResourceImportReport = {
	scanId: string;
	kind: ResourceImportKind;
	results: ResourceImportItemResult[];
	imported: number;
	skipped: number;
	failed: number;
};

export type ResourceImportApplyResponse = { ok: true; result: ResourceImportReport } | { ok: false; error: ResourceImportError };

/** Internal-only payload kept in the main process scan cache. */
export type StoredResourceImportCandidate = ResourceImportCandidate & {
	sourcePath: string;
	/** Lexical source path retained only in the main-process scan cache for stale checks. */
	sourcePathLexical?: string;
	sourceFingerprint: string;
	mcpDefinition?: McpServerDefinition;
};
