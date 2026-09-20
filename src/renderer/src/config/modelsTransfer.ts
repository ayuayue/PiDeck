// 模型配置 base64 导入/导出的纯函数层：信封编解码、可选密码加密（WebCrypto）、同名供应商 diff 与合并。
// 注意：crypto/btoa/atob/TextEncoder/TextDecoder 一律在函数体内惰性引用（loadTsCommonJs 的 vm 不注入这些全局）。
import type { ModelItem, ProviderConfig, ModelsFile } from "./configTypes";

export const MODELS_TRANSFER_KIND = "pideck-models-export";
export const MODELS_TRANSFER_SCHEMA_VERSION = 1;
const PBKDF2_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const FIELD_MODELS = "models";
const FIELD_ID = "id";

// WebCrypto 重载要求 BufferSource/Uint8Array 的泛型 buffer 为 ArrayBuffer，
// 而 DOM 默认 Uint8Array 泛型是 ArrayBufferLike；用显式泛型避开类型失配。
type WebBytes = Uint8Array<ArrayBuffer>;

// ---------- base64 工具（chunk 防 callstack 溢出） ----------

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(binary);
}

function base64ToBytes(b64: string): WebBytes {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes as WebBytes;
}

function randomBytes(length: number): WebBytes {
	const bytes = new Uint8Array(length) as WebBytes;
	crypto.getRandomValues(bytes);
	return bytes;
}

// ---------- 信封 ----------

interface PlaintextEnvelope {
	schemaVersion: number;
	kind: string;
	encrypted: false;
	providers: Record<string, ProviderConfig>;
}
interface EncryptedEnvelope {
	schemaVersion: number;
	kind: string;
	encrypted: true;
	kdf: { salt: string };
	cipher: { iv: string; data: string };
}

export type TransferDecodeError = "invalid-format" | "unsupported-version" | "wrong-kind";
export type DecodeModelsTransferResult =
	| { ok: true; providers: Record<string, ProviderConfig>; wasEncrypted: boolean }
	| { ok: false; error: TransferDecodeError | "encrypted-no-password" | "wrong-password" };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 外部粘贴数据：只做结构抽查（models 必须是数组——ProviderConfig 唯一必填字段），其余字段按 configTypes 契约透明透传。
// 通过校验后此处 as 是解析外部 unknown 的边界收窄，非绕过类型错误。
function toProviders(value: unknown): Record<string, ProviderConfig> | null {
	if (!isRecord(value)) return null;
	for (const entry of Object.values(value)) {
		if (!isRecord(entry) || !Array.isArray(entry.models)) return null;
	}
	return value as Record<string, ProviderConfig>;
}

async function deriveKey(password: string, salt: WebBytes): Promise<CryptoKey> {
	const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
	return crypto.subtle.deriveKey(
		{ name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
		keyMaterial,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
}

export async function encodeModelsTransfer(providers: Record<string, ProviderConfig>, password?: string): Promise<string> {
	const encoder = new TextEncoder();
	if (password) {
		const salt = randomBytes(SALT_BYTES);
		const iv = randomBytes(IV_BYTES);
		const key = await deriveKey(password, salt);
		const cipherBytes = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(JSON.stringify(providers)))) as WebBytes;
		const envelope: EncryptedEnvelope = {
			schemaVersion: MODELS_TRANSFER_SCHEMA_VERSION,
			kind: MODELS_TRANSFER_KIND,
			encrypted: true,
			kdf: { salt: bytesToBase64(salt) },
			cipher: { iv: bytesToBase64(iv), data: bytesToBase64(cipherBytes) },
		};
		return bytesToBase64(encoder.encode(JSON.stringify(envelope)));
	}
	const envelope: PlaintextEnvelope = {
		schemaVersion: MODELS_TRANSFER_SCHEMA_VERSION,
		kind: MODELS_TRANSFER_KIND,
		encrypted: false,
		providers,
	};
	return bytesToBase64(encoder.encode(JSON.stringify(envelope)));
}

