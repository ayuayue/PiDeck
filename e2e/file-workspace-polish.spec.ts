import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures";
import { makeSeedProject } from "./open-session";

const project = makeSeedProject("FileWorkspacePolish");
writeFileSync(join(project.path, "alpha.ts"), "export const alpha = true;\n");
test.afterAll(() => rmSync(project.path, { recursive: true, force: true }));

for (const theme of ["light", "dark"] as const) {
	test.describe(`${theme} file workspace`, () => {
		test.use({ seedProjects: [project], seedSettings: { theme, enableGitManagement: true, drawerWidth: 240 } });

		test("search recovers from errors, preserves keyboard focus and supports panel navigation", async ({ app, window }, testInfo) => {
			const pageErrors: string[] = [];
			window.on("pageerror", (error) => pageErrors.push(error.message));
			await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
			await app.evaluate(({ ipcMain }, projectPath) => {
				let attempts = 0;
				// 文件名搜索已收口到公共 `files:search-page`（位置分派），结果统一 Op 信封。
				ipcMain.removeHandler("files:search-page");
				ipcMain.handle("files:search-page", () => {
					if (attempts++ === 0) return { ok: false, code: "PROJECT_FILE_SEARCH_FAILED", outcome: "rejected" };
					return { ok: true, value: { results: [{ name: "alpha.ts", path: `${projectPath}/alpha.ts`, relativePath: "alpha.ts", type: "file" }] } };
				});
				ipcMain.removeHandler("files:search-content");
				ipcMain.handle("files:search-content", () => ({ hits: [], matchedFiles: 0, scannedFiles: 1, scannedBytes: 27, truncated: false }));
			}, project.path);
			const projectsTab = window.getByRole("tab", { name: "项目", exact: true });
			await expect(projectsTab).toBeVisible();
			await projectsTab.click();
			await window.locator(".conversation", { hasText: project.name }).first().click();
			await window.locator(".header-drawer-toggle").first().click();
			const drawer = window.locator(".detail-drawer");
			await expect(drawer).toHaveAttribute("data-open", "true");
			await drawer.getByRole("button", { name: /^按名称搜索文件/ }).click();
			const input = drawer.getByRole("searchbox");
			await expect(input).toBeFocused();
			await input.fill("alpha");
			const alert = drawer.getByRole("alert");
			await expect(alert).toContainText("PROJECT_FILE_SEARCH_FAILED");
			await expect(drawer.getByText("没有找到", { exact: false })).toHaveCount(0);
			await window.screenshot({ path: testInfo.outputPath(`file-search-error-${theme}.png`) });
			await alert.getByRole("button", { name: "重试", exact: true }).click();
			await expect(alert).toHaveCount(0);
			await expect(drawer.locator(".file-search-results button.file")).toHaveCount(1);
			await drawer.getByRole("button", { name: "清除", exact: true }).click();
			await expect(input).toHaveValue("");
			await expect(input).toBeFocused();
			await input.fill("alpha");
			await input.press("Escape");
			await expect(input).toHaveValue("");
			await expect(input).toBeFocused();
			await input.press("Escape");
			await expect(input).toHaveCount(0);
			await expect(drawer.locator(".files-panel")).toBeFocused();
			await window.keyboard.type("al");
			await expect(input).toHaveValue("al");
			await expect(input).toBeFocused();
			await expect(drawer.locator(".file-search-results button.file")).toHaveCount(1);
			await window.screenshot({ path: testInfo.outputPath(`file-search-results-${theme}.png`) });

			const rail = drawer.locator(".drawer-activity-rail");
			const files = rail.getByTestId("drawer-rail-files");
			const git = rail.getByTestId("drawer-rail-git");
			await files.focus();
			await expect(files).toHaveAttribute("tabindex", "0");
			await expect(git).toHaveAttribute("tabindex", "-1");
			await files.press("ArrowRight");
			await expect(git).toBeFocused();
			await expect(files).toHaveAttribute("aria-selected", "true");
			await expect(git).toHaveAttribute("aria-selected", "false");
			await git.press("Enter");
			await expect(git).toHaveAttribute("aria-selected", "true");
			await git.press("Home");
			await expect(files).toBeFocused();
			await files.press("Space");
			await expect(files).toHaveAttribute("aria-selected", "true");
			await files.press("Home");
			await expect(drawer).toHaveAttribute("data-open", "true");
			const lastTab = rail.getByRole("tab").last();
			await files.press("ArrowLeft");
			await expect(lastTab).toBeFocused();
			await expect(files).toHaveAttribute("aria-selected", "true");
			await lastTab.press("End");
			await expect(drawer).toHaveAttribute("data-open", "true");
			await lastTab.press("ArrowRight");
			await expect(files).toBeFocused();
			await files.press("End");
			await expect(lastTab).toBeFocused();
			await lastTab.press("Home");
			await expect(files).toBeFocused();
			await expect(rail.locator('[role="tab"][tabindex="0"]')).toHaveCount(1);

			const addPanel = rail.getByRole("button", { name: "添加常驻面板", exact: true });
			await addPanel.click();
			const optionalPanels = window.getByRole("menuitemcheckbox");
			await expect(optionalPanels.first()).toBeVisible();
			const optionalLabels = await optionalPanels.allTextContents();
			await window.keyboard.press("Escape");
			for (const label of optionalLabels) {
				await addPanel.click();
				const option = window.getByRole("menuitemcheckbox", { name: label.trim(), exact: true });
				if ((await option.getAttribute("aria-checked")) !== "true") await option.click();
				await window.keyboard.press("Escape");
			}
			await expect.poll(async () => Math.round((await drawer.boundingBox())?.width ?? 0)).toBe(240);
			await expect(addPanel).toBeInViewport();
			const railFits = await rail.evaluate((element) => {
				const bounds = element.getBoundingClientRect();
				return [...element.children].every((child) => {
					const box = child.getBoundingClientRect();
					return box.width === 0 || (box.left >= bounds.left && box.right <= bounds.right);
				});
			});
			expect(railFits).toBe(true);
			await files.focus();
			await files.press("End");
			await expect(lastTab).toBeFocused();
			await expect(lastTab).toBeInViewport();
			await window.screenshot({ path: testInfo.outputPath(`file-workspace-narrow-${theme}.png`) });
			expect(pageErrors).toEqual([]);
		});
	});
}
