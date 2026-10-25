import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { atom, createStore, Provider, useAtomValue } from "jotai";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createDefaultAppSettings } = loadTsCommonJs("src/shared/types/settings.ts");
const logoStyleAtom = atom("pi-tui");
const passthrough = ({ children }) => children;
const hidden = () => null;
const { AppearanceTab } = loadTsCommonJs("src/renderer/src/components/app/settings/AppearanceTab.tsx", {
	stubs: {
		jotai: { useAtomValue },
		"../../atoms/app-ui-atoms": { logoStyleAtom },
		"../../../desktopApi": { desktopApi: {} },
		"../../../i18n": { t: (key) => key },
		"@/lib/utils": { cn: (...classes) => classes.filter(Boolean).join(" ") },
		"./SettingsStorageTab": { SettingsSection: passthrough },
		"./SettingRows": { SettingRow: passthrough, DirtyMarker: hidden, SettingSwitchRow: hidden },
		"./ModuleVisibilitySection": { ModuleVisibilitySection: hidden },
		"./CustomThemeSection": { CustomThemeSection: hidden },
		// SSR 不渲染 Radix Portal；只替换菜单容器，保留真实选项内容与品牌 SVG。
		"../../ui-shadcn/select": {
			Select: passthrough,
			SelectTrigger: hidden,
			SelectValue: hidden,
			SelectContent: passthrough,
			SelectItem: ({ value, children }) => createElement("div", { "data-option": value }, children),
		},
	},
});

/** 真实外观页渲染：草稿与全局 Logo 风格独立，选项预览不能跟着当前选择变成另一种标。 */
function renderOptions(draftStyle = "pi-tui", savedStyle = "pi-tui") {
	const store = createStore();
	store.set(logoStyleAtom, savedStyle);
	const html = renderToStaticMarkup(
		createElement(
			Provider,
			{ store },
			createElement(AppearanceTab, {
				draft: { ...createDefaultAppSettings(), logoStyle: draftStyle },
				updateDraft: () => {},
				isDirty: () => false,
				perAreaFontSize: false,
				setPerAreaFontSize: () => {},
				visionEnabled: undefined,
			}),
		),
	);
	return (value) => {
		const content = html.match(new RegExp(`<div data-option="${value}">([\\s\\S]*?)</div>`))?.[1];
		assert.ok(content, `缺少 ${value} 选项`);
		return content;
	};
}

test("经典 Logo 选项使用不透明黑底，银灰图形不会融入浅色菜单", () => {
	const classic = renderOptions()("classic");
	assert.match(classic, /<svg\b[^>]*class="[^"]*\bbg-black\b/u);
	assert.doesNotMatch(classic, /opacity(?:=|-)|fill="(?:transparent|none)"/u);
	assert.match(classic, /aria-hidden="true"/u);
});

test("经典 Logo 预览保留完整 π 轮廓和镂空，不再用两个矩形近似", () => {
	const classic = renderOptions()("classic");
	assert.equal((classic.match(/<path\b/gu) ?? []).length, 2);
	assert.match(classic, /fill-rule="evenodd"/u);
	assert.match(classic, /fill="#f4f4f5"/u);
	assert.match(classic, /fill="#a7a8ab"/u);
	assert.doesNotMatch(classic, /<rect\b/u);
});

test("Logo 选项预览不受草稿或当前已保存风格影响，三色标保持原位图", () => {
	const expected = renderOptions();
	for (const draftStyle of ["classic", "pi-tui"]) {
		for (const savedStyle of ["classic", "pi-tui"]) {
			const options = renderOptions(draftStyle, savedStyle);
			assert.equal(options("classic"), expected("classic"));
			assert.equal(options("pi-tui"), expected("pi-tui"));
			assert.equal((options("pi-tui").match(/<rect\b/gu) ?? []).length, 10);
		}
	}
});