export async function decodeModelsTransfer(input: string, password?: string): Promise<DecodeModelsTransferResult> {
	let bytes: Uint8Array;
	try {
		bytes = base64ToBytes(input.trim());
	} catch {
		return { ok: false, error: "invalid-format" };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return { ok: false, error: "invalid-format" };
	}
	if (!isRecord(parsed)) return { ok: false, error: "invalid-format" };
	if (parsed.schemaVersion !== MODELS_TRANSFER_SCHEMA_VERSION) return { ok: false, error: "unsupported-version" };
	if (parsed.kind !== MODELS_TRANSFER_KIND) return { ok: false, error: "wrong-kind" };
	if (parsed.encrypted === false) {
		const providers = toProviders(parsed.providers);
		if (!providers) return { ok: false, error: "invalid-format" };
		return { ok: true, providers, wasEncrypted: false };
	}
	if (!password) return { ok: false, error: "encrypted-no-password" };
	const kdf = parsed.kdf;
	const cipher = parsed.cipher;
	if (!isRecord(kdf) || !isRecord(cipher) || typeof kdf.salt !== "string" || typeof cipher.iv !== "string" || typeof cipher.data !== "string") {
		return { ok: false, error: "invalid-format" };
	}
	try {
		const key = await deriveKey(password, base64ToBytes(kdf.salt));
		const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(cipher.iv) }, key, base64ToBytes(cipher.data));
		const providers = toProviders(JSON.parse(new TextDecoder().decode(plain)));
		if (!providers) return { ok: false, error: "wrong-password" };
		return { ok: true, providers, wasEncrypted: true };
	} catch {
		// GCM 认证失败 = 密码错误或密文损坏，统一按 wrong-password 处理让用户重试
		return { ok: false, error: "wrong-password" };
	}
}

// ---------- diff / 合并 ----------

function normalizeForCompare(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(normalizeForCompare);
	if (isRecord(value)) {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			if (v !== undefined) out[k] = normalizeForCompare(v);
		}
		return out;
	}
	return value;
}

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const keys = Object.keys(value).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

function deepEqual(a: unknown, b: unknown): boolean {
	return stableStringify(normalizeForCompare(a)) === stableStringify(normalizeForCompare(b));
}

export interface ProviderFieldDiff {
	field: string;
	local: unknown;
	imported: unknown;
}
export interface ModelFieldDiff {
	modelId: string;
	field: string;
	local: unknown;
	imported: unknown;
}
export interface ProviderMergePlan {
	/** 供应商级不一致字段（含 modelOverrides 整字段与自定义字段；models 除外） */
	providerFields: ProviderFieldDiff[];
	/** 仅导入侧有的模型，合并时自动并入、不询问 */
	newModels: { modelId: string; entry: ModelItem }[];
	/** 同名模型的不一致字段（id 除外，含自定义字段） */
	modelFieldDiffs: ModelFieldDiff[];
}

export function planProviderMerge(local: ProviderConfig, imported: ProviderConfig): ProviderMergePlan {
	const providerFields: ProviderFieldDiff[] = [];
	const fieldNames = new Set([...Object.keys(local), ...Object.keys(imported)]);
	for (const field of fieldNames) {
		if (field === FIELD_MODELS) continue;
		const importedVal = imported[field];
		// 导入侧未指定该字段（undefined）→ 视为无意见，保持本地，不列为差异
		if (importedVal === undefined) continue;
		if (!deepEqual(local[field], importedVal)) providerFields.push({ field, local: local[field], imported: importedVal });
	}
	const localModels = new Map(local.models.map((m) => [m.id, m]));
	const newModels: ProviderMergePlan["newModels"] = [];
	const modelFieldDiffs: ModelFieldDiff[] = [];
	for (const importedModel of imported.models ?? []) {
		const localModel = localModels.get(importedModel.id);
		if (!localModel) {
			newModels.push({ modelId: importedModel.id, entry: importedModel });
			continue;
		}
		const fields = new Set([...Object.keys(localModel), ...Object.keys(importedModel)]);
		for (const field of fields) {
			if (field === FIELD_ID) continue;
			const importedVal = importedModel[field];
			const localVal = localModel[field];
			// 导入侧未指定 → 保持本地；本地缺失而导入侧有值 → 合并时自动采纳，不列为差异
			if (importedVal === undefined) continue;
			if (localVal === undefined) continue;
			if (!deepEqual(localVal, importedVal)) {
				modelFieldDiffs.push({ modelId: importedModel.id, field, local: localVal, imported: importedVal });
			}
		}
	}
	return { providerFields, newModels, modelFieldDiffs };
}

