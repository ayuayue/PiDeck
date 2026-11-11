/**
 * PiConfigRouter (plan §6.4.1, Batch A + WS2 P1-1 + W4): the single decision point behind the config IPC.
 * An absent/local target keeps today's ConfigManager path byte-for-byte; an ssh target routes only to the
 * RemotePiConfigBackend; a wsl target routes only to WslPiConfigStore. Neither remote port can touch
 * ConfigManager, so a failed remote/wsl read cannot silently fall back to local files or local keys.
 *
 * Two families of methods:
 * - structured (readModels/readSettings): the rich editors' shape, extended incrementally;
 * - file-level (readRaw/writeRaw): one channel for the source-file page and the file-level editors
 *   (trust/mcp/auth under wsl, the remote patch panels over ssh). The file set is per-target:
 *   ssh writes = models/settings/trust/mcp and reads those plus the derived auth view (never the credential
 *   file itself); wsl/local = those plus auth.
 *
 * Provider connection tests, model catalog fetches and usage queries are NOT routed here: they are explicitly
 * deferred for every non-local target (ssh and wsl alike), so their handlers call rejectRemotePiConfigTarget and
 * answer the stable PROVIDER_OPERATION_UNSUPPORTED code without any network/helper/wsl.exe request.
 */

import { REMOTE_CONFIG_CODES, WSL_CONFIG_CODES, piConfigFilesForTarget, piConfigReadFilesForTarget, type PiConfigTarget, type PiConfigReadOptions, type PiConfigWriteOptions, type RemotePiAuthSnapshot, type WslPiConfigFileKey } from "../../shared/piConfig";
import type { ConfigFileDiagnostic, ConfigFileReadResult } from "../../shared/types";
import type { ConfigValidationResult, PiModelsFile, PiSettings } from "./ConfigManager";
import { readPiConfigReadOptions, readPiConfigTarget, readPiConfigWriteOptions } from "./piConfigTarget";
import type { RemotePiConfigBackend } from "./RemotePiConfigBackend";
import type { WslPiConfigSaveResult, WslPiConfigStore } from "./WslPiConfigStore";

export type PiConfigLocalPorts = {
	getModelsConfig: () => Promise<ConfigFileReadResult<{ providers: Record<string, unknown> }>>;
	getSettingsConfig: () => Promise<ConfigFileReadResult<Record<string, unknown>>>;
	saveModelsConfig: (data: PiModelsFile) => Promise<ConfigValidationResult>;
	saveSettingsConfig: (settings: PiSettings) => Promise<ConfigValidationResult>;
	/** Source text of one file, including a broken file's bytes plus diagnostic (the raw page repairs those). */
	getRawConfig: (file: WslPiConfigFileKey) => Promise<{ raw: string; diagnostic?: ConfigFileDiagnostic }>;
	/** Whole-file write, same rules as the raw save channel (`ConfigManager.saveRawConfig`). */
	saveRawConfig: (file: WslPiConfigFileKey, raw: string) => Promise<ConfigValidationResult>;
};

export type PiConfigRouterPorts = {
	local: PiConfigLocalPorts;
	remote?: RemotePiConfigBackend;
	/** wsl 目标只走这里；未装配 = fail closed（WSL_CONFIG_UNAVAILABLE），不退回本机。 */
	wsl?: WslPiConfigStore;
};

export type PiConfigReadRoute<T> = { kind: "local"; value: T } | import("../../shared/piConfig").RemotePiConfigSnapshot | import("../../shared/piConfig").WslPiConfigSnapshot;
/** wsl 保存与本地同语义（整文件 + 校验结果），所以它的返回值也带 ConfigValidationResult 的形状。 */
export type PiConfigWriteRoute = { kind: "local"; value: ConfigValidationResult } | { kind: "wsl"; value: WslPiConfigSaveResult } | import("../../shared/piConfig").RemotePiConfigWriteReceipt;

/** Raw-file read answer: local/wsl text (+ diagnostic when the JSON is broken), the ssh sanitized snapshot, or the
 * ssh derived auth view (no bytes exist for the credential file in any shape). */
export type PiConfigRawReadRoute = { kind: "local" | "wsl"; value: { raw: string; diagnostic?: ConfigFileDiagnostic } } | import("../../shared/piConfig").RemotePiConfigSnapshot | RemotePiAuthSnapshot;

function stable(code: string): Error {
	return new Error(code);
}

function fileKeyOf(value: unknown): WslPiConfigFileKey {
	if (typeof value === "string") {
		for (const key of ["models", "settings", "trust", "mcp", "auth"] as const) {
			if (key === value) return key;
		}
	}
	throw stable(WSL_CONFIG_CODES.targetInvalid);
}

/**
 * Reject a non-local target for the explicitly deferred provider operations (testProvider/fetchModels/usage).
 * Absent/local target stays allowed; an ssh- or wsl-shaped target gets the documented stable code before any I/O
 * (a wsl run would execute wsl.exe, which is exactly the "test/usage stays a local provider probe" boundary).
 */
export function rejectRemotePiConfigTarget(value: unknown): void {
	const target = readPiConfigTarget(value);
	if (target.kind !== "local") throw stable(REMOTE_CONFIG_CODES.providerOperationUnsupported);
}

