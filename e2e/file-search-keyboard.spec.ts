import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, expect, type Page } from "./fixtures";
import { makeSeedProject } from "./open-session";
import { rmSync } from "node:fs";

const project = makeSeedProject("FileSearchKeyboard");
const files = [
	{
		path: join(project.path, "src", "alpha.ts"),
		content: "export const alpha = true;\n",
	},
	{
		path: join(project.path, "src", "alpine.ts"),
		content: "export const alpine = true;\n",
	},
	{
		path: join(project.path, "docs", "guide.ts"),
		content: Array.from({ length: 48 }, (_, index) => (index === 39 ? "Search target in content." : `Documentation line ${index + 1}.`)).join("\n"),
	},
];
for (const file of files) {
	mkdirSync(dirname(file.path), { recursive: true });
	writeFileSync(file.path, file.content);
}
test.afterAll(() => rmSync(project.path, { recursive: true, force: true }));

for (const theme of ["light", "dark"] as const) {
	test.describe(`${theme} file search navigation`, () => {
		test.use({ seedProjects: [project], seedSettings: { theme } });

		async function openWorkspace(window: Page) {
			await expect(window.locator("#boot-overlay")).toHaveCount(0, {
				timeout: 20_000,
			});
			await expect(window.getByRole("tab", { name: "项目", exact: true })).toBeVisible();
			await window.getByRole("tab", { name: "项目", exact: true }).click();
			await window.locator(".conversation", { hasText: project.name }).first().click();
			await window.locator(".header-drawer-toggle").first().click();
			const drawer = window.locator(".detail-drawer");
			await expect(drawer).toHaveAttribute("data-open", "true");
			return drawer;
		}

		test("keyboard moves through visible results, opens directories with arrows and returns to the query", async ({ window }, testInfo) => {
			const drawer = await openWorkspace(window);
			await drawer.getByRole("button", { name: /^按名称搜索文件/ }).click();
			const input = drawer.getByRole("searchbox");
			await input.fill("al");
			await expect(drawer.locator(".file-search-results button.file")).toHaveCount(2);
			const directory = drawer.locator(".file-search-results button.directory", { hasText: "src" });
			const alpha = drawer.locator(".file-search-results button.file", {
				hasText: "alpha.ts",
			});
			const alpine = drawer.locator(".file-search-results button.file", {
				hasText: "alpine.ts",
			});
			await expect(alpha).toBeVisible();
			await expect(alpine).toBeVisible();

			await input.press("ArrowDown");
			await expect(directory).toBeFocused();
			await directory.press("ArrowDown");
			await expect(alpha).toBeFocused();
			await alpha.press("ArrowDown");
			await expect(alpine).toBeFocused();
			await alpine.press("ArrowDown");
			await expect(alpine).toBeFocused();
			await alpine.press("Home");
			await expect(directory).toBeFocused();
			await directory.press("ArrowLeft");
			await expect(directory).toHaveAttribute("aria-expanded", "false");
			await expect(alpha).toHaveCount(0);
			await directory.press("ArrowRight");
			await expect(directory).toHaveAttribute("aria-expanded", "true");
			await expect(alpha).toBeVisible();
			await directory.press("ArrowRight");
			await expect(alpha).toBeFocused();
			await alpine.press("End");
			await expect(alpine).toBeFocused();
			await alpine.press("ArrowUp");
			await expect(alpha).toBeFocused();
			await alpha.press("ArrowUp");
			await expect(directory).toBeFocused();
			await directory.press("ArrowUp");
			await expect(input).toBeFocused();
			expect(await input.evaluate((element: HTMLInputElement) => element.selectionStart)).toBe(2);
			await input.press("ArrowDown");
			await window.screenshot({
				path: testInfo.outputPath(`file-search-tree-focus-${theme}.png`),
			});
		});

		test("opening a content match from search preserves navigation and reveals its source line", async ({ app, window }, testInfo) => {
			const drawer = await openWorkspace(window);
			await app.evaluate(
				({ ipcMain }, result) => {
					ipcMain.removeHandler("files:search-content");
					ipcMain.handle("files:search-content", () => result);
				},
				{
					hits: [
						{
							name: "guide.ts",
							path: join(project.path, "docs", "guide.ts"),
							relativePath: "docs/guide.ts",
							line: 40,
							column: 1,
							snippet: "Search target in content.",
						},
					],
					matchedFiles: 1,
					scannedFiles: 3,
					scannedBytes: 1300,
					truncated: false,
				},
			);
			await drawer.getByRole("button", { name: /^按名称搜索文件/ }).click();
			const input = drawer.getByRole("searchbox");
			await input.fill("Search target");
			const hit = drawer.locator(".file-search-content > button");
			await expect(hit).toBeVisible({ timeout: 20_000 });
			await expect(hit).toContainText("guide.ts");
			await input.press("ArrowDown");
			await expect(hit).toBeFocused();
			await hit.press("ArrowUp");
			await expect(input).toBeFocused();
			await input.press("ArrowDown");
			await expect(hit).toBeFocused();
			await hit.press("Enter");
			await expect(window.locator(".workbench-stage-split").first()).toBeVisible();
			const editor = window.locator(".cm-editor").first();
			await expect(editor).toBeVisible();
			await expect(editor.locator(".cm-activeLine")).toContainText("Search target in content.");
			await window.screenshot({
				path: testInfo.outputPath(`file-search-content-line-${theme}.png`),
			});
		});
	});
}
