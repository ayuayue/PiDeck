import type { ModelPriceTag } from "../../../../shared/types";
import { getI18nLocale, t } from "../../i18n";
import { cn } from "../../lib/utils";

/**
 * 供应商公开报价徽章（当前只有 TokenDance 提供）：免费 / 折扣。
 *
 * 折扣按 locale 换算显示单位：中文用「8 折」（ratio × 10），其他语言用「20% off」。
 * 文案跟当前 locale 的词典（t），数字单位也取同一个 locale，两者不会错位。
 * 数值来自价格表的现价/参考价（见 src/main/config/tokendancePricing.ts），这里不再做取整妥协：
 * 2.5 折 / 3.5 折这类小数折扣原样显示。
 */
/** 折扣换算：中文「8 折」用 ratio × 10，其他语言用「20% off」的百分比。抽出纯函数便于验证两种口径。 */
export function formatDiscountBadgeValue(discount: number, locale: string): number {
	return locale === "zh-CN" || locale === "zh-TW" ? Math.round(discount * 100) / 10 : Math.round((1 - discount) * 100);
}

export function formatModelPriceTag(tag: ModelPriceTag): string | null {
	if (tag.free) return t("model.priceFree");
	if (tag.discount === undefined || tag.discount <= 0 || tag.discount >= 1) return null;
	return t("model.priceDiscount", { value: formatDiscountBadgeValue(tag.discount, getI18nLocale()) });
}

/** 模型名后面的小徽章；没有折扣/不是免费时不渲染（保持行高与现有模型行一致）。 */
export function ModelPriceTagBadge(props: { tag?: ModelPriceTag; className?: string }) {
	const label = props.tag ? formatModelPriceTag(props.tag) : null;
	if (!props.tag || !label) return null;
	return <span className={cn("shrink-0 rounded border border-border-subtle px-1 text-micro leading-4 tabular-nums", props.tag.free ? "text-success" : "text-muted-foreground", props.className)}>{label}</span>;
}
