import assert from "node:assert/strict";
import test from "node:test";
import postcss from "postcss";
import { build, createLogger, createServer } from "vite";
import { readRendererStyles } from "./helpers/rendererStyles.mjs";

test("renderer stylesheet has no nested style rules", async () => {
	const stylesheet = readRendererStyles();
	const root = postcss.parse(stylesheet);
	const nestedRules = [];

	root.walkRules((rule) => {
		if (rule.parent?.type === "rule") nestedRules.push(rule.selector);
	});

	assert.deepEqual(nestedRules, [], "A missing closing brace can make ordinary selectors children of another selector.");
});

test("sidebar canvas logo keeps the main dev dimensions", async () => {
	const stylesheet = readRendererStyles();
	const root = postcss.parse(stylesheet);
	const rule = root.nodes.find((node) => node.type === "rule" && node.selector === ".pi-logo-canvas");

	assert.ok(rule, "sidebar canvas logo rule must exist");
	const declarations = Object.fromEntries(rule.nodes.filter((node) => node.type === "decl").map((node) => [node.prop, node.value]));
	assert.equal(declarations.width, "34px");
	assert.equal(declarations.height, "34px");
	assert.equal(declarations["image-rendering"], "pixelated");
});

test("renderer stylesheet passes the real Vite CSS pipeline", async () => {
	const server = await createServer({
		root: process.cwd(),
		configFile: false,
		logLevel: "silent",
		server: { middlewareMode: true },
	});

	try {
		const result = await server.transformRequest("/src/renderer/src/styles.css");
		assert.ok(result, "Vite should transform the renderer stylesheet");
	} finally {
		await server.close();
	}

	const cssWarnings = [];
	const logger = createLogger("silent");
	logger.warn = (message) => cssWarnings.push(String(message));
	logger.warnOnce = logger.warn;

	await build({
		root: process.cwd(),
		configFile: false,
		customLogger: logger,
		build: {
			minify: "esbuild",
			write: false,
			rollupOptions: {
				input: "src/renderer/src/styles.css",
			},
		},
	});

	assert.deepEqual(cssWarnings, [], `CSS build warnings:\n${cssWarnings.join("\n")}`);
});
