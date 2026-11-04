/**
 * 渲染层价格徽章源：模块级缓存 + 目录注解。
 *
 * 数据来自主进程 config:get-tokendance-price-tags（TokenDance 公开报价派生，见
 * src/main/config/tokendancePricing.ts）。这里只做两件事：
 * 1. 一次会话内只拉一次（主进程自己做 6h TTL + 后台刷新，渲染层不需要轮询）；
 * 2. 把徽章挂到 tokendance 目录模型的 priceTag 上，其他 provider 的模型原样返回。
 *
 * 失败静默：徽章是装饰信息，拿不到就不显示，绝不因此影响模型列表或选择器交互。
 */
import type { AvailableModel } from "../../../shared/types";
import { TOKENDANCE_PROVIDER, type TokendancePriceTagMap } from "../../../shared/tokendance";
import { desktopApi } from "../desktopApi";

const EMPTY_TAGS: TokendancePriceTagMap = {};
let cached: TokendancePriceTagMap | null = null;
let inflight: Promise<TokendancePriceTagMap> | null = null;

/** 取价格徽章表（首次调用触发 IPC，之后走模块缓存；失败也缓存空表，避免反复打网络）。 */
export function loadTokenDancePriceTags(): Promise<TokendancePriceTagMap> {
	if (cached) return Promise.resolve(cached);
	inflight ??= desktopApi.config
		.getTokendancePriceTags()
		.then((result) => {
			cached = result.tags ?? EMPTY_TAGS;
			return cached;
		})
		.catch(() => {
			cached = EMPTY_TAGS;
			return cached;
		})
		.finally(() => {
			inflight = null;
		});
	return inflight;
}

/**
 * 给 tokendance 模型补 priceTag（原地不动：返回新数组，无变化时返回原数组以保持引用稳定）。
 * 已带 priceTag 的模型不覆盖——同一 id 在一份目录里只挂一次。
 */
export function applyTokenDancePriceTags(models: AvailableModel[], tags: TokendancePriceTagMap): AvailableModel[] {
	if (models.length === 0 || Object.keys(tags).length === 0) return models;
	let changed = false;
	const next = models.map((model) => {
		if (model.provider !== TOKENDANCE_PROVIDER || model.priceTag) return model;
		const tag = tags[model.id];
		if (!tag) return model;
		changed = true;
		return { ...model, priceTag: tag };
	});
	return changed ? next : models;
}
