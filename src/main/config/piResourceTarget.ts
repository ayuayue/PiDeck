/**
 * Resource-target input validation (W1): skills/prompts/extensions route by PiResourceTarget.
 *
 * Renderer input is untrusted. A target is a two-arm closed union, every field is checked here before any
 * WslHostStore read, and an ssh/unknown shape fails with a stable code instead of being coerced to local:
 * silently treating "ssh" as "local" would show Windows resources while the user is looking at a remote host.
 */

import { PI_RESOURCE_CODES, PI_RESOURCE_CODE_SET, type PiResourceOptions, type PiResourceTarget } from "../../shared/piConfig";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stable(code: string): Error {
	return new Error(code);
}

/** Absent/null = local (the compatibility default every existing renderer call relies on). */
export function readPiResourceTarget(value: unknown): PiResourceTarget {
	if (value === undefined || value === null) return { kind: "local" };
	if (!isRecord(value) || typeof value.kind !== "string") throw stable(PI_RESOURCE_CODES.targetInvalid);
	if (value.kind === "local") {
		if (Object.keys(value).length !== 1) throw stable(PI_RESOURCE_CODES.targetInvalid);
		return { kind: "local" };
	}
	if (value.kind === "wsl") {
		// Exactly one key: the resource target names *the* WSL environment; distro/user are read from the app
		// settings in the main process, so a crafted renderer payload cannot address another distribution.
		if (Object.keys(value).length !== 1) throw stable(PI_RESOURCE_CODES.targetInvalid);
		return { kind: "wsl" };
	}
	// ssh is a legal PiConfigTarget but not a PiResourceTarget: name it, do not coerce it to local.
	if (value.kind === "ssh") throw stable(PI_RESOURCE_CODES.sshUnsupported);
	throw stable(PI_RESOURCE_CODES.targetInvalid);
}

/** Options object: only the target key is accepted; unknown keys are rejected, not ignored. */
export function readPiResourceOptions(value: unknown): PiResourceOptions {
	if (value === undefined || value === null) return {};
	if (!isRecord(value) || Object.keys(value).some((key) => key !== "target")) throw stable(PI_RESOURCE_CODES.targetInvalid);
	return { target: readPiResourceTarget(value.target) };
}

/**
 * Local-only resource write channels (skills/extensions mutations, prompt create/delete/rename/toggle).
 *
 * 本轮只把 list/read/save 做成按目标路由；这些写通道仍只属于本机单例。收到非本机 target 时必须在触碰
 * 任何管理器之前回稳定码——静默落到本机 HOME 会把用户的 WSL 操作写成 Windows 内容（安全/一致性缺口）。
 */
export function requireLocalPiResourceTarget(options: unknown): void {
	const parsed = readPiResourceOptions(options);
	const target = parsed.target ?? { kind: "local" };
	if (target.kind !== "local") throw stable(PI_RESOURCE_CODES.writeUnsupported);
}

/** Stable code of an error already carrying one of the closed-set codes (else undefined). */
export function piResourceStableCodeOf(error: unknown): string | undefined {
	const message = error instanceof Error ? error.message : "";
	return PI_RESOURCE_CODE_SET.has(message) ? message : undefined;
}
