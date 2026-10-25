import { createHash } from "node:crypto";
import { relative, resolve, sep } from "node:path";
import type { ResourceImportSourceKind, ResourceImportTarget } from "../../shared/types/resourceImport";

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_SKILL_DEPTH = 32;
export const MAX_SKILL_CANDIDATES = 500;
export const MAX_SKILL_TREE_BYTES = 50 * 1024 * 1024;
export const SCAN_TTL_MS = 5 * 60 * 1000;
export const PROBE_CONCURRENCY = 4;
export const PROBE_TIMEOUT_MS = 3_000;
export const PREVIEW_TEXT_MAX = 1_024;

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasErrorCode(value: unknown, code: string): boolean {
	return isRecord(value) && value.code === code;
}

export function fingerprint(raw: string | Uint8Array): string {
	return createHash("sha256").update(raw).digest("hex");
}

export function sourceLabel(source: ResourceImportSourceKind): string {
	return {
		"claude-global": "Claude Code · 用户级",
		"claude-project": "Claude Code · 当前项目",
		"codex-global": "Codex · 用户级",
		"codex-project": "Codex · 当前项目",
	}[source];
}

export function pathInside(root: string, target: string): boolean {
	const rel = relative(resolve(root), resolve(target));
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.includes(`..${sep}`));
}

export function targetKey(target: ResourceImportTarget): string {
	return target.scope === "global" ? `global:${target.locationId}` : `project:${target.projectId}:${target.locationId}`;
}

