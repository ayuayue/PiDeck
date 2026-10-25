import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { atom, createStore, Provider, useAtomValue } from "jotai";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// 保留真实 React/Jotai 订阅，只隔离设置镜像与无关的文案、别名解析。
const logoStyleAtom = atom("pi-tui");
const customLogoAtom = atom("");
// AcpBackendMark 需要的工具表镜像（真实 acp-atoms 会引入 channelSwitchAtoms 的 jotai atom，
// 该沙箱只提供 useAtomValue，用本地 atom 隔离即可）。
const acpToolsAtom = atom([]);
const { PiLogo, DshLogo, SessionSourceBadge, SessionBackendBadge, AcpBackendMark } = loadTsCommonJs("src/renderer/src/components/session/SessionSourceBadge.tsx", {
	stubs: {
		// VM 用 CJS require，测试用 ESM import；共用同一个 Jotai hook，避免两个 Provider context。
		jotai: { useAtomValue },
		"../../atoms/app-ui-atoms": { logoStyleAtom, customLogoAtom },
		"../../atoms/acp-atoms": { acpToolsAtom },
		"../../i18n": { t: (key) => key },
		"@/lib/utils": { cn: (...classes) => classes.filter(Boolean).join(" ") },
	},
});

/** 从公开组件渲染 HTML，各用例独立持有设置 store，不接触真实用户配置。 */
function renderLogo(component, props = {}, store = createStore()) {
	return renderToStaticMarkup(createElement(Provider, { store }, createElement(component, props)));
}

/** 官方三色位图：4×4 方形，10 个有色格，不可回落旧单色路径。 */
function assertPiTuiLogo(html) {
	assert.match(html, /viewBox="0 0 4 4"/u);
	assert.equal((html.match(/<rect\b/gu) ?? []).length, 10);
	for (const color of ["#E48A7A", "#4F8EB3", "#EAB65D"]) {
		assert.ok(html.includes(`fill="${color}"`), `缺少官方品牌色 ${color}`);
	}
	assert.doesNotMatch(html, /viewBox="140 140 520 520"/u);
}

test("pi 后端标识默认显示新的官方三色 logo", () => {
	const html = renderLogo(PiLogo);
	assertPiTuiLogo(html);
	assert.match(html, /aria-hidden="true"/u);
	assert.match(html, /class="size-3\.5"/u);
});

test("显式选择经典风格时 pi 后端标识保留旧单色 logo", () => {
	const store = createStore();
	store.set(logoStyleAtom, "classic");
	const html = renderLogo(PiLogo, {}, store);
	assert.match(html, /viewBox="140 140 520 520"/u);
	assert.equal((html.match(/<path\b/gu) ?? []).length, 2);
	assert.match(html, /fill="currentColor"/u);
	assert.doesNotMatch(html, /<rect\b/u);
});

test("pi 后端标识读取同一设置镜像，风格往返切换后渲染一致", () => {
	const store = createStore();
	assertPiTuiLogo(renderLogo(PiLogo, {}, store));
	store.set(logoStyleAtom, "classic");
	assert.match(renderLogo(PiLogo, {}, store), /viewBox="140 140 520 520"/u);
	store.set(logoStyleAtom, "pi-tui");
	assertPiTuiLogo(renderLogo(PiLogo, {}, store));
});

test("新 pi 后端 logo 保留输入框、下拉项与头像各自的尺寸类", () => {
	for (const className of ["size-[15px] shrink-0", "size-3.5 shrink-0", "size-4"]) {
		const html = renderLogo(PiLogo, { className });
		assertPiTuiLogo(html);
		assert.ok(html.includes(`class="${className}"`));
	}
});

test("pi 会话来源徽标复用同一设置，避免另一份旧 SVG 不跟随", () => {
	const store = createStore();
	assertPiTuiLogo(renderLogo(SessionSourceBadge, { source: "pi" }, store));
	store.set(logoStyleAtom, "classic");
	assert.match(renderLogo(SessionSourceBadge, { source: "pi" }, store), /viewBox="140 140 520 520"/u);
});

test("自定义 logo 风格：来源徽标渲染用户图片，风格切回内置标后不再渲染图片", () => {
	const store = createStore();
	store.set(logoStyleAtom, "custom");
	store.set(customLogoAtom, "data:image/png;base64,AAAA");
	const html = renderLogo(PiLogo, {}, store);
	assert.match(html, /<img src="data:image\/png;base64,AAAA"/u);
	assert.match(html, /class="size-3\.5 object-contain"/u, "自定义图沿用调用方给的尺寸类");

	// 选了 custom 但还没传图（或图被清掉）：回落内置标，不能渲染空 img
	store.set(customLogoAtom, "");
	assertPiTuiLogo(renderLogo(PiLogo, {}, store));

	store.set(logoStyleAtom, "pi-tui");
	store.set(customLogoAtom, "data:image/png;base64,AAAA");
	// 非 custom 风格下即使镜像里残留图片也不渲染它
	assertPiTuiLogo(renderLogo(PiLogo, {}, store));
});

