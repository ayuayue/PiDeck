/**
 * pi ↔ DSH 单供应商迁移服务。
 *
 * 读：pi 走 ConfigManager；DSH 只读 $DSH_HOME/settings.yaml + .credentials.yaml，
 * 不启动 host（避免和 dsh-web 抢同一 DSH_HOME）。
 *
 * 写：
 * - 到 pi：合并 models.json / auth.json。
 * - 到 DSH：host 已就绪则走官方 settings.update + credentials.set；
 *   否则磁盘合并 settings.yaml / .credentials.yaml（不为此拉起 host）。
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ConfigManager, PiAuthFile, PiModelsFile, PiProviderConfig } from "./ConfigManager";
import type { DshHost } from "../dsh/DshHost";
import { credentialValueFromDocument, isValidCredentialRef } from "../dsh/dshCredentials";
import { getPiAiCatalogIndex } from "../pi/piAiBuiltinCatalog";
import {
	credentialRefFor,
	dshToPiSnapshot,
	dumpYamlObject,
	isSafeProviderName,
	loadYamlObject,
	looksLikeOfficialDeepseek,
	mergeCredentialDocument,
	mergeDshProviderIntoSettings,
	mergePiProvider,
	parseDshSettingsDocument,
	piBuiltinSnapshotFromCatalog,
	piToDshSnapshot,
	resolvePiApiKey,
	type DshProviderProfile,
	type DshProviderSnapshot,
	type MigratableProviderRow,
	type MigrationDirection,
	type PiProviderSnapshot,
} from "./providerMigration";

export type ProviderMigrationPreview = {
	direction: MigrationDirection;
	providers: MigratableProviderRow[];
};

export type ProviderMigrationResult = {
	ok: boolean;
	provider: string;
	direction: MigrationDirection;
	copiedKey: boolean;
	wroteViaHost: boolean;
	error?: string;
};

export type ProviderMigrationDeps = {
	configManager: ConfigManager;
	dshHost: Pick<DshHost, "getHomeDir" | "isHostReady" | "updateSettings" | "setCredential" | "describeSettings" | "readCredentialValue">;
};

function asStringHeaders(value: unknown): Record<string, string> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const out: Record<string, string> = {};
	for (const [key, item] of Object.entries(value)) {
		if (typeof item === "string" && item.length > 0) out[key] = item;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

async function readText(path: string): Promise<string> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return "";
	}
}

async function readDshSettings(homeDir: string): Promise<{ rawText: string; parsed: unknown }> {
	const rawText = await readText(join(homeDir, "settings.yaml"));
	return { rawText, parsed: loadYamlObject(rawText) };
}

/**
 * pi 内置 provider 名的小写集合（pi-ai catalog）。迁移据此分层：
 * 内置名 → key 写 pi auth.json（pi 靠内置 catalog 提供 provider/模型）；
 * 自定义名 → 全套写 pi models.json。
 * catalog 缺失/读取失败时退化为空集（全部当自定义处理，行为同旧版），绝不抛错。
 */
function piBuiltinProviderIds(): Set<string> {
	const set = new Set<string>();
	for (const id of getPiAiCatalogIndex().byProviderId.keys()) set.add(id.toLowerCase());
	return set;
}

/** 内置 provider 在 catalog 里的模型数与默认端点（preview 行展示用）。 */
function piBuiltinCatalogMeta(providerId: string): { modelCount: number; baseUrl?: string } {
	const inner = getPiAiCatalogIndex().byProviderId.get(providerId);
	if (!inner || inner.size === 0) return { modelCount: 0 };
	const first = [...inner.values()][0];
	return {
		modelCount: inner.size,
		baseUrl: typeof first?.baseUrl === "string" ? first.baseUrl : undefined,
	};
}

/**
 * auth.json 里、且是 pi 内置名、api_key 类型的条目 → preview 行
 * （models.json 里没有它们，但反向迁移时可由 catalog 补全后写入 DSH）。
 */
function authBuiltinPreviewRows(
	auth: Record<string, { type?: string }> | undefined,
	dshNames: Set<string>,
): MigratableProviderRow[] {
	if (!auth) return [];
	const rows: MigratableProviderRow[] = [];
	for (const [name, item] of Object.entries(auth)) {
		if (!isSafeProviderName(name)) continue;
		if (item?.type !== "api_key") continue; // OAuth 等不可用 API Key 迁移的跳过
		if (!piBuiltinProviderIds().has(name.toLowerCase())) continue; // 只列 pi 内置名
		const meta = piBuiltinCatalogMeta(name);
		rows.push({
			name,
			modelCount: meta.modelCount,
			hasKey: true,
			baseUrl: meta.baseUrl,
			targetExists: dshNames.has(name),
		});
	}
	return rows;
}

