import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { ResourceImportApplyInput, ResourceImportApplyResponse, ResourceImportError, ResourceImportErrorCode, ResourceImportScanInput, ResourceImportScanResponse, ResourceImportTarget } from "../../shared/types/resourceImport";
import type { ResourceImportManager } from "../resourceImport/ResourceImportManager";

export function isTarget(value: unknown): value is ResourceImportTarget {
	if (!isRecord(value)) return false;
	const record = value;
	if (!("scope" in record) || !("locationId" in record)) return false;
	if (record.scope === "global") {
		return Object.keys(record).every((key) => key === "scope" || key === "locationId") && (record.locationId === "pi-global" || record.locationId === "agents-global");
	}
	return (
		Object.keys(record).every((key) => key === "scope" || key === "locationId" || key === "projectId") &&
		record.scope === "project" &&
		typeof record.projectId === "string" &&
		record.projectId.trim().length > 0 &&
		record.projectId.length <= 256 &&
		(record.locationId === "project-pi" || record.locationId === "project-agents")
	);
}

export function isScanInput(value: unknown): value is ResourceImportScanInput {
	if (!isRecord(value)) return false;
	const record = value;
	if (Object.keys(record).some((key) => key !== "kind" && key !== "target" && key !== "sourceProjectId")) return false;
	if (!("kind" in record) || (record.kind !== "mcp" && record.kind !== "skill") || !("target" in record) || !isTarget(record.target)) return false;
	// MCP has a single PiDeck destination family; agents skill locations must never
	// be accepted as an apparently valid MCP scan target at the IPC boundary.
	if (record.kind === "mcp" && (record.target.locationId === "agents-global" || record.target.locationId === "project-agents")) return false;
	return record.sourceProjectId === undefined || (typeof record.sourceProjectId === "string" && record.sourceProjectId.trim().length > 0 && record.sourceProjectId.length <= 256);
}

export function isApplyInput(value: unknown): value is ResourceImportApplyInput {
	if (!isRecord(value)) return false;
	const record = value;
	if (Object.keys(record).some((key) => key !== "scanId" && key !== "target" && key !== "candidateIds")) return false;
	if (!("scanId" in record) || typeof record.scanId !== "string" || record.scanId.length < 8 || record.scanId.length > 128 || !("target" in record) || !isTarget(record.target) || !("candidateIds" in record) || !Array.isArray(record.candidateIds) || record.candidateIds.length > 1000) return false;
	return record.candidateIds.every((id) => typeof id === "string" && id.length > 0 && id.length <= 128);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SAFE_ERROR_MESSAGES = new Set([
	"Invalid resource import input.",
	"Invalid resource import candidate ids.",
	"Invalid resource import target.",
	"Invalid source project id.",
	"Source project is not registered.",
	"Invalid project id.",
	"Invalid MCP target.",
	"Invalid skill target.",
	"Invalid resource import scan input.",
	"Invalid resource import apply input.",
	"Project is not available for resource import.",
	"Project is not trusted.",
	"Import scan expired. Please scan again.",
	"Import target changed. Please scan again.",
	"Invalid import candidate.",
	"Source changed. Please scan again.",
	"Source changed or is no longer safe. Please scan again.",
	"MCP definition unavailable.",
	"PiDeck MCP configuration is invalid; repair it before importing.",
	"MCP config could not be saved.",
	"Target already contains this MCP server.",
	"Target already contains this skill.",
	"Skill target is unavailable.",
	"Project path is outside boundary.",
	"Resource import failed.",
]);

/** Convert domain exceptions into a user-safe, serializable IPC result. */
export function toResourceImportError(error: unknown): ResourceImportError {
	const raw = error instanceof Error ? error.message : "";
	const message = SAFE_ERROR_MESSAGES.has(raw) ? raw : "Resource import failed.";
	let code: ResourceImportErrorCode = "IMPORT_FAILED";
	if (message.startsWith("Invalid ")) code = "INVALID_INPUT";
	else if (message === "Source project is not registered.") code = "PROJECT_UNAVAILABLE";
	else if (message === "Project is not available for resource import.") code = "PROJECT_UNAVAILABLE";
	else if (message === "Project is not trusted.") code = "PROJECT_UNTRUSTED";
	else if (message === "Import scan expired. Please scan again.") code = "SCAN_EXPIRED";
	else if (message === "Import target changed. Please scan again.") code = "TARGET_CHANGED";
	else if (message.startsWith("Source changed")) code = "SOURCE_CHANGED";
	else if (message.startsWith("Target already contains")) code = "CONFLICT";
	return { code, message };
}

export function registerResourceImportIpc(manager: ResourceImportManager): void {
	ipcMain.handle(ipcChannels.resourceImportScan, async (_event, input: unknown) => {
		if (!isScanInput(input)) return { ok: false, error: toResourceImportError(new Error("Invalid resource import scan input.")) } satisfies ResourceImportScanResponse;
		try {
			return { ok: true, result: await manager.scan(input) } satisfies ResourceImportScanResponse;
		} catch (error) {
			return { ok: false, error: toResourceImportError(error) } satisfies ResourceImportScanResponse;
		}
	});
	ipcMain.handle(ipcChannels.resourceImportApply, async (_event, input: unknown) => {
		if (!isApplyInput(input)) return { ok: false, error: toResourceImportError(new Error("Invalid resource import apply input.")) } satisfies ResourceImportApplyResponse;
		try {
			return { ok: true, result: await manager.apply(input) } satisfies ResourceImportApplyResponse;
		} catch (error) {
			return { ok: false, error: toResourceImportError(error) } satisfies ResourceImportApplyResponse;
		}
	});
}
