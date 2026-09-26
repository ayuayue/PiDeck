import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DEFAULT_VOICE_TRANSCRIPTION_CONFIG, sanitizeVoiceTranscriptionApiKey, sanitizeVoiceTranscriptionConfig, type VoiceTranscriptionCloudProvider, type SanitizedVoiceTranscriptionConfig } from "../../shared/voiceTranscriptionConfig";
import type { VoiceTranscriptionPublicConfig, VoiceTranscriptionSaveResult, VoiceTranscriptionSecretField } from "../../shared/types/voiceTranscription";

const MAX_PROTECTED_SECRET_LENGTH = 8192;

/** 磁盘上的三个加密槽名字，与 PersistedVoiceTranscriptionConfig 的字段一一对应。 */
type SecretSlot = "protectedApiKey" | "protectedVolcAppId" | "protectedVolcAccessToken";

/**
 * 密钥字段 → 加密槽 → 归属服务商。云端密钥按服务商分槽、不复用同一格：
 * OpenAI 兼容只有一个 API Key；豆包语音旧版控制台是 App ID + Access Token 成对，
 * 新版控制台只有一个 API Key（填进 App ID 那格，Token 留空即走单密钥形态）。
 * 分槽的意义在于「切换服务商」不会把另一家的凭据覆盖掉。
 */
const SECRET_SLOTS: Array<{ slot: SecretSlot; field: VoiceTranscriptionSecretField; provider: VoiceTranscriptionCloudProvider }> = [
	{ slot: "protectedApiKey", field: "apiKey", provider: "openai" },
	{ slot: "protectedVolcAppId", field: "volcAppId", provider: "volcengine" },
	{ slot: "protectedVolcAccessToken", field: "volcAccessToken", provider: "volcengine" },
];

/**
 * 磁盘形态：sanitize 后的非密钥设置 + 最多三个加密槽。
 * 槽可以比当前服务商多余的（用户在两家之间来回切换），读取时一律保留。
 */
type PersistedVoiceTranscriptionConfig = SanitizedVoiceTranscriptionConfig & {
	version: 1;
	protectedApiKey?: string;
	protectedVolcAppId?: string;
	protectedVolcAccessToken?: string;
};