export function createPiConfigRouter(ports: PiConfigRouterPorts) {
	function remoteBackend(): RemotePiConfigBackend {
		if (ports.remote === undefined) throw stable(REMOTE_CONFIG_CODES.unavailable);
		return ports.remote;
	}
	function wslStore(): WslPiConfigStore {
		if (ports.wsl === undefined) throw stable(WSL_CONFIG_CODES.unavailable);
		return ports.wsl;
	}
	function readTarget(options: unknown): PiConfigTarget {
		const parsed: PiConfigReadOptions = readPiConfigReadOptions(options);
		return parsed.target ?? { kind: "local" };
	}
	function writeOptions(options: unknown): PiConfigWriteOptions & { target: PiConfigTarget } {
		const parsed = readPiConfigWriteOptions(options);
		return { ...parsed, target: parsed.target ?? { kind: "local" } };
	}
	function requireSshGuard(options: PiConfigWriteOptions): { expectedVersion: string; patch: Record<string, unknown> } {
		if (typeof options.expectedVersion !== "string" || options.patch === undefined) throw stable(REMOTE_CONFIG_CODES.versionConflict);
		return { expectedVersion: options.expectedVersion, patch: options.patch };
	}
	/** A target that cannot address this file must refuse before any I/O (never "read the local one instead"). */
	function requireFileForTarget(target: PiConfigTarget, file: WslPiConfigFileKey, files: readonly WslPiConfigFileKey[]): void {
		if (!files.includes(file)) {
			throw stable(target.kind === "ssh" ? REMOTE_CONFIG_CODES.targetInvalid : WSL_CONFIG_CODES.unsupported);
		}
	}

	return {
		async readModels(options?: unknown): Promise<PiConfigReadRoute<ConfigFileReadResult<{ providers: Record<string, unknown> }>>> {
			const target = readTarget(options);
			if (target.kind === "ssh") return await remoteBackend().read({ hostId: target.hostId, file: "models" });
			if (target.kind === "wsl") return await wslStore().read({ file: "models" });
			return { kind: "local", value: await ports.local.getModelsConfig() };
		},
		async readSettings(options?: unknown): Promise<PiConfigReadRoute<ConfigFileReadResult<Record<string, unknown>>>> {
			const target = readTarget(options);
			if (target.kind === "ssh") return await remoteBackend().read({ hostId: target.hostId, file: "settings" });
			if (target.kind === "wsl") return await wslStore().read({ file: "settings" });
			return { kind: "local", value: await ports.local.getSettingsConfig() };
		},
		async saveModels(data: PiModelsFile, options?: unknown): Promise<PiConfigWriteRoute> {
			const parsed = writeOptions(options);
			if (parsed.target.kind === "ssh") {
				const guard = requireSshGuard(parsed);
				return await remoteBackend().patch({ hostId: parsed.target.hostId, file: "models", ...guard });
			}
			if (parsed.target.kind === "wsl") return { kind: "wsl", value: await wslStore().saveModels({ data }) };
			return { kind: "local", value: await ports.local.saveModelsConfig(data) };
		},
		async saveSettings(data: PiSettings, options?: unknown): Promise<PiConfigWriteRoute> {
			const parsed = writeOptions(options);
			if (parsed.target.kind === "ssh") {
				const guard = requireSshGuard(parsed);
				return await remoteBackend().patch({ hostId: parsed.target.hostId, file: "settings", ...guard });
			}
			if (parsed.target.kind === "wsl") return { kind: "wsl", value: await wslStore().saveSettings({ settings: data }) };
			return { kind: "local", value: await ports.local.saveSettingsConfig(data) };
		},
		/**
		 * File-level read. Local answers raw bytes + diagnostic (a broken file must stay repairable);
		 * wsl answers the text of the file (broken JSON also comes back with a diagnostic);
		 * ssh answers only the sanitized snapshot (no raw bytes exist remotely).
		 */
		async readRaw(fileValue: unknown, options?: unknown): Promise<PiConfigRawReadRoute> {
			const file = fileKeyOf(fileValue);
			const target = readTarget(options);
			requireFileForTarget(target, file, piConfigReadFilesForTarget(target));
			if (target.kind === "ssh") {
				// auth.json 只有派生视图：没有字节、没有秘密位置，因此不存在可编辑的文档。
				if (file === "auth") return await remoteBackend().readAuth({ hostId: target.hostId });
				return await remoteBackend().read({ hostId: target.hostId, file: file as Exclude<WslPiConfigFileKey, "auth"> });
			}
			if (target.kind === "wsl") return { kind: "wsl", value: await wslStore().readRaw({ file }) };
			return { kind: "local", value: await ports.local.getRawConfig(file) };
		},
		/**
		 * File-level write. local/wsl write the whole document; ssh requires the merge-patch guard
		 * (expectedVersion + patch) exactly like the structured save path — the body argument is ignored there,
		 * mirroring saveModels/saveSettings so an accidental remote call can never write the local file.
		 */
		async writeRaw(fileValue: unknown, body: unknown, options?: unknown): Promise<PiConfigWriteRoute> {
			const file = fileKeyOf(fileValue);
			const parsed = writeOptions(options);
			requireFileForTarget(parsed.target, file, piConfigFilesForTarget(parsed.target));
			if (parsed.target.kind === "ssh") {
				const guard = requireSshGuard(parsed);
				return await remoteBackend().patch({ hostId: parsed.target.hostId, file: file as Exclude<WslPiConfigFileKey, "auth">, ...guard });
			}
			if (typeof body !== "string") throw stable(WSL_CONFIG_CODES.fileInvalid);
			if (parsed.target.kind === "wsl") return { kind: "wsl", value: await wslStore().saveRaw({ file, raw: body }) };
			return { kind: "local", value: await ports.local.saveRawConfig(file, body) };
		},
	};
}

export type PiConfigRouter = ReturnType<typeof createPiConfigRouter>;
