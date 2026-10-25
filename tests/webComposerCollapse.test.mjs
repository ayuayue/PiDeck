import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { resolveComposerCollapsed } = loadTsCommonJs("src/renderer/src/web/composerCollapse.ts");

const idle = { mobileViewport: true, draft: "", imageCount: 0, streaming: false, focused: false, busy: false, attachError: false, planMode: false };

test("窄屏空闲输入区折叠", () => {
	assert.equal(resolveComposerCollapsed(idle), true);
});

test("桌面宽度永不折叠（Web 桌面端视觉零变化）", () => {
	assert.equal(resolveComposerCollapsed({ ...idle, mobileViewport: false }), false);
});

test("任一「需要看工具行」的条件成立就不折叠", () => {
	assert.equal(resolveComposerCollapsed({ ...idle, draft: "hi" }), false);
	assert.equal(resolveComposerCollapsed({ ...idle, draft: " " }), false);
	assert.equal(resolveComposerCollapsed({ ...idle, imageCount: 1 }), false);
	assert.equal(resolveComposerCollapsed({ ...idle, streaming: true }), false);
	assert.equal(resolveComposerCollapsed({ ...idle, focused: true }), false);
	assert.equal(resolveComposerCollapsed({ ...idle, busy: true }), false);
	assert.equal(resolveComposerCollapsed({ ...idle, attachError: true }), false);
	assert.equal(resolveComposerCollapsed({ ...idle, planMode: true }), false);
});

test("接线契约：组件用纯函数判定，三处（行显隐 / min-h / CSS 下限）同改", () => {
	const composer = readFileSync("src/renderer/src/web/WebComposer.tsx", "utf8");
	assert.match(composer, /resolveComposerCollapsed\(\{/, "折叠判定必须走纯函数，不能只活在 JSX 表达式里");
	assert.doesNotMatch(composer, /collapsed\s*\?\s*null\s*:\s*\(/, "折叠不能卸载两行工具区：卸载会连带销毁提示词弹层与文件输入框");
	assert.match(composer, /inert=\{\s*collapsed\s*\}/, "折叠态改用 grid-rows 收高 + inert，而不是把 DOM 删掉");
	assert.match(composer, /collapsed\s*\?\s*"grid-rows-\[0fr\]"\s*:\s*"grid-rows-\[1fr\]"/, "两行工具区折叠复用顶栏的 grid-rows 范式");
	assert.match(composer, /data-testid="web-composer-tool-rows"/, "折叠外壳必须有稳定 testid：e2e 靠 inert 判定折叠态，不能靠可见性（裁剪后的元素仍有 boundingBox）");
	assert.match(composer, /collapsed\s*\?\s*"min-h-14"\s*:\s*"min-h-\[7rem\]"/, "composer-box 的最小高度必须随折叠态切换：只改 CSS 会被这条 utility 撑回 112px");

	const css = readFileSync("src/renderer/src/web/web.css", "utf8");
	const mobileBlock = css.match(/@media\s*\(max-width:\s*760px\)\s*\{[\s\S]*?\n\}/g) ?? [];
	const composerRule = mobileBlock.map((block) => block.match(/\.composer-box\s*\{[^}]*\}/)?.[0] ?? "").find((rule) => rule.includes("min-height"));
	assert.ok(composerRule, "web.css 移动断点里应有 composer-box 规则");
	assert.match(composerRule, /min-height:\s*0;/, "web.css 是 unlayered 声明，留着 6rem 会把折叠态顶回 96px");
});

test("折叠态仍保留后端切换入口（否则「换个后端试试」变成完全不可见）", () => {
	const composer = readFileSync("src/renderer/src/web/WebComposer.tsx", "utf8");
	assert.match(composer, /const\s+collapsedBackendPicker\s*=\s*collapsed\s*&&\s*Boolean\(\s*props\.onBackendChange\s*\)\s*&&\s*!props\.backendLocked/, "折叠态后端 pill 只在草稿期出现：锁定的历史会话不摆点不动的控件");
	assert.match(composer, /collapsedBackendPicker\s*&&\s*props\.onBackendChange\s*\?\s*<WebBackendSelector/, "折叠态浮动区必须能打开后端选择器");
	assert.match(composer, /const\s+suppressPointerFocus\s*=\s*mobileViewport\s*\?/, "阻止焦点转移只对窄屏生效：桌面宽度不参与折叠，应保持原生焦点语义");
	assert.match(composer, /onPointerDown=\{\s*suppressPointerFocus\s*\}/, "窄屏下浮动区与两行工具区都要阻止焦点转移，否则控件在 click 前被卸载");
	assert.match(composer, /\{\s*sendControls\(\s*true\s*\)\s*\}/, "折叠态浮动区必须保留发送/停止按钮（用独立 testid，避免与工具行里的同名按钮撞车）");
	assert.match(composer, /\{sendControls\(false\)\}/, "工具行保留自己的发送/停止按钮");
});

const { resolveComposerHidden } = loadTsCommonJs("src/renderer/src/web/composerCollapse.ts");

const hideBase = { headerHidden: true, nearBottom: false, streaming: false, engaged: false };

test("输入区整区收起：仅「离开底部 + 顶栏已收起 + 没输入 + 没收流」", () => {
	assert.equal(resolveComposerHidden(hideBase), true);
});

test("任一保护条件成立就不收起", () => {
	assert.equal(resolveComposerHidden({ ...hideBase, headerHidden: false }), false, "顶栏还露着时输入区不该先消失");
	assert.equal(resolveComposerHidden({ ...hideBase, nearBottom: true }), false, "在最新消息处必须能直接打字");
	assert.equal(resolveComposerHidden({ ...hideBase, streaming: true }), false, "流式中输入区就是 Stop 按钮");
	assert.equal(resolveComposerHidden({ ...hideBase, engaged: true }), false, "聚焦/有草稿/有附件时不能把内容藏掉");
});

test("接线契约：输入区收起复用顶栏 slot 范式，且由时间线的贴底状态驱动", () => {
	const app = readFileSync("src/renderer/src/web/WebChatApp.tsx", "utf8");
	assert.match(app, /resolveComposerHidden\(\{\s*headerHidden,\s*nearBottom,\s*streaming:\s*combinedStreaming,\s*engaged:\s*composerEngaged\s*\}\)/);
	assert.match(app, /if\s*\(\s*nearBottom\s*\)\s*revealHeader\(\s*\)/, "回到最新消息必须同时露出顶栏（输入区随顶栏恢复）");

	const composer = readFileSync("src/renderer/src/web/WebComposer.tsx", "utf8");
	assert.match(composer, /props\.hidden\s*\?\s*"grid-rows-\[0fr\]"\s*:\s*"grid-rows-\[1fr\]"/, "收起必须复用 grid-rows 过渡");
	assert.match(composer, /inert=\{Boolean\(props\.hidden\)\}/, "收起态必须 inert，否则看不见的输入框仍可被 Tab 命中");
	assert.match(composer, /props\.onEngagedChange\?\.\(engaged\)/);

	const timeline = readFileSync("src/renderer/src/web/WebTimeline.tsx", "utf8");
	assert.match(timeline, /props\.onNearBottomChange\?\.\(nearBottom\)/, "贴底状态必须在既有滚动回调里上报，且只在值变化时回调");
});
