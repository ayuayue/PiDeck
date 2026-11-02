/** 折扣/免费徽章：文案换算与渲染结构（无 tag 不占位，保证模型行高度不变）。 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { formatModelPriceTag, formatDiscountBadgeValue, ModelPriceTagBadge } = loadTsCommonJs("src/renderer/src/components/session/ModelPriceTagBadge.tsx");
const zhCN = loadTsCommonJs("src/renderer/src/i18n/rendererCopy.zh-CN.ts").zhCN;
const enUS = loadTsCommonJs("src/renderer/src/i18n/rendererCopy.en-US.ts").enUS;
const { renderToStaticMarkup } = await import("react-dom/server");
const { createElement } = await import("react");

const render = (tag) => renderToStaticMarkup(createElement(ModelPriceTagBadge, { tag }));

test("formatDiscountBadgeValue：中文用「折」（小数保留一位），英文用 % off", () => {
	assert.equal(formatDiscountBadgeValue(0.8, "zh-CN"), 8);
	assert.equal(formatDiscountBadgeValue(0.25, "zh-TW"), 2.5);
	assert.equal(formatDiscountBadgeValue(0.85, "zh-CN"), 8.5);
	assert.equal(formatDiscountBadgeValue(0.8, "en-US"), 20);
	assert.equal(formatDiscountBadgeValue(0.25, "en-US"), 75);
});

test("文案键：免费 / 折扣中英文都已存在", () => {
	assert.equal(zhCN["model.priceFree"], "免费");
	assert.equal(zhCN["model.priceDiscount"], "{value}折");
	assert.equal(enUS["model.priceFree"], "Free");
	assert.equal(enUS["model.priceDiscount"], "{value}% off");
});

test("formatModelPriceTag 用当前词典渲染，无折扣/原价/非法值返回 null", () => {
	// 默认 locale 是 zh-CN
	assert.equal(formatModelPriceTag({ free: true }), "免费");
	assert.equal(formatModelPriceTag({ discount: 0.8 }), "8折");
	assert.equal(formatModelPriceTag({ discount: 0.25 }), "2.5折");
	assert.equal(formatModelPriceTag({}), null);
	assert.equal(formatModelPriceTag({ discount: 1 }), null);
	assert.equal(formatModelPriceTag({ discount: 0 }), null);
	assert.equal(formatModelPriceTag({ discount: -0.5 }), null);
});

test("徽章渲染：免费走 success 色、折扣走次要色，无 tag 不渲染", () => {
	const free = render({ free: true });
	assert.match(free, /^<span /);
	assert.match(free, /text-success/);
	assert.match(free, />免费</);

	const discounted = render({ discount: 0.8 });
	assert.match(discounted, /text-muted-foreground/);
	assert.doesNotMatch(discounted, /text-success/);
	assert.match(discounted, />8折</);

	assert.equal(render(undefined), "");
	assert.equal(render({}), "");
});
