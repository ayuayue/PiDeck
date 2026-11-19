import { test, expect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

let server: ViteDevServer;
let baseUrl: string;

test.beforeAll(async () => {
	server = await createServer({
		configFile: false,
		root: process.cwd(),
		cacheDir: "node_modules/.vite-git-scroll",
		plugins: [tailwindcss()],
		esbuild: { jsx: "automatic" },
		resolve: { alias: { "@": resolve("src/renderer/src"), "@shared": resolve("src/shared") } },
		define: { __PIDECK_DEV_BUILD__: "false" },
		optimizeDeps: { entries: ["e2e/fixtures/git-scroll.html"] },
		server: { host: "127.0.0.1", port: 0 },
	});
	await server.listen();
	const address = server.httpServer?.address();
	if (!address || typeof address === "string") throw new Error("Missing fixture server port");
	baseUrl = `http://127.0.0.1:${address.port}/e2e/fixtures/git-scroll.html`;
});

test.afterAll(async () => {
	await server?.close();
});

for (const mode of ["single", "multiple"]) {
	test(`${mode} repository: wheel over changed files reaches the final file`, async ({ page }) => {
		await page.goto(`${baseUrl}?mode=${mode}`);
		const panel = page.locator(".git-panel[aria-label]").first();
		const first = panel.locator(".git-resource-name").first();
		await expect(first).toBeVisible();
		await first.hover();
		await page.mouse.wheel(0, 10_000);
		await expect(panel.locator(".git-resource-name", { hasText: "file-119.ts" })).toBeInViewport();
	});
}
