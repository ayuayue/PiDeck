import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readRendererStyles } from "./helpers/rendererStyles.mjs";

const css = readRendererStyles();
const shell = readFileSync("src/renderer/src/components/app/AppShell.tsx", "utf8");

test("wallpaper mode: background image reveals through translucent panels", () => {
	// 启用背景图时主容器透明（修复前 .wechat-shell 不透明背景盖住 body 背景图）。
	// 现由 shell 上的 Tailwind `[[data-bg-image=on]_&]:bg-transparent` 承担，
	// 覆盖主工作台与 compact 小任务两套 shell，不再写死根选择器。
	assert.match(shell, /wechat-shell[\s\S]*?\[\[data-bg-image=on\]_&\]:bg-transparent/);
	// 弹窗使用独立中高不透明度，并在弹窗内局部覆盖 bg 变量（变量继承），
	// 让 header/body 统一跟随壁纸设置，同时保留足够可读性。
	assert.match(css, /:root\[data-bg-image="on"\] \[data-slot="dialog-content"\][\s\S]*?--wallpaper-dialog-alpha: max\(90%, calc\(var\(--wallpaper-panel-alpha, 30%\) \+ 35%\)\);/);
	assert.match(css, /:root\[data-bg-image="on"\] \[data-slot="dialog-content"\][\s\S]*?--color-bg-muted: color-mix\(in srgb, var\(--wallpaper-base, var\(--color-bg-app\)\) var\(--wallpaper-dialog-alpha\), transparent\);/);
	// 背景图变量接线：使用独立 fixed 层，避免全屏根容器覆盖 body 背景。
	assert.match(css, /--app-bg-image: none;/);
	assert.match(css, /body::before\s*\{[\s\S]*?background-image: var\(--app-bg-mask, none\), var\(--app-bg-image, none\);/);
	assert.match(css, /--color-bg-popover: #ffffff;/);
	assert.match(css, /--color-bg-popover: #171717;/);
	assert.match(css, /:root\[data-bg-image="on"\] \.config-modal \.config-model-table,[\s\S]*?\.feedback-modal-shell \.feedback-actions[\s\S]*?\{\s*background:\s*transparent;/);
	assert.match(css, /background: var\(--color-chat-muted-bg\);/);
	assert.match(css, /background: var\(--color-chat-table-bg, var\(--color-bg-panel\)\);/);
});

test("wallpaper surfaces do not let bg-background utility hide the image", () => {
	const surfaceSource = readFileSync("src/renderer/src/components/session/SurfaceComponents.tsx", "utf8");
	const startSource = readFileSync("src/renderer/src/components/session/SessionStartSurface.tsx", "utf8");
	const composerSource = readFileSync("src/renderer/src/components/session/ComposerArea.tsx", "utf8");

	// 这些面板位于壁纸的内容层，默认透明即可继承 chat-pane；否则 utilities 层的
	// bg-background 会压过 foundation.css 的壁纸规则，把页面重新刷成纯白。
	assert.match(surfaceSource, /empty-state[^\n]*bg-transparent/);
	assert.match(startSource, /session-start-surface[^\n]*bg-transparent/);
	// composer 同样透出壁纸（远端 1cbbab34 有意修复壁纸模式回归：bg-background → bg-transparent），
	// 防止有人误加不透明背景再次盖住壁纸。
	assert.match(composerSource, /className="composer[^\n]*bg-transparent/);
});

test("large settings dialogs inherit page wallpaper transparency", () => {
	const settingsSource = readFileSync("src/renderer/src/components/app/SettingsModal.tsx", "utf8");
	const projectResourcesSource = readFileSync("src/renderer/src/components/app/ProjectResourcesModal.tsx", "utf8");
	const modelsSource = readFileSync("src/renderer/src/config/ModelsTab.tsx", "utf8");
	const modelsTableSource = readFileSync("src/renderer/src/config/ModelsTable.tsx", "utf8");
	const surfacesSource = readFileSync("src/renderer/src/styles/surfaces.css", "utf8");

	// 用户反馈「有些弹窗页面太透了」后：设置/项目资源这类工作台弹框不再按面板档降透明度
	// （背景图可见度 80% 时仅 30% 不透明，弹窗下方正文会透进设置内容、观感发虚），
	// 统一走通用弹窗的 ≥90% 基线——组件上因此不再有 --wallpaper-dialog-alpha
	// 内联覆盖（那份覆盖只会重复 CSS 基线的值，还因 utilities 层优先级更难改）。
	assert.doesNotMatch(settingsSource, /--wallpaper-dialog-alpha/);
	assert.doesNotMatch(projectResourcesSource, /--wallpaper-dialog-alpha/);
	assert.match(surfacesSource, /:root\[data-bg-image="on"\] \.config-modal \.config-layout[\s\S]*?background: transparent;/);
	assert.match(modelsSource, /config-provider-card/);
	assert.match(modelsSource, /config-provider-body/);
	// 模型表格容器已内聚到共享组件 ModelsTable（展开卡片与编辑页共用）
	assert.match(modelsTableSource, /config-model-table/);
	assert.match(surfacesSource, /\.config-modal \.config-model-table[\s\S]*?\.feedback-modal-shell \.feedback-environment-content[\s\S]*?\.feedback-modal-shell \.feedback-actions/);
});

test("Pi management and feedback dialogs inherit page wallpaper transparency", () => {
	const piSource = readFileSync("src/renderer/src/ConfigModal.tsx", "utf8");
	const environmentSource = readFileSync("src/renderer/src/components/overlays/OverlayComponents.tsx", "utf8");
	const feedbackSource = readFileSync("src/renderer/src/features/feedback/FeedbackDialog.tsx", "utf8");

	// Pi 环境管理和问题反馈都是完整业务面板，与设置/项目资源管理同档：走通用弹窗的
	// ≥90% 基线，不再各自按面板档降透明度；内部卡片继承主题 token 由 CSS 承担。
	assert.doesNotMatch(piSource, /--wallpaper-dialog-alpha/);
	assert.doesNotMatch(environmentSource, /--wallpaper-dialog-alpha/);
	// FeedbackDialog 现在直接使用通用 dialog-content；壁纸透明度由 foundation.css 的
	// 通用规则提供，业务组件不再在 overlay host 上注入旧的内联 alpha。
	assert.match(feedbackSource, /<DialogContent[\s\S]*?className=\{cn\(/);
	assert.match(css, /:root\[data-bg-image="on"\] \[data-slot="dialog-content"\][\s\S]*?--wallpaper-dialog-alpha: max\(90%, calc\(var\(--wallpaper-panel-alpha, 30%\) \+ 35%\)\);/);
});

test("all wallpaper dialogs share one readable baseline (no panel-alpha downgrade)", () => {
	// 回归守卫：弹窗透明度只保留「弹窗基线」一档。若有人再把某个弹窗（或草稿本）
	// 按面板档降档，背景图模式下该弹窗立刻发虚——这里逐条锁住。
	assert.doesNotMatch(css, /--wallpaper-dialog-alpha:\s*var\(--wallpaper-panel-alpha,\s*30%\)/, "no surface may downgrade dialogs to panel alpha");
	// 草稿本与 shadcn DialogContent 共用同一条基线规则（同一份 bg token 注入）。
	assert.match(css, /:root\[data-bg-image="on"\] \[data-slot="dialog-content"\],[\s\S]{0,240}?:root\[data-bg-image="on"\] \.scratch-pad-panel \{[\s\S]{0,240}?--wallpaper-dialog-alpha: max\(90%, calc\(var\(--wallpaper-panel-alpha, 30%\) \+ 35%\)\);/);
	// 工作台弹框仍要扁平化内部卡片底色，避免双层半透明（≈51%）白形成磨砂补丁。
	assert.match(css, /\[data-slot="dialog-content"\]\.environment-dialog \{[\s\S]{0,700}?--color-bg-panel: transparent;[\s\S]{0,200}?--color-card: transparent;[\s\S]{0,200}?--color-bg-muted: transparent;/);
});

test("App.tsx toggles wallpaper mode marker with background image setting", () => {
	const appSource = readFileSync("src/renderer/src/App.tsx", "utf8");
	assert.match(appSource, /root\.dataset\.bgImage = settings\.backgroundImage \? "on" : "off"/);
	// 皮肤 + 背景图合并为单一 effect（修复互相清除：皮肤 effect 清 token 误清壁纸注入、
	// 背景 else 分支误清皮肤 bg 键）
	assert.match(appSource, /root\.dataset\.bgImage = settings\.backgroundImage \? "on" : "off";/);
	// token 半透明注入：面板不透明度跟随滑块（panelMix 与遮罩 alpha 同步，
	// 100% 可见度 → 面板全透明，不再写死 80%）
	assert.match(appSource, /const panelMix = Math\.min\(100, Math\.round\(alpha \* 100\) \+ 10\);/);
	// 壁纸模式统一基色（--color-bg-app），侧栏/会话区/抽屉透出完全一致
	assert.match(appSource, /const base = cs\.getPropertyValue\("--color-bg-app"\)\.trim\(\);/);
	assert.match(appSource, /color-mix\(in srgb, \$\{base\} \$\{panelMix\}%, transparent\)/);
	// 浮层 token 单独提高不透明度，避免下拉菜单复用面板透明度而透出页面。
	assert.match(appSource, /const floatingMix = Math\.max\(92, Math\.min\(100, panelMix \+ 40\)\);/);
	assert.match(appSource, /"--color-chat-muted-bg"/);
	assert.match(appSource, /"--color-chat-table-bg"/);
	assert.match(appSource, /--color-bg-popover/);
	// 只清本 effect 注入过的壁纸 token（模块级记录，不误清皮肤键）
	assert.match(appSource, /injectedWallpaperTokens/);
});
