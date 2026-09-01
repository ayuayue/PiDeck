import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
	DEFAULT_VOICE_TRANSCRIPTION_CONFIG,
	sanitizeVoiceTranscriptionApiKey,
	sanitizeVoiceTranscriptionConfig,
} from "../../shared/voiceTranscriptionConfig";
import type {
	VoiceTranscriptionPublicConfig,
	VoiceTranscriptionSaveResult,
} from "../../shared/types/voiceTranscription";

const MAX_PROTECTED_API_KEY_LENGTH = 8192;

type PersistedVoiceTranscriptionConfig = {
	version: 1;
	baseUrl: string;
	model: string;
	language: string;
	protectedApiKey?: string;
};

export type VoiceTranscriptionCredentials = {
	baseUrl: string;
	apiKey: string;
	model: string;
	language: string;
};

/** Owns encrypted transcription credentials in Electron userData. */
export class VoiceTranscriptionConfigStore {
	constructor(private readonly deps: {
		getConfigPath: () => string;
		isEncryptionAvailable: () => boolean;
		protect: (plainText: string) => Uint8Array;
		unprotect: (encrypted: Uint8Array) => string;
		log: (message: string, details?: Record<string, unknown>) => void;
	}) {}

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
			this.deps.log("config saved", { hasApiKey: Boolean(protectedApiKey) });
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
			const protectedApiKey = typeof rawProtectedApiKey === "string" &&
				rawProtectedApiKey.length <= MAX_PROTECTED_API_KEY_LENGTH
				? rawProtectedApiKey
				: undefined;
			return { version: 1, ...sanitized, ...(protectedApiKey ? { protectedApiKey } : {}) };
		} catch {
			return this.emptyConfig();
		}
	}

	private emptyConfig(): PersistedVoiceTranscriptionConfig {
		return { version: 1, ...DEFAULT_VOICE_TRANSCRIPTION_CONFIG };
	}

	private toPublicConfig(config: PersistedVoiceTranscriptionConfig): VoiceTranscriptionPublicConfig {
		return {
			baseUrl: config.baseUrl,
			model: config.model,
			language: config.language,
			hasApiKey: Boolean(config.protectedApiKey),
		};
	}
}

function isRecord(input: unknown): input is Record<string, unknown> {
	return Boolean(input) && typeof input === "object";
}