export function redactPreviewUrl(value: string): string {
	try {
		const parsed = new URL(value);
		// URLs can carry credentials in the authority as well as query parameters.  The
		// preview is intentionally informational, so never expose either component to
		// the renderer even when the source configuration used basic auth syntax.
		if (parsed.username) parsed.username = "***";
		if (parsed.password) parsed.password = "***";
		for (const key of [...parsed.searchParams.keys()]) {
			if (/(token|secret|password|passwd|api[-_]?key|authorization|auth)/i.test(key)) {
				parsed.searchParams.set(key, "***");
			}
		}
		return redactSensitiveText(parsed.toString(), PREVIEW_TEXT_MAX);
	} catch {
		// Invalid URLs are not sent to the probe, but they can still be present in a
		// candidate preview when this helper is used by a caller with a partially
		// converted definition.  Mask credential-looking query values before returning
		// the diagnostic string so malformed input cannot bypass the redaction guard.
		return redactSensitiveText(value.replace(/([?&](?:token|secret|password|passwd|api[-_]?key|authorization|auth)=)[^&#\s]*/gi, "$1***").replace(/((?:token|secret|password|passwd|api[-_]?key|authorization|auth)\s*[:=]\s*)[^\s&#]+/gi, "$1***"), PREVIEW_TEXT_MAX);
	}
}

/**
 * Bound and redact free-form text before it crosses the renderer boundary.  Vendor
 * descriptions and per-item error strings are not configuration fields, but users can
 * still paste credentials into them; previews must not become an accidental secret sink.
 */
export function redactSensitiveText(value: string, maxLength = PREVIEW_TEXT_MAX): string {
	let safe = value
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/((?:token|secret|password|passwd|api[-_]?key|authorization|auth|bearer[_-]?token|cookie)\s*[:=]\s*)(?:bearer\s+)?("[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1***")
		.replace(/(--?(?:token|secret|password|passwd|api[-_]?key|authorization|auth|cookie)\s+)(?:bearer\s+)?("[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1***");
	if (safe.length > maxLength) safe = `${safe.slice(0, maxLength)}…`;
	return safe;
}

/** Redact and bound a list of diagnostics before it is exposed to renderer. */
export function redactSensitiveList(values: string[], maxLength = PREVIEW_TEXT_MAX): string[] {
	return values.map((value) => redactSensitiveText(value, maxLength));
}

/**
 * Keep useful command previews while masking the common inline credential forms
 * (`--token value`, `--api-key=value`, `TOKEN=value`, etc.).  Environment maps and
 * headers are never exposed at all; this is an additional guard for vendors that
 * put a secret directly in argv.
 */
export function redactPreviewArgs(args: string[] | undefined): string[] | undefined {
	if (!args) return undefined;
	const result: string[] = [];
	let redactNext: "credential" | "header" | undefined;
	for (const arg of args) {
		if (redactNext) {
			result.push("***");
			// Authorization flags are commonly encoded as `--authorization Bearer <token>`;
			// mask the scheme and the following token, not just the scheme word.
			redactNext = redactNext === "credential" && /^bearer$/i.test(arg) ? "credential" : undefined;
			continue;
		}
		const headerInline = /^(--(?:header|headers|http-header|http-headers|request-header|additional-header)(?:=|:)).*$/i.exec(arg);
		if (headerInline) {
			result.push(`${headerInline[1]}***`);
			continue;
		}
		if (/^--(?:header|headers|http-header|http-headers|request-header|additional-header)$/i.test(arg) || arg === "-H") {
			// Header values are always private, even when the header name itself is not
			// credential-looking (for example Cookie or a vendor-specific session header).
			result.push(arg);
			redactNext = "header";
			continue;
		}
		if (/^-H.+/.test(arg)) {
			// curl also accepts the compact `-HAuthorization: ...` spelling.
			result.push("-H***");
			continue;
		}
		const inline = /^(--?(?:token|secret|password|passwd|api[-_]?key|auth(?:orization)?|cookie)(?:=|:))(.+)$/i.exec(arg);
		if (inline) {
			result.push(`${inline[1]}***`);
			continue;
		}
		if (/^--?(?:token|secret|password|passwd|api[-_]?key|auth(?:orization)?|cookie)$/i.test(arg)) {
			result.push(arg);
			redactNext = "credential";
			continue;
		}
		const envInline = /^([^=]+)=(.*)$/.exec(arg);
		if (envInline && /(?:^|[_-])(token|secret|password|passwd|api[-_]?key|auth(?:orization)?|cookie)(?:$|[_-])/i.test(envInline[1])) {
			result.push(`${envInline[1]}=***`);
			continue;
		}
		result.push(redactSensitiveText(arg, PREVIEW_TEXT_MAX));
	}
	return result;
}

/**
 * Commands are displayed as a compact preview, not as an executable string.  A
 * number of MCP exports nevertheless put credentials directly in a shell command
 * (for example `curl --token value` or `TOKEN=value node server.js`).  Apply the
 * same conservative masking used for argv before the command reaches renderer.
 */
export function redactPreviewCommand(command: string | undefined): string | undefined {
	if (command === undefined) return undefined;
	let value = command;
	// Shell-like command fields occasionally use curl-style header flags instead of the
	// structured `headers` map.  A header can hold an arbitrary bearer, cookie, or vendor
	// session value, so redact the complete option payload up to a shell separator rather
	// than attempting to identify only familiar header names.  Losing part of a preview is
	// preferable to leaking a credential through IPC.
	value = value.replace(/(--(?:header|headers|http-header|http-headers|request-header|additional-header)(?:\s+|=))[^;|&\r\n]*/gi, "$1***");
	value = value.replace(/(-H(?:\s+|=))[^;|&\r\n]*/g, "$1***");
	value = value.replace(/-H(?=[^\s=])[^;|&\r\n]*/g, "-H***");
	// Authorization flags commonly use two argv-like values (`Bearer <token>`).
	// Mask both values so the first replacement cannot leave the credential behind.
	value = value.replace(/(--?(?:authorization|auth)(?:\s+|=))(?:(bearer)\s+)?("[^"]*"|'[^']*'|[^\s]+)/gi, (_match, prefix: string, scheme: string | undefined) => `${prefix}***${scheme ? " ***" : ""}`);
	value = value.replace(/(--?(?:token|secret|password|passwd|api[-_]?key)(?:\s+|=))("[^"]*"|'[^']*'|[^\s]+)/gi, "$1***");
	value = value.replace(/(\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API[-_]?KEY|AUTH[A-Z0-9_]*)[A-Z0-9_]*\s*=\s*)("[^"]*"|'[^']*'|[^\s]+)/gi, "$1***");
	value = value.replace(/((?:token|secret|password|passwd|api[-_]?key|authorization|auth)\s*[:=]\s*)[^\s,;"']+/gi, "$1***");
	return redactSensitiveText(value, PREVIEW_TEXT_MAX);
}

export function addUnique(values: string[], value: string): void {
	if (!values.includes(value)) values.push(value);
}

export function safeMessage(error: unknown, fallback: string): string {
	return error instanceof Error && error.message.trim() ? error.message : fallback;
}

export class ResourceImportConflictError extends Error {
	readonly code = "RESOURCE_IMPORT_CONFLICT";
}

export function isConflictError(error: unknown): boolean {
	return error instanceof ResourceImportConflictError || (isRecord(error) && error.code === "RESOURCE_IMPORT_CONFLICT");
}