function listDshRows(
	parsed: ReturnType<typeof parseDshSettingsDocument>,
	piNames: Set<string>,
	hasKey: (namespace: "llm-pi-ai" | "llm-deepseek", name: string, profile: DshProviderProfile) => boolean,
): MigratableProviderRow[] {
	const rows: MigratableProviderRow[] = [];
	const deepseek = parsed.deepseek ?? {};
	// deepseek-official is supplied by DSH composition even when the user has no
	// llm-deepseek stanza. It must remain migratable as a credential-only source.
	rows.push({
		name: "deepseek",
		modelCount: deepseek.models?.length ?? 0,
		hasKey: hasKey("llm-deepseek", "deepseek", deepseek),
		baseUrl: deepseek.baseURL,
		namespace: "llm-deepseek",
		targetExists: piNames.has("deepseek"),
	});
	for (const [name, profile] of Object.entries(parsed.piAi)) {
		rows.push({
			name,
			modelCount: profile.models?.length ?? 0,
			hasKey: hasKey("llm-pi-ai", name, profile),
			baseUrl: profile.baseURL,
			namespace: "llm-pi-ai",
			targetExists: piNames.has(name),
		});
	}
	return rows.sort((left, right) => left.name.localeCompare(right.name));
}

export async function previewProviderMigration(
	deps: ProviderMigrationDeps,
	direction: MigrationDirection,
): Promise<ProviderMigrationPreview> {
	const [models, auth, dshDoc] = await Promise.all([
		deps.configManager.getModelsConfig(),
		deps.configManager.getAuthConfig(),
		readDshSettings(deps.dshHost.getHomeDir()),
	]);
	const piProviders = models.parsed.providers ?? {};
	const dshParsed = parseDshSettingsDocument(dshDoc.parsed);
	const dshNames = new Set([
		...Object.keys(dshParsed.piAi),
		...(dshParsed.deepseek ? ["deepseek"] : []),
	]);

	if (direction === "pi-to-dsh") {
		const customRows: MigratableProviderRow[] = Object.entries(piProviders)
			.filter(([name]) => isSafeProviderName(name))
			.map(([name, provider]) => ({
				name,
				modelCount: Array.isArray(provider.models) ? provider.models.length : 0,
				hasKey: Boolean(resolvePiApiKey(provider, auth.parsed[name])),
				baseUrl: typeof provider.baseUrl === "string" ? provider.baseUrl : undefined,
				targetExists: name === "deepseek" && looksLikeOfficialDeepseek(provider.baseUrl)
					? Boolean(dshParsed.deepseek)
					: dshNames.has(name),
			}));
		// 反向也列出 auth.json 中 pi 内置名（api_key）——它们不在 models.json，
		// 但可由 catalog 补全后写入 DSH；OAuth 一律不列（无法用 API Key 迁移）。
		const authRows = authBuiltinPreviewRows(auth.parsed, dshNames);
		const providers = [...customRows, ...authRows]
			.sort((left, right) => left.name.localeCompare(right.name));
		return { direction, providers };
	}

	const credentialText = await readText(join(deps.dshHost.getHomeDir(), ".credentials.yaml"));
	// pi 侧“已有同名”既看 models.json（自定义名）也看 auth.json（内置名），
	// 否则内置名迁移覆盖 auth.json 已有 key 时不会弹覆盖确认。
	const piExisting = new Set([
		...Object.keys(piProviders),
		...(auth.parsed ? Object.keys(auth.parsed) : []),
	]);
	const providers = listDshRows(dshParsed, piExisting, (_ns, name, profile) => {
		const ref = credentialRefFor(profile, name);
		// 兼容 dsh-credentials-local v1（version:1 + refs）与旧扁平布局
		const fromFile = Boolean(credentialValueFromDocument(credentialText, ref));
		const fromEnv = typeof process.env[ref] === "string" && (process.env[ref] ?? "").length > 0;
		return fromFile || fromEnv;
	});
	return { direction, providers };
}

