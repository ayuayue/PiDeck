/**
 * ACP 模型倍率补充：从本机 magpie 的 provider 缓存里取每个模型的 credits 倍率，
 * 挂到 configOptions 的模型项上（ACP wire 本身没有价格字段，只有 name/description/_meta）。
 *
 * 同一个装配点还负责第二件事：把 agent 声明的单项锁定原因（`_meta["codebuddy.ai/locked"]`）
 * 映射成 DTO 的 `lockedReason`。两者都是「configOptions 出 main 时的注解」，共用
 * `createAcpModelRateAnnotator` 这一个出口，避免查询/下发/推送三条路径各写一遍。
 *
 * 数据源只读且可缺省：只有装了 magpie + codebuddy-import 插件才会有
 *   ~/.config/magpie/plugin-providers.json      （插件 provider 定义，含 rate/rateWas/free）
 *   ~/.cache/magpie/providers-state.json        （magpie 运行时缓存，同字段）
 * 文件不存在/损坏一律空表（fail-open）：ACP 模型列表退化为 agent 原样，不报错。
 *
 * 为什么读 magpie 而不直接问 WorkBuddy：倍率来自 WorkBuddy /v3/config 的 credits，
 * 需要账号 access token 和一整套 WorkBuddy 客户端头签名（见插件 vendor 的 sign()）。
 * 在 PiDeck 里复刻等于重写插件并把账号凭据搬进主进程，不做；magpie 哪天把 rate
 * 放进 /v1/models，也只需换掉这里的读取实现。
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, statSync } from "node:fs";
import type { AcpModelRate, AcpSessionConfigOption } from "../../shared/types/acp";
import { readAcpLockedReason } from "./acpProtocol";

type RateMap = Map<string, AcpModelRate>;
export type AcpModelRateCatalogue = { exact: RateMap; bare: Map<string, AcpModelRate | null> };

const EMPTY: AcpModelRateCatalogue = { exact: new Map(), bare: new Map() };

function rateOf(model: { rate?: unknown; rateWas?: unknown; free?: unknown }): AcpModelRate | undefined {
	// free 是插件显式标的「不计积分」；rate=0 但没有 free 的（如 auto 别名）不展示，
	// 否则每个别名都会挂一个没有意义的 0×。
	if (model.free === true) return { rate: 0, free: true };
	const rate = typeof model.rate === "number" && Number.isFinite(model.rate) && model.rate > 0 ? model.rate : undefined;
	if (rate === undefined) return undefined;
	const was = typeof model.rateWas === "number" && Number.isFinite(model.rateWas) && model.rateWas > rate ? model.rateWas : undefined;
	return { rate, ...(was !== undefined ? { was } : {}) };
}

function providerList(input: unknown): unknown[] {
	if (Array.isArray(input)) return input;
	const record = input as { providers?: unknown } | null;
	if (!record || typeof record !== "object") return [];
	if (Array.isArray(record.providers)) return record.providers;
	const nested = record.providers as { providers?: unknown } | null;
	return nested && Array.isArray(nested.providers) ? nested.providers : [];
}

function modelEntries(models: unknown): Array<Record<string, unknown>> {
	if (Array.isArray(models)) return models.filter((model): model is Record<string, unknown> => !!model && typeof model === "object");
	if (models && typeof models === "object") return Object.values(models).filter((model): model is Record<string, unknown> => !!model && typeof model === "object");
	return [];
}

/**
 * 解析 provider 文件（plugin-providers.json 与 providers-state.json 两种形态都吃）：
 * 产出 `providerId/modelId` 精确表，以及「去掉 provider 前缀后仍唯一」的裸模型名表。
 * 裸名冲突（同一个 glm-5.3 在多个 provider 下）记 null，宁可不显示也不猜。
 */
export function parseMagpieProviderRates(input: unknown): AcpModelRateCatalogue {
	const exact: RateMap = new Map();
	const bare: Map<string, AcpModelRate | null> = new Map();
	for (const provider of providerList(input)) {
		if (!provider || typeof provider !== "object") continue;
		const record = provider as { id?: unknown; models?: unknown };
		if (typeof record.id !== "string" || !record.id.trim()) continue;
		const providerId = record.id.trim();
		for (const model of modelEntries(record.models)) {
			const modelId = typeof model.id === "string" ? model.id.trim() : "";
			const rate = rateOf(model);
			if (!modelId || !rate) continue;
			exact.set(`${providerId}/${modelId}`, rate);
			const previous = bare.get(modelId);
			bare.set(modelId, previous === undefined ? rate : JSON.stringify(previous) === JSON.stringify(rate) ? previous : null);
		}
	}
	return { exact, bare };
}