export type SideChoice = "local" | "imported";

export function applyProviderMerge(
	local: ProviderConfig,
	imported: ProviderConfig,
	providerFieldChoices: Record<string, SideChoice>,
	modelChoices: Record<string, SideChoice>,
): ProviderConfig {
	const merged: ProviderConfig = { ...local };
	const fieldNames = new Set([...Object.keys(local), ...Object.keys(imported)]);
	for (const field of fieldNames) {
		if (field === FIELD_MODELS) continue;
		const importedVal = imported[field];
		// 导入侧未指定 → 保持本地
		if (importedVal === undefined) continue;
		if (deepEqual(local[field], importedVal)) continue;
		if (local[field] === undefined || providerFieldChoices[field] === "imported") merged[field] = importedVal;
		// 未选择或选择 local：merged 已从 local 复制，无需处理
	}
	const localModels = local.models;
	const importedModels = imported.models;
	const importedById = new Map(importedModels.map((m) => [m.id, m]));
	const models: ModelItem[] = localModels.map((localModel) => {
		const importedModel = importedById.get(localModel.id);
		if (!importedModel) return structuredClone(localModel);
		const mergedModel: ModelItem = { ...localModel };
		const fields = new Set([...Object.keys(localModel), ...Object.keys(importedModel)]);
		for (const field of fields) {
			if (field === FIELD_ID) continue;
			const importedVal = importedModel[field];
			const localVal = localModel[field];
			// 导入侧未指定 → 保持本地
			if (importedVal === undefined) continue;
			if (deepEqual(localVal, importedVal)) continue;
			if (localVal === undefined || modelChoices[`${localModel.id}::${field}`] === "imported") mergedModel[field] = importedVal;
		}
		return mergedModel;
	});
	const localIds = new Set(localModels.map((m) => m.id));
	for (const importedModel of importedModels) {
		if (!localIds.has(importedModel.id)) models.push(structuredClone(importedModel));
	}
	merged.models = models;
	return merged;
}

export type ProviderTransferDecision = "overwrite" | { merge: { providerFieldChoices: Record<string, SideChoice>; modelChoices: Record<string, SideChoice> } };

export function applyTransferToDraft(
	draft: ModelsFile,
	imported: Record<string, ProviderConfig>,
	decisions: Record<string, ProviderTransferDecision>,
): ModelsFile {
	const providers: Record<string, ProviderConfig> = { ...draft.providers };
	for (const [id, decision] of Object.entries(decisions)) {
		const incoming = imported[id];
		if (!incoming) continue; // decisions 里指向导入数据中不存在的 id：忽略
		const existing = providers[id];
		if (!existing || decision === "overwrite") {
			providers[id] = structuredClone(incoming);
			continue;
		}
		providers[id] = applyProviderMerge(existing, incoming, decision.merge.providerFieldChoices, decision.merge.modelChoices);
	}
	// ModelsFile 仅 { providers }；draft 其余键原样透传（设计决策：导入不动顶层）
	return { ...draft, providers };
}

// ---------- 展示辅助 ----------

/** UI 对比展示用脱敏：长字符串（API key 形态）保留首尾各 4 位 */
export function maskSecret(value: unknown): string {
	if (typeof value !== "string") return value === undefined ? "" : String(value);
	if (value.length > 8) return `${value.slice(0, 4)}****${value.slice(-4)}`;
	return value;
}