async function readPiSnapshot(deps: ProviderMigrationDeps, name: string): Promise<PiProviderSnapshot> {
	const [models, auth] = await Promise.all([
		deps.configManager.getModelsConfig(),
		deps.configManager.getAuthConfig(),
	]);
	const provider = models.parsed.providers[name];
	if (!provider) throw new Error(`pi provider not found: ${name}`);
	return {
		name,
		baseUrl: typeof provider.baseUrl === "string" ? provider.baseUrl : undefined,
		api: typeof provider.api === "string" ? provider.api : undefined,
		apiKey: resolvePiApiKey(provider, auth.parsed[name]),
		headers: asStringHeaders(provider.headers),
		models: Array.isArray(provider.models) ? provider.models : [],
	};
}

async function readDshSnapshot(deps: ProviderMigrationDeps, name: string): Promise<DshProviderSnapshot> {
	const { parsed } = await readDshSettings(deps.dshHost.getHomeDir());
	const doc = parseDshSettingsDocument(parsed);
	const official = name === "deepseek";
	// deepseek-official is a composition route: no user settings section is still
	// a valid source, with the adapter's default DEEPSEEK_API_KEY reference.
	const profile = official ? (doc.deepseek ?? {}) : doc.piAi[name];
	if (!profile) throw new Error(`dsh provider not found: ${name}`);
	const namespace = official ? "llm-deepseek" as const : "llm-pi-ai" as const;
	const ref = credentialRefFor(profile, official ? "deepseek" : name);
	let apiKey: string | undefined;
	try {
		apiKey = await deps.dshHost.readCredentialValue(ref);
	} catch {
		apiKey = undefined;
	}
	return { name: official ? "deepseek" : name, namespace, profile, apiKey };
}

async function writePiSnapshot(deps: ProviderMigrationDeps, snapshot: PiProviderSnapshot): Promise<void> {
	const [models, auth] = await Promise.all([
		deps.configManager.getModelsConfig(),
		deps.configManager.getAuthConfig(),
	]);
	const merged = mergePiProvider(
		{ providers: models.parsed.providers ?? {} },
		auth.parsed,
		snapshot,
	);
	const modelsResult = await deps.configManager.saveModelsConfig(merged.models as PiModelsFile);
	if (!modelsResult.valid) throw new Error(modelsResult.error ?? "failed to save models.json");
	const authResult = await deps.configManager.saveAuthConfig(merged.auth as PiAuthFile);
	if (!authResult.valid) throw new Error(authResult.error ?? "failed to save auth.json");
}

/**
 * 分层落点（DSH→pi）：pi 内置 provider 只把 key 写进 auth.json，不新建 models.json 条目。
 * pi 靠内置 catalog 提供该 provider 的 baseUrl/models，因此无需在 models.json 重复定义。
 * 其它 auth 条目原样保留，只 upsert 目标内置名的 key。
 */
async function writePiProviderAuthOnly(deps: ProviderMigrationDeps, snapshot: PiProviderSnapshot): Promise<void> {
	if (!snapshot.apiKey) return;
	const authResult = await deps.configManager.getAuthConfig();
	const nextAuth = {
		...authResult.parsed,
		[snapshot.name]: { type: "api_key" as const, key: snapshot.apiKey },
	};
	await deps.configManager.saveAuthConfig(nextAuth as PiAuthFile);
}

export async function writeDshSnapshot(deps: ProviderMigrationDeps, snapshot: DshProviderSnapshot): Promise<boolean> {
	const needsSettingsWrite = Object.keys(snapshot.profile).length > 0;
	const hostReady = deps.dshHost.isHostReady();
	if (hostReady) {
		if (needsSettingsWrite) {
			const described = await deps.dshHost.describeSettings();
			const view = described.namespaces.find((item) => item.ns === snapshot.namespace);
			if (snapshot.namespace === "llm-deepseek") {
				await deps.dshHost.updateSettings(snapshot.namespace, snapshot.profile as Record<string, unknown>, view?.revision);
			} else {
				const current = view?.value && typeof view.value === "object" && !Array.isArray(view.value)
					? (view.value as { providers?: Record<string, unknown> })
					: {};
				const providers = { ...(current.providers ?? {}) };
				providers[snapshot.name] = snapshot.profile;
				await deps.dshHost.updateSettings(snapshot.namespace, { providers }, view?.revision);
			}
		}
		if (snapshot.apiKey) {
			const ref = credentialRefFor(snapshot.profile, snapshot.namespace === "llm-deepseek" ? "deepseek" : snapshot.name);
			if (!isValidCredentialRef(ref)) throw new Error(`invalid credential ref: ${ref}`);
			await deps.dshHost.setCredential(ref, snapshot.apiKey);
		}
		return true;
	}

	const home = deps.dshHost.getHomeDir();
	if (needsSettingsWrite) {
		const settingsPath = join(home, "settings.yaml");
		const { parsed } = await readDshSettings(home);
		const next = mergeDshProviderIntoSettings(parsed, snapshot);
		await writeFile(settingsPath, dumpYamlObject(next), "utf8");
	}
	if (snapshot.apiKey) {
		const ref = credentialRefFor(snapshot.profile, snapshot.namespace === "llm-deepseek" ? "deepseek" : snapshot.name);
		if (!isValidCredentialRef(ref)) throw new Error(`invalid credential ref: ${ref}`);
		const credPath = join(home, ".credentials.yaml");
		const existing = await readText(credPath);
		await writeFile(credPath, mergeCredentialDocument(existing, ref, snapshot.apiKey), "utf8");
	}
	return false;
}