export type VoiceTranscriptionCredentials = { provider: "openai"; baseUrl: string; apiKey: string; model: string; language: string } | { provider: "volcengine"; appId: string; accessToken: string; resourceId: string; language: string };

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
		const current = await this.readPersisted();
		// 「清除」只对当前服务商生效：另一家可能配得好好的，切换服务商不该顺手毁掉；
		// 且清除优先于同一批请求里带来的新密钥（否则点「清除」时输入框残留的半截 key 会赢）。
		const clearing = Reflect.get(input, "clearApiKey") === true;
		const slots = {} as Record<SecretSlot, string | undefined>;
		for (const { slot, field, provider } of SECRET_SLOTS) {
			if (clearing && provider === sanitized.cloudProvider) {
				slots[slot] = undefined;
				continue;
			}
			slots[slot] = current[slot];
			const raw = Reflect.get(input, field);
			if (typeof raw !== "string" || !raw.trim()) continue;
			const secret = sanitizeVoiceTranscriptionApiKey(raw);
			if (!secret) return { ok: false, error: "invalidConfig" };
			if (!this.deps.isEncryptionAvailable()) return { ok: false, error: "secureStorageUnavailable" };
			try {
				slots[slot] = Buffer.from(this.deps.protect(secret)).toString("base64");
			} catch {
				return { ok: false, error: "saveFailed" };
			}
		}

		const next: PersistedVoiceTranscriptionConfig = { version: 1, ...sanitized, ...compact(slots) };
		try {
			const configPath = this.deps.getConfigPath();
			await mkdir(dirname(configPath), { recursive: true });
			await writeFile(configPath, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
			this.deps.log("config saved", { engine: sanitized.engine, cloudProvider: sanitized.cloudProvider, hasApiKey: Boolean(slots.protectedApiKey), hasVolcAppId: Boolean(slots.protectedVolcAppId) });
			return { ok: true, config: this.toPublicConfig(next) };
		} catch {
			this.deps.log("config save failed");
			return { ok: false, error: "saveFailed" };
		}
	}

	async getCredentials(): Promise<VoiceTranscriptionCredentials | null> {
		const config = await this.readPersisted();
		if (!this.deps.isEncryptionAvailable()) return null;
		if (config.cloudProvider === "volcengine") {
			// 豆包语音的 App ID 是必填项，Access Token 只在旧版控制台需要（新版单密钥即可）。
			const appId = this.unprotectSecret(config.protectedVolcAppId);
			if (!appId) return null;
			return { provider: "volcengine", appId, accessToken: this.unprotectSecret(config.protectedVolcAccessToken) ?? "", resourceId: config.cloudResourceId, language: config.language };
		}
		const apiKey = this.unprotectSecret(config.protectedApiKey);
		return apiKey ? { provider: "openai", baseUrl: config.baseUrl, model: config.model, language: config.language, apiKey } : null;
	}

	/** 解密一个槽；密文缺失或被外部改动导致 unprotect 失败时返回 null（调用方按未配置处理）。 */
	private unprotectSecret(protectedSecret: string | undefined): string | null {
		if (!protectedSecret) return null;
		try {
			return this.deps.unprotect(Buffer.from(protectedSecret, "base64")).trim() || null;
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
			const protectedApiKey = readProtectedSecret(parsed, "protectedApiKey");
			// 旧配置只有 protectedApiKey，且那时唯一的云端服务商就是 openai → 直接沿用。
			const protectedVolcAppId = readProtectedSecret(parsed, "protectedVolcAppId");
			const protectedVolcAccessToken = readProtectedSecret(parsed, "protectedVolcAccessToken");
			// 迁移：旧云版配置没有 enabled 字段但已配好密钥 → 视为已开启，
			// 避免升级后录音按钮从用户界面上凭空消失。
			const migratedEnabled = !Object.hasOwn(parsed, "enabled") ? Boolean(protectedApiKey) : sanitized.enabled;
			return {
				version: 1,
				...sanitized,
				enabled: migratedEnabled,
				...compact({ protectedApiKey, protectedVolcAppId, protectedVolcAccessToken }),
			};
		} catch {
			return this.emptyConfig();
		}
	}

	private emptyConfig(): PersistedVoiceTranscriptionConfig {
		return { version: 1, ...DEFAULT_VOICE_TRANSCRIPTION_CONFIG, engine: "cloud", localModelId: DEFAULT_VOICE_TRANSCRIPTION_CONFIG.localModelId };
	}

	private toPublicConfig(config: PersistedVoiceTranscriptionConfig): VoiceTranscriptionPublicConfig {
		const runtimeReady = config.engine === "local" ? this.deps.isLocalReady({ cliPath: config.cliPath, localModelId: config.localModelId }) : this.cloudReady(config);
		return {
			enabled: config.enabled,
			engine: config.engine,
			cloudProvider: config.cloudProvider,
			baseUrl: config.baseUrl,
			model: config.model,
			language: config.language,
			inputDeviceId: config.inputDeviceId,
			localModelId: config.localModelId,
			cliPath: config.cliPath,
			cloudResourceId: config.cloudResourceId,
			hasApiKey: Boolean(config.protectedApiKey),
			hasVolcAppId: Boolean(config.protectedVolcAppId),
			hasVolcAccessToken: Boolean(config.protectedVolcAccessToken),
			runtimeReady,
		};
	}

	/** 云端「能力就绪」按服务商各自的必填项判定，避免用 openai 的 baseUrl/model 去要求豆包。 */
	private cloudReady(config: PersistedVoiceTranscriptionConfig): boolean {
		if (config.cloudProvider === "volcengine") return Boolean(config.protectedVolcAppId) && config.cloudResourceId.trim().length > 0;
		return Boolean(config.protectedApiKey) && config.baseUrl.trim().length > 0 && config.model.trim().length > 0;
	}
}

function readProtectedSecret(parsed: Record<string, unknown>, key: string): string | undefined {
	const raw = Reflect.get(parsed, key);
	return typeof raw === "string" && raw.length <= MAX_PROTECTED_SECRET_LENGTH ? raw : undefined;
}

/** 丢掉空槽，写盘的 JSON 里不留空字段（也让「未配置」与「配置后清空」在磁盘上同形）。 */
function compact(slots: Record<string, string | undefined>): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(slots)) {
		if (value) result[key] = value;
	}
	return result;
}

function isRecord(input: unknown): input is Record<string, unknown> {
	return Boolean(input) && typeof input === "object";
}
