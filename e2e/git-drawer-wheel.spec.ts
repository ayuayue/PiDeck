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
		cacheDir: "node_modules/.vite-git-drawer-wheel",
		plugins: [tailwindcss()],
		esbuild: { jsx: "automatic" },
		resolve: { alias: { "@": resolve("src/renderer/src"), "@shared": resolve("src/shared") } },
		define: { __PIDECK_DEV_BUILD__: "false" },
		optimizeDeps: { entries: ["e2e/fixtures/git-drawer-wheel.html"] },
		server: { host: "127.0.0.1", port: 0 },
	});
	await server.listen();
	const address = server.httpServer?.address();
	if (!address || typeof address === "string") throw new Error("Missing fixture server port");
	baseUrl = `http://127.0.0.1:${address.port}/e2e/fixtures/git-drawer-wheel.html`;
});

test.afterAll(async () => {
	await server?.close();
});

test("single repository: wheel scrolls the change list in both directions", async ({ page }) => {
	await page.goto(baseUrl);
	const panel = page.locator(".git-panel[aria-label]");
	const firstFile = panel.locator(".git-resource-name").first();
	const changes = panel.locator('[id$="-changes"] .overflow-y-auto');
	await expect(firstFile).toBeInViewport();
	await firstFile.hover();
	await page.mouse.wheel(0, 10_000);
	await expect(panel.getByText("file-119.ts", { exact: true })).toBeInViewport();
	await expect.poll(() => changes.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
	await page.mouse.wheel(0, -10_000);
	await expect.poll(() => changes.evaluate((element) => element.scrollTop)).toBe(0);
	await expect(panel.getByText("file-000.ts", { exact: true })).toBeInViewport();
});

for (const count of [8, 120]) {
	test(`multiple repositories with ${count} files: wheel passes through files and headers to the repository list`, async ({ page }) => {
		await page.goto(`${baseUrl}?mode=multiple&count=${count}&height=360`);
		const fixture = page.getByTestId("git-drawer-fixture");
		const repositories = fixture.locator(":scope > .git-panel > .overflow-y-auto");
		const panels = fixture.locator(".git-panel[aria-label]");
		await expect(panels).toHaveCount(3);
		const firstPanel = panels.first();
		const firstFile = firstPanel.getByText("file-000.ts", { exact: true });
		await expect(firstFile).toBeInViewport();

		// Cover both VirtualStack's plain rows and virtual rows without scrolling locators into view.
		const targets = [firstFile, firstPanel.locator("button[aria-expanded]").first(), firstPanel.locator('[role="button"][aria-expanded]').first()];
		for (const target of targets) {
			await target.hover();
			await page.mouse.wheel(0, 120);
			await expect.poll(() => repositories.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
			await page.mouse.wheel(0, -120);
			await expect.poll(() => repositories.evaluate((element) => element.scrollTop)).toBe(0);
		}

		await firstFile.hover();
		await page.mouse.wheel(0, 10_000);
		const lastFile = panels.nth(1).getByText(`file-${String(count - 1).padStart(3, "0")}.ts`, { exact: true });
		await expect(lastFile).toBeInViewport();
		await lastFile.hover();
		await page.mouse.wheel(0, -10_000);
		await expect.poll(() => repositories.evaluate((element) => element.scrollTop)).toBe(0);
		await expect(firstFile).toBeInViewport();
	});
}
