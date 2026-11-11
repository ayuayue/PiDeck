/**
 * Main-side validation of the shared PiConfigTarget option (plan §6.4.1).
 *
 * Renderer input is untrusted: a target is a small closed union, every field is checked here before any
 * session is touched, and an invalid shape fails with a stable code instead of being coerced to local.
 */

import { REMOTE_CONFIG_CODES, WSL_CONFIG_CODES, type PiConfigReadOptions, type PiConfigTarget, type PiConfigWriteOptions } from "../../shared/piConfig";
import { PROJECT_HOST_ID_PATTERN } from "../../shared/projectLocation";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stable(code: string): Error {
	return new Error(code);
}

export function readPiConfigTarget(value: unknown): PiConfigTarget {
	// Absent or null = local, the compatibility default the existing renderer calls rely on.
	if (value === undefined || value === null) return { kind: "local" };
	if (!isRecord(value) || typeof value.kind !== "string") throw stable(REMOTE_CONFIG_CODES.targetInvalid);
	if (value.kind === "local") {
		if (Object.keys(value).length !== 1) throw stable(REMOTE_CONFIG_CODES.targetInvalid);
		return { kind: "local" };
	}
	if (value.kind === "wsl") {
		// Exactly one key: the target names *the* WSL environment, whose distro/user come from the app settings
		// on the main side. The renderer never supplies an identity, so it cannot address another distribution.
		if (Object.keys(value).length !== 1) throw stable(WSL_CONFIG_CODES.targetInvalid);
		return { kind: "wsl" };
	}
	if (value.kind !== "ssh") throw stable(REMOTE_CONFIG_CODES.targetInvalid);
	if (Object.keys(value).length !== 2 || typeof value.hostId !== "string" || !PROJECT_HOST_ID_PATTERN.test(value.hostId)) throw stable(REMOTE_CONFIG_CODES.targetInvalid);
	return { kind: "ssh", hostId: value.hostId };
}

/** Read an optional options object: only the target key is accepted. */
export function readPiConfigReadOptions(value: unknown): PiConfigReadOptions {
	if (value === undefined || value === null) return {};
	if (!isRecord(value) || Object.keys(value).some((key) => key !== "target")) throw stable(REMOTE_CONFIG_CODES.targetInvalid);
	return { target: readPiConfigTarget(value.target) };
}

/**
 * Write options: local keeps the old body-only contract, so expectedVersion/patch must be absent for it;
 * ssh requires both (a remote write without a version guard would be an unguarded overwrite); wsl writes the
 * whole file like local, so it also refuses the ssh-only guard fields instead of silently ignoring them.
 */
export function readPiConfigWriteOptions(value: unknown): PiConfigWriteOptions {
	if (value === undefined || value === null) return { target: { kind: "local" } };
	if (!isRecord(value) || Object.keys(value).some((key) => key !== "target" && key !== "expectedVersion" && key !== "patch")) throw stable(REMOTE_CONFIG_CODES.targetInvalid);
	const target = readPiConfigTarget(value.target);
	if (target.kind !== "ssh") {
		if (value.expectedVersion !== undefined || value.patch !== undefined) throw stable(target.kind === "wsl" ? WSL_CONFIG_CODES.targetInvalid : REMOTE_CONFIG_CODES.targetInvalid);
		return { target };
	}
	if (typeof value.expectedVersion !== "string" || !/^[0-9a-f]{64}$/.test(value.expectedVersion)) throw stable(REMOTE_CONFIG_CODES.versionConflict);
	if (!isRecord(value.patch)) throw stable(REMOTE_CONFIG_CODES.fileInvalid);
	return { target, expectedVersion: value.expectedVersion, patch: value.patch };
}