test("DSH 后端标记用官方鲸鱼 logo（品牌蓝），不再渲染灰色文本徽标", () => {
	const html = renderLogo(SessionBackendBadge, { backend: "dsh" });
	// 官方 logo 的 viewBox（DeepSeek 鲸鱼），并带品牌蓝
	assert.match(html, /viewBox="0 0 50 50"/u);
	assert.match(html, /text-\[#4d6bfe\]/u);
	// 语义仍保留给悬停提示与读屏
	assert.match(html, /aria-label="sessionBackend\.dsh"/u);
	assert.match(html, /role="img"/u);
	// 不再把「DSH」当正文文本渲染
	assert.doesNotMatch(html, />sessionBackend\.dsh</u);
});

test("DSH logo 缺省即品牌蓝：回复行头与输入框不再渲染黑灰鲸鱼", () => {
	// 用户反馈（2026-10）：时间线回复行头、输入框后端选择器里的鲸鱼是黑灰的（currentColor 继承正文色），
	// 只有侧栏/Tab 的官方蓝。品牌蓝现在写在组件缺省值里，任何调用点漏传也是蓝的。
	const bare = renderLogo(DshLogo);
	assert.match(bare, /viewBox="0 0 50 50"/u);
	assert.match(bare, /text-\[#4d6bfe\]/u, "缺省必须带 DeepSeek 官方蓝");
	assert.match(bare, /dark:text-\[#8b9dff\]/u, "暗色按品牌蓝提亮一档");
	assert.match(bare, /size-3\.5/u, "缺省尺寸不变");

	// 调用方尺寸类照常生效（行头 size-4、输入框 size-[15px]、下拉项 size-3.5）
	for (const className of ["size-4", "size-[15px] shrink-0", "size-3.5 shrink-0"]) {
		const html = renderLogo(DshLogo, { className });
		assert.match(html, /text-\[#4d6bfe\]/u, "自定义尺寸下仍是品牌蓝");
		assert.ok(html.includes(className), `尺寸类 ${className} 必须原样透传`);
	}
});

test("输入框与行头不各自持有鲸鱼配色：DSH logo 只有一处品牌蓝定义", () => {
	const badge = readFileSync("src/renderer/src/components/session/SessionSourceBadge.tsx", "utf8");
	const composer = readFileSync("src/renderer/src/components/session/ComposerComponents.tsx", "utf8");
	const header = readFileSync("src/renderer/src/components/session/turn/TurnAuthorHeader.tsx", "utf8");
	// 品牌蓝只定义一次（组件缺省），调用点不再手写色值——新增调用点不可能再漏
	assert.equal((badge.match(/#4d6bfe/gu) ?? []).length, 1);
	assert.equal((composer.match(/#4d6bfe/gu) ?? []).length, 0);
	assert.equal((header.match(/#4d6bfe/gu) ?? []).length, 0);
	// 输入框三处（选择器触发、下拉项、锁定只读标）与行头都走同一个 DshLogo
	assert.equal((composer.match(/<DshLogo\b/gu) ?? []).length, 3);
	assert.match(header, /isDsh \? <DshLogo className="size-4"/u);
});

test("切换 pi logo 风格不改变 DSH 或其他会话来源品牌", () => {
	const store = createStore();
	const cases = [[DshLogo, {}], ...["codex", "claude", "qoder", "opencode", "zcode", "workbuddy", "cursor"].map((source) => [SessionSourceBadge, { source }])];
	for (const [component, props] of cases) {
		store.set(logoStyleAtom, "classic");
		const classic = renderLogo(component, props, store);
		store.set(logoStyleAtom, "pi-tui");
		assert.equal(renderLogo(component, props, store), classic);
	}
});

test("ACP 后端标记：按 acpToolId 解析品牌图标，无工具时回退通用终端图标", () => {
	const store = createStore();
	store.set(acpToolsAtom, [{ id: "tool-1", name: "Claude Agent", command: "npx", args: ["-y", "@agentclientprotocol/claude-agent"] }]);
	// brand 表命中 claude：渲染品牌 SVG 而非 lucide 终端图标
	const branded = renderLogo(AcpBackendMark, { acpToolId: "tool-1" }, store);
	assert.match(branded, /<svg/u);
	assert.doesNotMatch(branded, /lucide-terminal/u, "品牌命中时不应回落通用终端图标");

	// acpToolId 缺失（旧 catalog/工具已删）：不假装品牌，回退通用图标
	const fallback = renderLogo(AcpBackendMark, { acpToolId: undefined }, store);
	assert.match(fallback, /lucide-terminal/u);
});

test("输入框后端选择、下拉选项和锁定按钮全部复用统一 PiLogo", () => {
	const source = readFileSync("src/renderer/src/components/session/ComposerComponents.tsx", "utf8");
	assert.match(source, /import\s*\{[^}]*\bPiLogo\b[^}]*\}\s*from\s*["']\.\/SessionSourceBadge["']/u);
	assert.equal((source.match(/<PiLogo\b/gu) ?? []).length, 3);
	assert.doesNotMatch(source, /viewBox\s*=\s*["']140 140 520 520["']/u);
});
