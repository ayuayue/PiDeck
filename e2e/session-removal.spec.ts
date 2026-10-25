import { existsSync, writeFileSync } from "node:fs";
import { test, expect } from "./mock-pi-fixture";
import { makeSeedProject } from "./open-session";
import type { ElectronApplication, Page } from "@playwright/test";

const project = makeSeedProject("delete-sessions");
const titles = ["会话-A", "会话-B", "会话-C", "会话-D", "会话-E"];
const seedSessionFiles = titles.map((title, index) => ({
	projectPath: project.path,
	fileName: `history-${index}.jsonl`,
	entries: [
		{ type: "session", version: 3, id: `history-${index}`, parentId: null, name: title, cwd: project.path, timestamp: new Date(Date.now() + index * 1000).toISOString() },
		{ type: "message", id: "u1", parentId: `history-${index}`, message: { role: "user", content: [{ type: "text", text: `${title}的问题：检查删除时列表是否抖动` }] }, timestamp: new Date().toISOString() },
		{ type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [{ type: "text", text: `${title}的回答\n\n` + Array.from({ length: 32 }, (_, line) => `第 ${line + 1} 行：保留真实历史内容用于切换与删除验证。`).join("\n") }], stopReason: "stop" }, timestamp: new Date().toISOString() },
	],
}));
test.use({ seedProjects: [project], seedSessionFiles: async ({}, use) => use(seedSessionFiles) });

async function openProject(window: Page) {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await window.getByRole("tab", { name: "项目", exact: true }).click();
	await window.locator(".conversation", { hasText: project.name }).first().click();
	await expect(window.locator(".history-session-row")).toHaveCount(5);
	await expect(window.locator(".project-session-loading")).toHaveCount(0);
}

async function deleteFromMenu(window: Page, title: string) {
	await window.locator(".history-session-row", { hasText: title }).click({ button: "right" });
	// 无子会话的记录按产品行为直接删除，只有父会话级联删除才弹确认。
	await window.getByRole("menuitem", { name: "删除", exact: true }).click();
}