export async function applyProviderMigration(
	deps: ProviderMigrationDeps,
	direction: MigrationDirection,
	providerName: string,
): Promise<ProviderMigrationResult> {
	if (!isSafeProviderName(providerName)) {
		return { ok: false, provider: String(providerName), direction, copiedKey: false, wroteViaHost: false, error: "invalid provider name" };
	}
	try {
		if (direction === "pi-to-dsh") {
			// auth.json 里只有 key、models.json 没有条目的 pi 内置名：
			// 由 catalog 补全端点/模型后写入 DSH。OAuth 拒绝；其余无条件迁移——
			// DSH 内置匹配的 provider（official deepseek）由 piToDshSnapshot 路由到
			// 对应 namespace（llm-deepseek），DSH 不认识的按普通 API Key provider
			// 落 llm-pi-ai.providers.<name>。不再要求 DSH settings.yaml 预先存在同名条目。
			const [models, auth] = await Promise.all([
				deps.configManager.getModelsConfig(),
				deps.configManager.getAuthConfig(),
			]);
			const authItem = auth.parsed[providerName];
			const inModels = Boolean(models.parsed.providers?.[providerName]);
			const isBuiltin = piBuiltinProviderIds().has(providerName.toLowerCase());
			if (!inModels && authItem && isBuiltin) {
				if (authItem.type !== "api_key") {
					return {
						ok: false,
						provider: providerName,
						direction,
						copiedKey: false,
						wroteViaHost: false,
						error: "OAuth 无法迁移：仅支持 API Key 认证的 provider",
					};
				}
				// 无条件迁移：不要求 DSH settings.yaml 预先存在同名条目。
				const snapshot = piBuiltinSnapshotFromCatalog(
					providerName,
					typeof authItem.key === "string" ? authItem.key : undefined,
					getPiAiCatalogIndex(),
				);
				if (!snapshot) {
					return {
						ok: false,
						provider: providerName,
						direction,
						copiedKey: false,
						wroteViaHost: false,
						error: "pi-ai catalog 无该内置 provider 的可用模型，无法迁移",
					};
				}
				const target = piToDshSnapshot(snapshot);
				const wroteViaHost = await writeDshSnapshot(deps, target);
				return { ok: true, provider: providerName, direction, copiedKey: Boolean(target.apiKey), wroteViaHost };
			}
			const source = await readPiSnapshot(deps, providerName);
			const target = piToDshSnapshot(source);
			const wroteViaHost = await writeDshSnapshot(deps, target);
			return { ok: true, provider: providerName, direction, copiedKey: Boolean(target.apiKey), wroteViaHost };
		}
		const source = await readDshSnapshot(deps, providerName);
		const target = dshToPiSnapshot(source);
		const isPiBuiltin = piBuiltinProviderIds().has(target.name.toLowerCase());
		if (isPiBuiltin) {
			// 内置名：key 落 pi auth.json，不建 models.json 条目（pi 靠内置 catalog 提供模型）。
			await writePiProviderAuthOnly(deps, target);
			return { ok: true, provider: providerName, direction, copiedKey: Boolean(target.apiKey), wroteViaHost: false };
		}
		await writePiSnapshot(deps, target);
		return { ok: true, provider: providerName, direction, copiedKey: Boolean(target.apiKey), wroteViaHost: false };
	} catch (error) {
		return {
			ok: false,
			provider: providerName,
			direction,
			copiedKey: false,
			wroteViaHost: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/** 给测试构造最小 pi provider。 */
export function asPiProvider(partial: Partial<PiProviderConfig> & { models?: PiProviderConfig["models"] }): PiProviderConfig {
	return {
		models: partial.models ?? [],
		...partial,
	};
}
