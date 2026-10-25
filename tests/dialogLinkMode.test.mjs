import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

// 弹框（Dialog/Modal/Overlay）内的链接必须强制系统浏览器打开：
// 内置浏览器面板位于 Dialog 下层不可见，linkOpenMode=internal 时跟随设置打开会被遮挡，
// 用户表现为“点了没反应”。统一规则与 ConfigShared.openDocsInSystemBrowser 一致（forceSystem=true）。

test("skill hub result cards force system browser", () => {
	const src = readFileSync("src/renderer/src/config/SkillHubStorePanel.tsx", "utf8");
	// 技能搜索结果卡片：点击跳 skills.sh 网页，弹框内必须系统浏览器
	assert.match(src, /window\.piDesktop\.app\.openExternal\(\s*`https:\/\/www\.skills\.sh\/search\?q=\$\{encodeURIComponent\(item\.name\)\}`,\s*true\s*\)/);
});

test("extension recommendation cards force system browser", () => {
	const src = readFileSync("src/renderer/src/config/extensionsRecommendedPackages.tsx", "utf8");
	// 扩展推荐卡片：原来裸 window.open（会走 setWindowOpenHandler 跟随设置，internal 时同样被遮挡）
	assert.doesNotMatch(src, /window\.open\(/);
	assert.match(src, /window\.piDesktop\.app\.openExternal\(\s*`https:\/\/pi\.dev\/packages\/\$\{pkg\.name\}\?name=\$\{packageName\}`,\s*true\s*\)/);
});

test("config diagnostic docs link forces system browser", () => {
	const src = readFileSync("src/renderer/src/ConfigModal.tsx", "utf8");
	assert.match(src, /onOpenDocs=\{\(\) => api\.app\.openExternal\(configDiagnostic\.docsUrl, true\)\}/);
});

test("environment dialog nodejs link forces system browser in dialog implementations", () => {
	// OverlayComponents 版是 EnvironmentDialog 唯一实现；未安装态的 Node.js 外链现在在
	// EnvironmentSetupPanel（一键安装面板）里，必须保留 forceSystem（Dialog 下内置浏览器不可见）。
	const overlay = readFileSync("src/renderer/src/components/overlays/OverlayComponents.tsx", "utf8");
	assert.doesNotMatch(overlay, /window\.open\(/);
	const setup = readFileSync("src/renderer/src/components/overlays/EnvironmentSetupPanel.tsx", "utf8");
	assert.match(setup, /openExternal\(\s*"https:\/\/nodejs\.org\/zh-cn\/download\/",\s*true\s*\)/);
});

test("settings web service link forces system browser", () => {
	const src = readFileSync("src/renderer/src/components/app/SettingsFeatureRoot.tsx", "utf8");
	// forceSystem=true：Web 服务页必须离开内置浏览器面板——面板在 Dialog 下层，
	// 设置弹窗打开时会被遮挡；且外部端按桌面浏览器视口设计，系统浏览器体验更完整。
	// URL 组装已移到 WebTab（previewUrl = buildWebAccessUrl(previewHostFromBinding(...))），
	// 回调只负责带 forceSystem 转发——契约守第二个参数，不断言具体 URL 拼接位置。
	assert.match(src, /onOpenWebService: \(url: string\) => api\.app\.openExternal\(url, true\)/);
});
