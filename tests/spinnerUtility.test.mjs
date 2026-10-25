import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import tailwindcss from "@tailwindcss/vite";
import { createServer } from "vite";

const rendererRoot = "src/renderer/src";
const tailwindStyles = readFileSync(`${rendererRoot}/styles/tailwind.css`, "utf8");

function extractTransformedCss(moduleCode) {
	const cssLiteral = moduleCode.match(/const __vite__css = ("(?:[^"\\]|\\.)*")/);
	assert.ok(cssLiteral, "Vite must expose the transformed stylesheet payload");
	return JSON.parse(cssLiteral[1]);
}

function rendererSourceFiles(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const filePath = join(directory, entry.name);
		if (entry.isDirectory()) return rendererSourceFiles(filePath);
		return /\.(?:ts|tsx|css)$/.test(entry.name) ? [filePath] : [];
	});
}

test("spinner utility centralizes an explicit loading-state animation", () => {
	assert.match(tailwindStyles, /--animate-pideck-spin:\s*pideck-spin\s+1s\s+linear\s+infinite;/, "all renderer spinners must use one named animation token");
	assert.match(tailwindStyles, /@keyframes\s+pideck-spin\s*\{[\s\S]*?transform:\s*rotate\(360deg\);[\s\S]*?\}/, "the shared spinner animation must explicitly own its rotation keyframe");
	const foundationStyles = readFileSync(`${rendererRoot}/styles/foundation.css`, "utf8");
	assert.match(
		foundationStyles,
		/\*:not\(\.animate-pideck-spin\):not\(\.animate-title-scroll\),\s*\*:not\(\.animate-pideck-spin\):not\(\.animate-title-scroll\)::before,\s*\*:not\(\.animate-pideck-spin\):not\(\.animate-title-scroll\)::after\s*\{[\s\S]*?animation-duration:\s*0\.01ms\s*!important;[\s\S]*?animation-iteration-count:\s*1\s*!important;/,
		"the global reduced-motion reset must exclude loading spinners and title hover-scroll",
	);
});

test("compiled renderer CSS emits the spinner utility and its keyframe", async () => {
	const server = await createServer({
		root: process.cwd(),
		configFile: false,
		logLevel: "silent",
		plugins: [tailwindcss()],
		server: { middlewareMode: true },
	});

	try {
		const result = await server.transformRequest("/src/renderer/src/styles.css");
		const css = extractTransformedCss(result?.code ?? "");
		assert.match(css, /\.animate-pideck-spin\s*\{\s*animation:\s*var\(--animate-pideck-spin\);/);
		assert.match(css, /--animate-pideck-spin:\s*pideck-spin\s+1s\s+linear\s+infinite;/);
		assert.match(css, /@keyframes\s+pideck-spin\s*\{\s*to\s*\{\s*transform:\s*rotate\(360deg\);/);
	} finally {
		await server.close();
	}
});

test("renderer spinner call sites do not bypass the shared utility", () => {
	const legacySpinnerClasses = /(?<![\w-])(?:animate-spin|pideck-spin)(?![\w-])/;
	const legacyUses = rendererSourceFiles(rendererRoot).filter((filePath) => filePath.replaceAll("\\", "/") !== `${rendererRoot}/styles/tailwind.css` && legacySpinnerClasses.test(readFileSync(filePath, "utf8")));

	assert.deepEqual(legacyUses, [], "replace legacy spinner classes with animate-pideck-spin so reduced-motion applies everywhere");
});

test("title-tab loading badge delegates rotation to the shared utility", () => {
	const badge = readFileSync("src/renderer/src/components/motion/animated-badge.tsx", "utf8");
	const tabBar = readFileSync("src/renderer/src/components/session/SessionTabsBar.tsx", "utf8");

	assert.match(tabBar, /<AnimatedBadge[\s\S]*?status=\{badge\.status\}/);
	assert.match(badge, /status === "loading" && !icon[\s\S]*?className="inline-flex animate-pideck-spin"/, "the title-tab loading badge must keep the shared spinner active under reduced motion");
	assert.doesNotMatch(badge, /status === "loading" && !reduce && !icon/);
});

test("legacy spinner shells delegate rotation to the shared utility", () => {
	const legacyStyles = ["src/renderer/src/styles/foundation.css", "src/renderer/src/styles/timeline.css", "src/renderer/src/styles/integrations.css", "src/renderer/src/styles/surfaces.css"].map((filePath) => readFileSync(filePath, "utf8")).join("\n");

	assert.doesNotMatch(legacyStyles, /animation:\s*(?:[\w-]*spin|spin)[^;]*;/, "legacy spinner shells must not define their own rotation timing");

	for (const [filePath, selector] of [
		// 全屏 loading 壳已从 AppParts 拆到 OverlayComponents（12066004 环境引导重构），
		// 「用共享旋转工具」的契约随之跟到新宿主文件，类名不放宽。
		["src/renderer/src/components/overlays/OverlayComponents.tsx", 'className="loader animate-pideck-spin"'],
		// 会话历史面板（含行内 copy/export/delete 的 mini-loader）已从 WorkspaceSurface 迁出
		["src/renderer/src/components/session/SessionHistoryPanel.tsx", 'className="mini-loader animate-pideck-spin"'],
		["src/renderer/src/components/feishu/FeishuLinkIndicator.tsx", 'className="feishu-link-spinner animate-pideck-spin"'],
		["src/renderer/src/config/extensionsRecommendedPackages.tsx", 'className="skillhub-installing-dot animate-pideck-spin"'],
		["src/renderer/src/web/WebTimeline.tsx", 'className="tool-card-spinner animate-pideck-spin"'],
	]) {
		assert.match(readFileSync(filePath, "utf8"), new RegExp(selector));
	}
});
