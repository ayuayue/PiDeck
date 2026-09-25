import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DEFAULT_VOICE_TRANSCRIPTION_CONFIG, sanitizeVoiceTranscriptionApiKey, sanitizeVoiceTranscriptionConfig, type SanitizedVoiceTranscriptionConfig } from "../../shared/voiceTranscriptionConfig";
import type { WhisperModelId } from "../../shared/types/whisperRuntime";
import type { VoiceTranscriptionPublicConfig, VoiceTranscriptionSaveResult } from "../../shared/types/voiceTranscription";

const MAX_PROTECTED_API_KEY_LENGTH = 8192;

type PersistedVoiceTranscriptionConfig = SanitizedVoiceTranscriptionConfig & {
	version: 1;
	protectedApiKey?: string;
};

export type VoiceTranscriptionCredentials = {
	baseUrl: string;
	apiKey: string;
	model: string;
	language: string;
};

/** Owns transcription settings (and encrypted cloud credentials) in Electron userData. */
export class VoiceTranscriptionConfigStore {
	constructor(
		private readonly deps: {
			getConfigPath: () => string;
			isEncryptionAvailable: () => boolean;
			protect: (plainText: string) => Uint8Array;
			unprotect: (encrypted: Uint8Array) => string;
			log: (message: string, details?: Record<string, unknown>) => void;
			/** 本地引擎是否可用（whisper-cli 就位 + 所选模型已装）；由主进程注入。 */
			isLocalReady: (config: { cliPath: string; localModelId: string }) => boolean;
		},
	) {}

	async getPublicConfig(): Promise<VoiceTranscriptionPublicConfig> {
		const config = await this.readPersisted();
		return this.toPublicConfig(config);
	}

	async saveConfig(input: unknown): Promise<VoiceTranscriptionSaveResult> {
		const sanitized = sanitizeVoiceTranscriptionConfig(input);
		if (!sanitized) return { ok: false, error: "invalidConfig" };
		if (!isRecord(input)) return { ok: false, error: "invalidConfig" };
		const rawApiKey = Reflect.get(input, "apiKey");
		const clearApiKey = Reflect.get(input, "clearApiKey") === true;
		const current = await this.readPersisted();
		let protectedApiKey = clearApiKey ? undefined : current.protectedApiKey;
		if (!clearApiKey && typeof rawApiKey === "string" && rawApiKey.trim()) {
			const apiKey = sanitizeVoiceTranscriptionApiKey(rawApiKey);
			if (!apiKey) return { ok: false, error: "invalidConfig" };
			if (!this.deps.isEncryptionAvailable()) {
				return { ok: false, error: "secureStorageUnavailable" };
			}
			try {
				protectedApiKey = Buffer.from(this.deps.protect(apiKey)).toString("base64");
			} catch {
				return { ok: false, error: "saveFailed" };
			}
		}

		const next: PersistedVoiceTranscriptionConfig = {
			version: 1,
			...sanitized,
			...(protectedApiKey ? { protectedApiKey } : {}),
		};
		try {
			const configPath = this.deps.getConfigPath();
			await mkdir(dirname(configPath), { recursive: true });
			await writeFile(configPath, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
			this.deps.log("config saved", { engine: sanitized.engine, hasApiKey: Boolean(protectedApiKey) });
			return { ok: true, config: this.toPublicConfig(next) };
		} catch {
			this.deps.log("config save failed");
			return { ok: false, error: "saveFailed" };
		}
	}

	async getCredentials(): Promise<VoiceTranscriptionCredentials | null> {
		const config = await this.readPersisted();
		if (!config.protectedApiKey || !this.deps.isEncryptionAvailable()) return null;
		try {
			const apiKey = this.deps.unprotect(Buffer.from(config.protectedApiKey, "base64")).trim();
			return apiKey ? { baseUrl: config.baseUrl, model: config.model, language: config.language, apiKey } : null;
		} catch {
			this.deps.log("credential decrypt failed");
			return null;
		}
	}

	private async readPersisted(): Promise<PersistedVoiceTranscriptionConfig> {
		try {
			const parsed: unknown = JSON.parse(await readFile(this.deps.getConfigPath(), "utf8"));
			const sanitized = sanitizeVoiceTranscriptionConfig(parsed);
			if (!sanitized || !isRecord(parsed)) return this.emptyConfig();
			const rawProtectedApiKey = Reflect.get(parsed, "protectedApiKey");
			const protectedApiKey = typeof rawProtectedApiKey === "string" && rawProtectedApiKey.length <= MAX_PROTECTED_API_KEY_LENGTH ? rawProtectedApiKey : undefined;
			// 迁移：旧云版配置没有 enabled 字段但已配好密钥 → 视为已开启，
			// 避免升级后录音按钮从用户界面上凭空消失。
			const migratedEnabled = !Object.hasOwn(parsed, "enabled") ? Boolean(protectedApiKey) : sanitized.enabled;
			return { version: 1, ...sanitized, enabled: migratedEnabled, ...(protectedApiKey ? { protectedApiKey } : {}) };
		} catch {
			return this.emptyConfig();
		}
	}

	private emptyConfig(): PersistedVoiceTranscriptionConfig {
		return { version: 1, ...DEFAULT_VOICE_TRANSCRIPTION_CONFIG, engine: "cloud", localModelId: DEFAULT_VOICE_TRANSCRIPTION_CONFIG.localModelId };
	}

	private toPublicConfig(config: PersistedVoiceTranscriptionConfig): VoiceTranscriptionPublicConfig {
		const runtimeReady = config.engine === "local" ? this.deps.isLocalReady({ cliPath: config.cliPath, localModelId: config.localModelId }) : Boolean(config.protectedApiKey) && config.baseUrl.trim().length > 0 && config.model.trim().length > 0;
		return {
			enabled: config.enabled,
			engine: config.engine,
			baseUrl: config.baseUrl,
			model: config.model,
			language: config.language,
			inputDeviceId: config.inputDeviceId,
			localModelId: config.localModelId,
			cliPath: config.cliPath,
			hasApiKey: Boolean(config.protectedApiKey),
			runtimeReady,
		};
	}
}

function isRecord(input: unknown): input is Record<string, unknown> {
	return Boolean(input) && typeof input === "object";
}