async function delayRefreshAfterRealDelete(app: ElectronApplication) {
	await app.evaluate(({ ipcMain }) => {
		const handlers = (ipcMain as typeof ipcMain & { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers;
		const remove = handlers.get("sessions:catalog-delete");
		const list = handlers.get("sessions:catalog-list");
		if (!remove || !list) throw new Error("missing real session handlers");
		let deleted = false;
		ipcMain.removeHandler("sessions:catalog-delete");
		ipcMain.handle("sessions:catalog-delete", async (...args) => {
			const result = await remove(...args);
			deleted = true;
			return result;
		});
		ipcMain.removeHandler("sessions:catalog-list");
		ipcMain.handle("sessions:catalog-list", async (...args) => {
			// 只延后刷新响应以确定性覆盖布局边界，删除本身仍走真实回收站与catalog逻辑。
			if (deleted) await new Promise((resolve) => setTimeout(resolve, 450));
			return list(...args);
		});
	});
}

test("deleting another history session keeps the reading pane and remaining rows stable", async ({ app, window }, testInfo) => {
	await openProject(window);
	await window.locator(".history-session-row", { hasText: titles[0] }).dblclick();
	await expect(window.locator(".message-timeline")).toContainText(`${titles[0]}的回答`);
	const deletedFile = await window.evaluate(async (projectId) => (await window.piDesktop.sessions.listCatalog(projectId, { scan: false })).find((record) => record.title === "会话-C")?.filePath, project.id);
	expect(deletedFile).toBeTruthy();
	await delayRefreshAfterRealDelete(app);
	await window.evaluate(() => {
		const snapshot = () => ({
			at: performance.now(),
			loading: document.querySelectorAll(".project-session-loading").length,
			rows: [...document.querySelectorAll(".history-session-row")].map((row) => {
				const wrapper = row.closest("[data-sidebar-removal-id]");
				if (!wrapper) throw new Error("missing row motion wrapper");
				const style = getComputedStyle(wrapper);
				return { text: row.textContent, top: row.getBoundingClientRect().top, exitHeight: wrapper.getBoundingClientRect().height, opacity: Number(style.opacity), transform: style.transform };
			}),
		});
		const samples = [snapshot()];
		let frame = 0;
		const tick = () => {
			samples.push(snapshot());
			frame = requestAnimationFrame(tick);
		};
		frame = requestAnimationFrame(tick);
		(globalThis as unknown as { deleteProbe: { samples: typeof samples; stop: () => void } }).deleteProbe = { samples, stop: () => cancelAnimationFrame(frame) };
	});
	await deleteFromMenu(window, titles[2]);
	await expect(window.locator(".history-session-row", { hasText: titles[2] })).toHaveCount(0);
	await window.waitForTimeout(650);
	const samples = await window.evaluate(() => {
		const probe = (globalThis as unknown as { deleteProbe: { samples: unknown[]; stop: () => void } }).deleteProbe;
		probe.stop();
		return probe.samples;
	});
	writeFileSync(testInfo.outputPath("delete-frames.json"), JSON.stringify(samples, null, 2), "utf8");
	expect(existsSync(deletedFile!)).toBe(false);
	await expect(window.locator(".message-timeline")).toContainText(`${titles[0]}的回答`);
	await expect(window.locator(".history-session-row")).toHaveCount(4);
	expect(
		(samples as { loading: number }[]).some((sample) => sample.loading > 0),
		"deleting one row must not insert a whole-project loading row",
	).toBe(false);
	const rows = (samples as { rows: { text: string; exitHeight: number; opacity: number; transform: string }[] }[]).flatMap((sample) => sample.rows);
	const exiting = rows.filter((row) => row.text.includes(titles[2]));
	expect(
		exiting.some((row) => row.opacity > 0 && row.opacity < 1),
		"deleted row must fade before unmount",
	).toBe(true);
	const heights = exiting.map((row) => row.exitHeight);
	expect(Math.max(...heights) - Math.min(...heights), "fade must not animate height or squeeze text").toBeLessThan(1);
	expect(
		rows.some((row) => !row.text.includes(titles[2]) && row.transform !== "none"),
		"remaining rows must move with transform",
	).toBe(true);
});

test("failed history deletion keeps the file, current pane and session row", async ({ app, window }) => {
	await openProject(window);
	await window.locator(".history-session-row", { hasText: titles[0] }).dblclick();
	await expect(window.locator(".message-timeline")).toContainText(`${titles[0]}的回答`);
	const filePath = await window.evaluate(async (projectId) => (await window.piDesktop.sessions.listCatalog(projectId, { scan: false })).find((record) => record.title === "会话-A")?.filePath, project.id);
	await app.evaluate(({ ipcMain }) => {
		ipcMain.removeHandler("sessions:catalog-delete");
		ipcMain.handle("sessions:catalog-delete", () => {
			throw new Error("SESSION_DELETE_TEST_FAILURE");
		});
	});
	await deleteFromMenu(window, titles[0]);
	await expect(window.getByText("SESSION_DELETE_TEST_FAILURE", { exact: true })).toBeVisible();
	await expect(window.locator(".history-session-row")).toHaveCount(5);
	await expect(window.locator(".message-timeline")).toContainText(`${titles[0]}的回答`);
	expect(existsSync(filePath!)).toBe(true);
});

test("deleting current then last sessions closes their panes without removing the project", async ({ window }) => {
	await openProject(window);
	for (const title of titles) {
		await window.locator(".history-session-row", { hasText: title }).dblclick();
		await expect(window.locator(".message-timeline")).toContainText(`${title}的回答`);
		await deleteFromMenu(window, title);
		await expect(window.locator(".history-session-row", { hasText: title })).toHaveCount(0);
	}
	await expect(window.locator(".history-session-row")).toHaveCount(0);
	await expect(window.locator(".session-card")).toHaveCount(0);
	await expect(window.locator(".project-session-loading")).toHaveCount(0);
	await expect(window.locator(".message-timeline")).toHaveCount(0);
	expect(existsSync(project.path)).toBe(true);
	expect(await window.evaluate(async (id) => (await window.piDesktop.projects.list()).some((project) => project.id === id), project.id)).toBe(true);
});

test("project record waits for real deletion then exits smoothly, including the last project", async ({ app, window }, testInfo) => {
	await openProject(window);
	const row = window.locator(`[data-sidebar-removal-id="${project.id}"]`);
	await app.evaluate(({ ipcMain }) => {
		const handlers = (ipcMain as typeof ipcMain & { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers;
		const original = handlers.get("projects:remove");
		if (!original) throw new Error("missing real projects:remove handler");
		ipcMain.removeHandler("projects:remove");
		ipcMain.handle("projects:remove", async (...args) => {
			await new Promise((resolve) => setTimeout(resolve, 250));
			return original(...args);
		});
	});
	await window.evaluate((id) => {
		const samples: { height: number; opacity: number }[] = [];
		const tick = () => {
			const row = document.querySelector(`[data-sidebar-removal-id="${id}"]`);
			samples.push({ height: row?.getBoundingClientRect().height ?? 0, opacity: row ? Number(getComputedStyle(row).opacity) : 0 });
			if (row) requestAnimationFrame(tick);
		};
		(globalThis as unknown as { projectRemovalFrames: typeof samples }).projectRemovalFrames = samples;
		requestAnimationFrame(tick);
	}, project.id);
	await row.locator(".conversation").first().click({ button: "right" });
	await window.getByRole("menuitem", { name: "删除目录记录" }).click();
	await expect(row).toBeVisible();
	await expect(row).toHaveCount(0);
	const samples = await window.evaluate(() => (globalThis as unknown as { projectRemovalFrames: { height: number; opacity: number }[] }).projectRemovalFrames);
	writeFileSync(testInfo.outputPath("project-exit-frames.json"), JSON.stringify(samples, null, 2), "utf8");
	expect(samples.some((frame) => frame.height > 0 && frame.opacity > 0 && frame.opacity < 1)).toBe(true);
	const retainedHeights = samples.filter((frame) => frame.height > 0).map((frame) => frame.height);
	expect(Math.max(...retainedHeights) - Math.min(...retainedHeights), "project contents must not be squeezed during exit").toBeLessThan(1);
	expect(existsSync(project.path)).toBe(true);
	await expect(window.getByRole("button", { name: "添加项目", exact: true })).toBeVisible();
});

test("project deletion failure keeps its record visible instead of playing an exit", async ({ app, window }) => {
	await openProject(window);
	await app.evaluate(({ ipcMain }) => {
		ipcMain.removeHandler("projects:remove");
		ipcMain.handle("projects:remove", () => {
			throw new Error("PROJECT_HAS_RUNNING_AGENT");
		});
	});
	const row = window.locator(`[data-sidebar-removal-id="${project.id}"]`);
	await row.locator(".conversation").first().click({ button: "right" });
	await window.getByRole("menuitem", { name: "删除目录记录" }).click();
	await expect(window.getByRole("alertdialog")).toContainText("该项目仍有运行中的 Agent");
	await expect(row).toBeVisible();
	await expect(row).not.toHaveAttribute("inert", "");
	expect(await row.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
});
