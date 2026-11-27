import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { atom, createStore, Provider, useAtomValue } from "jotai";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const logoStyleAtom = atom("pi-tui");
const customLogoAtom = atom("");
const { LogoMark, BuiltinLogoMark } = loadTsCommonJs("src/renderer/src/components/app/LogoMark.tsx", {
	stubs: {
		jotai: { useAtomValue },
		"../../atoms/app-ui-atoms": { logoStyleAtom, customLogoAtom },
		"../../i18n": { t: (key) => key },
	},
});

/** 以真实设置镜像渲染品牌标，不触碰用户配置。 */
function renderMark(style = "pi-tui", size = 40, customImage = "", props = {}) {
	const store = createStore();
	store.set(logoStyleAtom, style);
	store.set(customLogoAtom, customImage);
	return renderToStaticMarkup(createElement(Provider, { store }, createElement(LogoMark, { size, ...props })));
}

test("新建页等静态品牌位：两种内置风格共用白底与 65% 正方形主体", () => {
	for (const size of [16, 28, 40, 64, 88]) {
		for (const style of ["classic", "pi-tui"]) {
			const html = renderMark(style, size);
			assert.match(html, /class="[^"]*\bbg-white\b/u);
			assert.doesNotMatch(html, /\bbg-black\b/u);
			const [, width, height] = html.match(/<svg\b[^>]*width="([^"]+)" height="([^"]+)"/u) ?? [];
			assert.equal(Number(width), size * 0.65);
			assert.equal(Number(height), size * 0.65);
			assert.ok(html.includes(`width:${size}px;height:${size}px`));
		}
	}
});

test("标题栏品牌位不叠底板、描边或阴影，主体按指定尺寸显示", () => {
	for (const style of ["classic", "pi-tui"]) {
		const html = renderMark(style, 18, "", { variant: "inline" });
		assert.doesNotMatch(html, /\bbg-white\b|\bshadow-sm\b|\bring-1\b/u);
		assert.match(html, /<svg\b[^>]*width="18" height="18"/u);
		assert.ok(html.includes("width:18px;height:18px"));
		if (style === "classic") assert.match(html, /fill="currentColor"/u);
	}
	const customImage = "data:image/png;base64,AAAA";
	assert.equal(renderMark("custom", 18, customImage, { variant: "inline" }), renderMark("custom", 18, customImage));
});

test("经典品牌位使用深灰完整几何，三色标保持品牌原色", () => {
	const classic = renderMark("classic");
	assert.match(classic, /viewBox="165\.29 165\.29 469\.43 469\.43"/u);
	assert.equal((classic.match(/<path\b/gu) ?? []).length, 2);
	assert.match(classic, /fill-rule="evenodd"/u);
	assert.match(classic, /fill="#18181b"/u);
	const triColor = renderMark();
	assert.equal((triColor.match(/<rect\b/gu) ?? []).length, 10);
	for (const color of ["#E48A7A", "#4F8EB3", "#EAB65D"]) assert.ok(triColor.includes(color));
});

test("自定义品牌图铺满外框，不叠白底或缩为 65%；缺图回落三色标", () => {
	const html = renderMark("custom", 64, "data:image/png;base64,AAAA");
	assert.match(html, /^<img\b/u);
	assert.doesNotMatch(html, /\bbg-white\b|<svg/u);
	assert.match(html, /width="64" height="64"/u);
	assert.equal(renderMark("custom"), renderMark("pi-tui"));
});

test("设置预览显式风格不受全局选择和自定义图影响", () => {
	assert.equal(typeof BuiltinLogoMark, "function");
	const store = createStore();
	store.set(logoStyleAtom, "custom");
	store.set(customLogoAtom, "data:image/png;base64,AAAA");
	for (const style of ["classic", "pi-tui"]) {
		const html = renderToStaticMarkup(createElement(Provider, { store }, createElement(BuiltinLogoMark, { style, size: 16 })));
		assert.doesNotMatch(html, /<img/u);
		assert.match(html, /\bbg-white\b/u);
		assert.match(html, /width="10\.4" height="10\.4"/u);
	}
});
