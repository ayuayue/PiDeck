/**
 * TokenDance 一键安装：把供应商信息 + 目录模型写入 pi / DSH 配置。
 *
 * 设计动机（对应用户可见的「确认后写入配置文件」流程）：
 * - 不依赖任何展示层注入：模型写入 models.json（pi 侧）/ llm-pi-ai providers（DSH 侧）
 *   后，由 pi/DSH 运行时自行解析，配置页模型列表、会话模型选择、用量查询全部走
 *   既有链路，无需特判。
 * - 幂等：重复安装以同一份目录覆盖模型（用户改过模型列表？不覆盖——只做 upsert，
 *   保留已有 provider 时用户手工调整的字段；models 目录更新时合并）。
 * - Key 落点跟随迁移服务惯例（mergePiProvider）：内联写 models.json provider.apiKey，
 *   与 ModelsTab 编辑器一致（此前写 auth.json 造成迁移后 key 显示为空的 bug）。
 * - DSH 侧不写 X-App-URL 请求头：TokenDance 通过 OAuth 创建的 Key 已带 app_url 归因，
 *   且 DSH settings schema 白名单字段可能拒绝 headers，落点保持最小。
 */
import { TOKENDANCE_APP_URL, TOKENDANCE_APP_URL_HEADER, TOKENDANCE_BASE_URL, TOKENDANCE_PROVIDER } from "../../shared/tokendance";
import type { AvailableModel } from "../../shared/types";
import { credentialRefFor, dshModelsFromPi, mergePiProvider, type DshProviderSnapshot, type PiProviderSnapshot } from "./providerMigration";
import type { PiModelItem } from "./ConfigManager";
import type { ProviderMigrationDeps } from "./providerMigrationService";
import type { TokendanceCatalogStore } from "./tokendanceCatalog";
import type { PiAiCatalogEntry } from "../pi/piAiBuiltinCatalog";

/**
 * 按模型 id 从 pi-ai 目录补能力字段（maxTokens/reasoning/input/thinkingLevelMap）。
 * TokenDance /models 只下 id/name/context_length/supported_protocols，没有这些字段；
 * 不补的话配置页表格「最大 Token/能力」大量空白，且 pi 侧无从得知思考档位映射。
 * 供应商名字段未知（网关模型 id 与官方一致），用全局 id 精确匹配即可；
 * 依赖注入便于单测（测试传 stub），主进程装配时接 getPiAiCatalogIndex+lookupPiAiCatalogEntry。
 */
export type TokendanceCatalogLookup = (modelId: string) => PiAiCatalogEntry | undefined;

export type TokendanceInstallResult = {
	ok: boolean;
	/** 本次写入的模型数（目录为空时为 0 且 ok=false）。 */
	modelCount: number;
	/** pi models.json 是否已写入（含 Key upsert）。 */
	piSaved: boolean;
	/** DSH 侧是否也写入（host 未就绪时经磁盘合并，仍返回 true）。 */
	dshSaved: boolean;
	/** DSH 写入是否走了 host 官方 API（false = 磁盘直写 settings.yaml/.credentials.yaml）。 */
	dshWroteViaHost?: boolean;
	/** DSH 写入失败原因（不含 Key；仅诊断用，UI 不直接展示）。 */
	dshError?: string;
	error?: string;
};

export type TokendanceInstallDeps = ProviderMigrationDeps & {
	tokendanceCatalog: TokendanceCatalogStore;
	/** 能力字段补全（可选）：未提供时只写目录实报字段。 */
	catalogLookup?: TokendanceCatalogLookup;
};

/**
 * 执行安装：目录 → pi models.json（merge upsert）+ DSH llm-pi-ai（host 就绪走
 * settings API，否则磁盘直写）。任一写盘失败即返回 ok=false（错误信息原样上抛，
 * 由 IPC 边界转结构化结果，不泄露 Key）。
 */