/** 带 mtime 缓存的读取器：文件变了才重解析；两条路径都读不到时返回空表。 */
export function createMagpieRateSource(deps: { homeDir?: () => string; readFile?: (path: string) => string; statFile?: (path: string) => { mtimeMs: number; size: number } } = {}): () => AcpModelRateCatalogue {
	const home = deps.homeDir ?? homedir;
	const read = deps.readFile ?? ((path: string) => readFileSync(path, "utf8"));
	const stat = deps.statFile ?? ((path: string) => statSync(path));
	let cached: { key: string; catalogue: AcpModelRateCatalogue } | undefined;
	return () => {
		for (const path of [join(home(), ".config", "magpie", "plugin-providers.json"), join(home(), ".cache", "magpie", "providers-state.json")]) {
			try {
				const info = stat(path);
				const key = `${path}:${info.mtimeMs}:${info.size}`;
				if (cached?.key === key) return cached.catalogue;
				const catalogue = parseMagpieProviderRates(JSON.parse(read(path)));
				cached = { key, catalogue };
				return catalogue;
			} catch {
				continue;
			}
		}
		return EMPTY;
	};
}

function rateFor(value: string, catalogue: AcpModelRateCatalogue): AcpModelRate | undefined {
	const exact = catalogue.exact.get(value) ?? (value.startsWith("magpie/") ? catalogue.exact.get(value.slice("magpie/".length)) : undefined);
	if (exact) return exact;
	if (value.includes("/")) return undefined;
	return catalogue.bare.get(value) ?? undefined;
}

/**
 * 给模型选择项挂 rate（PiDeck 扩展字段，不是 ACP wire 字段）。
 * 只动 category/id 为 model 的选项；其他选项即使值碰巧相同也不标倍率。
 */
export function annotateAcpModelRates(options: AcpSessionConfigOption[] | undefined, catalogue: AcpModelRateCatalogue): AcpSessionConfigOption[] | undefined {
	if (!options?.length) return options;
	return options.map((option) => {
		if (option.category?.toLowerCase() !== "model" && option.id.toLowerCase() !== "model") return option;
		if (!Array.isArray(option.options)) return option;
		let changed = false;
		const next = option.options.map((item) => {
			if ("group" in item) {
				let itemChanged = false;
				const values = item.options.map((value) => {
					const rate = rateFor(value.value, catalogue);
					if (!rate) return value;
					itemChanged = true;
					return { ...value, rate };
				});
				if (!itemChanged) return item;
				changed = true;
				return { ...item, options: values };
			}
			const rate = rateFor(item.value, catalogue);
			if (!rate) return item;
			changed = true;
			return { ...item, rate };
		});
		return changed ? { ...option, options: next } : option;
	});
}

/**
 * 把 agent 声明的单项锁定原因搬进 DTO（`_meta` 是协议元数据，不进渲染层契约）。
 *
 * 与倍率注解共用同一个装配点：`acpSessionConfigGet` / `acpSessionConfigSet` /
 * `acpSessionConfigChanged` 三个出口都经过这里，所以只在「出 main」时映射一次。
 * 解锁是运行期事件（`config_option_update` 不再带原因），因此每次都从当前 option 重算，
 * 不做跨次缓存。
 */
export function annotateAcpLockedOptions(options: AcpSessionConfigOption[] | undefined): AcpSessionConfigOption[] | undefined {
	if (!options?.length) return options;
	return options.map((option) => {
		const lockedReason = readAcpLockedReason((option as { _meta?: Record<string, unknown> })._meta);
		return lockedReason === undefined ? option : { ...option, lockedReason };
	});
}

/** 装配用：一次读取（缓存）+ 注解，main/index 把它同时接给查询/下发/推送三个出口。 */
export function createAcpModelRateAnnotator(source: () => AcpModelRateCatalogue = createMagpieRateSource()) {
	return (options: AcpSessionConfigOption[] | undefined): AcpSessionConfigOption[] | undefined => annotateAcpLockedOptions(annotateAcpModelRates(options, source()));
}
