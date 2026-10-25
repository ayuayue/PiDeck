import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import tailwindcss from "@tailwindcss/vite";
import { createServer } from "vite";

function extractTransformedCss(moduleCode) {
	const cssLiteral = moduleCode.match(/const __vite__css = ("(?:[^"\\]|\\.)*")/);
	assert.ok(cssLiteral, "Vite must expose the transformed stylesheet payload");
	return JSON.parse(cssLiteral[1]);
}

test("compiled title-scroll animation keeps duration on the element", async () => {
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
		assert.match(css, /\.animate-title-scroll\s*\{\s*animation:\s*title-scroll-to-end\s+var\(--title-scroll-duration,\s*3s\)\s+linear\s+forwards;/, "compiled utility must resolve the duration variable at element style time");
		assert.doesNotMatch(css, /\.animate-title-scroll\s*\{\s*animation:\s*var\(--animate-title-scroll\);/, "the animation token must not freeze the nested duration through :root");
	} finally {
		await server.close();
	}
});

test("reduced-motion reset keeps title hover-scroll alive", () => {
	// 全局 prefers-reduced-motion 把动画压成 0.01ms 单帧；标题滚动是用户主动
	// hover 触发的功能行为（压成单帧会直接跳尾，无法阅读），必须与 spinner 一样被排除。
	const foundation = readFileSync("src/renderer/src/styles/foundation.css", "utf8");
	const reset = foundation.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\n\}/)?.[0];
	assert.ok(reset, "global reduced-motion reset must exist");
	assert.match(reset, /\*:not\(\.animate-pideck-spin\):not\(\.animate-title-scroll\)\s*,\s*\*:not\(\.animate-pideck-spin\):not\(\.animate-title-scroll\)::before\s*,\s*\*:not\(\.animate-pideck-spin\):not\(\.animate-title-scroll\)::after/, "title scroll must be excluded from the single-frame animation reset");
});