export async function installTokendanceProvider(
	deps: TokendanceInstallDeps,
	options: { apiKey?: string } = {},
): Promise<TokendanceInstallResult> {
	// 安装前强制刷新目录：旧缓存可能含已废弃的行（如 2026-09 曾写入 context_length=0
	// 的模型导致 pi 拒绝整个 provider）；刷新失败（断网/超时）降级用旧缓存，不让目录消失。
	let catalogResult;
	try {
		catalogResult = await deps.tokendanceCatalog.refresh();
	} catch {
		catalogResult = await deps.tokendanceCatalog.getModels();
	}
	if (!catalogResult || catalogResult.models.length === 0) {
		return {
			ok: false,
			modelCount: 0,
			piSaved: false,
			dshSaved: false,
			error: "TokenDance catalog unavailable",
		};
	}

	const apiKey = typeof options.apiKey === "string" && options.apiKey.trim() ? options.apiKey.trim() : undefined;
	const piModels: PiModelItem[] = catalogResult.models.map((model: AvailableModel) => {
		const row: PiModelItem = { id: model.id };
		// 目录条目是网络数据，逐字段收窄后落盘（name/contextWindow 缺失时省略）；
		// contextWindow 必须正整数：pi 报 invalid contextWindow 会拒绝整个 provider。
		if (typeof model.name === "string" && model.name.trim()) row.name = model.name.trim();
		if (typeof model.contextWindow === "number" && Number.isInteger(model.contextWindow) && model.contextWindow > 0) {
			row.contextWindow = model.contextWindow;
		}
		// 能力字段从 pi-ai 目录补：目录权威（contextWindow 以平台实报为准），
		// 目录命中时补 maxTokens/reasoning/input/thinkingLevelMap；命中不在数据即省略（不猜默认值）。
		const entry = deps.catalogLookup?.(model.id);
		if (entry) {
			if (typeof entry.maxTokens === "number" && Number.isFinite(entry.maxTokens)) row.maxTokens = entry.maxTokens;
			if (typeof entry.reasoning === "boolean") row.reasoning = entry.reasoning;
			if (Array.isArray(entry.input) && entry.input.length > 0) row.input = [...entry.input];
			if (entry.thinkingLevelMap) row.thinkingLevelMap = { ...entry.thinkingLevelMap };
		}
		return row;
	});

	// pi 侧：merge upsert，保留用户已有条目（apiKey 等），模型以目录为准覆盖。
	const piSnapshot: PiProviderSnapshot = {
		name: TOKENDANCE_PROVIDER,
		baseUrl: TOKENDANCE_BASE_URL,
		api: "openai-completions",
		// 请求维度归因：TokenDance 平台按 X-App-URL 将调用计入 PiDeck（覆盖 Key 归因）
		headers: { [TOKENDANCE_APP_URL_HEADER]: TOKENDANCE_APP_URL },
		models: piModels,
		apiKey,
	};
	const [modelsConfig, authConfig] = await Promise.all([
		deps.configManager.getModelsConfig(),
		deps.configManager.getAuthConfig(),
	]);
	const merged = mergePiProvider(
		{ providers: modelsConfig.parsed.providers ?? {} },
		authConfig.parsed,
		piSnapshot,
	);
	const saveResult = await deps.configManager.saveModelsConfig(merged.models as never);
	if (!saveResult.valid) {
		return {
			ok: false,
			modelCount: piModels.length,
			piSaved: false,
			dshSaved: false,
			error: saveResult.error ?? "failed to save models.json",
		};
	}

	// DSH 侧：不写 headers（Key 已带归因；避免 schema 拒绝未知字段），其余字段对齐
	// dsh-web llm-pi-ai 惯例（displayName/baseURL/api/apiKeyEnv/models）。
	// 容错：DSH 未安装/未启动/直写失败都不阻断 pi 侧写入——用户可能只用 pi 后端，
	// DSH 侧失败仅体现在 dshSaved=false（渲染层提示“已写入 Pi 配置；DSH 未同步”）。
	const dshSnapshot: DshProviderSnapshot = {
		name: TOKENDANCE_PROVIDER,
		namespace: "llm-pi-ai",
		profile: {
			displayName: "TokenDance",
			baseURL: TOKENDANCE_BASE_URL,
			api: "openai-completions",
			apiKeyEnv: credentialRefFor(undefined, TOKENDANCE_PROVIDER),
			models: dshModelsFromPi(piModels),
		},
		apiKey,
	};
	try {
		// writeDshSnapshot 由 providerMigrationService 提供并复用（host 就绪走官方 API，
		// 否则直写 settings.yaml/.credentials.yaml）。
		const { writeDshSnapshot } = await import("./providerMigrationService");
		const wroteViaHost = await writeDshSnapshot(deps, dshSnapshot);
		return {
			ok: true,
			modelCount: piModels.length,
			piSaved: true,
			dshSaved: true,
			dshWroteViaHost: wroteViaHost,
		};
	} catch (error) {
		// 跨 realm（测试 vm 加载）时 instanceof Error 不可靠，用结构提取 message
		const dshError =
			error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string"
				? (error as { message: string }).message
				: String(error);
		return {
			ok: true,
			modelCount: piModels.length,
			piSaved: true,
			dshSaved: false,
			dshError,
		};
	}
}
